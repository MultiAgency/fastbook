//! Admin handler for reconciling follower/following counts and sorted indices.

use crate::agent::*;
use crate::registry::{load_registry, write_sorted_indices};
use crate::require_caller;
use crate::response::*;
use crate::store::*;
use crate::types::*;
use std::collections::{HashMap, HashSet};

use super::endorse::collect_endorsable;

/// Validate an endorser index against actual records, prune orphans, repair reverse indices.
/// Returns `(valid_endorsers, orphans_pruned)`.
fn reconcile_endorser_index(handle: &str, ns: &str, val: &str) -> (Vec<String>, u64) {
    let endorser_idx_key = keys::endorsers(handle, ns, val);
    let endorsers = index_list(&endorser_idx_key);
    let mut valid = Vec::new();
    let mut pruned = 0u64;

    for endorser in &endorsers {
        if has(&keys::endorsement(handle, ns, val, endorser)) {
            valid.push(endorser.clone());
            // Repair reverse index if missing
            let by_key = keys::endorsement_by(endorser, handle);
            let entry = format!("{ns}:{val}");
            if !index_list(&by_key).iter().any(|e| e == &entry) {
                let _ = index_append(&by_key, &entry);
            }
        } else {
            let _ = index_remove(
                &keys::endorsement_by(endorser, handle),
                &format!("{ns}:{val}"),
            );
            pruned += 1;
        }
    }

    if valid.len() != endorsers.len() {
        if let Ok(bytes) = serde_json::to_vec(&valid) {
            let _ = set_public(&endorser_idx_key, &bytes);
        }
    }

    (valid, pruned)
}

/// Clean endorsement records left behind when tags or capabilities were removed.
///
/// Phase 1b only scans CURRENT endorsable pairs.  Records for REMOVED pairs
/// linger as invisible dead data.  We reach them through the `endorsement_by`
/// reverse index — our only path to non-current pairs — and delete the
/// records, endorser-index entries, and reverse-index entries that reference them.
fn clean_orphaned_endorsements(handles: &[String], agents: &[AgentRecord]) -> u64 {
    let endorsable_by_handle: HashMap<&str, HashSet<(String, String)>> = agents
        .iter()
        .map(|a| {
            (
                a.handle.as_str(),
                collect_endorsable(Some(&a.tags), Some(&a.capabilities)),
            )
        })
        .collect();

    let mut cleaned: u64 = 0;
    // Read old endorsed_targets BEFORE the caller rebuilds them.
    for handle in handles {
        let old_targets = index_list(&keys::endorsed_targets(handle));
        for target in &old_targets {
            let by_key = keys::endorsement_by(handle, target);
            let entries = index_list(&by_key);
            if entries.is_empty() {
                continue;
            }
            let target_endorsable = endorsable_by_handle.get(target.as_str());
            for entry in &entries {
                if let Some((ns, val)) = entry.split_once(':') {
                    let is_current = target_endorsable
                        .is_some_and(|e| e.contains(&(ns.to_string(), val.to_string())));
                    if !is_current {
                        let _ = delete(&keys::endorsement(target, ns, val, handle));
                        let _ = index_remove(&keys::endorsers(target, ns, val), handle);
                        let _ = index_remove(&by_key, entry);
                        cleaned += 1;
                    }
                }
            }
        }
    }
    cleaned
}

/// Prune notification index entries whose data is missing.
///
/// If a notification key was written but the index append failed (and the
/// cleanup delete also failed), the key persists outside any index — that
/// case is handled by the `store_notification` cleanup path.  The reverse
/// case (index entry exists but data is missing) is what we fix here.
fn prune_dangling_notifications(handles: &[String]) -> u64 {
    let mut pruned: u64 = 0;
    for handle in handles {
        let idx_key = keys::notif_idx(handle);
        let entries: Vec<String> = get_json(&idx_key).unwrap_or_default();
        if entries.is_empty() {
            continue;
        }
        let valid: Vec<String> = entries
            .iter()
            .filter(|k| get_string(k).is_some())
            .cloned()
            .collect();
        if valid.len() != entries.len() {
            pruned += (entries.len() - valid.len()) as u64;
            let _ = set_json(&idx_key, &valid);
        }
    }
    pruned
}

pub fn handle_reconcile_all(req: &Request) -> Response {
    let caller = require_caller!(req);
    if let Err(e) = crate::auth::require_admin(&caller) {
        return e;
    }

    let handles = load_registry();
    let live: HashSet<&str> = handles.iter().map(std::string::String::as_str).collect();
    let mut agents_checked: u64 = 0;
    let mut counts_corrected: u64 = 0;
    let mut edges_pruned: u64 = 0;
    let mut near_mappings_rebuilt: u64 = 0;

    // --- Phase 1: prune dead handles from indices, correct counts, rebuild near mappings ---
    let mut all_tags: Vec<String> = Vec::new();
    let mut agents: Vec<AgentRecord> = Vec::new();

    for handle in &handles {
        let Some(mut agent) = load_agent(handle) else {
            continue;
        };
        agents_checked += 1;

        // Prune follower/following indices: remove handles whose agent no longer exists.
        // This heals partial deregistrations where Phase 2 (edge cleanup) did not complete.
        let followers = index_list(&keys::pub_followers(&agent.handle));
        let clean_followers: Vec<String> = followers
            .iter()
            .filter(|h| live.contains(h.as_str()))
            .cloned()
            .collect();
        if clean_followers.len() != followers.len() {
            edges_pruned += (followers.len() - clean_followers.len()) as u64;
            if let Ok(bytes) = serde_json::to_vec(&clean_followers) {
                let _ = set_public(&keys::pub_followers(&agent.handle), &bytes);
            }
        }

        let following = index_list(&keys::pub_following(&agent.handle));
        let clean_following: Vec<String> = following
            .iter()
            .filter(|h| live.contains(h.as_str()))
            .cloned()
            .collect();
        if clean_following.len() != following.len() {
            edges_pruned += (following.len() - clean_following.len()) as u64;
            if let Ok(bytes) = serde_json::to_vec(&clean_following) {
                let _ = set_public(&keys::pub_following(&agent.handle), &bytes);
            }
        }

        // Note: we recount from the already-pruned indices rather than calling
        // `recount_social` because reconcile prunes dead handles first.
        let actual_followers = clean_followers.len() as i64;
        let actual_following = clean_following.len() as i64;

        if agent.follower_count != actual_followers || agent.following_count != actual_following {
            if agent.follower_count < 0 || agent.following_count < 0 {
                eprintln!(
                    "[reconcile] negative count on {}: followers={}, following={}",
                    agent.handle, agent.follower_count, agent.following_count,
                );
            }
            agent.follower_count = actual_followers;
            agent.following_count = actual_following;
            let Ok(bytes) = serde_json::to_vec(&agent) else {
                continue;
            };
            let _ = set_public(&keys::pub_agent(&agent.handle), &bytes);
            counts_corrected += 1;
        }

        // Rebuild near account mapping
        let _ = set_public(
            &keys::near_account(&agent.near_account_id),
            agent.handle.as_bytes(),
        );
        near_mappings_rebuilt += 1;

        all_tags.extend(agent.tags.iter().cloned());
        agents.push(agent);
    }

    // --- Phase 1b: endorsement consistency scan ---
    // Validates endorser indices against actual endorsement records,
    // removes orphaned entries, repairs reverse indices, corrects counts,
    // and rebuilds endorsed_targets indices.
    // Scope: current endorsable set only.  Phase 1c (below) handles orphaned
    // endorsement records for REMOVED tags/capabilities.
    let mut endorsements_corrected: u64 = 0;
    let mut endorsement_indices_pruned: u64 = 0;
    // Collect endorsed_targets: endorser → set of target handles
    let mut endorsed_targets_map: HashMap<String, HashSet<String>> = HashMap::new();

    for agent in &mut agents {
        let endorsable = collect_endorsable(Some(&agent.tags), Some(&agent.capabilities));
        let mut rebuilt = Endorsements::new();

        for (ns, val) in &endorsable {
            let (valid, pruned) = reconcile_endorser_index(&agent.handle, ns, val);
            endorsement_indices_pruned += pruned;
            if !valid.is_empty() {
                rebuilt.set_count(ns, val, valid.len() as i64);
                for endorser in &valid {
                    endorsed_targets_map
                        .entry(endorser.clone())
                        .or_default()
                        .insert(agent.handle.clone());
                }
            }
        }

        if !rebuilt.eq_counts(&agent.endorsements) {
            agent.endorsements = rebuilt;
            let Ok(bytes) = serde_json::to_vec(&*agent) else {
                continue;
            };
            let _ = set_public(&keys::pub_agent(&agent.handle), &bytes);
            endorsements_corrected += 1;
        }
    }

    // --- Phase 1c: clean orphaned endorsements for removed tags/capabilities ---
    let orphaned_endorsements_cleaned = clean_orphaned_endorsements(&handles, &agents);

    // Rebuild endorsed_targets indices from the data collected above.
    for handle in &handles {
        let targets: Vec<String> = endorsed_targets_map
            .remove(handle.as_str())
            .map(|s| s.into_iter().collect())
            .unwrap_or_default();
        let key = keys::endorsed_targets(handle);
        if targets.is_empty() {
            let _ = delete(&key);
        } else if let Ok(bytes) = serde_json::to_vec(&targets) {
            let _ = set_public(&key, &bytes);
        }
    }

    // --- Phase 2: rebuild all sorted indices from scratch ---
    // Clear existing sorted indices
    for sort in &["followers", "endorsements", "newest", "active"] {
        let _ = set_public(&keys::pub_sorted(sort), b"[]");
    }
    for agent in &agents {
        let _ = write_sorted_indices(agent);
    }

    // --- Phase 3: rebuild tag counts ---
    let mut tag_counts: HashMap<String, u32> = HashMap::new();
    for tag in &all_tags {
        *tag_counts.entry(tag.clone()).or_insert(0) += 1;
    }
    if let Ok(bytes) = serde_json::to_vec(&tag_counts) {
        let _ = set_public(keys::pub_tag_counts(), &bytes);
    }

    // --- Phase 4: update meta ---
    let _ = set_public(
        keys::pub_meta_count(),
        agents_checked.to_string().as_bytes(),
    );

    // --- Phase 5: count nonces for monitoring ---
    let nonce_count = index_list(keys::nonce_idx()).len() as u64;

    // --- Phase 6: prune dangling notification index entries ---
    let notif_entries_pruned = prune_dangling_notifications(&handles);

    ok_response(serde_json::json!({
        "agents_checked": agents_checked,
        "counts_corrected": counts_corrected,
        "edges_pruned": edges_pruned,
        "endorsements_corrected": endorsements_corrected,
        "endorsement_indices_pruned": endorsement_indices_pruned,
        "orphaned_endorsements_cleaned": orphaned_endorsements_cleaned,
        "notif_entries_pruned": notif_entries_pruned,
        "sorted_rebuilt": true,
        "near_mappings_rebuilt": near_mappings_rebuilt,
        "nonce_count": nonce_count,
    }))
}

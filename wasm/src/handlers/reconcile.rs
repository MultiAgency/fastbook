//! Admin handler for reconciling follower/following counts and endorsement indices.

use crate::agent::*;
use crate::registry::load_registry;
use crate::store::*;
use crate::types::*;
use std::collections::{HashMap, HashSet};

use super::endorse::collect_endorsable;

/// Validate endorser keys against actual records, prune orphans, repair reverse indices.
/// Returns `(valid_endorsers, orphans_pruned)`.
fn reconcile_endorser_index(handle: &str, ns: &str, val: &str) -> (Vec<String>, u64) {
    let endorsers = handles_from_prefix(&keys::pub_endorser_prefix(handle, ns, val));
    let mut valid = Vec::new();
    let mut pruned = 0u64;

    for endorser in &endorsers {
        if has(&keys::endorsement(handle, ns, val, endorser)) {
            valid.push(endorser.clone());
            // Repair reverse index if missing
            let by_key = keys::pub_endorsement_by(endorser, handle, ns, val);
            if !user_has(&by_key) {
                let _ = user_set(&by_key, b"1");
            }
        } else {
            // Remove orphaned endorser key
            user_delete_key(&keys::pub_endorser(handle, ns, val, endorser));
            // Remove reverse index key
            user_delete_key(&keys::pub_endorsement_by(endorser, handle, ns, val));
            pruned += 1;
        }
    }

    (valid, pruned)
}

/// Prune individual user-scope keys under `prefix` whose handle suffix is not in `live`.
/// Deletes dead keys. Returns `(pruned_count, clean_handles)`.
fn prune_prefix_keys(prefix: &str, live: &HashSet<&str>) -> (u64, Vec<String>) {
    let all = handles_from_prefix(prefix);
    let mut clean = Vec::new();
    let mut pruned = 0u64;
    for handle in all {
        if live.contains(handle.as_str()) {
            clean.push(handle);
        } else {
            // Delete the individual key: prefix + handle
            user_delete_key(&format!("{prefix}{handle}"));
            pruned += 1;
        }
    }
    (pruned, clean)
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
    // Scan endorsed_target keys BEFORE the caller rebuilds them.
    for handle in handles {
        let old_targets = handles_from_prefix(&keys::pub_endorsed_target_prefix(handle));
        for target in &old_targets {
            // Scan all endorsement_by keys for this (handle → target) pair.
            let by_keys = user_list(&keys::pub_endorsement_by_prefix(handle, target));
            if by_keys.is_empty() {
                continue;
            }
            let target_endorsable = endorsable_by_handle.get(target.as_str());
            let prefix = keys::pub_endorsement_by_prefix(handle, target);
            for by_key in &by_keys {
                let after_prefix = by_key.strip_prefix(&prefix).unwrap_or("");
                if let Some((ns, val)) = after_prefix.split_once(':') {
                    let is_current = target_endorsable
                        .is_some_and(|e| e.contains(&(ns.to_string(), val.to_string())));
                    if !is_current {
                        let _ = delete(&keys::endorsement(target, ns, val, handle));
                        user_delete_key(&keys::pub_endorser(target, ns, val, handle));
                        user_delete_key(by_key);
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

        // Prune follower/following keys: remove keys whose handle suffix no longer exists.
        // This heals partial deregistrations where Phase 2 (edge cleanup) did not complete.
        let (pruned, clean_followers) =
            prune_prefix_keys(&keys::pub_follower_prefix(&agent.handle), &live);
        edges_pruned += pruned;

        let (pruned, clean_following) =
            prune_prefix_keys(&keys::pub_following_prefix(&agent.handle), &live);
        edges_pruned += pruned;

        // Recount from the already-pruned key lists.
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

        // Derive mutual count: followers who this agent also follows.
        let follower_set: HashSet<&str> = clean_followers.iter().map(String::as_str).collect();
        let actual_mutual = clean_following
            .iter()
            .filter(|h| follower_set.contains(h.as_str()))
            .count() as i64;

        // Sync atomic counters to match derived counts.
        let _ = user_set(
            &keys::follower_count(&agent.handle),
            actual_followers.to_string().as_bytes(),
        );
        let _ = user_set(
            &keys::following_count(&agent.handle),
            actual_following.to_string().as_bytes(),
        );
        let _ = user_set(
            &keys::mutual_count(&agent.handle),
            actual_mutual.to_string().as_bytes(),
        );

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

    // Rebuild endorsed_target keys from the data collected above.
    for handle in &handles {
        let targets: HashSet<String> = endorsed_targets_map
            .remove(handle.as_str())
            .unwrap_or_default();
        // Delete existing endorsed_target keys, then write current ones.
        let existing = handles_from_prefix(&keys::pub_endorsed_target_prefix(handle));
        for t in &existing {
            if !targets.contains(t) {
                user_delete_key(&keys::pub_endorsed_target(handle, t));
            }
        }
        for t in &targets {
            let _ = user_set(&keys::pub_endorsed_target(handle, t), b"1");
        }
    }

    // --- Phase 2: rebuild tag counts ---
    let mut tag_counts: HashMap<String, u32> = HashMap::new();
    for tag in &all_tags {
        *tag_counts.entry(tag.clone()).or_insert(0) += 1;
    }
    if let Ok(bytes) = serde_json::to_vec(&tag_counts) {
        let _ = set_public(keys::pub_tag_counts(), &bytes);
    }

    // --- Phase 3: update meta ---
    let _ = set_public(
        keys::pub_meta_count(),
        agents_checked.to_string().as_bytes(),
    );

    // --- Phase 4: count nonces for monitoring ---
    let nonce_count = index_list(keys::nonce_idx()).len() as u64;

    // --- Phase 5: prune dangling notification index entries ---
    let notif_entries_pruned = prune_dangling_notifications(&handles);

    // --- Phase 6: Full FastData KV sync ---
    // Batches all public state into __fastdata_kv calls (max 256 keys each).
    {
        let mut sync = crate::fastdata::SyncBatch::new();
        sync.global_counts(agents_checked, &tag_counts);

        for agent in &agents {
            sync.agent(agent);

            for f in &handles_from_prefix(&keys::pub_follower_prefix(&agent.handle)) {
                sync.push(
                    crate::fastdata::follower_key(&agent.handle, f),
                    serde_json::json!({ "ts": 0 }),
                );
            }
            for f in &handles_from_prefix(&keys::pub_following_prefix(&agent.handle)) {
                sync.push(
                    crate::fastdata::following_key(&agent.handle, f),
                    serde_json::json!({ "ts": 0 }),
                );
                let edge_val = get_string(&keys::pub_edge(&agent.handle, f))
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                    .unwrap_or(serde_json::json!({ "ts": 0 }));
                sync.push(crate::fastdata::edge_key(&agent.handle, f), edge_val);
            }

            let endorsable = collect_endorsable(Some(&agent.tags), Some(&agent.capabilities));
            for (ns, ev) in &endorsable {
                let endorsers =
                    handles_from_prefix(&keys::pub_endorser_prefix(&agent.handle, ns, ev));
                let json_val = if endorsers.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::json!(endorsers)
                };
                sync.push(
                    crate::fastdata::endorsers_key(&agent.handle, ns, ev),
                    json_val,
                );
            }
        }

        sync.flush();
    }

    ok_response(serde_json::json!({
        "agents_checked": agents_checked,
        "counts_corrected": counts_corrected,
        "edges_pruned": edges_pruned,
        "endorsements_corrected": endorsements_corrected,
        "endorsement_indices_pruned": endorsement_indices_pruned,
        "orphaned_endorsements_cleaned": orphaned_endorsements_cleaned,
        "notif_entries_pruned": notif_entries_pruned,
        "near_mappings_rebuilt": near_mappings_rebuilt,
        "nonce_count": nonce_count,
        "fastdata_synced": true,
    }))
}

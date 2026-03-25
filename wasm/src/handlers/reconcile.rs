//! Admin handler for reconciling follower/following counts and sorted indices.

use crate::agent::*;
use crate::registry::{load_registry, write_sorted_indices};
use crate::require_caller;
use crate::response::*;
use crate::store::*;
use crate::types::*;
use std::collections::HashMap;

fn admin_account() -> Option<String> {
    std::env::var("OUTLAYER_ADMIN_ACCOUNT")
        .ok()
        .filter(|s| !s.is_empty())
}

pub fn handle_reconcile_all(req: &Request) -> Response {
    let caller = require_caller!(req);

    match admin_account() {
        Some(admin) if caller == admin => {}
        _ => return err_coded("AUTH_FAILED", "Unauthorized: admin access required"),
    }

    let handles = load_registry();
    let mut agents_checked: u64 = 0;
    let mut counts_corrected: u64 = 0;
    let mut near_mappings_rebuilt: u64 = 0;

    // --- Phase 1: correct per-agent counts and rebuild near mappings ---
    let mut all_tags: Vec<String> = Vec::new();
    let mut agents: Vec<AgentRecord> = Vec::new();

    for handle in &handles {
        let Some(mut agent) = load_agent(handle) else {
            continue;
        };
        agents_checked += 1;

        let actual_followers = index_list(&keys::pub_followers(&agent.handle)).len() as i64;
        let actual_following = index_list(&keys::pub_following(&agent.handle)).len() as i64;

        if agent.follower_count != actual_followers || agent.following_count != actual_following {
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

    // --- Phase 2: rebuild all sorted indices from scratch ---
    // Clear existing sorted indices
    for sort in &["followers", "endorsements", "created", "active"] {
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

    ok_response(serde_json::json!({
        "agents_checked": agents_checked,
        "counts_corrected": counts_corrected,
        "sorted_rebuilt": true,
        "near_mappings_rebuilt": near_mappings_rebuilt,
        "nonce_count": nonce_count,
    }))
}

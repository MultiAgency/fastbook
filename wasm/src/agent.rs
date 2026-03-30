//! Agent record CRUD: load, save, format, and account-to-handle resolution.

use crate::keys;
use crate::store::*;
use crate::types::*;

pub(crate) fn agent_handle_for_account(account_id: &str) -> Option<String> {
    if let Some(handle) = get_string(&keys::near_account(account_id)) {
        return Some(handle);
    }
    // Legacy key format from pre-v2 storage.  Migrates on read by writing the
    // canonical key.  Safe to remove once reconcile_all has run on all deployments.
    let handle = get_string(&format!("near:{account_id}"))?;
    let _ = set_public(&keys::near_account(account_id), handle.as_bytes());
    Some(handle)
}

pub(crate) fn load_agent(handle: &str) -> Option<AgentRecord> {
    get_json::<AgentRecord>(&keys::pub_agent(handle))
}

/// Write agent record to storage without updating sorted indices.
/// Used by deregister to update connected agents' counts — sorted indices
/// are rebuilt by ReconcileAll rather than updated per-edge during teardown.
pub(crate) fn write_agent_record(agent: &AgentRecord) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(agent).map_err(|e| AppError::Storage(e.to_string()))?;
    set_public(&keys::pub_agent(&agent.handle), &bytes)
}

pub(crate) fn save_agent(agent: &AgentRecord, before: &AgentRecord) -> Result<(), AppError> {
    use crate::registry::{replace_sorted_indices, write_sorted_indices};

    let bytes = serde_json::to_vec(agent).map_err(|e| AppError::Storage(e.to_string()))?;
    set_public(&keys::pub_agent(&agent.handle), &bytes)?;

    if before.follower_count != agent.follower_count
        || before.last_active != agent.last_active
        || before.endorsements.total_count() != agent.endorsements.total_count()
    {
        replace_sorted_indices(agent, before)?;
    } else {
        // First save (registration) — just insert, nothing to remove.
        // Also triggers if no sortable fields changed — safe because insert is idempotent.
        write_sorted_indices(agent)?;
    }
    Ok(())
}

/// Recount follower/following from index lengths and endorsements from endorser
/// indices.  Used by both heartbeat (~2% reconciliation) and admin reconcile_all.
pub(crate) fn recount_social(agent: &mut AgentRecord) {
    let handle = &agent.handle;
    agent.follower_count = index_list(&keys::pub_followers(handle)).len() as i64;
    agent.following_count = index_list(&keys::pub_following(handle)).len() as i64;

    let endorsable = crate::collect_endorsable(Some(&agent.tags), Some(&agent.capabilities));
    let mut rebuilt = Endorsements::new();
    for (ns, val) in &endorsable {
        let count = index_list(&keys::endorsers(handle, ns, val)).len() as i64;
        if count > 0 {
            rebuilt.set_count(ns, val, count);
        }
    }
    if !rebuilt.eq_counts(&agent.endorsements) {
        agent.endorsements = rebuilt;
    }
}

pub(crate) fn format_agent(agent: &AgentRecord) -> serde_json::Value {
    let endorsements = agent.endorsements.positive_only();
    serde_json::json!({
        "handle": agent.handle,
        "description": agent.description,
        "avatar_url": agent.avatar_url,
        "tags": agent.tags,
        "capabilities": agent.capabilities,
        "endorsements": endorsements,
        "platforms": agent.platforms,
        "near_account_id": agent.near_account_id,
        "follower_count": agent.follower_count,
        "following_count": agent.following_count,
        "created_at": agent.created_at,
        "last_active": agent.last_active,
    })
}

/// Lightweight agent profile for inline display (e.g. follower deltas, notifications).
/// Intentionally omits tags, capabilities, endorsements, and counts.
pub(crate) fn format_agent_summary(agent: &AgentRecord) -> serde_json::Value {
    serde_json::json!({
        "handle": agent.handle,
        "description": agent.description,
        "avatar_url": agent.avatar_url,
    })
}

pub(crate) fn format_suggestion(
    agent: &AgentRecord,
    reason: serde_json::Value,
) -> serde_json::Value {
    let mut entry = format_agent(agent);
    entry["follow_url"] = serde_json::json!(format!("/api/v1/agents/{}/follow", agent.handle));
    entry["reason"] = reason;
    entry
}

const MIN_MEANINGFUL_DESCRIPTION: usize = 10;

fn has_meaningful_capabilities(caps: &serde_json::Value) -> bool {
    caps.as_object().is_some_and(|o| !o.is_empty())
}

const WEIGHT_DESCRIPTION: u32 = 30;
const WEIGHT_TAGS: u32 = 30;
const WEIGHT_CAPABILITIES: u32 = 40;
const _: () = assert!(
    WEIGHT_DESCRIPTION + WEIGHT_TAGS + WEIGHT_CAPABILITIES == 100,
    "profile completeness weights must sum to 100"
);

pub(crate) fn profile_completeness(agent: &AgentRecord) -> u32 {
    let mut score: u32 = 0;
    if agent.description.len() > MIN_MEANINGFUL_DESCRIPTION {
        score += WEIGHT_DESCRIPTION;
    }
    if !agent.tags.is_empty() {
        score += WEIGHT_TAGS;
    }
    if has_meaningful_capabilities(&agent.capabilities) {
        score += WEIGHT_CAPABILITIES;
    }
    score
}

//! Agent record CRUD: load, save, format, and account-to-handle resolution.

use crate::keys;
use crate::store::*;
use crate::types::*;

/// Resolve account → handle, returning `None` if the mapping is absent or stale.
///
/// A mapping can become stale when a multi-step write (register, migrate_account)
/// fails partway through.  Rather than requiring every caller to handle staleness,
/// we verify here: the mapped handle must have an agent record whose
/// `near_account_id` matches.  Stale mappings are invisible to the rest of the
/// codebase.
pub(crate) fn agent_handle_for_account(account_id: &str) -> Option<(String, AgentRecord)> {
    let bytes = user_get_bytes(&keys::near_account(account_id));
    if bytes.is_empty() {
        return None;
    }
    let handle = String::from_utf8(bytes).ok()?;
    let agent = load_agent(&handle)?;
    if agent.near_account_id == account_id {
        Some((handle, agent))
    } else {
        None
    }
}

pub(crate) fn load_agent(handle: &str) -> Option<AgentRecord> {
    user_get_json::<AgentRecord>(&keys::pub_agent(handle))
}

/// Write agent record to storage without updating sorted indices.
/// Used by deregister to update connected agents' counts — sorted indices
/// are rebuilt by ReconcileAll rather than updated per-edge during teardown.
pub(crate) fn write_agent_record(agent: &AgentRecord) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(agent).map_err(|e| AppError::Storage(e.to_string()))?;
    user_set(&keys::pub_agent(&agent.handle), &bytes)
}

/// Serialize an agent to a `serde_json::Value` and the corresponding byte
/// representation.  Used by reconcile_all for bulk sync.
#[allow(dead_code)]
pub(crate) fn agent_to_value_and_bytes(
    agent: &AgentRecord,
) -> Result<(serde_json::Value, Vec<u8>), AppError> {
    let val = serde_json::to_value(agent).map_err(|e| AppError::Storage(e.to_string()))?;
    let bytes = serde_json::to_vec(&val).map_err(|e| AppError::Storage(e.to_string()))?;
    Ok((val, bytes))
}

pub(crate) fn save_agent(agent: &AgentRecord) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(agent).map_err(|e| AppError::Storage(e.to_string()))?;
    save_agent_preserialized(&bytes, agent)
}

/// Like `save_agent`, but accepts pre-serialized bytes to avoid double-
/// serialization when the caller also needs the Value for FastData sync.
/// Sorted indices are maintained by FastData KV, not OutLayer storage.
pub(crate) fn save_agent_preserialized(bytes: &[u8], agent: &AgentRecord) -> Result<(), AppError> {
    user_set(&keys::pub_agent(&agent.handle), bytes)
}

/// Recount follower/following from individual key counts and endorsements from
/// endorser prefix scans.  Used by heartbeat (~2% reconciliation) and admin
/// reconcile_all.
pub(crate) fn recount_social(agent: &mut AgentRecord) {
    let handle = &agent.handle;
    let follower_handles = handles_from_prefix(&keys::pub_follower_prefix(handle));
    let following_handles = handles_from_prefix(&keys::pub_following_prefix(handle));
    let fc = follower_handles.len() as i64;
    let gc = following_handles.len() as i64;
    agent.follower_count = fc;
    agent.following_count = gc;

    // Sync atomic counters to match actual key counts.
    let _ = user_increment(
        &keys::follower_count(handle),
        fc - user_counter(&keys::follower_count(handle)),
    );
    let _ = user_increment(
        &keys::following_count(handle),
        gc - user_counter(&keys::following_count(handle)),
    );

    // Recount mutual relationships: intersection of followers and following.
    let follower_set: std::collections::HashSet<&str> =
        follower_handles.iter().map(String::as_str).collect();
    let mc = following_handles
        .iter()
        .filter(|h| follower_set.contains(h.as_str()))
        .count() as i64;
    let _ = user_increment(
        &keys::mutual_count(handle),
        mc - user_counter(&keys::mutual_count(handle)),
    );

    let endorsable = crate::collect_endorsable(Some(&agent.tags), Some(&agent.capabilities));
    let mut rebuilt = Endorsements::new();
    for (ns, val) in &endorsable {
        let count = handles_from_prefix(&keys::pub_endorser_prefix(handle, ns, val)).len() as i64;
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

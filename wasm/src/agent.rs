//! Agent record CRUD: load, save, format, and account-to-handle resolution.

use crate::keys;
use crate::store::*;
use crate::types::*;

pub(crate) fn agent_handle_for_account(account_id: &str) -> Option<String> {
    if let Some(handle) = get_string(&keys::near_account(account_id)) {
        return Some(handle);
    }
    let handle = get_string(&format!("near:{account_id}"))?;
    let _ = set_public(&keys::near_account(account_id), handle.as_bytes());
    Some(handle)
}

pub(crate) fn load_agent(handle: &str) -> Option<AgentRecord> {
    get_json::<AgentRecord>(&keys::pub_agent(handle))
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

pub(crate) const FOLLOW_URL_FMT: &str = "/api/v1/agents/{}/follow";

pub(crate) fn format_agent(agent: &AgentRecord) -> serde_json::Value {
    let endorsements = agent.endorsements.positive_only();
    serde_json::json!({
        "handle": agent.handle,
        "display_name": agent.display_name,
        "description": agent.description,
        "avatar_url": agent.avatar_url,
        "tags": agent.tags,
        "capabilities": agent.capabilities,
        "endorsements": endorsements,
        "near_account_id": agent.near_account_id,
        "follower_count": agent.follower_count,
        "unfollow_count": agent.unfollow_count,
        "following_count": agent.following_count,
        "created_at": agent.created_at,
        "last_active": agent.last_active,
        "schema_version": agent.schema_version,
    })
}

pub(crate) fn format_suggestion(
    agent: &AgentRecord,
    reason: serde_json::Value,
) -> serde_json::Value {
    let mut entry = format_agent(agent);
    entry["follow_url"] = serde_json::json!(FOLLOW_URL_FMT.replacen("{}", &agent.handle, 1));
    entry["reason"] = reason;
    entry
}

const WEIGHT_HANDLE: u32 = 20;
const WEIGHT_NEAR_ACCOUNT: u32 = 20;
const WEIGHT_DESCRIPTION: u32 = 20;
const WEIGHT_DISPLAY_NAME: u32 = 10;
const WEIGHT_TAGS: u32 = 20;
const WEIGHT_AVATAR: u32 = 10;
const MIN_MEANINGFUL_DESCRIPTION: usize = 10;
const _: () = assert!(
    WEIGHT_HANDLE
        + WEIGHT_NEAR_ACCOUNT
        + WEIGHT_DESCRIPTION
        + WEIGHT_DISPLAY_NAME
        + WEIGHT_TAGS
        + WEIGHT_AVATAR
        == 100,
    "profile completeness weights must sum to 100"
);

pub(crate) fn profile_completeness(agent: &AgentRecord) -> u32 {
    let mut score: u32 = 0;
    if !agent.handle.is_empty() {
        score += WEIGHT_HANDLE;
    }
    if !agent.near_account_id.is_empty() {
        score += WEIGHT_NEAR_ACCOUNT;
    }
    if agent.description.len() > MIN_MEANINGFUL_DESCRIPTION {
        score += WEIGHT_DESCRIPTION;
    }
    if agent.display_name != agent.handle {
        score += WEIGHT_DISPLAY_NAME;
    }
    if !agent.tags.is_empty() {
        score += WEIGHT_TAGS;
    }
    if agent.avatar_url.is_some() {
        score += WEIGHT_AVATAR;
    }
    score
}

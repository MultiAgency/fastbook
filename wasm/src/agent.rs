use crate::keys;
use crate::types::*;
use crate::wstore::*;

// ─── Agent CRUD ───────────────────────────────────────────────────────────

pub(crate) fn agent_handle_for_account(account_id: &str) -> Option<String> {
    w_get_string(&keys::near_account(account_id))
}

pub(crate) fn load_agent(handle: &str) -> Option<AgentRecord> {
    w_get_json::<AgentRecord>(&keys::agent(handle))
}

pub(crate) fn save_agent(agent: &AgentRecord) -> Result<(), String> {
    save_agent_with_old(agent, None)
}

pub(crate) fn save_agent_with_old(agent: &AgentRecord, old: Option<&AgentRecord>) -> Result<(), String> {
    use crate::registry::{write_sorted_indices, remove_sorted_indices};

    // Remove old indices before saving (scores/timestamps may have changed)
    let loaded;
    let old_ref = match old {
        Some(o) => Some(o),
        None => { loaded = load_agent(&agent.handle); loaded.as_ref() }
    };
    if let Some(old) = old_ref {
        if trust_score(old) != trust_score(agent) || old.last_active != agent.last_active {
            remove_sorted_indices(old);
        }
    }
    w_set_json(&keys::agent(&agent.handle), agent)?;
    write_sorted_indices(agent)
}

// ─── Scoring & formatting ─────────────────────────────────────────────────

pub(crate) fn trust_score(agent: &AgentRecord) -> i64 {
    agent.follower_count - agent.unfollow_count
}

pub(crate) fn format_agent(agent: &AgentRecord) -> serde_json::Value {
    serde_json::json!({
        "handle": agent.handle,
        "displayName": agent.display_name,
        "description": agent.description,
        "avatarUrl": agent.avatar_url,
        "tags": agent.tags,
        "capabilities": agent.capabilities,
        "nearAccountId": agent.near_account_id,
        "followerCount": agent.follower_count,
        "unfollowCount": agent.unfollow_count,
        "trustScore": trust_score(agent),
        "followingCount": agent.following_count,
        "createdAt": agent.created_at,
        "lastActive": agent.last_active,
    })
}

// Profile completeness weights (out of 100).
// Core identity fields are worth 20 each; optional polish fields are worth 10.
const WEIGHT_HANDLE: u32 = 20;
const WEIGHT_NEAR_ACCOUNT: u32 = 20;
const WEIGHT_DESCRIPTION: u32 = 20;      // must be >10 chars to count
const WEIGHT_DISPLAY_NAME: u32 = 10;     // must differ from handle
const WEIGHT_TAGS: u32 = 20;
const WEIGHT_AVATAR: u32 = 10;

pub(crate) fn profile_completeness(agent: &AgentRecord) -> u32 {
    let mut score: u32 = 0;
    if !agent.handle.is_empty() { score += WEIGHT_HANDLE; }
    if !agent.near_account_id.is_empty() { score += WEIGHT_NEAR_ACCOUNT; }
    if agent.description.len() > 10 { score += WEIGHT_DESCRIPTION; }
    if agent.display_name != agent.handle { score += WEIGHT_DISPLAY_NAME; }
    if !agent.tags.is_empty() { score += WEIGHT_TAGS; }
    if agent.avatar_url.is_some() { score += WEIGHT_AVATAR; }
    score
}

/// Retry-once helper for agent count updates after follow/unfollow.
/// Applies `mutate` to the agent, saves, and retries once on conflict.
pub(crate) fn retry_agent_update(handle: &str, mutate: impl Fn(&mut AgentRecord), context: &str) {
    if let Some(old) = load_agent(handle) {
        let mut agent = old.clone();
        mutate(&mut agent);
        if let Err(e) = save_agent_with_old(&agent, Some(&old)) {
            eprintln!("Warning: {context} failed, retrying: {e}");
            if let Some(old2) = load_agent(handle) {
                let mut agent2 = old2.clone();
                mutate(&mut agent2);
                if let Err(e) = save_agent_with_old(&agent2, Some(&old2)) {
                    eprintln!("Warning: {context} failed after retry: {e}");
                }
            }
        }
    }
}

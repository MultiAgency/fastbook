//! Social graph operations: follow/unfollow edges, unfollow history, and follower deltas.

use crate::{
    agent_handle_for_account, edge_timestamp, format_agent, format_agent_summary, get_json,
    get_string, index_append, index_list, load_agent, AgentRecord, AppError,
};

pub(crate) fn parse_edge(raw: &str) -> serde_json::Value {
    if let Ok(parsed) = serde_json::from_str(raw) {
        return parsed;
    }
    if let Ok(ts) = raw.parse::<u64>() {
        return serde_json::json!({ "ts": ts });
    }
    serde_json::json!({ "ts": null })
}

pub(crate) fn format_edge(
    agent: &AgentRecord,
    edge_key: &str,
    direction: &str,
) -> serde_json::Value {
    let mut entry = format_agent(agent);
    entry["direction"] = serde_json::json!(direction);
    if let Some(raw) = get_string(edge_key) {
        let edge = parse_edge(&raw);
        entry["follow_reason"] = edge
            .get("reason")
            .cloned()
            .unwrap_or(serde_json::json!(null));
        entry["followed_at"] = edge.get("ts").cloned().unwrap_or(serde_json::json!(null));
    }
    entry
}

pub(crate) fn append_unfollow_index(handle: &str, key: &str) -> Result<(), AppError> {
    index_append(&crate::keys::unfollow_idx(handle), key)
}

pub(crate) fn append_unfollow_index_by_account(account: &str, key: &str) -> Result<(), AppError> {
    index_append(&crate::keys::unfollow_idx_by(account), key)
}

pub(crate) fn load_unfollow_history(
    idx_key: &str,
    resolve_handle: impl Fn(&[&str]) -> (String, &'static str),
) -> Vec<serde_json::Value> {
    let keys: Vec<String> = get_json(idx_key).unwrap_or_default();
    keys.iter()
        .filter_map(|key| {
            let raw = get_string(key)?;
            let mut entry = parse_edge(&raw);
            let parts: Vec<&str> = key.splitn(4, ':').collect();
            if parts.len() >= 3 {
                let (handle_val, direction) = resolve_handle(&parts);
                entry["handle"] = serde_json::json!(handle_val);
                entry["direction"] = serde_json::json!(direction);
            } else {
                return None;
            }
            Some(entry)
        })
        .collect()
}

pub(crate) fn load_unfollow_history_for(handle: &str) -> Vec<serde_json::Value> {
    load_unfollow_history(&crate::keys::unfollow_idx(handle), |parts| {
        let account = parts[1];
        let from = agent_handle_for_account(account).unwrap_or_else(|| account.to_string());
        (from, "was_unfollowed_by")
    })
}

pub(crate) fn load_unfollow_history_by(account: &str) -> Vec<serde_json::Value> {
    load_unfollow_history(&crate::keys::unfollow_idx_by(account), |parts| {
        (parts[2].to_string(), "unfollowed")
    })
}

fn handles_since(
    handles: &[String],
    since: u64,
    edge_key_fn: impl Fn(&str) -> String,
) -> Vec<String> {
    let mut result = Vec::new();
    for h in handles.iter().rev() {
        let Some(val) = get_string(&edge_key_fn(h)) else {
            continue;
        };
        let Some(ts) = edge_timestamp(&val) else {
            continue;
        };
        if ts > since {
            result.push(h.clone());
        }
    }
    result
}

fn to_agent_summaries(handles: &[String]) -> Vec<serde_json::Value> {
    handles
        .iter()
        .filter_map(|h| Some(format_agent_summary(&load_agent(h)?)))
        .collect()
}

pub(crate) fn new_followers_since(handle: &str, since: u64) -> Vec<serde_json::Value> {
    let followers = index_list(&crate::keys::pub_followers(handle));
    let recent = handles_since(&followers, since, |fh| crate::keys::pub_edge(fh, handle));
    to_agent_summaries(&recent)
}

pub(crate) fn new_following_count_since(handle: &str, since: u64) -> usize {
    let following = index_list(&crate::keys::pub_following(handle));
    handles_since(&following, since, |th| crate::keys::pub_edge(handle, th)).len()
}

pub(crate) fn new_following_since(handle: &str, since: u64) -> Vec<serde_json::Value> {
    let following = index_list(&crate::keys::pub_following(handle));
    let recent = handles_since(&following, since, |th| crate::keys::pub_edge(handle, th));
    to_agent_summaries(&recent)
}

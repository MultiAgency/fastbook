use outlayer::storage;

use crate::{
    agent_handle_for_account, edge_timestamp, format_agent, load_agent, ok_paginated, w_get_json,
    w_get_string, w_set_json, AgentRecord, Response,
};

pub fn parse_edge(raw: &str) -> serde_json::Value {
    if let Ok(parsed) = serde_json::from_str(raw) {
        return parsed;
    }
    if let Ok(ts) = raw.parse::<u64>() {
        return serde_json::json!({ "ts": ts });
    }
    eprintln!("Warning: unparseable edge value: {}", &raw[..raw.len().min(100)]);
    serde_json::json!({ "ts": null })
}

pub fn format_edge(agent: &AgentRecord, edge_key: &str, direction: &str) -> serde_json::Value {
    let mut entry = format_agent(agent);
    entry["direction"] = serde_json::json!(direction);
    if let Some(raw) = w_get_string(edge_key) {
        let edge = parse_edge(&raw);
        entry["followReason"] = edge
            .get("reason")
            .cloned()
            .unwrap_or(serde_json::json!(null));
        entry["followedAt"] = edge.get("ts").cloned().unwrap_or(serde_json::json!(null));
    }
    entry
}

pub fn paginate_json(
    items: &[serde_json::Value],
    limit: usize,
    cursor: &Option<String>,
) -> Response {
    let (page, pagination) = paginate_json_raw(items, limit, cursor);
    ok_paginated(serde_json::json!(page), limit as u32, pagination)
}

pub fn paginate_json_raw(
    items: &[serde_json::Value],
    limit: usize,
    cursor: &Option<String>,
) -> (Vec<serde_json::Value>, Option<String>) {
    let start = cursor
        .as_ref()
        .and_then(|c| {
            items
                .iter()
                .position(|a| a.get("handle").and_then(|v| v.as_str()) == Some(c))
                .map(|i| i + 1)
        })
        .unwrap_or(0);
    let page: Vec<serde_json::Value> = items.iter().skip(start).take(limit).cloned().collect();
    let next = if start + limit < items.len() {
        page.last()
            .and_then(|a| a.get("handle").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
    } else {
        None
    };
    (page, next)
}

pub fn append_to_index(idx_key: &str, key: &str) -> Result<(), String> {
    let mut idx: Vec<String> = w_get_json(idx_key).unwrap_or_default();
    idx.push(key.to_string());
    w_set_json(idx_key, &idx)
        .map_err(|e| format!("failed to update index {idx_key}: {e}"))
}

pub fn append_unfollow_index(handle: &str, key: &str) -> Result<(), String> {
    append_to_index(&crate::keys::unfollow_idx(handle), key)
}

pub fn append_unfollow_index_by_account(account: &str, key: &str) -> Result<(), String> {
    append_to_index(&crate::keys::unfollow_idx_by(account), key)
}

pub fn load_unfollow_history(
    idx_key: &str,
    resolve_handle: impl Fn(&[&str]) -> (String, &'static str),
) -> Vec<serde_json::Value> {
    let keys: Vec<String> = w_get_json(idx_key).unwrap_or_default();
    keys.iter()
        .filter_map(|key| {
            let raw = w_get_string(key)?;
            let mut entry = parse_edge(&raw);
            let parts: Vec<&str> = key.splitn(4, ':').collect();
            if parts.len() >= 3 {
                let (handle_val, direction) = resolve_handle(&parts);
                entry["handle"] = serde_json::json!(handle_val);
                entry["direction"] = serde_json::json!(direction);
            } else {
                eprintln!("Warning: skipping malformed unfollow key (expected >=3 colon-separated parts): {key}");
                return None;
            }
            Some(entry)
        })
        .collect()
}

pub fn load_unfollow_history_for(handle: &str) -> Vec<serde_json::Value> {
    load_unfollow_history(&crate::keys::unfollow_idx(handle), |parts| {
        let account = parts[1];
        let from =
            agent_handle_for_account(account).unwrap_or_else(|| account.to_string());
        (from, "was_unfollowed_by")
    })
}

pub fn load_unfollow_history_by(account: &str) -> Vec<serde_json::Value> {
    load_unfollow_history(&crate::keys::unfollow_idx_by(account), |parts| {
        (parts[2].to_string(), "unfollowed")
    })
}

/// Collect new followers since `since` for a given handle, returned as JSON summaries.
pub fn new_followers_since(handle: &str, since: u64) -> Vec<serde_json::Value> {
    let prefix = crate::keys::follower_prefix(handle);
    let keys = storage::list_keys(&prefix).unwrap_or_default();
    keys.iter()
        .filter_map(|key| {
            let follower_account = key.strip_prefix(&prefix)?;
            let val = w_get_string(key)?;
            let ts = edge_timestamp(&val)?;
            if ts <= since { return None; }
            let follower_handle = agent_handle_for_account(follower_account)?;
            let a = load_agent(&follower_handle)?;
            Some(serde_json::json!({ "handle": a.handle, "displayName": a.display_name, "description": a.description }))
        })
        .collect()
}

/// Count new following edges since `since` for the given caller account.
pub fn new_following_count_since(caller: &str, since: u64) -> usize {
    let prefix = crate::keys::following_prefix(caller);
    let keys = storage::list_keys(&prefix).unwrap_or_default();
    keys.iter()
        .filter(|key| w_get_string(key)
            .and_then(|s| edge_timestamp(&s))
            .map(|ts| ts > since).unwrap_or(false))
        .count()
}

/// Collect new following since `since` for the given caller account, returned as JSON summaries.
pub fn new_following_since(caller: &str, since: u64) -> Vec<serde_json::Value> {
    let prefix = crate::keys::following_prefix(caller);
    let keys = storage::list_keys(&prefix).unwrap_or_default();
    keys.iter()
        .filter_map(|key| {
            let target_handle = key.strip_prefix(&prefix)?;
            let val = w_get_string(key)?;
            let ts = edge_timestamp(&val)?;
            if ts <= since { return None; }
            let a = load_agent(target_handle)?;
            Some(serde_json::json!({ "handle": a.handle, "displayName": a.display_name, "description": a.description }))
        })
        .collect()
}

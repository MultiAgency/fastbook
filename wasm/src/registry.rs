use outlayer::storage;
use crate::keys;
use crate::types::*;
use crate::wstore::*;
use crate::agent::*;

// ─── Agent Registry ────────────────────────────────────────────────────────
// Uses prefix scan on "agent:" keys instead of a serialized JSON array.
// O(1) registration, O(n) for full listing (only used by suggestions fallback).

pub(crate) fn load_registry() -> Vec<String> {
    storage::list_keys("agent:")
        .unwrap_or_default()
        .into_iter()
        .filter_map(|k| {
            let handle = k.strip_prefix("agent:")?;
            if handle.is_empty() { return None; }
            if !w_has(&k) { return None; }
            Some(handle.to_string())
        })
        .collect()
}

pub(crate) fn load_all_agents() -> Vec<AgentRecord> {
    load_registry().iter().filter_map(|h| load_agent(h)).collect()
}

pub(crate) fn registry_count() -> u64 {
    match w_get_string("registry:count").and_then(|s| s.parse::<u64>().ok()) {
        Some(count) => count,
        None => {
            // Cache miss: rebuild from source and persist so this O(n) scan happens at most once.
            let count = load_registry().len() as u64;
            let _ = w_set_string("registry:count", &count.to_string());
            count
        }
    }
}

pub(crate) fn add_to_registry() -> Result<(), String> {
    let count = match w_get_string("registry:count").and_then(|s| s.parse::<u64>().ok()) {
        Some(cached) => cached + 1,
        None => load_registry().len() as u64,
    };
    w_set_string("registry:count", &count.to_string())
}

// ─── Sorted indices ───────────────────────────────────────────────────────

/// Generate the three sorted index keys for an agent.
fn sorted_index_keys(agent: &AgentRecord) -> [String; 3] {
    let inv_score = (i64::MAX / 2).saturating_sub(trust_score(agent));
    let inv_created = u64::MAX - agent.created_at;
    let inv_active = u64::MAX - agent.last_active;
    [
        keys::idx_trust(inv_score, &agent.handle),
        keys::idx_created(inv_created, &agent.handle),
        keys::idx_active(inv_active, &agent.handle),
    ]
}

/// Write sorted index entries for an agent. Called on registration and when scores change.
pub(crate) fn write_sorted_indices(agent: &AgentRecord) -> Result<(), String> {
    for key in &sorted_index_keys(agent) {
        w_set_string(key, &agent.handle)?;
    }
    Ok(())
}

/// Remove old sorted index entries before writing new ones (scores/timestamps changed).
pub(crate) fn remove_sorted_indices(agent: &AgentRecord) {
    for key in &sorted_index_keys(agent) {
        let _ = w_delete(key);
    }
}

/// Load agents using sorted index prefix scan. Returns (agents, next_cursor).
pub(crate) fn load_agents_sorted(
    sort: &str,
    limit: usize,
    cursor: &Option<String>,
    filter: impl Fn(&AgentRecord) -> bool,
) -> Result<(Vec<AgentRecord>, Option<String>), String> {
    let prefix = match sort {
        "followers" => "idx:by_trust:",
        "newest" => "idx:by_created:",
        "active" => "idx:by_active:",
        _ => return Err("Invalid sort: use followers, newest, or active".to_string()),
    };

    let keys = storage::list_keys(prefix).map_err(|e| e.to_string())?;

    // If index is empty, fall back to legacy load_all_agents path
    if keys.is_empty() {
        let mut agents = load_all_agents();
        match sort {
            "followers" => agents.sort_by_key(|b| std::cmp::Reverse(trust_score(b))),
            "newest" => agents.sort_by(|a, b| b.created_at.cmp(&a.created_at)),
            "active" => agents.sort_by(|a, b| b.last_active.cmp(&a.last_active)),
            _ => {}
        }
        let filtered: Vec<AgentRecord> = agents.into_iter().filter(|a| filter(a)).collect();
        let take = limit + 1;
        let start = cursor.as_ref().and_then(|c| filtered.iter().position(|a| a.handle == *c).map(|i| i + 1)).unwrap_or(0);
        let page: Vec<AgentRecord> = filtered.into_iter().skip(start).take(take).collect();
        let next = if page.len() > limit { Some(page[limit].handle.clone()) } else { None };
        let result: Vec<AgentRecord> = page.into_iter().take(limit).collect();
        return Ok((result, next));
    }

    // Keys are already sorted lexicographically (descending by score/time due to inversion)
    let mut past_cursor = cursor.is_none();
    let mut agents = Vec::with_capacity(limit + 1);

    for key in &keys {
        let handle = match key.rsplit(':').next() {
            Some(h) => h,
            None => continue,
        };

        if !past_cursor {
            if cursor.as_deref() == Some(handle) {
                past_cursor = true;
            }
            continue;
        }

        if let Some(agent) = load_agent(handle) {
            if filter(&agent) {
                agents.push(agent);
                if agents.len() > limit {
                    break;
                }
            }
        }
    }

    let next = if agents.len() > limit {
        Some(agents[limit].handle.clone())
    } else {
        None
    };
    agents.truncate(limit);
    Ok((agents, next))
}

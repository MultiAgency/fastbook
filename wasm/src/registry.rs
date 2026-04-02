//! Agent registry: tag counts and paginated listing queries.
//!
//! Sorted indices for public reads are maintained by FastData KV, not OutLayer
//! storage. The `load_agents_by_followers` function loads all agents and sorts
//! in-memory — acceptable at current scale (hundreds of agents).

use crate::agent::*;
use crate::keys;
use crate::store::*;
use crate::types::*;
use std::collections::HashMap;

pub(crate) fn load_registry() -> Vec<String> {
    handles_from_prefix(keys::pub_agent_reg_prefix())
}

#[cfg(test)]
pub(crate) fn registry_count() -> u64 {
    get_user_string(keys::pub_meta_count())
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| handles_from_prefix(keys::pub_agent_reg_prefix()).len() as u64)
}

pub(crate) fn load_agents_by_followers(
    limit: usize,
    cursor: &Option<String>,
    filter: impl Fn(&AgentRecord) -> bool,
) -> Result<(Vec<AgentRecord>, Option<String>), AppError> {
    let mut agents: Vec<AgentRecord> = load_registry()
        .iter()
        .filter_map(|h| load_agent(h))
        .collect();

    agents.sort_by_key(|a| std::cmp::Reverse(a.follower_count));

    let filtered: Vec<AgentRecord> = agents.into_iter().filter(|a| filter(a)).collect();
    let take = limit + 1;
    let start = cursor
        .as_ref()
        .and_then(|c| filtered.iter().position(|a| a.handle == *c).map(|i| i + 1))
        .unwrap_or(0);
    let page: Vec<AgentRecord> = filtered.into_iter().skip(start).take(take).collect();
    let next = if page.len() > limit {
        Some(page[limit - 1].handle.clone())
    } else {
        None
    };
    let result: Vec<AgentRecord> = page.into_iter().take(limit).collect();
    Ok((result, next))
}

fn load_tag_counts() -> Option<HashMap<String, u32>> {
    get_json::<HashMap<String, u32>>(keys::pub_tag_counts())
}

fn persist_tag_counts(counts: &HashMap<String, u32>) {
    if let Ok(bytes) = serde_json::to_vec(counts) {
        let _ = set_public(keys::pub_tag_counts(), &bytes);
    }
}

pub(crate) fn update_tag_counts(old_tags: &[String], new_tags: &[String]) {
    if old_tags == new_tags {
        return;
    }
    let mut counts = load_tag_counts().unwrap_or_default();
    for tag in old_tags {
        if let Some(c) = counts.get_mut(tag) {
            *c = c.saturating_sub(1);
            if *c == 0 {
                counts.remove(tag);
            }
        }
    }
    for tag in new_tags {
        let c = counts.entry(tag.clone()).or_insert(0);
        *c = c.saturating_add(1);
    }
    persist_tag_counts(&counts);
}

// ---------------------------------------------------------------------------
// Social graph queries: follower/following deltas since a given timestamp.
// ---------------------------------------------------------------------------

fn handles_since(
    handles: &[String],
    since: u64,
    edge_key_fn: impl Fn(&str) -> String,
) -> Vec<String> {
    let mut result = Vec::new();
    for h in handles.iter().rev() {
        let bytes = user_get_bytes(&edge_key_fn(h));
        if bytes.is_empty() {
            continue;
        }
        let Ok(val) = String::from_utf8(bytes) else {
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
    let followers = handles_from_prefix(&keys::pub_follower_prefix(handle));
    let recent = handles_since(&followers, since, |fh| keys::pub_edge(fh, handle));
    to_agent_summaries(&recent)
}

pub(crate) fn new_following_count_since(handle: &str, since: u64) -> usize {
    let following = handles_from_prefix(&keys::pub_following_prefix(handle));
    handles_since(&following, since, |th| keys::pub_edge(handle, th)).len()
}

pub(crate) fn new_following_since(handle: &str, since: u64) -> Vec<serde_json::Value> {
    let following = handles_from_prefix(&keys::pub_following_prefix(handle));
    let recent = handles_since(&following, since, |th| keys::pub_edge(handle, th));
    to_agent_summaries(&recent)
}

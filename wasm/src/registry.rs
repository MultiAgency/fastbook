//! Agent registry: tag counts and social graph queries.

use crate::keys;
use crate::store::*;
use std::collections::HashMap;

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
// Used by tests/graph.rs only — production reads go through FastData KV.
// ---------------------------------------------------------------------------

#[cfg(test)]
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

#[cfg(test)]
fn to_agent_summaries(handles: &[String]) -> Vec<serde_json::Value> {
    use crate::agent::{format_agent_summary, load_agent};
    handles
        .iter()
        .filter_map(|h| Some(format_agent_summary(&load_agent(h)?)))
        .collect()
}

#[cfg(test)]
pub(crate) fn new_followers_since(handle: &str, since: u64) -> Vec<serde_json::Value> {
    let followers = handles_from_prefix(&keys::pub_follower_prefix(handle));
    let recent = handles_since(&followers, since, |fh| keys::pub_edge(fh, handle));
    to_agent_summaries(&recent)
}

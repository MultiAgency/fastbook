//! Agent registry: sorted indices, tag counts, and paginated listing queries.

use crate::agent::*;
use crate::keys;
use crate::store::*;
use crate::types::*;
use std::collections::HashMap;

pub(crate) fn load_registry() -> Vec<String> {
    index_list(keys::pub_agents())
}

/// Cold-start bootstrap: loads every agent record by iterating the registry.
/// After the first reconciliation, sorted indices and tag counts exist,
/// so the callers (`load_agents_sorted`, `list_tags`) never hit this path.
pub(crate) fn load_all_agents() -> Vec<AgentRecord> {
    load_registry()
        .iter()
        .filter_map(|h| load_agent(h))
        .collect()
}

pub(crate) fn registry_count() -> u64 {
    get_string(keys::pub_meta_count())
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| index_list(keys::pub_agents()).len() as u64)
}

pub(crate) fn add_to_registry(handle: &str) -> Result<(), AppError> {
    // Read the index once, append, write back, and derive count from the
    // same Vec — avoids a second index_list read (saves one storage I/O).
    let mut idx = index_list(keys::pub_agents());
    if !idx.iter().any(|e| e == handle) {
        idx.push(handle.to_string());
        let bytes = serde_json::to_vec(&idx).map_err(|e| AppError::Storage(e.to_string()))?;
        set_public(keys::pub_agents(), &bytes)?;
    }
    let count_bytes = idx.len().to_string();
    set_public(keys::pub_meta_count(), count_bytes.as_bytes())
}

fn sorted_entries(agent: &AgentRecord) -> [(String, String); 4] {
    let inv_followers = (i64::MAX / 2).saturating_sub(agent.follower_count);
    let inv_endorsed = (i64::MAX / 2).saturating_sub(agent.endorsements.total_count());
    let inv_created = u64::MAX - agent.created_at;
    let inv_active = u64::MAX - agent.last_active;
    [
        (
            keys::pub_sorted("followers"),
            format!("{inv_followers:020}:{}", agent.handle),
        ),
        (
            keys::pub_sorted("endorsements"),
            format!("{inv_endorsed:020}:{}", agent.handle),
        ),
        (
            keys::pub_sorted("newest"),
            format!("{inv_created:020}:{}", agent.handle),
        ),
        (
            keys::pub_sorted("active"),
            format!("{inv_active:020}:{}", agent.handle),
        ),
    ]
}

pub(crate) fn write_sorted_indices(agent: &AgentRecord) -> Result<(), AppError> {
    for (key, entry) in &sorted_entries(agent) {
        index_insert_sorted(key, entry)?;
    }
    Ok(())
}

pub(crate) fn remove_sorted_indices(agent: &AgentRecord) {
    for (key, entry) in &sorted_entries(agent) {
        let _ = index_remove_sorted(key, entry);
    }
}

pub(crate) fn replace_sorted_indices(new: &AgentRecord, old: &AgentRecord) -> Result<(), AppError> {
    let old_entries = sorted_entries(old);
    let new_entries = sorted_entries(new);
    for ((key, old_e), (_, new_e)) in old_entries.iter().zip(new_entries.iter()) {
        index_replace_sorted(key, old_e, new_e)?;
    }
    Ok(())
}

#[derive(Clone, Copy)]
pub(crate) enum SortKey {
    Followers,
    Endorsements,
    Newest,
    Active,
}

impl SortKey {
    pub fn parse(s: &str) -> Result<Self, AppError> {
        match s {
            "followers" => Ok(Self::Followers),
            "endorsements" => Ok(Self::Endorsements),
            "newest" => Ok(Self::Newest),
            "active" => Ok(Self::Active),
            _ => Err(AppError::Validation(
                "Invalid sort: use followers, endorsements, newest, or active".to_string(),
            )),
        }
    }
    fn index_key(self) -> &'static str {
        match self {
            Self::Followers => "followers",
            Self::Endorsements => "endorsements",
            Self::Newest => "newest",
            Self::Active => "active",
        }
    }
}

pub(crate) fn load_agents_sorted(
    sort: SortKey,
    limit: usize,
    cursor: &Option<String>,
    filter: impl Fn(&AgentRecord) -> bool,
) -> Result<(Vec<AgentRecord>, Option<String>), AppError> {
    let sort_key = sort.index_key();

    let entries = index_list(&keys::pub_sorted(sort_key));

    if entries.is_empty() {
        // Cold-start fallback: sorted indices are empty before the first
        // `reconcile_all` run.  This in-memory sort is O(n) in agent count
        // and should only fire on initial deployment.  Run `reconcile_all`
        // (admin action) after deploy to populate sorted indices.
        let mut agents = load_all_agents();
        match sort {
            SortKey::Followers => agents.sort_by_key(|a| std::cmp::Reverse(a.follower_count)),
            SortKey::Endorsements => {
                agents.sort_by_key(|a| std::cmp::Reverse(a.endorsements.total_count()))
            }
            SortKey::Newest => agents.sort_by(|a, b| b.created_at.cmp(&a.created_at)),
            SortKey::Active => agents.sort_by(|a, b| b.last_active.cmp(&a.last_active)),
        }
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
        return Ok((result, next));
    }

    let mut past_cursor = cursor.is_none();
    let mut agents = Vec::with_capacity(limit + 1);

    for entry in &entries {
        let Some(handle) = entry.rsplit(':').next() else {
            continue;
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
        Some(agents[limit - 1].handle.clone())
    } else {
        None
    };
    agents.truncate(limit);
    Ok((agents, next))
}

fn load_tag_counts() -> Option<HashMap<String, u32>> {
    get_json::<HashMap<String, u32>>(keys::pub_tag_counts())
}

fn persist_tag_counts(counts: &HashMap<String, u32>) {
    if let Ok(bytes) = serde_json::to_vec(counts) {
        let _ = set_public(keys::pub_tag_counts(), &bytes);
    }
}

fn sorted_tag_vec(counts: HashMap<String, u32>) -> Vec<(String, u32)> {
    let mut tags: Vec<_> = counts.into_iter().collect();
    tags.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    tags
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

pub(crate) fn list_tags() -> Vec<(String, u32)> {
    if let Some(counts) = load_tag_counts() {
        return sorted_tag_vec(counts);
    }
    let mut rebuilt = HashMap::new();
    for agent in load_all_agents() {
        for tag in &agent.tags {
            *rebuilt.entry(tag.clone()).or_insert(0u32) += 1;
        }
    }
    persist_tag_counts(&rebuilt);
    sorted_tag_vec(rebuilt)
}

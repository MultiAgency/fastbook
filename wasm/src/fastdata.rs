//! Sync public state to FastData KV via `__fastdata_kv` NEAR calls.
//!
//! Feature-gated: if the `FASTDATA_NAMESPACE` env var is absent, all sync
//! operations are no-ops. This allows incremental rollout and keeps tests
//! working without mocking RPC.

use crate::types::AgentRecord;
use std::collections::HashMap;

/// Read FastData config from env. Returns None if not configured (no-op mode).
#[cfg(not(test))]
fn config() -> Option<(String, String, String)> {
    let namespace = std::env::var("FASTDATA_NAMESPACE").ok()?;
    let signer_id = std::env::var("FASTDATA_SIGNER_ID").ok()?;
    let signer_key = std::env::var("FASTDATA_SIGNER_KEY").ok()?;
    Some((namespace, signer_id, signer_key))
}

/// Sync one or more key-value pairs to FastData KV.
///
/// Each `(key, value)` becomes a root-level entry in the `__fastdata_kv` JSON
/// argument. Keys may contain slashes for prefix-scan support.
///
/// Max 256 keys per call (FastData KV limit).
///
/// Returns `Ok(tx_hash)` on success, `Err(error_string)` on failure.
/// Callers should log errors but not fail the request — OutLayer storage
/// is the source of truth and `reconcile_all` repairs divergence.
#[cfg(not(test))]
pub(crate) fn sync<K: AsRef<str>>(entries: &[(K, serde_json::Value)]) -> Result<String, String> {
    let Some((namespace, signer_id, signer_key)) = config() else {
        return Ok(String::new()); // no-op: not configured
    };

    if entries.is_empty() {
        return Ok(String::new());
    }

    let mut obj = serde_json::Map::new();
    for (key, value) in entries {
        obj.insert(key.as_ref().to_string(), value.clone());
    }
    let args_json = serde_json::Value::Object(obj).to_string();

    let (tx_hash, error) = outlayer::raw::rpc::call(
        &signer_id,
        &signer_key,
        &namespace,
        "__fastdata_kv",
        &args_json,
        "0",
        "30000000000000", // 30 TGas
        "NONE",           // fire-and-forget: don't block on execution confirmation
    );

    if error.is_empty() {
        Ok(tx_hash)
    } else {
        Err(error)
    }
}

/// Test stub: no-op.
#[cfg(test)]
pub(crate) fn sync<K: AsRef<str>>(entries: &[(K, serde_json::Value)]) -> Result<String, String> {
    let _ = entries;
    Ok(String::new())
}

// ---------------------------------------------------------------------------
// Key helpers: map OutLayer pub: keys to FastData KV keys (with slashes)
// ---------------------------------------------------------------------------

pub(crate) fn agent_key(handle: &str) -> String {
    format!("agent/{handle}")
}

pub(crate) fn follower_key(target: &str, follower: &str) -> String {
    format!("follower/{target}/{follower}")
}

pub(crate) fn following_key(caller: &str, target: &str) -> String {
    format!("following/{caller}/{target}")
}

pub(crate) fn edge_key(from: &str, to: &str) -> String {
    format!("edge/{from}/{to}")
}

pub(crate) fn endorsers_key(target: &str, ns: &str, value: &str) -> String {
    format!("endorsers/{target}/{ns}/{value}")
}

// ---------------------------------------------------------------------------
// Sorted score entries: individual keys for O(1) writes, prefix-scan reads
// ---------------------------------------------------------------------------

/// Build sorted entries with handle-keyed FastData keys for O(1) writes.
pub(crate) fn sorted_entry_pairs(agent: &AgentRecord) -> Vec<(String, serde_json::Value)> {
    vec![
        (
            format!("sorted/followers/{}", agent.handle),
            serde_json::json!({ "score": agent.follower_count }),
        ),
        (
            format!("sorted/endorsements/{}", agent.handle),
            serde_json::json!({ "score": agent.endorsements.total_count() }),
        ),
        (
            format!("sorted/newest/{}", agent.handle),
            serde_json::json!({ "ts": agent.created_at }),
        ),
        (
            format!("sorted/active/{}", agent.handle),
            serde_json::json!({ "ts": agent.last_active }),
        ),
    ]
}

/// Build agent key + sorted index entries for a single agent.
/// Combines `agent_key` + serialized record + `sorted_entry_pairs` + tag-sorted entries.
pub(crate) fn agent_entries(agent: &AgentRecord) -> Vec<(String, serde_json::Value)> {
    let mut entries = vec![(
        agent_key(&agent.handle),
        serde_json::to_value(agent).unwrap_or_default(),
    )];
    entries.extend(sorted_entry_pairs(agent));
    entries.extend(tag_sorted_entries(agent));
    entries
}

/// Per-tag sorted entries: one key per tag with the same score as `sorted/followers/`.
pub(crate) fn tag_sorted_entries(agent: &AgentRecord) -> Vec<(String, serde_json::Value)> {
    agent
        .tags
        .iter()
        .map(|tag| {
            (
                format!("sorted/followers/tag:{}/{}", tag, agent.handle),
                serde_json::json!({ "score": agent.follower_count }),
            )
        })
        .collect()
}

/// Max keys per `__fastdata_kv` call (FastData KV limit).
const MAX_KEYS_PER_CALL: usize = 256;

/// Sync owned-key entries and log. Automatically chunks into batches of 256
/// keys to respect the FastData KV limit. Callers never need to chunk manually.
pub(crate) fn sync_and_log(entries: &[(String, serde_json::Value)]) -> Option<String> {
    if entries.len() <= MAX_KEYS_PER_CALL {
        return log_sync_result(sync(entries));
    }
    let mut last_warning = None;
    for chunk in entries.chunks(MAX_KEYS_PER_CALL) {
        if let Some(w) = log_sync_result(sync(chunk)) {
            last_warning = Some(w);
        }
    }
    last_warning
}

/// Log a sync error as a warning. Returns the warning string if sync failed.
pub(crate) fn log_sync_result(result: Result<String, String>) -> Option<String> {
    match result {
        Ok(_) => None,
        Err(e) => {
            eprintln!("[fastdata] sync failed: {e}");
            Some(format!("fastdata_sync: {e}"))
        }
    }
}

// ---------------------------------------------------------------------------
// SyncBatch: builder for FastData KV sync payloads
// ---------------------------------------------------------------------------

pub(crate) struct SyncBatch(Vec<(String, serde_json::Value)>);

impl SyncBatch {
    pub fn new() -> Self {
        Self(Vec::new())
    }

    /// Add agent profile + sorted index entries (re-serializes the agent).
    pub fn agent(&mut self, agent: &AgentRecord) {
        self.0.extend(agent_entries(agent));
    }

    /// Add global meta: agent count + tag counts.
    pub fn global_counts(&mut self, count: u64, tag_counts: &HashMap<String, u32>) {
        self.0
            .push(("meta/agent_count".into(), serde_json::json!(count)));
        self.0
            .push(("tag_counts".into(), serde_json::json!(tag_counts)));
    }

    /// Add a raw key-value entry.
    pub fn push(&mut self, key: String, val: serde_json::Value) {
        self.0.push((key, val));
    }

    /// Sync all entries to FastData KV. Returns a warning string on failure.
    pub fn flush(self) -> Option<String> {
        sync_and_log(&self.0)
    }
}

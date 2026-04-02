//! Storage abstraction: key-value wrappers, index operations, and storage key definitions.
//!
//! # Concurrency model
//!
//! All **public** data (`pub:` keys) uses individual atomic key-value writes
//! and is TOCTOU-safe regardless of execution model.
//!
//! Auxiliary index operations (`index_append`, `prune_index`) on non-pub keys
//! (nonce_idx, notif_idx) are read-modify-write
//! cycles that are **not** atomic at the storage layer.  Correctness depends on
//! OutLayer serialising WASM executions per project.  If OutLayer ever allows
//! parallel execution, these auxiliary RMW operations must be replaced with
//! compare-and-swap or host-level atomic list primitives.
//!
//! [`set_if_absent`] delegates to the host's atomic set-if-absent and is safe
//! regardless of the execution model.

#[cfg(not(test))]
use outlayer::storage as backend;
use serde::Serialize;
#[cfg(test)]
use test_backend as backend;

use crate::types::AppError;

pub(crate) const NANOS_PER_SEC: u64 = 1_000_000_000;

#[cfg(test)]
pub(crate) mod test_backend {
    use std::cell::RefCell;
    use std::collections::HashMap;

    thread_local! {
        /// Worker-scoped storage (auxiliary indices: notifications, rate limits, etc.).
        static STORE: RefCell<HashMap<String, Vec<u8>>> = RefCell::new(HashMap::new());
        /// User-scoped storage (all pub: keys, atomic counters, nonces).
        static USER_STORE: RefCell<HashMap<String, Vec<u8>>> = RefCell::new(HashMap::new());
        static FAIL_NEXT: RefCell<u32> = const { RefCell::new(0) };
        static SUCCEED_THEN_FAIL: RefCell<Option<(u32, u32)>> = const { RefCell::new(None) };
    }

    pub fn clear() {
        STORE.with(|s| s.borrow_mut().clear());
        USER_STORE.with(|s| s.borrow_mut().clear());
        FAIL_NEXT.with(|f| *f.borrow_mut() = 0);
        SUCCEED_THEN_FAIL.with(|s| *s.borrow_mut() = None);
    }

    pub fn fail_next_writes(n: u32) {
        FAIL_NEXT.with(|f| *f.borrow_mut() = n);
    }

    /// Let `n` writes succeed, then fail the next `fail_count` writes.
    /// Pass `None` to disable.
    pub fn fail_after_writes(n: Option<u32>, fail_count: u32) {
        SUCCEED_THEN_FAIL.with(|s| *s.borrow_mut() = n.map(|n| (n, fail_count)));
    }

    fn check_fail_injection() -> bool {
        SUCCEED_THEN_FAIL.with(|s| {
            let mut opt = s.borrow_mut();
            if let Some(ref mut pair) = *opt {
                if pair.0 > 0 {
                    pair.0 -= 1;
                    false
                } else if pair.1 > 0 {
                    pair.1 -= 1;
                    true
                } else {
                    *opt = None;
                    false
                }
            } else {
                false
            }
        }) || FAIL_NEXT.with(|f| {
            let mut count = f.borrow_mut();
            if *count > 0 {
                *count -= 1;
                true
            } else {
                false
            }
        })
    }

    pub fn set_worker(key: &str, value: &[u8]) -> Result<(), outlayer::storage::StorageError> {
        if check_fail_injection() {
            return Err(outlayer::storage::StorageError(
                "injected test failure".into(),
            ));
        }
        STORE.with(|s| s.borrow_mut().insert(key.to_string(), value.to_vec()));
        Ok(())
    }

    pub fn get_worker(key: &str) -> Result<Option<Vec<u8>>, outlayer::storage::StorageError> {
        Ok(STORE.with(|s| s.borrow().get(key).cloned()))
    }

    /// Assert that a pub: key exists (or doesn't) in user-scoped storage.
    pub fn assert_scope(key: &str, expect_present: bool) {
        let found = user_has(key);
        assert_eq!(
            found,
            expect_present,
            "Scope check for key {key:?}: expected {}, found {}",
            if expect_present { "present" } else { "absent" },
            if found { "present" } else { "absent" },
        );
    }

    // --- User-scoped storage (atomic set_if_absent for nonce replay) ---

    pub fn user_set_if_absent(
        key: &str,
        value: &[u8],
    ) -> Result<bool, outlayer::storage::StorageError> {
        if check_fail_injection() {
            return Err(outlayer::storage::StorageError(
                "injected test failure".into(),
            ));
        }
        USER_STORE.with(|s| {
            let mut store = s.borrow_mut();
            if store.contains_key(key) {
                Ok(false)
            } else {
                store.insert(key.to_string(), value.to_vec());
                Ok(true)
            }
        })
    }

    pub fn user_get(key: &str) -> Result<Option<Vec<u8>>, outlayer::storage::StorageError> {
        Ok(USER_STORE.with(|s| s.borrow().get(key).cloned()))
    }

    pub fn user_delete(key: &str) -> bool {
        USER_STORE.with(|s| s.borrow_mut().remove(key).is_some())
    }

    pub fn user_set(key: &str, value: &[u8]) -> Result<(), outlayer::storage::StorageError> {
        if check_fail_injection() {
            return Err(outlayer::storage::StorageError(
                "injected test failure".into(),
            ));
        }
        USER_STORE.with(|s| s.borrow_mut().insert(key.to_string(), value.to_vec()));
        Ok(())
    }

    pub fn user_has(key: &str) -> bool {
        USER_STORE.with(|s| s.borrow().get(key).map(|v| !v.is_empty()).unwrap_or(false))
    }

    pub fn user_list_keys(prefix: &str) -> Result<Vec<String>, outlayer::storage::StorageError> {
        Ok(USER_STORE.with(|s| {
            let store = s.borrow();
            let mut keys: Vec<String> = store
                .keys()
                .filter(|k| k.starts_with(prefix))
                .cloned()
                .collect();
            keys.sort();
            keys
        }))
    }

    pub fn user_increment(key: &str, delta: i64) -> Result<i64, outlayer::storage::StorageError> {
        if check_fail_injection() {
            return Err(outlayer::storage::StorageError(
                "injected test failure".into(),
            ));
        }
        USER_STORE.with(|s| {
            let mut store = s.borrow_mut();
            let current = store
                .get(key)
                .and_then(|v| String::from_utf8(v.clone()).ok())
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0);
            let new_val = current + delta;
            store.insert(key.to_string(), new_val.to_string().into_bytes());
            Ok(new_val)
        })
    }

    // Wrappers matching outlayer::storage names so cfg-aliased `backend` works.
    pub fn set(key: &str, value: &[u8]) -> Result<(), outlayer::storage::StorageError> {
        user_set(key, value)
    }
    pub fn get(key: &str) -> Result<Option<Vec<u8>>, outlayer::storage::StorageError> {
        user_get(key)
    }
    pub fn has(key: &str) -> bool {
        user_has(key)
    }
    pub fn delete(key: &str) -> bool {
        user_delete(key)
    }
    pub fn set_if_absent(key: &str, value: &[u8]) -> Result<bool, outlayer::storage::StorageError> {
        user_set_if_absent(key, value)
    }
    pub fn list_keys(prefix: &str) -> Result<Vec<String>, outlayer::storage::StorageError> {
        user_list_keys(prefix)
    }
    pub fn increment(key: &str, delta: i64) -> Result<i64, outlayer::storage::StorageError> {
        user_increment(key, delta)
    }
}

/// Storage key schema (all colon-delimited):
///
/// User-scoped (pub: prefix — atomic, TOCTOU-safe):
///   pub:agent:{handle}                            — full AgentRecord JSON
///   pub:agent_reg:{handle}                        — registry marker (value = "1")
///   pub:follower:{target}:{follower}              — follower edge marker
///   pub:following:{caller}:{target}               — following edge marker
///   pub:edge:{from}:follows:{to}                  — edge with timestamp
///   pub:cnt:followers:{handle}                    — atomic follower counter
///   pub:cnt:following:{handle}                    — atomic following counter
///   pub:meta:agent_count                          — total registered agents
///   pub:tag_counts                                — HashMap<tag, count> JSON
///   pub:near:{account_id}                         — account → handle mapping
///       Can become stale after partial failures; `agent_handle_for_account()`
///       verifies the agent record before returning, so stale mappings are
///       invisible to callers.
///   pub:endorsement:{target}:{ns}:{value}:{from}  — endorsement record
///   pub:endorser:{target}:{ns}:{value}:{from}     — endorser marker
///   pub:endorsement_by:{from}:{target}:{ns}:{val} — reverse lookup
///   pub:endorsed_target:{from}:{target}            — "from endorsed target" flag
///   pub:notif_dedup:{target}:{type}:{from}        — notification dedup marker (timestamp)
///
/// Worker-scoped (auxiliary, RMW — requires serialised execution):
///   nonce:{nonce_val}          — replay-protection marker (user-scoped atomic)
///   nonce_idx                  — JSON array of active nonce keys
///   notif:{handle}:{ts}:{type}:{from} — notification record
///   notif_idx:{handle}         — JSON array of notification keys
///   notif_read:{handle}        — last-read timestamp
///   rate:{action}:{caller}     — rate-limit window:count
pub mod keys {
    pub fn pub_agent(handle: &str) -> String {
        format!("pub:agent:{handle}")
    }
    pub fn pub_agent_reg(handle: &str) -> String {
        format!("pub:agent_reg:{handle}")
    }
    pub fn pub_agent_reg_prefix() -> &'static str {
        "pub:agent_reg:"
    }

    pub fn pub_follower(target: &str, follower: &str) -> String {
        format!("pub:follower:{target}:{follower}")
    }
    pub fn pub_follower_prefix(handle: &str) -> String {
        format!("pub:follower:{handle}:")
    }
    pub fn pub_following_key(caller: &str, target: &str) -> String {
        format!("pub:following:{caller}:{target}")
    }
    pub fn pub_following_prefix(handle: &str) -> String {
        format!("pub:following:{handle}:")
    }
    pub fn pub_edge(from: &str, to: &str) -> String {
        format!("pub:edge:{from}:follows:{to}")
    }

    pub fn follower_count(handle: &str) -> String {
        format!("pub:cnt:followers:{handle}")
    }
    pub fn following_count(handle: &str) -> String {
        format!("pub:cnt:following:{handle}")
    }
    pub fn mutual_count(handle: &str) -> String {
        format!("pub:cnt:mutual:{handle}")
    }

    pub fn pub_meta_count() -> &'static str {
        "pub:meta:agent_count"
    }
    pub fn pub_tag_counts() -> &'static str {
        "pub:tag_counts"
    }
    pub fn near_account(account_id: &str) -> String {
        format!("pub:near:{account_id}")
    }

    pub fn endorsement(target: &str, ns: &str, value: &str, from: &str) -> String {
        format!("pub:endorsement:{target}:{ns}:{value}:{from}")
    }
    pub fn pub_endorser(target: &str, ns: &str, value: &str, from: &str) -> String {
        format!("pub:endorser:{target}:{ns}:{value}:{from}")
    }
    pub fn pub_endorser_prefix(target: &str, ns: &str, value: &str) -> String {
        format!("pub:endorser:{target}:{ns}:{value}:")
    }
    pub fn pub_endorsement_by(from: &str, target: &str, ns: &str, value: &str) -> String {
        format!("pub:endorsement_by:{from}:{target}:{ns}:{value}")
    }
    pub fn pub_endorsement_by_prefix(from: &str, target: &str) -> String {
        format!("pub:endorsement_by:{from}:{target}:")
    }
    pub fn pub_endorsed_target(from: &str, target: &str) -> String {
        format!("pub:endorsed_target:{from}:{target}")
    }
    pub fn pub_endorsed_target_prefix(from: &str) -> String {
        format!("pub:endorsed_target:{from}:")
    }

    pub fn nonce(nonce_val: &str) -> String {
        format!("nonce:{nonce_val}")
    }
    pub fn nonce_idx() -> &'static str {
        "nonce_idx"
    }
    pub fn notif(handle: &str, ts: u64, notif_type: &str, from: &str) -> String {
        format!("notif:{handle}:{ts}:{notif_type}:{from}")
    }
    pub fn notif_idx(handle: &str) -> String {
        format!("notif_idx:{handle}")
    }
    pub fn notif_read(handle: &str) -> String {
        format!("notif_read:{handle}")
    }
    pub fn rate(action: &str, caller: &str) -> String {
        format!("rate:{action}:{caller}")
    }
    pub fn notif_dedup(target: &str, notif_type: &str, from: &str) -> String {
        format!("pub:notif_dedup:{target}:{notif_type}:{from}")
    }
}

fn backend_set(key: &str, val: &[u8]) -> Result<(), AppError> {
    backend::set_worker(key, val).map_err(|e| AppError::Storage(e.to_string()))
}

fn backend_get(key: &str) -> Result<Option<Vec<u8>>, AppError> {
    backend::get_worker(key).map_err(|e| AppError::Storage(e.to_string()))
}

pub(crate) fn set_string(key: &str, val: &str) -> Result<(), AppError> {
    backend_set(key, val.as_bytes())
}

/// Scope-routed read: `pub:` keys read from user scope, others from worker scope.
/// Returns `None` for missing keys or empty values.
fn read_scoped(key: &str) -> Option<Vec<u8>> {
    if key.starts_with("pub:") {
        let b = user_get_bytes(key);
        if b.is_empty() {
            None
        } else {
            Some(b)
        }
    } else {
        backend_get(key).ok().flatten().filter(|b| !b.is_empty())
    }
}

pub(crate) fn get_string(key: &str) -> Option<String> {
    read_scoped(key).and_then(|b| String::from_utf8(b).ok())
}

/// Read from user-scoped storage (used for nonce replay markers).
pub(crate) fn get_user_string(key: &str) -> Option<String> {
    backend::get(key)
        .ok()
        .flatten()
        .filter(|b| !b.is_empty())
        .and_then(|b| String::from_utf8(b).ok())
}

/// Delete from user-scoped storage (used for nonce GC).
pub(crate) fn delete_user(key: &str) {
    backend::delete(key);
}

pub(crate) fn set_json<T: Serialize>(key: &str, val: &T) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(val).map_err(|e| AppError::Storage(e.to_string()))?;
    backend_set(key, &bytes)
}

pub(crate) fn get_json<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    read_scoped(key).and_then(|b| serde_json::from_slice(&b).ok())
}

/// Write to public storage. Now routes to user scope for all pub: keys.
pub(crate) fn set_public(key: &str, val: &[u8]) -> Result<(), AppError> {
    user_set(key, val)
}

#[cfg(test)]
pub(crate) fn get_bytes(key: &str) -> Vec<u8> {
    read_scoped(key).unwrap_or_default()
}

/// Check key existence. For `pub:` keys, checks user scope (where new data lives).
/// Falls back to worker scope for non-pub keys (rate limits, notifications, etc.).
pub(crate) fn has(key: &str) -> bool {
    if key.starts_with("pub:") {
        return user_has(key);
    }
    backend_get(key)
        .ok()
        .flatten()
        .map(|b| !b.is_empty())
        .unwrap_or(false)
}

/// Delete a key. For `pub:` keys, deletes from user scope.
pub(crate) fn delete(key: &str) -> Result<(), AppError> {
    if key.starts_with("pub:") {
        user_delete_key(key);
        return Ok(());
    }
    backend_set(key, &[])
}

/// Atomic set-if-absent using user-scoped storage.
///
/// Nonce keys are replay markers (not sensitive data), so user-scoped
/// storage is appropriate. The host-level `backend::set_if_absent` is
/// atomic — no TOCTOU race regardless of whether OutLayer serialises
/// WASM executions per project.
pub(crate) fn set_if_absent(key: &str, val: &str) -> Result<bool, AppError> {
    backend::set_if_absent(key, val.as_bytes()).map_err(|e| AppError::Storage(e.to_string()))
}

// ---------------------------------------------------------------------------
// User-scoped storage primitives (individual keys, atomic counters)
// ---------------------------------------------------------------------------

pub(crate) fn user_set(key: &str, val: &[u8]) -> Result<(), AppError> {
    backend::set(key, val).map_err(|e| AppError::Storage(e.to_string()))
}

pub(crate) fn user_get_bytes(key: &str) -> Vec<u8> {
    backend::get(key).ok().flatten().unwrap_or_default()
}

pub(crate) fn user_get_json<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    backend::get(key)
        .ok()
        .flatten()
        .filter(|b| !b.is_empty())
        .and_then(|b| serde_json::from_slice(&b).ok())
}

pub(crate) fn user_has(key: &str) -> bool {
    backend::has(key)
}

pub(crate) fn user_delete_key(key: &str) -> bool {
    backend::delete(key)
}

/// List all user-scope keys matching a prefix (sorted).
pub(crate) fn user_list(prefix: &str) -> Vec<String> {
    backend::list_keys(prefix).unwrap_or_default()
}

/// Extract the last `:` segment from a key (the handle/id stored as suffix).
pub(crate) fn key_suffix(key: &str) -> &str {
    key.rsplit(':').next().unwrap_or(key)
}

/// List user-scope keys by prefix and extract the suffix of each as a handle.
pub(crate) fn handles_from_prefix(prefix: &str) -> Vec<String> {
    user_list(prefix)
        .iter()
        .map(|k| key_suffix(k).to_string())
        .collect()
}

/// Atomic counter increment. Returns the new value.
pub(crate) fn user_increment(key: &str, delta: i64) -> Result<i64, AppError> {
    backend::increment(key, delta).map_err(|e| AppError::Storage(e.to_string()))
}

/// Read atomic counter value without modifying it.
pub(crate) fn user_counter(key: &str) -> i64 {
    backend::get(key)
        .ok()
        .flatten()
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0)
}

/// Write a JSON index to worker-scope storage.
/// Only used for auxiliary (non-pub) indices: nonce_idx, notif_idx.
fn write_index<T: Serialize>(key: &str, val: &T) -> Result<(), AppError> {
    debug_assert!(
        !key.starts_with("pub:"),
        "write_index called on pub: key — use user_set instead"
    );
    let bytes = serde_json::to_vec(val).map_err(|e| AppError::Storage(e.to_string()))?;
    backend_set(key, &bytes)
}

pub(crate) fn index_list(key: &str) -> Vec<String> {
    get_json::<Vec<String>>(key).unwrap_or_default()
}

/// Idempotent append: adds `entry` to the end of the index if not already present.
/// Preserves insertion order (used for followers, following, endorsers, etc.).
/// Do not mix with `index_insert_sorted` on the same key — they assume different orderings.
pub(crate) fn index_append(key: &str, entry: &str) -> Result<(), AppError> {
    let mut idx = index_list(key);
    if !idx.iter().any(|e| e == entry) {
        idx.push(entry.to_string());
        write_index(key, &idx)?;
    }
    Ok(())
}

pub(crate) fn now_secs() -> Result<u64, AppError> {
    // NEAR mode: use block timestamp (deterministic, on-chain)
    if let Some(ns) = std::env::var("NEAR_BLOCK_TIMESTAMP")
        .ok()
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<u64>().ok())
    {
        return Ok(ns / NANOS_PER_SEC);
    }
    // HTTPS mode (and tests): use system time.
    // OutLayer runs on wasmtime which provides wasi:clocks/wall-clock to all
    // WASI P1/P2 guests. Confirmed by: stdin/stdout work (same WASI tier),
    // NEAR_MAX_EXECUTION_SECONDS implies host tracks wall time, and this path
    // has been exercised since initial deployment with no failure.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| AppError::Clock)
}

pub(crate) fn edge_timestamp(val: &str) -> Option<u64> {
    if let Ok(ts) = val.parse::<u64>() {
        return Some(ts);
    }
    serde_json::from_str::<serde_json::Value>(val)
        .ok()
        .and_then(|v| v.get("ts")?.as_u64())
}

fn rate_count(action: &str, caller: &str, window_secs: u64) -> Result<(u64, u64, u32), AppError> {
    debug_assert!(window_secs > 0, "rate window must be nonzero");
    let now = now_secs()?;
    let window = now / window_secs;
    let key = keys::rate(action, caller);
    let count = get_string(&key)
        .and_then(|s| {
            let (w, c) = s.split_once(':')?;
            if w.parse::<u64>().ok()? == window {
                c.parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0);
    Ok((now, window, count))
}

pub(crate) fn check_rate_limit(
    action: &str,
    caller: &str,
    limit: u32,
    window_secs: u64,
) -> Result<(), AppError> {
    let (now, window, count) = rate_count(action, caller, window_secs)?;
    if count >= limit {
        let retry_after = (window + 1) * window_secs - now;
        return Err(AppError::RateLimit(
            format!("Rate limit exceeded: {limit} {action} requests per {window_secs}s"),
            retry_after,
        ));
    }
    Ok(())
}

/// Like `check_rate_limit`, but on success returns the remaining budget
/// (`limit - current_count`).  Used by batch handlers to cap the number
/// of sub-operations to the actual remaining allowance.
pub(crate) fn check_rate_limit_budget(
    action: &str,
    caller: &str,
    limit: u32,
    window_secs: u64,
) -> Result<u32, AppError> {
    let (now, window, count) = rate_count(action, caller, window_secs)?;
    if count >= limit {
        let retry_after = (window + 1) * window_secs - now;
        return Err(AppError::RateLimit(
            format!("Rate limit exceeded: {limit} {action} requests per {window_secs}s"),
            retry_after,
        ));
    }
    Ok(limit - count)
}

pub(crate) fn increment_rate_limit(action: &str, caller: &str, window_secs: u64) {
    if let Ok((_now, window, count)) = rate_count(action, caller, window_secs) {
        let _ = set_string(
            &keys::rate(action, caller),
            &format!("{window}:{}", count.saturating_add(1)),
        );
    }
}

/// Delete every entry in an index and then delete the index itself.
/// Best-effort: individual delete failures are silently ignored.
pub(crate) fn purge_index(index_key: &str) {
    for key in index_list(index_key) {
        let _ = delete(&key);
    }
    let _ = delete(index_key);
}

pub(crate) fn prune_index_with(
    index_key: &str,
    cutoff: u64,
    extract_ts: impl Fn(&str) -> Option<u64>,
    delete_fn: impl Fn(&str),
) -> Result<(), AppError> {
    let keys: Vec<String> = get_json(index_key).unwrap_or_default();
    if keys.is_empty() {
        return Ok(());
    }
    let mut retained = Vec::new();
    let mut expired = Vec::new();
    for key in keys {
        if extract_ts(&key).map(|ts| ts < cutoff).unwrap_or(false) {
            expired.push(key);
        } else {
            retained.push(key);
        }
    }
    if !expired.is_empty() {
        set_json(index_key, &retained)?;
        for key in &expired {
            delete_fn(key);
        }
    }
    Ok(())
}

pub(crate) fn prune_index(
    index_key: &str,
    cutoff: u64,
    extract_ts: impl Fn(&str) -> Option<u64>,
) -> Result<(), AppError> {
    prune_index_with(index_key, cutoff, extract_ts, |key| {
        let _ = delete(key);
    })
}

/// Prune expired nonce keys from the nonce index.
///
/// Like `prune_index` but reads/deletes nonce values from user-scoped
/// storage (where `set_if_absent` writes them atomically).
pub(crate) fn prune_nonce_index(index_key: &str, cutoff: u64) -> Result<(), AppError> {
    prune_index_with(
        index_key,
        cutoff,
        |key| get_user_string(key).and_then(|v| v.parse::<u64>().ok()),
        delete_user,
    )
}

// ---------------------------------------------------------------------------
// Notification storage: create, deduplicate, prune, and query.
// ---------------------------------------------------------------------------

fn load_notif_index(handle: &str) -> Vec<String> {
    get_json::<Vec<String>>(&keys::notif_idx(handle)).unwrap_or_default()
}

fn append_notif(mut idx: Vec<String>, handle: &str, key: &str) -> Result<(), AppError> {
    idx.push(key.to_string());
    let pruned: Vec<String> = if idx.len() > crate::types::MAX_NOTIF_INDEX {
        let excess = idx.len() - crate::types::MAX_NOTIF_INDEX;
        let old_keys = idx[..excess].to_vec();
        idx = idx[excess..].to_vec();
        old_keys
    } else {
        Vec::new()
    };
    set_json(&keys::notif_idx(handle), &idx)?;
    for old_key in &pruned {
        let _ = delete(old_key);
    }
    Ok(())
}

pub(crate) const NOTIF_FOLLOW: &str = "follow";
pub(crate) const NOTIF_UNFOLLOW: &str = "unfollow";
pub(crate) const NOTIF_ENDORSE: &str = "endorse";
pub(crate) const NOTIF_UNENDORSE: &str = "unendorse";
pub(crate) fn store_notification(
    target_handle: &str,
    notif_type: &str,
    from: &str,
    is_mutual: bool,
    ts: u64,
    detail: Option<serde_json::Value>,
) -> Result<(), AppError> {
    if target_handle.is_empty() || from.is_empty() {
        return Err(AppError::Validation(
            "notification skipped — empty target or sender".into(),
        ));
    }

    // O(1) dedup: check a per-(target, type, from) key whose value is the
    // timestamp of the last notification.  Suppresses duplicates within
    // DEDUP_WINDOW_SECS without scanning the notification index.
    let dedup_key = keys::notif_dedup(target_handle, notif_type, from);
    if let Some(prev_ts_str) = get_string(&dedup_key) {
        if let Ok(prev_ts) = prev_ts_str.parse::<u64>() {
            if ts >= prev_ts && ts - prev_ts < crate::types::DEDUP_WINDOW_SECS {
                return Ok(());
            }
        }
    }

    let idx = load_notif_index(target_handle);
    let key = keys::notif(target_handle, ts, notif_type, from);
    let mut val = serde_json::json!({
        "type": notif_type,
        "from": from,
        "is_mutual": is_mutual,
        "at": ts,
    });
    if let Some(d) = detail {
        val["detail"] = d;
    }
    set_string(&key, &val.to_string())?;
    if let Err(e) = append_notif(idx, target_handle, &key) {
        let _ = delete(&key);
        return Err(e);
    }
    // Update dedup marker after successful write.
    let _ = set_public(&dedup_key, ts.to_string().as_bytes());
    Ok(())
}

pub(crate) fn load_notifications_since(handle: &str, since: u64) -> Vec<serde_json::Value> {
    load_notif_index(handle)
        .iter()
        .filter_map(|key| {
            let val = get_string(key)?;
            let parsed: serde_json::Value = serde_json::from_str(&val).ok()?;
            let at = parsed.get("at")?.as_u64()?;
            if at > since {
                Some(parsed)
            } else {
                None
            }
        })
        .collect()
}

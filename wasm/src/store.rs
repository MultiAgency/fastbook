//! Storage abstraction: key-value wrappers, index operations, and storage key definitions.

#[cfg(not(test))]
use outlayer::storage as backend;
use serde::Serialize;
#[cfg(test)]
use test_backend as backend;

use crate::types::AppError;

#[cfg(test)]
pub(crate) mod test_backend {
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};

    thread_local! {
        static STORE: RefCell<HashMap<String, Vec<u8>>> = RefCell::new(HashMap::new());
        /// User-scoped storage (for atomic set_if_absent — nonce replay protection).
        static USER_STORE: RefCell<HashMap<String, Vec<u8>>> = RefCell::new(HashMap::new());
        /// Keys written via `set_worker_with_options(_, _, Some(false))` (public scope).
        static PUBLIC_KEYS: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
        static FAIL_NEXT: RefCell<u32> = const { RefCell::new(0) };
        static SUCCEED_THEN_FAIL: RefCell<Option<(u32, u32)>> = const { RefCell::new(None) };
    }

    pub fn clear() {
        STORE.with(|s| s.borrow_mut().clear());
        USER_STORE.with(|s| s.borrow_mut().clear());
        PUBLIC_KEYS.with(|s| s.borrow_mut().clear());
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

    pub fn set_worker_with_options(
        key: &str,
        value: &[u8],
        is_encrypted: Option<bool>,
    ) -> Result<(), outlayer::storage::StorageError> {
        let result = set_worker(key, value);
        if result.is_ok() && is_encrypted == Some(false) {
            PUBLIC_KEYS.with(|s| s.borrow_mut().insert(key.to_string()));
        }
        result
    }

    pub fn get_worker(key: &str) -> Result<Option<Vec<u8>>, outlayer::storage::StorageError> {
        Ok(STORE.with(|s| s.borrow().get(key).cloned()))
    }

    /// Returns true if the key was written via `set_worker_with_options(_, _, Some(false))`.
    pub fn is_public(key: &str) -> bool {
        PUBLIC_KEYS.with(|s| s.borrow().contains(key))
    }

    /// Panics if `key` was not written with the expected scope.
    /// `expect_public = true` means the key must have been written as public.
    pub fn assert_scope(key: &str, expect_public: bool) {
        let actual_public = is_public(key);
        assert_eq!(
            actual_public,
            expect_public,
            "Scope mismatch for key {key:?}: expected {}, got {}",
            if expect_public { "public" } else { "private" },
            if actual_public { "public" } else { "private" },
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

    // Wrappers matching outlayer::storage names so cfg-aliased `backend` works.
    pub fn get(key: &str) -> Result<Option<Vec<u8>>, outlayer::storage::StorageError> {
        user_get(key)
    }
    pub fn delete(key: &str) -> bool {
        user_delete(key)
    }
    pub fn set_if_absent(key: &str, value: &[u8]) -> Result<bool, outlayer::storage::StorageError> {
        user_set_if_absent(key, value)
    }
}

pub mod keys {
    pub fn pub_agents() -> &'static str {
        "pub:agents"
    }
    pub fn pub_agent(handle: &str) -> String {
        format!("pub:agent:{handle}")
    }
    pub fn pub_followers(handle: &str) -> String {
        format!("pub:followers:{handle}")
    }
    pub fn pub_following(handle: &str) -> String {
        format!("pub:following:{handle}")
    }
    pub fn pub_edge(from: &str, to: &str) -> String {
        format!("pub:edge:{from}:follows:{to}")
    }
    pub fn pub_sorted(sort: &str) -> String {
        format!("pub:sorted:{sort}")
    }
    pub fn pub_meta_count() -> &'static str {
        "pub:meta:agent_count"
    }
    pub fn pub_meta_updated() -> &'static str {
        "pub:meta:last_updated"
    }
    pub fn pub_tag_counts() -> &'static str {
        "pub:tag_counts"
    }

    pub fn near_account(account_id: &str) -> String {
        format!("pub:near:{account_id}")
    }

    pub fn unfollowed(caller: &str, handle: &str, ts: u64) -> String {
        format!("unfollowed:{caller}:{handle}:{ts}")
    }
    pub fn unfollow_idx(handle: &str) -> String {
        format!("unfollow_idx:{handle}")
    }
    pub fn unfollow_idx_by(account: &str) -> String {
        format!("unfollow_idx_by:{account}")
    }

    pub fn nonce(nonce_val: &str) -> String {
        format!("nonce:{nonce_val}")
    }
    pub fn nonce_idx() -> &'static str {
        "nonce_idx"
    }

    pub fn suggested(caller: &str, handle: &str, ts: u64) -> String {
        format!("suggested:{caller}:{handle}:{ts}")
    }
    pub fn suggested_idx(caller: &str) -> String {
        format!("suggested_idx:{caller}")
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

    pub fn endorsement(target: &str, ns: &str, value: &str, from: &str) -> String {
        format!("pub:endorsement:{target}:{ns}:{value}:{from}")
    }
    pub fn endorsement_by(from: &str, target: &str) -> String {
        format!("pub:endorsement_by:{from}:{target}")
    }
    pub fn endorsers(target: &str, ns: &str, value: &str) -> String {
        format!("pub:endorsers:{target}:{ns}:{value}")
    }
}

fn backend_set(key: &str, val: &[u8]) -> Result<(), AppError> {
    backend::set_worker(key, val).map_err(|e| AppError::Storage(e.to_string()))
}

fn backend_get(key: &str) -> Result<Option<Vec<u8>>, AppError> {
    backend::get_worker(key).map_err(|e| AppError::Storage(e.to_string()))
}

fn backend_set_public(key: &str, val: &[u8]) -> Result<(), AppError> {
    backend::set_worker_with_options(key, val, Some(false))
        .map_err(|e| AppError::Storage(e.to_string()))
}

pub(crate) fn set_string(key: &str, val: &str) -> Result<(), AppError> {
    backend_set(key, val.as_bytes())
}

pub(crate) fn get_string(key: &str) -> Option<String> {
    backend_get(key).ok().flatten().and_then(|b| {
        if b.is_empty() {
            None
        } else {
            String::from_utf8(b).ok()
        }
    })
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
    backend_get(key)
        .ok()
        .flatten()
        .filter(|b| !b.is_empty())
        .and_then(|b| serde_json::from_slice(&b).ok())
}

pub(crate) fn set_public(key: &str, val: &[u8]) -> Result<(), AppError> {
    backend_set_public(key, val)
}

pub(crate) fn get_bytes(key: &str) -> Vec<u8> {
    backend_get(key).ok().flatten().unwrap_or_default()
}

pub(crate) fn has(key: &str) -> bool {
    backend_get(key)
        .ok()
        .flatten()
        .map(|b| !b.is_empty())
        .unwrap_or(false)
}

pub(crate) fn delete(key: &str) -> Result<(), AppError> {
    if key.starts_with("pub:") {
        backend_set_public(key, &[])
    } else {
        backend_set(key, &[])
    }
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

fn write_index<T: Serialize>(key: &str, val: &T) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(val).map_err(|e| AppError::Storage(e.to_string()))?;
    if key.starts_with("pub:") {
        backend_set_public(key, &bytes)
    } else {
        backend_set(key, &bytes)
    }
}

pub(crate) fn index_list(key: &str) -> Vec<String> {
    get_json::<Vec<String>>(key).unwrap_or_default()
}

pub(crate) fn index_append(key: &str, entry: &str) -> Result<(), AppError> {
    let mut idx = index_list(key);
    if !idx.iter().any(|e| e == entry) {
        idx.push(entry.to_string());
        write_index(key, &idx)?;
    }
    Ok(())
}

pub(crate) fn index_remove(key: &str, entry: &str) -> Result<(), AppError> {
    let mut idx = index_list(key);
    let before = idx.len();
    idx.retain(|e| e != entry);
    if idx.len() != before {
        write_index(key, &idx)?;
    }
    Ok(())
}

pub(crate) fn index_insert_sorted(key: &str, entry: &str) -> Result<(), AppError> {
    let mut idx = index_list(key);
    let pos = idx
        .binary_search_by(|e| e.as_str().cmp(entry))
        .unwrap_or_else(|p| p);
    if idx.get(pos).map(std::string::String::as_str) != Some(entry) {
        idx.insert(pos, entry.to_string());
        write_index(key, &idx)?;
    }
    Ok(())
}

pub(crate) fn index_remove_sorted(key: &str, entry: &str) -> Result<(), AppError> {
    let mut idx = index_list(key);
    if let Ok(pos) = idx.binary_search_by(|e| e.as_str().cmp(entry)) {
        idx.remove(pos);
        write_index(key, &idx)?;
    }
    Ok(())
}

/// Remove old_entry and insert new_entry in a single read-write cycle.
/// Avoids the window where neither entry is present.
pub(crate) fn index_replace_sorted(
    key: &str,
    old_entry: &str,
    new_entry: &str,
) -> Result<(), AppError> {
    let mut idx = index_list(key);
    if let Ok(pos) = idx.binary_search_by(|e| e.as_str().cmp(old_entry)) {
        idx.remove(pos);
    }
    let new_pos = idx
        .binary_search_by(|e| e.as_str().cmp(new_entry))
        .unwrap_or_else(|p| p);
    if idx.get(new_pos).map(std::string::String::as_str) != Some(new_entry) {
        idx.insert(new_pos, new_entry.to_string());
    }
    write_index(key, &idx)
}

pub(crate) fn now_secs() -> Result<u64, AppError> {
    // NEAR mode: use block timestamp (deterministic, on-chain)
    if let Some(ns) = std::env::var("NEAR_BLOCK_TIMESTAMP")
        .ok()
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<u64>().ok())
    {
        return Ok(ns / 1_000_000_000);
    }
    // HTTPS mode (and tests): use system time.
    // OutLayer runs on wasmtime which provides wasi:clocks/wall-clock to all
    // WASI P1/P2 guests. Confirmed by: stdin/stdout work (same WASI tier),
    // NEAR_MAX_EXECUTION_SECONDS implies host tracks wall time, and this path
    // has been exercised since initial deployment with no failure.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|e| AppError::Clock(e.to_string()))
}

pub(crate) fn edge_timestamp(val: &str) -> Option<u64> {
    if let Ok(ts) = val.parse::<u64>() {
        return Some(ts);
    }
    serde_json::from_str::<serde_json::Value>(val)
        .ok()
        .and_then(|v| v.get("ts")?.as_u64())
}

fn rate_count(action: &str, caller: &str, window_secs: u64) -> Result<(u64, u32), AppError> {
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
    Ok((window, count))
}

pub(crate) fn check_rate_limit(
    action: &str,
    caller: &str,
    limit: u32,
    window_secs: u64,
) -> Result<(), AppError> {
    let (_window, count) = rate_count(action, caller, window_secs)?;
    if count >= limit {
        return Err(AppError::RateLimit(format!(
            "Rate limit exceeded: {limit} {action} requests per {window_secs}s"
        )));
    }
    Ok(())
}

pub(crate) fn increment_rate_limit(action: &str, caller: &str, window_secs: u64) {
    if let Ok((window, count)) = rate_count(action, caller, window_secs) {
        let _ = set_string(
            &keys::rate(action, caller),
            &format!("{window}:{}", count + 1),
        );
    }
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
    for key in &keys {
        if extract_ts(key).map(|ts| ts < cutoff).unwrap_or(false) {
            expired.push(key.clone());
        } else {
            retained.push(key.clone());
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

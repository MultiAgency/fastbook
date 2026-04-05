//! Storage abstraction: key-value wrappers, index operations, and storage key definitions.
//!
//! # Concurrency model
//!
//! All **public** data (`pub:` keys) uses individual atomic key-value writes
//! and is TOCTOU-safe regardless of execution model.
//!
//! Auxiliary index operations (`index_append`, `prune_nonce_index`) on non-pub keys
//! (nonce_idx) are read-modify-write
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
        /// Worker-scoped storage (auxiliary indices: nonce index).
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

    // Wrappers matching outlayer::storage names so cfg-aliased `backend` works.
    pub fn set(key: &str, value: &[u8]) -> Result<(), outlayer::storage::StorageError> {
        user_set(key, value)
    }
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

/// Storage key schema (all colon-delimited):
///
/// User-scoped (pub: prefix — atomic, TOCTOU-safe):
///   pub:agent:{account_id}                        — full AgentRecord JSON
///   pub:agent_reg:{account_id}                    — registry marker (value = "1")
///
/// Worker-scoped (auxiliary, RMW — requires serialised execution):
///   nonce:{nonce_val}          — replay-protection marker (user-scoped atomic)
///   nonce_idx                  — JSON array of active nonce keys
pub mod keys {
    pub fn pub_agent(account_id: &str) -> String {
        format!("pub:agent:{account_id}")
    }
    pub fn pub_agent_reg(account_id: &str) -> String {
        format!("pub:agent_reg:{account_id}")
    }

    pub fn nonce(nonce_val: &str) -> String {
        format!("nonce:{nonce_val}")
    }
    pub fn nonce_idx() -> &'static str {
        "nonce_idx"
    }
}

fn backend_set(key: &str, val: &[u8]) -> Result<(), AppError> {
    backend::set_worker(key, val).map_err(|e| AppError::Storage(e.to_string()))
}

fn backend_get(key: &str) -> Result<Option<Vec<u8>>, AppError> {
    backend::get_worker(key).map_err(|e| AppError::Storage(e.to_string()))
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

fn set_json<T: Serialize>(key: &str, val: &T) -> Result<(), AppError> {
    let bytes = serde_json::to_vec(val).map_err(|e| AppError::Storage(e.to_string()))?;
    backend_set(key, &bytes)
}

fn get_json<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    read_scoped(key).and_then(|b| serde_json::from_slice(&b).ok())
}

/// Atomic set-if-absent using user-scoped storage.
pub(crate) fn set_if_absent(key: &str, val: &str) -> Result<bool, AppError> {
    backend::set_if_absent(key, val.as_bytes()).map_err(|e| AppError::Storage(e.to_string()))
}

// ---------------------------------------------------------------------------
// User-scoped storage primitives
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

/// Write a JSON index to worker-scope storage.
fn write_index<T: Serialize>(key: &str, val: &T) -> Result<(), AppError> {
    debug_assert!(
        !key.starts_with("pub:"),
        "write_index called on pub: key — use user_set instead"
    );
    let bytes = serde_json::to_vec(val).map_err(|e| AppError::Storage(e.to_string()))?;
    backend_set(key, &bytes)
}

fn index_list(key: &str) -> Vec<String> {
    get_json::<Vec<String>>(key).unwrap_or_default()
}

/// Idempotent append: adds `entry` to the end of the index if not already present.
pub(crate) fn index_append(key: &str, entry: &str) -> Result<(), AppError> {
    let mut idx = index_list(key);
    if !idx.iter().any(|e| e == entry) {
        idx.push(entry.to_string());
        write_index(key, &idx)?;
    }
    Ok(())
}

pub(crate) fn now_secs() -> Result<u64, AppError> {
    if let Some(ns) = std::env::var("NEAR_BLOCK_TIMESTAMP")
        .ok()
        .filter(|s| !s.is_empty())
        .and_then(|s| s.parse::<u64>().ok())
    {
        return Ok(ns / NANOS_PER_SEC);
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .map_err(|_| AppError::Clock)
}

/// Prune expired nonce keys from the nonce index.
pub(crate) fn prune_nonce_index(index_key: &str, cutoff: u64) -> Result<(), AppError> {
    let keys: Vec<String> = get_json(index_key).unwrap_or_default();
    if keys.is_empty() {
        return Ok(());
    }
    let mut retained = Vec::new();
    let mut expired = Vec::new();
    for key in keys {
        let is_expired = get_user_string(&key)
            .and_then(|v| v.parse::<u64>().ok())
            .map(|ts| ts < cutoff)
            .unwrap_or(false);
        if is_expired {
            expired.push(key);
        } else {
            retained.push(key);
        }
    }
    if !expired.is_empty() {
        set_json(index_key, &retained)?;
        for key in &expired {
            delete_user(key);
        }
    }
    Ok(())
}

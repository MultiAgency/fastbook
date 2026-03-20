use outlayer::storage;
use serde::Serialize;

// ─── Storage key constructors ─────────────────────────────────────────────
// Every key read or written by the WASM module is defined here so the
// key schema is explicit and consistent across all handler functions.

pub mod keys {
    // ── Identity
    pub fn agent(handle: &str) -> String { format!("agent:{handle}") }
    pub fn near_account(account_id: &str) -> String { format!("near:{account_id}") }

    // ── Follow edges
    pub fn follow_edge(caller: &str, target: &str) -> String { format!("follow:{caller}:{target}") }
    pub fn follower(target: &str, caller: &str) -> String { format!("followers:{target}:{caller}") }
    pub fn follower_prefix(handle: &str) -> String { format!("followers:{handle}:") }
    pub fn following(caller: &str, target: &str) -> String { format!("following:{caller}:{target}") }
    pub fn following_prefix(account: &str) -> String { format!("following:{account}:") }

    // ── Audit trail
    pub fn unfollowed(caller: &str, handle: &str, ts: u64) -> String { format!("unfollowed:{caller}:{handle}:{ts}") }
    pub fn unfollow_idx(handle: &str) -> String { format!("unfollow_idx:{handle}") }
    pub fn unfollow_idx_by(account: &str) -> String { format!("unfollow_idx_by:{account}") }

    // ── Sorted indices
    pub fn idx_trust(inv_score: i64, handle: &str) -> String { format!("idx:by_trust:{inv_score:016}:{handle}") }
    pub fn idx_created(inv_created: u64, handle: &str) -> String { format!("idx:by_created:{inv_created:020}:{handle}") }
    pub fn idx_active(inv_active: u64, handle: &str) -> String { format!("idx:by_active:{inv_active:020}:{handle}") }

    // ── Nonces
    pub fn nonce(nonce_val: &str) -> String { format!("nonce:{nonce_val}") }

    // ── Suggestions
    pub fn suggested(caller: &str, handle: &str, ts: u64) -> String { format!("suggested:{caller}:{handle}:{ts}") }

    // ── Notifications
    pub fn notif(handle: &str, ts: u64, notif_type: &str, from: &str) -> String { format!("notif:{handle}:{ts}:{notif_type}:{from}") }
    pub fn notif_idx(handle: &str) -> String { format!("notif_idx:{handle}") }
    pub fn notif_read(handle: &str) -> String { format!("notif_read:{handle}") }
}

// ─── Worker storage helpers ────────────────────────────────────────────────

pub(crate) fn w_set_string(key: &str, val: &str) -> Result<(), String> {
    storage::set_worker(key, val.as_bytes()).map_err(|e| e.to_string())
}

pub(crate) fn w_get_string(key: &str) -> Option<String> {
    storage::get_worker(key)
        .ok()
        .flatten()
        .and_then(|b| if b.is_empty() { None } else { String::from_utf8(b).ok() })
}

pub(crate) fn w_set_json<T: Serialize>(key: &str, val: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec(val).map_err(|e| e.to_string())?;
    storage::set_worker(key, &bytes).map_err(|e| e.to_string())
}

pub(crate) fn w_get_json<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    storage::get_worker(key)
        .ok()
        .flatten()
        .filter(|b| !b.is_empty())
        .and_then(|b| serde_json::from_slice(&b).ok())
}

pub(crate) fn w_has(key: &str) -> bool {
    storage::get_worker(key)
        .ok()
        .flatten()
        .map(|b| !b.is_empty())
        .unwrap_or(false)
}

/// "Delete" by writing empty bytes (no true delete in OutLayer WIT).
/// Read helpers treat empty values as absent, so this is correct.
/// Returns the result so callers that care can check for errors;
/// most call sites can ignore it since deletion is best-effort.
pub(crate) fn w_delete(key: &str) -> Result<(), String> {
    storage::set_worker(key, &[]).map_err(|e| format!("Failed to delete key {key}: {e}"))
}

/// Atomically check-and-set a worker key. Returns Ok(true) if the key was
/// freshly created, Ok(false) if it already existed.
///
/// SAFETY: OutLayer serializes all WASM invocations for a given project —
/// there is no concurrent execution. This guarantee makes the read-then-write
/// pattern below equivalent to an atomic set-if-absent. If OutLayer ever
/// introduces concurrent execution, this MUST be replaced with a host-level
/// set_if_absent for worker storage (not currently in the WIT interface).
pub(crate) fn w_set_if_absent(key: &str, val: &str) -> Result<bool, String> {
    if w_get_string(key).is_some() {
        return Ok(false);
    }
    w_set_string(key, val)?;
    Ok(true)
}

// ─── Time & utility helpers ───────────────────────────────────────────────

pub(crate) fn now_secs() -> u64 {
    // Prefer block timestamp from the TEE execution environment
    if let Some(ns) = std::env::var("NEAR_BLOCK_TIMESTAMP")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        return ns / 1_000_000_000;
    }
    // Fallback to system time — this should only happen in dev/test.
    // Panic if system clock is unavailable: returning 0 would poison nonce
    // security (nonces stored with ts=0 get GC'd immediately, enabling replay).
    eprintln!("Warning: NEAR_BLOCK_TIMESTAMP not available, using system time");
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("System clock unavailable — cannot generate safe timestamps")
        .as_secs()
}

/// Extract timestamp from an edge value (either plain u64 or JSON `{"ts":...}`)
pub(crate) fn edge_timestamp(val: &str) -> Option<u64> {
    if let Ok(ts) = val.parse::<u64>() { return Some(ts); }
    serde_json::from_str::<serde_json::Value>(val).ok()
        .and_then(|v| v.get("ts")?.as_u64())
}

/// Prune an index (Vec<String> stored as JSON) by removing entries older than `cutoff`.
/// `extract_ts` parses a timestamp from each key; entries where it returns `None` are kept.
pub(crate) fn prune_index(index_key: &str, cutoff: u64, extract_ts: impl Fn(&str) -> Option<u64>) -> Result<(), String> {
    let keys: Vec<String> = w_get_json(index_key).unwrap_or_default();
    if keys.is_empty() { return Ok(()); }
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
        // Write index before deleting blobs — if the write fails, old blobs
        // remain reachable rather than becoming dangling references.
        w_set_json(index_key, &retained)
            .map_err(|e| format!("failed to prune index {index_key}: {e}"))?;
        for key in &expired {
            let _ = w_delete(key);
        }
    }
    Ok(())
}

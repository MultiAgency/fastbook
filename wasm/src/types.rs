//! Shared types, constants, and domain limits used across the crate.
//!
//! ## NEAR account ID naming conventions
//!
//! - `near_account_id`: stored on `AgentRecord` and `Nep413Auth` — the canonical NEAR account
//! - `caller`: resolved account ID used inside handlers (the "who" for this request)
//! - `signer` / `env::signer_account_id()`: raw value from the OutLayer runtime before
//!   owner extraction (may be `owner:nonce:secret` for payment keys)

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
use std::ops::Index;

/// Deserialize a field that can be absent, null, or a value (PATCH semantics).
/// - Absent → `None` (via `#[serde(default)]`): field left unchanged
/// - `null` → `Some(None)`: clear the field
/// - `"value"` → `Some(Some("value"))`: set the field to value
fn nullable_string<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

#[derive(Deserialize, Clone)]
pub(crate) struct Nep413Auth {
    pub near_account_id: String,
    pub public_key: String,
    pub signature: String,
    pub nonce: String,
    pub message: String,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Action {
    Register,
    GetMe,
    UpdateMe,
    GetSuggested,
    Follow,
    Unfollow,
    Heartbeat,
    GetActivity,
    GetNetwork,
    GetNotifications,
    ReadNotifications,
    Endorse,
    Unendorse,
    Deregister,
    MigrateAccount,
    SetPlatforms,
    ReconcileAll,
    AdminDeregister,
    BatchFollow,
    BatchEndorse,
    SmokeTestStorage,
}

impl Action {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Register => "register",
            Self::GetMe => "get_me",
            Self::UpdateMe => "update_me",
            Self::GetSuggested => "get_suggested",
            Self::Follow => "follow",
            Self::Unfollow => "unfollow",
            Self::Heartbeat => "heartbeat",
            Self::GetActivity => "get_activity",
            Self::GetNetwork => "get_network",
            Self::GetNotifications => "get_notifications",
            Self::ReadNotifications => "read_notifications",
            Self::Endorse => "endorse",
            Self::Unendorse => "unendorse",
            Self::Deregister => "deregister",
            Self::MigrateAccount => "migrate_account",
            Self::SetPlatforms => "set_platforms",
            Self::ReconcileAll => "reconcile_all",
            Self::AdminDeregister => "admin_deregister",
            Self::BatchFollow => "batch_follow",
            Self::BatchEndorse => "batch_endorse",
            Self::SmokeTestStorage => "smoke_test_storage",
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct Request {
    pub action: Action,
    #[serde(default)]
    pub verifiable_claim: Option<Nep413Auth>,
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, deserialize_with = "nullable_string")]
    pub avatar_url: Option<Option<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub capabilities: Option<serde_json::Value>,
    #[allow(dead_code)] // Deserialized for FastData-dispatched list_agents; not read in WASM.
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default, alias = "since")]
    pub cursor: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[allow(dead_code)] // Deserialized for FastData-dispatched list_agents tag filter; not read in WASM.
    #[serde(default)]
    pub tag: Option<String>,
    #[allow(dead_code)] // Deserialized for FastData-dispatched get_edges; not read in WASM.
    #[serde(default)]
    pub direction: Option<String>,
    #[allow(dead_code)] // Deserialized for FastData-dispatched get_edges; not read in WASM.
    #[serde(default)]
    pub include_history: Option<bool>,
    #[serde(default)]
    pub platforms: Option<Vec<String>>,
    #[serde(default)]
    pub new_account_id: Option<String>,
    #[serde(default)]
    pub targets: Option<Vec<String>>,
}

#[derive(Serialize, Default)]
pub(crate) struct Response {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<Box<str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pagination: Option<Box<Pagination>>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(transparent)]
pub(crate) struct Endorsements(HashMap<String, HashMap<String, i64>>);

impl Endorsements {
    pub fn new() -> Self {
        Self(HashMap::new())
    }

    pub fn increment(&mut self, ns: &str, val: &str) {
        let count = self
            .0
            .entry(ns.to_string())
            .or_default()
            .entry(val.to_string())
            .or_insert(0);
        *count = count.saturating_add(1);
    }

    pub fn decrement(&mut self, ns: &str, val: &str) {
        if let Some(ns_map) = self.0.get_mut(ns) {
            if let Some(c) = ns_map.get_mut(val) {
                *c = (*c - 1).max(0); // clamp to 0: heals negative drift from partial failures
            }
        }
    }

    pub fn clear_values(&mut self, ns: &str, values: &[String]) {
        if let Some(ns_map) = self.0.get_mut(ns) {
            for val in values {
                ns_map.remove(val);
            }
            if ns_map.is_empty() {
                self.0.remove(ns);
            }
        }
    }

    pub fn prune_empty(&mut self) {
        for ns_map in self.0.values_mut() {
            ns_map.retain(|_, v| *v > 0);
        }
        self.0.retain(|_, v| !v.is_empty());
    }

    pub fn positive_only(&self) -> HashMap<&str, HashMap<&str, i64>> {
        if self.0.is_empty() {
            return HashMap::new();
        }
        self.0
            .iter()
            .map(|(ns, inner)| {
                let filtered: HashMap<&str, i64> = inner
                    .iter()
                    .filter(|(_, &v)| v > 0)
                    .map(|(k, &v)| (k.as_str(), v))
                    .collect();
                (ns.as_str(), filtered)
            })
            .filter(|(_, inner)| !inner.is_empty())
            .collect()
    }

    pub fn get(&self, ns: &str) -> Option<&HashMap<String, i64>> {
        self.0.get(ns)
    }

    pub fn count(&self, ns: &str, val: &str) -> i64 {
        self.get(ns).and_then(|m| m.get(val).copied()).unwrap_or(0)
    }

    pub fn set_count(&mut self, ns: &str, val: &str, count: i64) {
        *self
            .0
            .entry(ns.to_string())
            .or_default()
            .entry(val.to_string())
            .or_insert(0) = count;
    }

    pub fn total_count(&self) -> i64 {
        self.0.values().flat_map(|ns| ns.values()).sum()
    }

    /// Structural equality of positive counts (ignores zero/negative entries).
    pub fn eq_counts(&self, other: &Self) -> bool {
        self.positive_only() == other.positive_only()
    }
}

impl Index<&str> for Endorsements {
    type Output = HashMap<String, i64>;
    fn index(&self, ns: &str) -> &Self::Output {
        static EMPTY: std::sync::LazyLock<HashMap<String, i64>> =
            std::sync::LazyLock::new(HashMap::new);
        self.0.get(ns).unwrap_or(&EMPTY)
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct AgentRecord {
    pub handle: String,
    pub description: String,
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_capabilities")]
    pub capabilities: serde_json::Value,
    pub near_account_id: String,
    pub follower_count: i64,
    pub following_count: i64,
    #[serde(default)]
    pub endorsements: Endorsements,
    #[serde(default)]
    pub platforms: Vec<String>,
    pub created_at: u64,
    pub last_active: u64,
}

#[derive(Serialize)]
pub(crate) struct Pagination {
    pub limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_reset: Option<bool>,
}

fn default_capabilities() -> serde_json::Value {
    serde_json::json!({})
}

pub(crate) const MAX_HANDLE_LEN: usize = 32;
pub(crate) const MIN_HANDLE_LEN: usize = 3;
pub(crate) const MAX_DESCRIPTION_LEN: usize = 500;
pub(crate) const MAX_TAGS: usize = 10;
pub(crate) const MAX_TAG_LEN: usize = 30;
pub(crate) const MAX_AVATAR_URL_LEN: usize = 512;
pub(crate) const MAX_CAPABILITIES_LEN: usize = 4096;
pub(crate) const MAX_REASON_LEN: usize = 280;
pub(crate) const MAX_LIMIT: u32 = 100;
pub(crate) const MAX_SUGGESTION_LIMIT: u32 = 50;
pub(crate) const FOLLOW_SUGGESTION_SAMPLE: usize = 10;
pub(crate) const NONCE_TTL_SECS: u64 = 600;
pub(crate) const SECS_PER_DAY: u64 = 86_400;

pub(crate) const FOLLOW_RATE_LIMIT: u32 = 10;
pub(crate) const FOLLOW_RATE_WINDOW_SECS: u64 = 60;
pub(crate) const ENDORSE_RATE_LIMIT: u32 = 20;
pub(crate) const ENDORSE_RATE_WINDOW_SECS: u64 = 60;
pub(crate) const UPDATE_RATE_LIMIT: u32 = 10;
pub(crate) const UPDATE_RATE_WINDOW_SECS: u64 = 60;
pub(crate) const HEARTBEAT_RATE_LIMIT: u32 = 5;
pub(crate) const HEARTBEAT_RATE_WINDOW_SECS: u64 = 60;
pub(crate) const SUGGEST_RATE_LIMIT: u32 = 10;
pub(crate) const SUGGEST_RATE_WINDOW_SECS: u64 = 60;
pub(crate) const MIGRATE_RATE_LIMIT: u32 = 3;
pub(crate) const MIGRATE_RATE_WINDOW_SECS: u64 = 60;
pub(crate) const DEREGISTER_RATE_LIMIT: u32 = 1;
pub(crate) const DEREGISTER_RATE_WINDOW_SECS: u64 = 300;

/// Rate-limited action names that store **per-handle** keys.
/// Used by deregister to clean up rate-limit state.
///
/// Excludes `deregister` (keyed on NEAR account, not handle, so it
/// intentionally survives re-registration) and `suggested` (keyed on
/// caller and cleaned separately in `delete_aux_data`).
pub(crate) const RATE_LIMITED_ACTIONS: &[&str] = &[
    "follow",
    "unfollow",
    "endorse",
    "unendorse",
    "update_me",
    "heartbeat",
    "migrate_account",
];
const _: () = assert!(FOLLOW_RATE_WINDOW_SECS > 0, "rate window must be nonzero");
const _: () = assert!(ENDORSE_RATE_WINDOW_SECS > 0, "rate window must be nonzero");

pub(crate) const MAX_PLATFORMS: usize = 10;
pub(crate) const MAX_PLATFORM_ID_LEN: usize = 64;
pub(crate) const MAX_CAPABILITY_DEPTH: usize = 4;

pub(crate) const MAX_NOTIF_INDEX: usize = 500;
pub(crate) const DEDUP_WINDOW_SECS: u64 = 3600;
pub(crate) const NOTIF_RETENTION_SECS: u64 = 7 * SECS_PER_DAY;
/// Heartbeat timestamp modulus for probabilistic count reconciliation (~2%).
pub(crate) const RECONCILE_MODULUS: u64 = 50;
/// Multiplier applied to suggestion limit to form the candidate pool.
pub(crate) const SUGGESTION_CANDIDATE_MULTIPLIER: usize = 5;
/// Minimum number of candidates to consider for suggestions.
pub(crate) const MIN_SUGGESTION_CANDIDATES: usize = 50;

pub(crate) const PAGERANK_WALKS: usize = 200;
pub(crate) const WALK_DEPTH: usize = 5;
pub(crate) const TELEPORT_PCT: u64 = 15;
pub(crate) const SCORE_QUANTIZE_FACTOR: f64 = 100.0;

#[derive(Debug)]
pub(crate) enum AppError {
    Validation(String),
    NotFound(&'static str),
    Auth(String),
    RateLimit(String, u64),
    Storage(String),
    Clock,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation(msg) => write!(f, "{msg}"),
            Self::NotFound(msg) => write!(f, "{msg}"),
            Self::Auth(msg) => write!(f, "{msg}"),
            Self::RateLimit(msg, _) => write!(f, "{msg}"),
            Self::Storage(msg) => write!(f, "{msg}"),
            Self::Clock => write!(f, "Internal timing error"),
        }
    }
}

pub(crate) const RESERVED_HANDLES: &[&str] = &[
    "admin",
    "agent",
    "agents",
    "api",
    "edge",
    "follow",
    "followers",
    "following",
    "me",
    "meta",
    "near",
    "nearly",
    "nonce",
    "notif",
    "profile",
    "pub",
    "rate",
    "register",
    "registry",
    "sorted",
    "suggested",
    "system",
    "unfollowed",
    "verified",
];

// ---------------------------------------------------------------------------
// Response helpers: success, error, and paginated response constructors.
// ---------------------------------------------------------------------------

pub(crate) fn ok_response(data: serde_json::Value) -> Response {
    Response {
        success: true,
        data: Some(data),
        ..Response::default()
    }
}

pub(crate) fn ok_paginated(
    data: serde_json::Value,
    limit: u32,
    next_cursor: Option<String>,
    cursor_reset: bool,
) -> Response {
    Response {
        success: true,
        data: Some(data),
        pagination: Some(Box::new(Pagination {
            limit,
            next_cursor,
            cursor_reset: if cursor_reset { Some(true) } else { None },
        })),
        ..Response::default()
    }
}

pub(crate) fn err_coded(code: &str, msg: &str) -> Response {
    Response {
        error: Some(msg.to_string()),
        code: Some(code.to_string()),
        ..Response::default()
    }
}

pub(crate) fn err_hint(code: &str, msg: &str, hint: &str) -> Response {
    Response {
        error: Some(msg.to_string()),
        code: Some(code.to_string()),
        hint: Some(hint.into()),
        ..Response::default()
    }
}

impl From<AppError> for Response {
    fn from(e: AppError) -> Self {
        match &e {
            AppError::Validation(msg) => err_coded("VALIDATION_ERROR", msg),
            AppError::NotFound(msg) => err_coded("NOT_FOUND", msg),
            AppError::Auth(msg) => err_hint(
                "AUTH_FAILED",
                msg,
                "Check verifiable_claim fields: nonce (32 bytes, unique), timestamp \
                 within 5 minutes, domain \"nearly.social\", and public key with \
                 FullAccess on the claimed account",
            ),
            AppError::RateLimit(msg, retry_after) => {
                let mut resp = err_coded("RATE_LIMITED", msg);
                resp.retry_after = Some(*retry_after);
                resp
            }
            AppError::Storage(msg) => {
                eprintln!("[storage error] {msg}");
                err_coded("STORAGE_ERROR", "Storage operation failed")
            }
            AppError::Clock => err_coded("INTERNAL_ERROR", "Internal timing error"),
        }
    }
}

pub(crate) fn parse_u64_param(
    name: &str,
    value: Option<&String>,
    default: u64,
) -> Result<u64, Response> {
    match value {
        Some(s) => s.parse::<u64>().map_err(|_| {
            AppError::Validation(format!(
                "Invalid '{name}' value: expected numeric timestamp"
            ))
            .into()
        }),
        None => Ok(default),
    }
}

pub(crate) struct Warnings(Vec<String>);

impl Warnings {
    pub fn new() -> Self {
        Self(Vec::new())
    }

    pub fn on_err(&mut self, label: &str, r: Result<(), impl std::fmt::Display>) {
        if let Err(e) = r {
            eprintln!("[warning] {label}: {e}");
            self.0.push(format!("{label}: failed"));
        }
    }

    pub fn push(&mut self, msg: String) {
        self.0.push(msg);
    }

    pub fn extend(&mut self, other: Vec<String>) {
        self.0.extend(other);
    }

    pub fn attach(self, resp: &mut serde_json::Value) {
        if !self.0.is_empty() {
            resp["warnings"] = serde_json::json!(self.0);
        }
    }
}

#[cfg(test)]
mod enum_consistency_tests {
    use super::*;

    /// Verify that Action::as_str() matches serde serialization for every variant.
    #[test]
    fn action_as_str_matches_serde() {
        let all_actions = [
            Action::Register,
            Action::GetMe,
            Action::UpdateMe,
            Action::GetSuggested,
            Action::Follow,
            Action::Unfollow,
            Action::Heartbeat,
            Action::GetActivity,
            Action::GetNetwork,
            Action::GetNotifications,
            Action::ReadNotifications,
            Action::Endorse,
            Action::Unendorse,
            Action::Deregister,
            Action::MigrateAccount,
            Action::SetPlatforms,
            Action::ReconcileAll,
            Action::AdminDeregister,
            Action::BatchFollow,
            Action::BatchEndorse,
            Action::SmokeTestStorage,
        ];
        for action in &all_actions {
            let serde_str = serde_json::to_value(action)
                .expect("Action should serialize")
                .as_str()
                .expect("Action should serialize as string")
                .to_string();
            assert_eq!(
                action.as_str(),
                serde_str,
                "Action::{action:?} as_str() = {:?} but serde = {:?}",
                action.as_str(),
                serde_str,
            );
        }
    }
}

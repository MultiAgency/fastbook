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
    GetVrfSeed,
    /// Catch-all for actions that migrated to direct FastData writes.
    #[serde(other)]
    Other,
}

impl Action {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::GetVrfSeed => "get_vrf_seed",
            Self::Other => "other",
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
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(transparent)]
pub(crate) struct Endorsements(HashMap<String, HashMap<String, i64>>);

impl Endorsements {
    pub fn new() -> Self {
        Self(HashMap::new())
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

fn default_capabilities() -> serde_json::Value {
    serde_json::json!({})
}

// Dead in Rust but parsed by frontend/__tests__/constant-sync.test.ts
// as a cross-language source of truth.
#[allow(dead_code)]
pub(crate) const MAX_HANDLE_LEN: usize = 20;
#[allow(dead_code)]
pub(crate) const MIN_HANDLE_LEN: usize = 3;
pub(crate) const MAX_DESCRIPTION_LEN: usize = 500;
pub(crate) const MAX_TAGS: usize = 10;
pub(crate) const MAX_TAG_LEN: usize = 30;
pub(crate) const MAX_AVATAR_URL_LEN: usize = 512;
pub(crate) const MAX_CAPABILITIES_LEN: usize = 4096;
pub(crate) const NONCE_TTL_SECS: u64 = 600;
pub(crate) const MAX_CAPABILITY_DEPTH: usize = 4;

// Dead in Rust but parsed by frontend/__tests__/constant-sync.test.ts
// as a cross-language source of truth.
#[allow(dead_code)]
pub(crate) const MAX_REASON_LEN: usize = 280;
#[allow(dead_code)]
pub(crate) const MAX_SUGGESTION_LIMIT: u32 = 50;
#[allow(dead_code)]
pub(crate) const DEREGISTER_RATE_LIMIT: u32 = 1;
#[allow(dead_code)]
pub(crate) const DEREGISTER_RATE_WINDOW_SECS: u64 = 300;

#[derive(Debug)]
pub(crate) enum AppError {
    Validation(String),
    Auth(String),
    Storage(String),
    Clock,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation(msg) => write!(f, "{msg}"),
            Self::Auth(msg) => write!(f, "{msg}"),
            Self::Storage(msg) => write!(f, "{msg}"),
            Self::Clock => write!(f, "Internal timing error"),
        }
    }
}

// Dead in Rust but parsed by frontend/__tests__/constant-sync.test.ts
// as a cross-language source of truth.
#[allow(dead_code)]
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
// Response helpers
// ---------------------------------------------------------------------------

pub(crate) fn ok_response(data: serde_json::Value) -> Response {
    Response {
        success: true,
        data: Some(data),
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
            AppError::Auth(msg) => err_hint(
                "AUTH_FAILED",
                msg,
                "Check verifiable_claim fields: nonce (32 bytes, unique), timestamp \
                 within 5 minutes, domain \"nearly.social\", and public key with \
                 FullAccess on the claimed account",
            ),
            AppError::Storage(msg) => {
                eprintln!("[storage error] {msg}");
                err_coded("STORAGE_ERROR", "Storage operation failed")
            }
            AppError::Clock => err_coded("INTERNAL_ERROR", "Internal timing error"),
        }
    }
}

#[cfg(test)]
mod enum_consistency_tests {
    use super::*;

    /// Verify that Action::as_str() matches serde serialization for active variants.
    /// Other is a catch-all and doesn't round-trip through serde.
    #[test]
    fn action_as_str_matches_serde() {
        let action = Action::GetVrfSeed;
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

    /// Verify that unknown actions deserialize to Other.
    #[test]
    fn unknown_action_deserializes_to_other() {
        let val: Action = serde_json::from_str("\"follow\"").unwrap();
        assert_eq!(val, Action::Other);
    }
}

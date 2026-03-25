//! Shared types, constants, and domain limits used across the crate.

use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashMap;
use std::ops::Index;

/// Deserialize a field that can be absent, null, or a value.
/// - Absent → `None` (via `#[serde(default)]`)
/// - `null` → `Some(None)` (clear the field)
/// - `"value"` → `Some(Some("value"))` (set the field)
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
    GetProfile,
    ListAgents,
    GetSuggested,
    Follow,
    Unfollow,
    GetFollowers,
    GetFollowing,
    GetEdges,
    Heartbeat,
    GetActivity,
    GetNetwork,
    GetNotifications,
    ReadNotifications,
    ListTags,
    Health,
    Endorse,
    Unendorse,
    GetEndorsers,
    ReconcileAll,
}

impl Action {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Register => "register",
            Self::GetMe => "get_me",
            Self::UpdateMe => "update_me",
            Self::GetProfile => "get_profile",
            Self::ListAgents => "list_agents",
            Self::GetSuggested => "get_suggested",
            Self::Follow => "follow",
            Self::Unfollow => "unfollow",
            Self::GetFollowers => "get_followers",
            Self::GetFollowing => "get_following",
            Self::GetEdges => "get_edges",
            Self::Heartbeat => "heartbeat",
            Self::GetActivity => "get_activity",
            Self::GetNetwork => "get_network",
            Self::GetNotifications => "get_notifications",
            Self::ReadNotifications => "read_notifications",
            Self::ListTags => "list_tags",
            Self::Health => "health",
            Self::Endorse => "endorse",
            Self::Unendorse => "unendorse",
            Self::GetEndorsers => "get_endorsers",
            Self::ReconcileAll => "reconcile_all",
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
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default, deserialize_with = "nullable_string")]
    pub avatar_url: Option<Option<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub capabilities: Option<serde_json::Value>,
    #[serde(default)]
    pub sort: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub since: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub include_history: Option<bool>,
}

#[derive(Serialize)]
pub(crate) struct Response {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pagination: Option<Pagination>,
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
                *c = (*c - 1).max(0);
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

    pub fn total_count(&self) -> i64 {
        self.0.values().flat_map(|ns| ns.values()).sum()
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
    pub display_name: String,
    pub description: String,
    pub avatar_url: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_capabilities")]
    pub capabilities: serde_json::Value,
    pub near_account_id: String,
    pub follower_count: i64,
    #[serde(default)]
    pub unfollow_count: i64,
    pub following_count: i64,
    #[serde(default)]
    pub endorsements: Endorsements,
    pub created_at: u64,
    pub last_active: u64,
    #[serde(default)]
    pub schema_version: u8,
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
pub(crate) const MAX_DISPLAY_NAME_LEN: usize = 64;
pub(crate) const MAX_DESCRIPTION_LEN: usize = 500;
pub(crate) const MAX_TAGS: usize = 10;
pub(crate) const MAX_TAG_LEN: usize = 30;
pub(crate) const MAX_AVATAR_URL_LEN: usize = 512;
pub(crate) const MAX_CAPABILITIES_LEN: usize = 4096;
pub(crate) const MAX_REASON_LEN: usize = 280;
pub(crate) const DEFAULT_LIMIT: u32 = 25;
pub(crate) const MAX_LIMIT: u32 = 100;
pub(crate) const MAX_EDGE_SCAN: usize = 10_000;
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
const _: () = assert!(FOLLOW_RATE_WINDOW_SECS > 0, "rate window must be nonzero");
const _: () = assert!(ENDORSE_RATE_WINDOW_SECS > 0, "rate window must be nonzero");

pub(crate) const MAX_CAPABILITY_DEPTH: usize = 4;

pub(crate) const MAX_NOTIF_INDEX: usize = 500;
pub(crate) const DEDUP_WINDOW_SECS: u64 = 3600;
pub(crate) const NOTIF_RETENTION_SECS: u64 = 7 * SECS_PER_DAY;
pub(crate) const UNFOLLOW_RETENTION_SECS: u64 = 30 * SECS_PER_DAY;

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
    RateLimit(String),
    Storage(String),
    Clock(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Validation(msg) => write!(f, "{msg}"),
            Self::NotFound(msg) => write!(f, "{msg}"),
            Self::Auth(msg) => write!(f, "{msg}"),
            Self::RateLimit(msg) => write!(f, "{msg}"),
            Self::Storage(msg) => write!(f, "{msg}"),
            Self::Clock(msg) => write!(f, "{msg}"),
        }
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        Self::Storage(s)
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
            Action::GetProfile,
            Action::ListAgents,
            Action::GetSuggested,
            Action::Follow,
            Action::Unfollow,
            Action::GetFollowers,
            Action::GetFollowing,
            Action::GetEdges,
            Action::Heartbeat,
            Action::GetActivity,
            Action::GetNetwork,
            Action::GetNotifications,
            Action::ReadNotifications,
            Action::ListTags,
            Action::Health,
            Action::Endorse,
            Action::Unendorse,
            Action::GetEndorsers,
            Action::ReconcileAll,
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

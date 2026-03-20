use serde::{Deserialize, Serialize};
use std::collections::HashSet;

// ─── Request / Response ────────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
pub(crate) struct Nep413Auth {
    pub near_account_id: String,
    pub public_key: String,
    pub signature: String,
    pub nonce: String,
    pub message: String,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Action {
    Register,
    GetMe,
    UpdateMe,
    GetProfile,
    ListAgents,
    ListVerified,
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
    Health,
}

#[derive(Deserialize)]
pub(crate) struct Request {
    pub action: Action,
    #[serde(default)]
    pub auth: Option<Nep413Auth>,
    #[serde(default)]
    pub handle: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
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
    pub pagination: Option<Pagination>,
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
    pub created_at: u64,
    pub last_active: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pagination {
    pub limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

fn default_capabilities() -> serde_json::Value { serde_json::json!({}) }

// ─── Constants ─────────────────────────────────────────────────────────────

pub(crate) const MAX_HANDLE_LEN: usize = 32;
pub(crate) const MIN_HANDLE_LEN: usize = 2;
pub(crate) const MAX_DISPLAY_NAME_LEN: usize = 64;
pub(crate) const MAX_DESCRIPTION_LEN: usize = 500;
pub(crate) const MAX_TAGS: usize = 10;
pub(crate) const MAX_TAG_LEN: usize = 30;
pub(crate) const MAX_AVATAR_URL_LEN: usize = 512;
pub(crate) const MAX_CAPABILITIES_LEN: usize = 4096;
pub(crate) const DEFAULT_LIMIT: u32 = 25;
pub(crate) const MAX_LIMIT: u32 = 100;
pub(crate) const NONCE_TTL_SECS: u64 = 600;

// ─── Response constructors ─────────────────────────────────────────────────

pub(crate) fn ok_response(data: serde_json::Value) -> Response {
    Response { success: true, data: Some(data), error: None, pagination: None }
}

pub(crate) fn ok_paginated(data: serde_json::Value, limit: u32, next_cursor: Option<String>) -> Response {
    Response { success: true, data: Some(data), error: None, pagination: Some(Pagination { limit, next_cursor }) }
}

pub(crate) fn err_response(msg: &str) -> Response {
    Response { success: false, data: None, error: Some(msg.to_string()), pagination: None }
}

// ─── Reserved handles ─────────────────────────────────────────────────────

pub(crate) const RESERVED_HANDLES: &[&str] = &[
    "admin", "agent", "agents", "api", "follow", "followers", "following",
    "me", "near", "nearly", "notif", "profile", "register", "registry",
    "suggested", "system", "unfollowed", "verified",
];

// ─── Validation helpers ───────────────────────────────────────────────────

pub(crate) fn validate_handle(handle: &str) -> Result<String, String> {
    let lower = handle.to_lowercase();
    if lower.len() < MIN_HANDLE_LEN || lower.len() > MAX_HANDLE_LEN {
        return Err(format!("Handle must be {MIN_HANDLE_LEN}-{MAX_HANDLE_LEN} characters"));
    }
    if !lower.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("Handle must be alphanumeric or underscore".to_string());
    }
    if RESERVED_HANDLES.contains(&lower.as_str()) {
        return Err("Handle is reserved".to_string());
    }
    Ok(lower)
}

pub(crate) fn validate_description(desc: &str) -> Result<(), String> {
    if desc.len() > MAX_DESCRIPTION_LEN {
        return Err(format!("Description max {MAX_DESCRIPTION_LEN} chars"));
    }
    Ok(())
}

pub(crate) fn validate_display_name(name: &str) -> Result<(), String> {
    if name.len() > MAX_DISPLAY_NAME_LEN {
        return Err(format!("Display name max {MAX_DISPLAY_NAME_LEN} chars"));
    }
    Ok(())
}

pub(crate) fn validate_avatar_url(url: &str) -> Result<(), String> {
    if url.len() > MAX_AVATAR_URL_LEN {
        return Err(format!("Avatar URL max {MAX_AVATAR_URL_LEN} chars"));
    }
    if !url.starts_with("https://") {
        return Err("Avatar URL must use https://".to_string());
    }
    if url.chars().any(|c| c.is_control()) {
        return Err("Avatar URL contains invalid characters".to_string());
    }
    Ok(())
}

pub(crate) fn validate_capabilities(caps: &serde_json::Value) -> Result<(), String> {
    let serialized = serde_json::to_string(caps).map_err(|e| format!("Invalid capabilities: {e}"))?;
    if serialized.len() > MAX_CAPABILITIES_LEN {
        return Err(format!("Capabilities JSON max {MAX_CAPABILITIES_LEN} bytes"));
    }
    Ok(())
}

pub(crate) fn validate_tags(tags: &[String]) -> Result<Vec<String>, String> {
    if tags.len() > MAX_TAGS {
        return Err(format!("Maximum {MAX_TAGS} tags"));
    }
    let mut seen = HashSet::new();
    let mut validated = Vec::new();
    for tag in tags {
        let t = tag.to_lowercase();
        if t.len() > MAX_TAG_LEN {
            return Err(format!("Tag must be at most {MAX_TAG_LEN} characters"));
        }
        if !t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("Tags must be lowercase alphanumeric with hyphens".to_string());
        }
        if seen.insert(t.clone()) {
            validated.push(t);
        }
    }
    Ok(validated)
}


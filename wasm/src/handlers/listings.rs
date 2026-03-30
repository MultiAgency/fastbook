//! Handlers for listing agents, tags, health checks, and handle availability.

use crate::agent::*;
use crate::registry::{list_tags, load_agents_sorted, registry_count, SortKey};
use crate::response::*;
use crate::store::now_secs;
use crate::types::*;
use crate::validation::{self, validate_cursor};
use crate::{require_field, require_target_handle};

// RESPONSE: [Agent] + pagination { limit, next_cursor? }
pub fn handle_list_agents(
    req: &Request,
    filter: impl Fn(&AgentRecord) -> bool,
    default_sort: SortKey,
    default_limit: u32,
) -> Response {
    if let Some(c) = req.cursor.as_deref() {
        if let Err(e) = validate_cursor(c) {
            return e.into();
        }
    }
    let sort = match req.sort.as_deref() {
        Some(s) => match SortKey::parse(s) {
            Ok(k) => k,
            Err(e) => return e.into(),
        },
        None => default_sort,
    };
    let limit = req.limit.unwrap_or(default_limit).min(MAX_LIMIT) as usize;

    match load_agents_sorted(sort, limit, &req.cursor, filter) {
        Ok((agents, next_cursor)) => {
            let data: Vec<serde_json::Value> = agents.iter().map(format_agent).collect();
            ok_paginated(serde_json::json!(data), limit as u32, next_cursor, false)
        }
        Err(e) => e.into(),
    }
}

// RESPONSE: { tags: [{ tag, count }] }
pub fn handle_list_tags(_req: &Request) -> Response {
    let tags: Vec<serde_json::Value> = list_tags()
        .into_iter()
        .map(|(tag, count)| serde_json::json!({ "tag": tag, "count": count }))
        .collect();
    ok_response(serde_json::json!({ "tags": tags }))
}

// RESPONSE: { handle, available: bool, reason? }
pub fn handle_check_handle(req: &Request) -> Response {
    let h = require_target_handle!(req);
    // Reserved handles: available=false (not a format error).
    if RESERVED_HANDLES.contains(&h.as_str()) {
        return ok_response(serde_json::json!({
            "handle": h,
            "available": false,
            "reason": "reserved",
        }));
    }
    // Full format validation (delegates to the same rules used by register).
    if let Err(e) = validation::validate_handle(&h) {
        return err_coded("HANDLE_INVALID", &format!("{e}"));
    }
    // Taken handles: available=false.
    if load_agent(&h).is_some() {
        return ok_response(serde_json::json!({
            "handle": h,
            "available": false,
            "reason": "taken",
        }));
    }
    ok_response(serde_json::json!({
        "handle": h,
        "available": true,
    }))
}

// RESPONSE: { status: "ok", agent_count, server_time }
pub fn handle_health(_req: &Request) -> Response {
    let server_time = now_secs().ok();
    ok_response(serde_json::json!({
        "status": "ok",
        "agent_count": registry_count(),
        "server_time": server_time,
    }))
}

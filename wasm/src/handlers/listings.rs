//! Handlers for listing agents, tags, and health checks.

use crate::agent::*;
use crate::registry::{list_tags, load_agents_sorted, registry_count, SortKey};
use crate::response::*;
use crate::types::*;

// RESPONSE: [Agent] + pagination { limit, next_cursor? }
pub fn handle_list_agents(
    req: &Request,
    filter: impl Fn(&AgentRecord) -> bool,
    default_sort: SortKey,
    default_limit: u32,
) -> Response {
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

// RESPONSE: { status: "ok", agent_count }
pub fn handle_health(_req: &Request) -> Response {
    ok_response(serde_json::json!({
        "status": "ok",
        "agent_count": registry_count(),
    }))
}

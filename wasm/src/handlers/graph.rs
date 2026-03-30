//! Handlers for querying edges, followers, and following lists with pagination.

use crate::agent::*;
use crate::response::*;
use crate::social_graph::{format_edge, load_unfollow_history_by, load_unfollow_history_for};
use crate::store::*;
use crate::types::*;
use crate::validation::validate_cursor;
use crate::{require_agent, require_field, require_target_handle};
use std::collections::HashMap;

pub(crate) fn cursor_offset_by<T>(
    items: &[T],
    cursor: &Option<String>,
    key_fn: impl Fn(&T) -> &str,
) -> (usize, bool) {
    match cursor.as_ref() {
        None => (0, true),
        Some(c) => match items.iter().position(|item| key_fn(item) == c) {
            Some(i) => (i + 1, true),
            None => (0, false),
        },
    }
}

fn paginate_graph(
    handle: &str,
    handles: &[String],
    cursor: &Option<String>,
    limit: usize,
    edge_key_fn: impl Fn(&str, &str) -> String,
    direction: &str,
) -> Response {
    let (start, cursor_found) = cursor_offset_by(handles, cursor, |h| h.as_str());
    let mut results = Vec::with_capacity(limit);
    let mut has_more = false;
    for h in handles.iter().skip(start) {
        if results.len() >= limit {
            has_more = true;
            break;
        }
        if let Some(agent) = load_agent(h) {
            results.push(format_edge(&agent, &edge_key_fn(h, handle), direction));
        }
    }
    let next = if has_more {
        results
            .last()
            .and_then(|a| a["handle"].as_str())
            .map(String::from)
    } else {
        None
    };
    ok_paginated(
        serde_json::json!(results),
        limit as u32,
        next,
        !cursor_found,
    )
}

#[derive(Clone, Copy)]
enum GraphDir {
    Followers,
    Following,
}

fn handle_graph_list(req: &Request, dir: GraphDir) -> Response {
    let handle = require_target_handle!(req);
    if let Some(c) = req.cursor.as_deref() {
        if let Err(e) = validate_cursor(c) {
            return e.into();
        }
    }
    if !has(&keys::pub_agent(&handle)) {
        return AppError::NotFound("Agent not found").into();
    }
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
    match dir {
        GraphDir::Followers => {
            let handles = index_list(&keys::pub_followers(&handle));
            paginate_graph(
                &handle,
                &handles,
                &req.cursor,
                limit,
                keys::pub_edge,
                "incoming",
            )
        }
        GraphDir::Following => {
            let handles = index_list(&keys::pub_following(&handle));
            paginate_graph(
                &handle,
                &handles,
                &req.cursor,
                limit,
                |target, source| keys::pub_edge(source, target),
                "outgoing",
            )
        }
    }
}

// RESPONSE: [Edge] + pagination { limit, next_cursor?, cursor_reset? }
pub fn handle_get_followers(req: &Request) -> Response {
    handle_graph_list(req, GraphDir::Followers)
}
// RESPONSE: [Edge] + pagination { limit, next_cursor?, cursor_reset? }
pub fn handle_get_following(req: &Request) -> Response {
    handle_graph_list(req, GraphDir::Following)
}

// RESPONSE: { handle, edges: [Edge], edge_count, history?: [UnfollowRecord],
//   pagination: { limit, next_cursor?, cursor_reset? } }
// Edge adds: direction ("incoming"|"outgoing"|"mutual"), follow_reason?, followed_at?,
//   outgoing_reason? (mutual only), outgoing_at? (mutual only)
pub fn handle_get_edges(req: &Request) -> Response {
    let handle = require_target_handle!(req);
    if let Some(c) = req.cursor.as_deref() {
        if let Err(e) = validate_cursor(c) {
            return e.into();
        }
    }
    let agent = require_agent!(&handle);
    let direction = req.direction.as_deref().unwrap_or("both");
    if !["incoming", "outgoing", "both"].contains(&direction) {
        return err_coded(
            "VALIDATION_ERROR",
            "Invalid direction: use incoming, outgoing, or both",
        );
    }
    let include_history = req.include_history.unwrap_or(false);
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;

    let mut all_handles: Vec<(String, bool, bool)> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    if direction == "incoming" || direction == "both" {
        for fh in index_list(&keys::pub_followers(&handle)) {
            if all_handles.len() >= MAX_EDGE_SCAN {
                break;
            }
            seen.insert(fh.clone(), all_handles.len());
            all_handles.push((fh, true, false));
        }
    }
    if direction == "outgoing" || direction == "both" {
        for target in index_list(&keys::pub_following(&handle)) {
            if all_handles.len() >= MAX_EDGE_SCAN {
                break;
            }
            if let Some(&idx) = seen.get(&target) {
                all_handles[idx].2 = true;
                continue;
            }
            all_handles.push((target, false, false));
        }
    }

    let total_edges = all_handles.len();
    let (start, cursor_found) = cursor_offset_by(&all_handles, &req.cursor, |(h, _, _)| h.as_str());

    let mut edges = Vec::with_capacity(limit);
    let mut has_more = false;
    for (h, incoming, is_mutual) in all_handles.iter().skip(start) {
        if edges.len() >= limit {
            has_more = true;
            break;
        }
        if let Some(a) = load_agent(h) {
            let (edge_key, dir) = if *incoming {
                (
                    keys::pub_edge(h, &handle),
                    if *is_mutual { "mutual" } else { "incoming" },
                )
            } else {
                (keys::pub_edge(&handle, h), "outgoing")
            };
            let mut entry = format_edge(&a, &edge_key, dir);
            if *is_mutual {
                let outgoing_key = keys::pub_edge(&handle, h);
                if let Some(raw) = get_string(&outgoing_key) {
                    let out_edge = crate::social_graph::parse_edge(&raw);
                    entry["outgoing_reason"] = out_edge
                        .get("reason")
                        .cloned()
                        .unwrap_or(serde_json::json!(null));
                    entry["outgoing_at"] = out_edge
                        .get("ts")
                        .cloned()
                        .unwrap_or(serde_json::json!(null));
                }
            }
            edges.push(entry);
        }
    }

    let next = if has_more {
        edges
            .last()
            .and_then(|a| a["handle"].as_str())
            .map(String::from)
    } else {
        None
    };

    let mut history: Vec<serde_json::Value> = Vec::new();
    if include_history {
        if direction == "incoming" || direction == "both" {
            history.extend(load_unfollow_history_for(&handle));
        }
        if direction == "outgoing" || direction == "both" {
            history.extend(load_unfollow_history_by(&agent.near_account_id));
        }
    }

    // Pagination is nested inside `data` (not top-level) because get_edges
    // returns extra fields (edge_count, truncated, history) alongside the list.
    let mut pagination = serde_json::json!({ "limit": limit, "next_cursor": next });
    if !cursor_found {
        pagination["cursor_reset"] = serde_json::json!(true);
    }
    ok_response(serde_json::json!({
        "handle": handle,
        "edges": edges,
        "edge_count": total_edges,
        "truncated": total_edges >= MAX_EDGE_SCAN,
        "history": if include_history { serde_json::json!(history) } else { serde_json::json!(null) },
        "pagination": pagination,
    }))
}

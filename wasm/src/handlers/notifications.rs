//! Handlers for fetching and marking notifications as read.

use crate::agent::*;
use crate::notifications::load_notifications_since;
use crate::response::*;
use crate::store::*;
use crate::types::*;
use crate::{require_auth, require_caller, require_handle, require_timestamp};
use std::collections::HashMap;

fn notif_ts(n: &serde_json::Value) -> u64 {
    n.get("at")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(u64::MAX)
}

// RESPONSE: { notifications: [{ type, from, from_agent?, is_mutual, read, at, detail? }],
//   unread_count, pagination: { limit, next_cursor? } }
pub fn handle_get_notifications(req: &Request) -> Response {
    let (_caller, handle) = require_auth!(req);
    // Notifications default to 50 (vs DEFAULT_LIMIT=25) because clients
    // typically poll infrequently and want a larger catch-up window.
    const NOTIFICATIONS_DEFAULT_LIMIT: u32 = 50;
    let limit = req
        .limit
        .unwrap_or(NOTIFICATIONS_DEFAULT_LIMIT)
        .min(MAX_LIMIT) as usize;

    let cursor = match req.cursor.as_ref() {
        Some(s) => match s.parse::<u64>() {
            Ok(v) => Some(v),
            Err(_) => {
                return AppError::Validation(
                    "Invalid 'cursor' value: expected numeric timestamp".into(),
                )
                .into();
            }
        },
        None => None,
    };

    let read_ts: u64 = get_string(&keys::notif_read(&handle))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let mut notifs = load_notifications_since(&handle, 0);
    // Cursor is an exclusive upper bound — return notifications older than cursor.
    // Two notifications with the same timestamp but different (type, from) keys
    // could theoretically straddle a page boundary; in practice the dedup window
    // (3600 s) suppresses same-type-same-from duplicates, making collisions rare.
    if let Some(ub) = cursor {
        notifs.retain(|n| notif_ts(n) < ub);
    }
    notifs.sort_by_key(|n| std::cmp::Reverse(notif_ts(n)));

    // Take limit+1 to detect whether there's a next page.
    let has_more = notifs.len() > limit;
    let page: Vec<serde_json::Value> = notifs.into_iter().take(limit).collect();

    // Build a summary cache for unique `from` handles.
    let mut summary_cache: HashMap<String, serde_json::Value> = HashMap::new();
    for n in &page {
        if let Some(from) = n.get("from").and_then(|v| v.as_str()) {
            if !summary_cache.contains_key(from) {
                if let Some(agent) = load_agent(from) {
                    summary_cache.insert(from.to_string(), format_agent_summary(&agent));
                }
            }
        }
    }

    let mut oldest_at: Option<u64> = None;
    let results: Vec<serde_json::Value> = page
        .into_iter()
        .map(|mut n| {
            let at = notif_ts(&n);
            n["read"] = serde_json::json!(at <= read_ts);
            if let Some(from) = n.get("from").and_then(|v| v.as_str()) {
                if let Some(summary) = summary_cache.get(from) {
                    n["from_agent"] = summary.clone();
                }
            }
            oldest_at = Some(oldest_at.map_or(at, |prev: u64| prev.min(at)));
            n
        })
        .collect();

    let unread = results
        .iter()
        .filter(|n| n.get("read") == Some(&serde_json::json!(false)))
        .count();

    // Cursor is the oldest timestamp on this page. The next request filters
    // `at < cursor` to get older notifications, advancing through history.
    let next_cursor = if has_more {
        oldest_at.map(|ts| ts.to_string())
    } else {
        None
    };

    ok_paginated(
        serde_json::json!({
            "notifications": results,
            "unread_count": unread,
        }),
        limit as u32,
        next_cursor,
        false,
    )
}

// RESPONSE: { read_at }
pub fn handle_read_notifications(req: &Request) -> Response {
    let (_caller, handle) = require_auth!(req);

    let ts = require_timestamp!();
    if let Err(e) = set_string(&keys::notif_read(&handle), &ts.to_string()) {
        eprintln!("[storage error] mark notifications read: {e}");
        return err_coded("STORAGE_ERROR", "Storage operation failed");
    }

    ok_response(serde_json::json!({ "read_at": ts }))
}

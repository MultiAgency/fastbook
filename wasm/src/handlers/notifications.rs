//! Handlers for fetching and marking notifications as read.

use crate::agent::*;
use crate::notifications::load_notifications_since;
use crate::response::*;
use crate::store::*;
use crate::types::*;
use crate::{require_auth, require_caller, require_handle, require_timestamp};

// RESPONSE: { notifications: [{ type, from, is_mutual, read, at, detail? }], unread_count }
pub fn handle_get_notifications(req: &Request) -> Response {
    let (_caller, handle) = require_auth!(req);
    let limit = req.limit.unwrap_or(50).min(MAX_LIMIT) as usize;

    let since = req
        .since
        .as_ref()
        .or(req.cursor.as_ref())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let read_ts: u64 = get_string(&keys::notif_read(&handle))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let mut notifs = load_notifications_since(&handle, since);
    notifs.sort_by(|a, b| {
        let ta = a.get("at").and_then(serde_json::Value::as_u64).unwrap_or(0);
        let tb = b.get("at").and_then(serde_json::Value::as_u64).unwrap_or(0);
        tb.cmp(&ta)
    });

    let results: Vec<serde_json::Value> = notifs
        .into_iter()
        .take(limit)
        .map(|mut n| {
            let at = n.get("at").and_then(serde_json::Value::as_u64).unwrap_or(0);
            n["read"] = serde_json::json!(at <= read_ts);
            n
        })
        .collect();

    let unread = results
        .iter()
        .filter(|n| n.get("read") == Some(&serde_json::json!(false)))
        .count();

    ok_response(serde_json::json!({
        "notifications": results,
        "unread_count": unread,
    }))
}

// RESPONSE: { read_at }
pub fn handle_read_notifications(req: &Request) -> Response {
    let (_caller, handle) = require_auth!(req);

    let ts = require_timestamp!();
    if let Err(e) = set_string(&keys::notif_read(&handle), &ts.to_string()) {
        return err_response(&format!("Failed to mark notifications read: {e}"));
    }

    ok_response(serde_json::json!({ "read_at": ts }))
}

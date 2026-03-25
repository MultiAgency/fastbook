//! Notification storage: create, deduplicate, prune, and query per-agent notifications.

use crate::types::AppError;
use crate::types::{DEDUP_WINDOW_SECS, MAX_NOTIF_INDEX};
use crate::{get_json, get_string, set_json, set_string};

/// Number of recent notifications to scan for deduplication.
const DEDUP_SCAN_WINDOW: usize = 100;

fn load_notif_index(handle: &str) -> Vec<String> {
    get_json::<Vec<String>>(&crate::keys::notif_idx(handle)).unwrap_or_default()
}

fn append_notif(mut idx: Vec<String>, handle: &str, key: &str) -> Result<(), AppError> {
    idx.push(key.to_string());
    let pruned: Vec<String> = if idx.len() > MAX_NOTIF_INDEX {
        let excess = idx.len() - MAX_NOTIF_INDEX;
        let old_keys = idx[..excess].to_vec();
        idx = idx[excess..].to_vec();
        old_keys
    } else {
        Vec::new()
    };
    set_json(&crate::keys::notif_idx(handle), &idx)?;
    for old_key in &pruned {
        let _ = crate::delete(old_key);
    }
    Ok(())
}

pub(crate) const NOTIF_FOLLOW: &str = "follow";
pub(crate) const NOTIF_UNFOLLOW: &str = "unfollow";
pub(crate) const NOTIF_ENDORSE: &str = "endorse";
pub(crate) const NOTIF_UNENDORSE: &str = "unendorse";

pub(crate) fn store_notification(
    target_handle: &str,
    notif_type: &str,
    from: &str,
    is_mutual: bool,
    ts: u64,
) -> Result<(), AppError> {
    store_notification_with_detail(target_handle, notif_type, from, is_mutual, ts, None)
}

pub(crate) fn store_notification_with_detail(
    target_handle: &str,
    notif_type: &str,
    from: &str,
    is_mutual: bool,
    ts: u64,
    detail: Option<serde_json::Value>,
) -> Result<(), AppError> {
    if target_handle.is_empty() || from.is_empty() {
        return Err(AppError::Validation(
            "notification skipped — empty target or sender".into(),
        ));
    }

    let idx = load_notif_index(target_handle);
    let dominated = idx
        .iter()
        .rev()
        .take(DEDUP_SCAN_WINDOW)
        .any(|existing_key| {
            let mut parts = existing_key.splitn(6, ':');
            let (Some(_prefix), Some(_handle), Some(ts_str), Some(etype), Some(efrom)) = (
                parts.next(),
                parts.next(),
                parts.next(),
                parts.next(),
                parts.next(),
            ) else {
                return false;
            };
            let existing_ts = ts_str.parse::<u64>().unwrap_or(0);
            etype == notif_type
                && efrom == from
                && ts >= existing_ts
                && ts - existing_ts < DEDUP_WINDOW_SECS
        });
    if dominated {
        return Ok(());
    }

    let key = crate::keys::notif(target_handle, ts, notif_type, from);
    let mut val = serde_json::json!({
        "type": notif_type,
        "from": from,
        "is_mutual": is_mutual,
        "at": ts,
    });
    if let Some(d) = detail {
        val["detail"] = d;
    }
    set_string(&key, &val.to_string())?;
    if let Err(e) = append_notif(idx, target_handle, &key) {
        let _ = crate::delete(&key);
        return Err(e);
    }
    Ok(())
}

pub(crate) fn load_notifications_since(handle: &str, since: u64) -> Vec<serde_json::Value> {
    load_notif_index(handle)
        .iter()
        .filter_map(|key| {
            let val = get_string(key)?;
            let parsed: serde_json::Value = serde_json::from_str(&val).ok()?;
            let at = parsed.get("at")?.as_u64()?;
            if at > since {
                Some(parsed)
            } else {
                None
            }
        })
        .collect()
}

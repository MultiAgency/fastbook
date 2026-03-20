use crate::{w_get_json, w_get_string, w_set_json, w_set_string};

pub fn notif_index_key(handle: &str) -> String {
    crate::keys::notif_idx(handle)
}

pub fn load_notif_index(handle: &str) -> Vec<String> {
    w_get_json::<Vec<String>>(&notif_index_key(handle)).unwrap_or_default()
}

/// Max notification index entries before inline pruning kicks in.
/// Heartbeat does proper 7-day GC; this is a safety cap to prevent
/// unbounded growth if heartbeat isn't called frequently.
const MAX_NOTIF_INDEX: usize = 500;

pub fn append_notif(handle: &str, key: &str) -> Result<(), String> {
    let mut idx = load_notif_index(handle);
    idx.push(key.to_string());
    // If the index exceeds the cap, drop the oldest entries (front of the vec).
    // Notifications are appended chronologically, so the front is oldest.
    let pruned: Vec<String> = if idx.len() > MAX_NOTIF_INDEX {
        let excess = idx.len() - MAX_NOTIF_INDEX;
        let old_keys = idx[..excess].to_vec();
        idx = idx[excess..].to_vec();
        old_keys
    } else {
        Vec::new()
    };
    // Write index before deleting blobs — if the write fails, old blobs
    // remain reachable rather than becoming dangling references.
    w_set_json(&notif_index_key(handle), &idx)?;
    for old_key in &pruned {
        let _ = crate::w_delete(old_key);
    }
    Ok(())
}

pub fn store_notification(
    target_handle: &str,
    notif_type: &str,
    from: &str,
    is_mutual: bool,
    ts: u64,
) -> Result<(), String> {
    if target_handle.is_empty() || from.is_empty() {
        return Err("notification skipped — empty target or sender".into());
    }
    let key = crate::keys::notif(target_handle, ts, notif_type, from);
    let val = serde_json::json!({
        "type": notif_type,
        "from": from,
        "is_mutual": is_mutual,
        "at": ts,
    });
    w_set_string(&key, &val.to_string())
        .map_err(|e| format!("failed to store notification: {e}"))?;
    if let Err(e) = append_notif(target_handle, &key) {
        let _ = crate::w_delete(&key); // clean up orphaned blob
        return Err(format!("failed to append notification index: {e}"));
    }
    Ok(())
}

pub fn load_notifications_since(handle: &str, since: u64) -> Vec<serde_json::Value> {
    load_notif_index(handle)
        .iter()
        .filter_map(|key| {
            let val = w_get_string(key)?;
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

use outlayer::storage;
use crate::keys;
use crate::types::*;
use crate::wstore::*;
use crate::agent::*;
use crate::auth::get_caller_from;
use crate::notifications::store_notification;
use crate::social_graph::{append_unfollow_index, append_unfollow_index_by_account};
use crate::fastgraph;

// ─── Follow ────────────────────────────────────────────────────────────────

pub(crate) fn handle_follow(req: &Request) -> Response {
    let caller = match get_caller_from(req) { Ok(c) => c, Err(e) => return e };
    let target_handle = match req.handle.as_deref() {
        Some(v) => v.to_lowercase(),
        None => return err_response("Handle is required"),
    };

    let caller_handle = agent_handle_for_account(&caller);
    if caller_handle.as_deref() == Some(target_handle.as_str()) { return err_response("Cannot follow yourself"); }

    let mut target = match load_agent(&target_handle) {
        Some(a) => a,
        None => return err_response("Agent not found"),
    };
    let edge = keys::follow_edge(&caller, &target_handle);
    if w_has(&edge) { return ok_response(serde_json::json!({ "action": "already_following" })); }

    let ts = now_secs();
    let edge_val = serde_json::json!({ "ts": ts, "reason": req.reason }).to_string();
    let follower_key = keys::follower(&target_handle, &caller);
    let following_key = keys::following(&caller, &target_handle);

    // Write all edges, rolling back on failure
    if let Err(e) = w_set_string(&edge, &edge_val) {
        return err_response(&format!("Failed to write edge: {e}"));
    }
    if let Err(e) = w_set_string(&follower_key, &edge_val) {
        let _ = w_delete(&edge);
        return err_response(&format!("Failed to store follower index: {e}"));
    }
    if let Err(e) = w_set_string(&following_key, &edge_val) {
        let _ = w_delete(&edge);
        let _ = w_delete(&follower_key);
        return err_response(&format!("Failed to store following index: {e}"));
    }

    // Update target follower count, rolling back edges on failure
    let old_target = target.clone();
    target.follower_count += 1;
    if let Err(e) = save_agent_with_old(&target, Some(&old_target)) {
        let _ = w_delete(&edge);
        let _ = w_delete(&follower_key);
        let _ = w_delete(&following_key);
        return err_response(&format!("Failed to update follower count: {e}"));
    }

    // Check if this creates a mutual follow (target already follows caller)
    let is_mutual = caller_handle.as_ref()
        .map(|ch| w_has(&keys::follow_edge(&target.near_account_id, ch)))
        .unwrap_or(false);

    // Notify the target agent — collect warning if it fails
    let mut warnings: Vec<String> = Vec::new();
    let from_handle = caller_handle.as_deref().unwrap_or("unknown");
    if let Err(e) = store_notification(&target_handle, "follow", from_handle, is_mutual, ts) {
        warnings.push(format!("notification: {e}"));
    }

    // Update caller following count — retry once on failure to prevent count drift
    if let Some(ch) = &caller_handle {
        retry_agent_update(ch, |a| { a.following_count += 1; a.last_active = ts; }, "follow caller count update");
    }
    let (my_following, my_followers) = caller_handle.as_deref()
        .and_then(load_agent)
        .map(|a| (a.following_count, a.follower_count))
        .unwrap_or((0, 0));

    // Find next suggestion: who does the target follow that I don't?
    let target_following_prefix = keys::following_prefix(&target.near_account_id);
    let target_following_keys = storage::list_keys(&target_following_prefix).unwrap_or_default();
    let next = target_following_keys.iter()
        .filter_map(|key| {
            let h = key.strip_prefix(&target_following_prefix)?;
            if h == target_handle { return None; }
            if caller_handle.as_deref() == Some(h) { return None; }
            if w_has(&keys::follow_edge(&caller, h)) { return None; }
            load_agent(h)
        })
        .max_by_key(trust_score);

    let reason_str = req.reason.as_deref().unwrap_or("");
    let reasoning = if is_mutual {
        format!("{} followed {} (mutual follow). {}", from_handle, target_handle, reason_str)
    } else {
        format!("{} followed {}. {}", from_handle, target_handle, reason_str)
    };
    let chain_commit = fastgraph::chain_commit(
        vec![fastgraph::create_follow_edge(from_handle, &target_handle, req.reason.as_deref(), is_mutual)],
        reasoning.trim(),
        "follow",
    );

    let mut resp = serde_json::json!({
        "action": "followed",
        "followed": format_agent(&target),
        "yourNetwork": { "followingCount": my_following, "followerCount": my_followers },
        "chainCommit": chain_commit,
    });
    if !warnings.is_empty() { resp["warnings"] = serde_json::json!(warnings); }
    if let Some(n) = next {
        let mut suggestion = format_agent(&n);
        suggestion["reason"] = serde_json::json!(format!("Also followed by {}", target.handle));
        suggestion["followUrl"] = serde_json::json!(format!("/v1/agents/{}/follow", n.handle));
        resp["nextSuggestion"] = suggestion;
    }
    ok_response(resp)
}

// ─── Unfollow ──────────────────────────────────────────────────────────────

pub(crate) fn handle_unfollow(req: &Request) -> Response {
    let caller = match get_caller_from(req) { Ok(c) => c, Err(e) => return e };
    let th = match req.handle.as_deref() {
        Some(v) => v.to_lowercase(),
        None => return err_response("Handle is required"),
    };
    let mut target = match load_agent(&th) {
        Some(a) => a,
        None => return err_response("Agent not found"),
    };

    let edge_key = keys::follow_edge(&caller, &th);
    let follower_key = keys::follower(&th, &caller);
    let following_key = keys::following(&caller, &th);

    // Snapshot edge values before deleting so we can restore on failure
    let edge_val = match w_get_string(&edge_key) {
        Some(v) => v,
        None => return ok_response(serde_json::json!({ "action": "not_following" })),
    };
    let follower_val = w_get_string(&follower_key);
    let following_val = w_get_string(&following_key);

    let ts = now_secs();

    // Check if was mutual before we delete the edge
    let caller_handle = agent_handle_for_account(&caller);
    let was_mutual = caller_handle.as_ref()
        .map(|ch| w_has(&keys::follow_edge(&target.near_account_id, ch)))
        .unwrap_or(false);

    // Delete edges
    let _ = w_delete(&edge_key);
    let _ = w_delete(&follower_key);
    let _ = w_delete(&following_key);

    // Update target counts, restoring edges on failure
    let old_target = target.clone();
    target.follower_count = (target.follower_count - 1).max(0);
    target.unfollow_count += 1;
    if let Err(e) = save_agent_with_old(&target, Some(&old_target)) {
        if let Err(re) = w_set_string(&edge_key, &edge_val) { eprintln!("Warning: rollback failed for edge {edge_key}: {re}"); }
        if let Some(v) = &follower_val { if let Err(re) = w_set_string(&follower_key, v) { eprintln!("Warning: rollback failed for follower index: {re}"); } }
        if let Some(v) = &following_val { if let Err(re) = w_set_string(&following_key, v) { eprintln!("Warning: rollback failed for following index: {re}"); } }
        return err_response(&format!("Failed to update target agent: {e}"));
    }

    // Write audit trail and notification only after the unfollow is committed
    let mut warnings: Vec<String> = Vec::new();
    let unfollow_val = serde_json::json!({ "ts": ts, "reason": req.reason }).to_string();
    let unfollow_key = keys::unfollowed(&caller, &th, ts);
    if let Err(e) = w_set_string(&unfollow_key, &unfollow_val) {
        warnings.push(format!("audit record: {e}"));
    } else {
        // Only index the key if the audit record was actually stored
        if let Err(e) = append_unfollow_index(&th, &unfollow_key) { warnings.push(format!("unfollow index: {e}")); }
        if let Err(e) = append_unfollow_index_by_account(&caller, &unfollow_key) { warnings.push(format!("unfollow index (by account): {e}")); }
    }

    let from_handle = caller_handle.as_deref().unwrap_or("unknown");
    if let Err(e) = store_notification(&th, "unfollow", from_handle, was_mutual, ts) {
        warnings.push(format!("notification: {e}"));
    }

    // Update caller count — retry once on failure to prevent count drift
    if let Some(ch) = &caller_handle {
        retry_agent_update(ch, |a| { a.following_count = (a.following_count - 1).max(0); a.last_active = ts; }, "unfollow caller count update");
    }

    let reason_str = req.reason.as_deref().unwrap_or("");
    let reasoning = format!("{} unfollowed {}. {}", from_handle, th, reason_str);
    let chain_commit = fastgraph::chain_commit(
        vec![fastgraph::delete_follow_edge(from_handle, &th, req.reason.as_deref())],
        reasoning.trim(),
        "unfollow",
    );

    let mut resp = serde_json::json!({ "action": "unfollowed", "chainCommit": chain_commit });
    if !warnings.is_empty() { resp["warnings"] = serde_json::json!(warnings); }
    ok_response(resp)
}

// ─── Suggestion reason ─────────────────────────────────────────────────────

pub(crate) fn suggestion_reason(visits: u32, shared_tags: &[String]) -> serde_json::Value {
    if visits > 0 && !shared_tags.is_empty() {
        serde_json::json!({ "type": "graph_and_tags",
            "detail": format!("Connected through your network · Shared tags: {}", shared_tags.join(", ")),
            "sharedTags": shared_tags })
    } else if visits > 0 {
        serde_json::json!({ "type": "graph", "detail": "Connected through your network" })
    } else if !shared_tags.is_empty() {
        serde_json::json!({ "type": "shared_tags",
            "detail": format!("Shared tags: {}", shared_tags.join(", ")), "sharedTags": shared_tags })
    } else {
        serde_json::json!({ "type": "discover", "detail": "Discover new agents" })
    }
}

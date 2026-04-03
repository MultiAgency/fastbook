//! Handlers for follow and unfollow with mutual detection and suggestions.

use crate::agent::*;
use crate::keys;
use crate::store::*;
use crate::types::*;
use crate::validation::*;

/// Follow vs unfollow selector.
#[derive(Clone, Copy)]
enum SocialOp {
    Follow,
    Unfollow,
}

impl SocialOp {
    fn rate_key(&self) -> &'static str {
        match self {
            Self::Follow => "follow",
            Self::Unfollow => "unfollow",
        }
    }
    fn self_err(&self) -> (&'static str, &'static str) {
        match self {
            Self::Follow => ("SELF_FOLLOW", "Cannot follow yourself"),
            Self::Unfollow => ("SELF_UNFOLLOW", "Cannot unfollow yourself"),
        }
    }
}

/// Applies the follow/unfollow mutation using individual keys + atomic counters.
/// Returns the post-mutation caller agent on success, or a Response on error.
fn apply_social_mutation(
    req: &Request,
    op: SocialOp,
    caller_handle: &str,
    target_handle: &str,
    target: &mut AgentRecord,
    edge_key: &str,
    ts: u64,
) -> Result<AgentRecord, Response> {
    let to_resp = Response::from;

    // Check reverse edge BEFORE any mutations — needed for mutual counter accuracy.
    let reverse_edge_exists = user_has(&keys::pub_edge(target_handle, caller_handle));

    match op {
        SocialOp::Follow => {
            // Write edge metadata
            let edge_bytes =
                serde_json::to_vec(&serde_json::json!({ "ts": ts, "reason": req.reason }))
                    .map_err(|e| {
                        eprintln!("[storage error] Failed to serialize edge: {e}");
                        err_coded("INTERNAL_ERROR", "Storage operation failed")
                    })?;
            user_set(edge_key, &edge_bytes).map_err(to_resp)?;

            // Individual relationship keys
            user_set(&keys::pub_follower(target_handle, caller_handle), b"1").map_err(to_resp)?;
            user_set(&keys::pub_following_key(caller_handle, target_handle), b"1")
                .map_err(to_resp)?;

            // Atomic counters
            target.follower_count =
                user_increment(&keys::follower_count(target_handle), 1).map_err(to_resp)?;

            // Mutual counter: if target already follows caller, this creates a mutual pair.
            if reverse_edge_exists {
                let _ = user_increment(&keys::mutual_count(caller_handle), 1);
                let _ = user_increment(&keys::mutual_count(target_handle), 1);
            }
        }
        SocialOp::Unfollow => {
            // Mutual counter: if the reverse edge exists, this breaks a mutual pair.
            // Must be checked before edge deletion (already done above).
            if reverse_edge_exists {
                let _ = user_increment(&keys::mutual_count(caller_handle), -1);
                let _ = user_increment(&keys::mutual_count(target_handle), -1);
            }

            // Clear edge
            user_set(edge_key, &[]).map_err(to_resp)?;

            // Remove individual relationship keys
            user_delete_key(&keys::pub_follower(target_handle, caller_handle));
            user_delete_key(&keys::pub_following_key(caller_handle, target_handle));

            // Atomic counters
            target.follower_count =
                user_increment(&keys::follower_count(target_handle), -1).map_err(to_resp)?;
        }
    }

    save_agent(target).map_err(to_resp)?;

    let Some(mut caller_agent) = load_agent(caller_handle) else {
        return Err(err_coded("STORAGE_ERROR", "Failed to load caller agent"));
    };
    caller_agent.last_active = ts;

    match op {
        SocialOp::Follow => {
            caller_agent.following_count =
                user_increment(&keys::following_count(caller_handle), 1).map_err(to_resp)?;
        }
        SocialOp::Unfollow => {
            caller_agent.following_count =
                user_increment(&keys::following_count(caller_handle), -1).map_err(to_resp)?;
        }
    }

    save_agent(&caller_agent).map_err(to_resp)?;

    increment_rate_limit(op.rate_key(), caller_handle, FOLLOW_RATE_WINDOW_SECS);
    Ok(caller_agent)
}

struct SocialResponseCtx<'a> {
    op: SocialOp,
    caller_handle: &'a str,
    caller_agent: &'a AgentRecord,
    target_handle: &'a str,
    target: &'a AgentRecord,
    was_mutual: Option<bool>,
    ts: u64,
}

fn build_social_response(ctx: &SocialResponseCtx<'_>) -> Response {
    let mut warnings = Warnings::new();

    match ctx.op {
        SocialOp::Follow => {
            let is_mutual = user_has(&keys::pub_edge(ctx.target_handle, ctx.caller_handle));
            warnings.on_err(
                "notification",
                store_notification(
                    ctx.target_handle,
                    NOTIF_FOLLOW,
                    ctx.caller_handle,
                    is_mutual,
                    ctx.ts,
                    None,
                ),
            );
        }
        SocialOp::Unfollow => {
            warnings.on_err(
                "notification",
                store_notification(
                    ctx.target_handle,
                    NOTIF_UNFOLLOW,
                    ctx.caller_handle,
                    ctx.was_mutual.unwrap_or(false),
                    ctx.ts,
                    None,
                ),
            );
        }
    }

    let (my_following, my_followers) = (
        ctx.caller_agent.following_count,
        ctx.caller_agent.follower_count,
    );

    let mut resp = match ctx.op {
        SocialOp::Follow => {
            let mut r = serde_json::json!({
                "action": "followed",
                "followed": format_agent(ctx.target),
                "your_network": { "following_count": my_following, "follower_count": my_followers },
            });
            let target_following =
                handles_from_prefix(&keys::pub_following_prefix(ctx.target_handle));
            let next = target_following
                .iter()
                .filter(|h| h.as_str() != ctx.target_handle && h.as_str() != ctx.caller_handle)
                .filter(|h| !user_has(&keys::pub_edge(ctx.caller_handle, h)))
                .take(FOLLOW_SUGGESTION_SAMPLE)
                .filter_map(|h| load_agent(h))
                .max_by_key(|a| a.follower_count);
            if let Some(n) = next {
                let mut s = format_suggestion(
                    &n,
                    serde_json::json!(format!("Also followed by {}", ctx.target.handle)),
                );
                s["reason_data"] = serde_json::json!({
                    "shared_tags": [],
                    "network_connected": true,
                });
                r["next_suggestion"] = s;
            }
            r
        }
        SocialOp::Unfollow => {
            serde_json::json!({
                "action": "unfollowed",
                "your_network": { "following_count": my_following, "follower_count": my_followers },
            })
        }
    };
    warnings.attach(&mut resp);
    ok_response(resp)
}

fn idempotent_social_response(
    action: &str,
    caller_handle: &str,
    target: Option<&AgentRecord>,
) -> Response {
    let (my_following, my_followers) = load_agent(caller_handle)
        .map(|a| (a.following_count, a.follower_count))
        .unwrap_or((0, 0));
    let mut json = serde_json::json!({
        "action": action,
        "your_network": { "following_count": my_following, "follower_count": my_followers },
    });
    if let Some(t) = target {
        json["followed"] = serde_json::json!(format_agent(t));
    }
    ok_response(json)
}

fn execute_social_op(req: &Request, op: SocialOp) -> Response {
    // --- Validate ---
    let (_caller, caller_handle) = require_auth!(req);
    if let Err(e) = check_rate_limit(
        op.rate_key(),
        &caller_handle,
        FOLLOW_RATE_LIMIT,
        FOLLOW_RATE_WINDOW_SECS,
    ) {
        return e.into();
    }
    let target_handle = require_target_handle!(req);
    let (code, msg) = op.self_err();
    if target_handle == caller_handle {
        return err_coded(code, msg);
    }
    let mut target = require_agent!(&target_handle);
    if let Some(reason) = &req.reason {
        if let Err(e) = validate_reason(reason) {
            return e.into();
        }
    }
    let edge_key = keys::pub_edge(&caller_handle, &target_handle);
    match op {
        SocialOp::Follow if user_has(&edge_key) => {
            return idempotent_social_response("already_following", &caller_handle, Some(&target));
        }
        SocialOp::Unfollow if !user_has(&edge_key) => {
            return idempotent_social_response("not_following", &caller_handle, None);
        }
        _ => {}
    }
    let ts = require_timestamp!();
    let was_mutual = matches!(op, SocialOp::Unfollow)
        .then(|| user_has(&keys::pub_edge(&target_handle, &caller_handle)));

    // --- Mutate ---
    let caller_agent = match apply_social_mutation(
        req,
        op,
        &caller_handle,
        &target_handle,
        &mut target,
        &edge_key,
        ts,
    ) {
        Ok(agent) => agent,
        Err(resp) => return resp,
    };

    // --- Notify + respond ---
    build_social_response(&SocialResponseCtx {
        op,
        caller_handle: &caller_handle,
        caller_agent: &caller_agent,
        target_handle: &target_handle,
        target: &target,
        was_mutual,
        ts,
    })
}

// RESPONSE: { action: "followed"|"already_following", followed?: Agent,
//   your_network: { following_count, follower_count }, next_suggestion?: Suggestion }
pub fn handle_follow(req: &Request) -> Response {
    execute_social_op(req, SocialOp::Follow)
}
// RESPONSE: { action: "unfollowed"|"not_following",
//   your_network: { following_count, follower_count } }
pub fn handle_unfollow(req: &Request) -> Response {
    execute_social_op(req, SocialOp::Unfollow)
}

pub(crate) fn suggestion_reason(
    visits: u32,
    shared_tags: &[String],
) -> (serde_json::Value, serde_json::Value) {
    let text = if visits > 0 && !shared_tags.is_empty() {
        format!("Network · shared tags: {}", shared_tags.join(", "))
    } else if visits > 0 {
        "Connected through your network".to_string()
    } else if !shared_tags.is_empty() {
        format!("Shared tags: {}", shared_tags.join(", "))
    } else {
        "Popular on the network".to_string()
    };
    let data = serde_json::json!({
        "shared_tags": shared_tags,
        "network_connected": visits > 0,
    });
    (serde_json::json!(text), data)
}

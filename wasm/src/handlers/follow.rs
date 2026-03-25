//! Handlers for follow and unfollow with mutual detection and suggestions.

use crate::agent::*;
use crate::keys;
use crate::notifications::{store_notification, NOTIF_FOLLOW, NOTIF_UNFOLLOW};
use crate::response::*;
use crate::social_graph::{append_unfollow_index, append_unfollow_index_by_account};
use crate::store::*;
use crate::transaction::Transaction;
use crate::types::*;
use crate::validation::*;
use crate::{
    require_agent, require_auth, require_caller, require_field, require_handle,
    require_target_handle, require_timestamp,
};

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

fn apply_social_mutation(
    req: &Request,
    op: SocialOp,
    caller_handle: &str,
    target_handle: &str,
    target: &mut AgentRecord,
    edge_key: &str,
    ts: u64,
) -> Response {
    let edge_bytes = match &op {
        SocialOp::Follow => {
            match serde_json::to_vec(&serde_json::json!({ "ts": ts, "reason": req.reason })) {
                Ok(b) => b,
                Err(e) => return err_response(&format!("Failed to serialize edge: {e}")),
            }
        }
        SocialOp::Unfollow => vec![],
    };

    let mut txn = Transaction::new();
    if let Some(r) = txn.set_public("Failed to write edge", edge_key, &edge_bytes) {
        return r;
    }

    let before = target.clone();
    match &op {
        SocialOp::Follow => {
            if let Some(r) = txn.index_append(
                "Failed to update follower index",
                &keys::pub_followers(target_handle),
                caller_handle,
            ) {
                return r;
            }
            if let Some(r) = txn.index_append(
                "Failed to update following index",
                &keys::pub_following(caller_handle),
                target_handle,
            ) {
                return r;
            }
            target.follower_count = target.follower_count.saturating_add(1);
        }
        SocialOp::Unfollow => {
            if let Some(r) = txn.index_remove(
                "Failed to update follower index",
                &keys::pub_followers(target_handle),
                caller_handle,
            ) {
                return r;
            }
            if let Some(r) = txn.index_remove(
                "Failed to update following index",
                &keys::pub_following(caller_handle),
                target_handle,
            ) {
                return r;
            }
            target.follower_count = target.follower_count.saturating_sub(1);
            target.unfollow_count = target.unfollow_count.saturating_add(1);
        }
    }

    if let Some(r) = txn.save_agent("Failed to update target agent", target, &before) {
        return r;
    }

    let Some(caller_before) = load_agent(caller_handle) else {
        return txn.rollback_response("Failed to load caller agent");
    };
    let mut caller_agent = caller_before.clone();
    match &op {
        SocialOp::Follow => {
            caller_agent.following_count = caller_agent.following_count.saturating_add(1);
        }
        SocialOp::Unfollow => {
            caller_agent.following_count = caller_agent.following_count.saturating_sub(1);
        }
    }
    caller_agent.last_active = ts;
    if let Some(r) = txn.save_agent(
        "Failed to update caller agent",
        &caller_agent,
        &caller_before,
    ) {
        return r;
    }

    increment_rate_limit(op.rate_key(), caller_handle, FOLLOW_RATE_WINDOW_SECS);
    ok_response(serde_json::json!(null)) // sentinel — caller uses separate response builder
}

struct SocialResponseCtx<'a> {
    req: &'a Request,
    op: SocialOp,
    caller: &'a str,
    caller_handle: &'a str,
    target_handle: &'a str,
    target: &'a AgentRecord,
    was_mutual: Option<bool>,
    ts: u64,
}

fn build_social_response(ctx: &SocialResponseCtx<'_>) -> Response {
    let mut warnings = Warnings::new();

    match ctx.op {
        SocialOp::Follow => {
            let is_mutual = has(&keys::pub_edge(ctx.target_handle, ctx.caller_handle));
            warnings.on_err(
                "notification",
                store_notification(
                    ctx.target_handle,
                    NOTIF_FOLLOW,
                    ctx.caller_handle,
                    is_mutual,
                    ctx.ts,
                ),
            );
        }
        SocialOp::Unfollow => {
            let unfollow_val =
                serde_json::json!({ "ts": ctx.ts, "reason": ctx.req.reason }).to_string();
            let unfollow_key = keys::unfollowed(ctx.caller, ctx.target_handle, ctx.ts);
            match set_string(&unfollow_key, &unfollow_val) {
                Ok(()) => {
                    warnings.on_err(
                        "unfollow index",
                        append_unfollow_index(ctx.target_handle, &unfollow_key),
                    );
                    warnings.on_err(
                        "unfollow index by account",
                        append_unfollow_index_by_account(ctx.caller, &unfollow_key),
                    );
                }
                Err(e) => warnings.push(format!("unfollow audit record: {e}")),
            }
            warnings.on_err(
                "notification",
                store_notification(
                    ctx.target_handle,
                    NOTIF_UNFOLLOW,
                    ctx.caller_handle,
                    ctx.was_mutual.unwrap_or(false),
                    ctx.ts,
                ),
            );
        }
    }

    let (my_following, my_followers) = load_agent(ctx.caller_handle)
        .map(|a| (a.following_count, a.follower_count))
        .unwrap_or((0, 0));

    let mut resp = match ctx.op {
        SocialOp::Follow => {
            let mut r = serde_json::json!({
                "action": "followed",
                "followed": format_agent(ctx.target),
                "your_network": { "following_count": my_following, "follower_count": my_followers },
            });
            let target_following = index_list(&keys::pub_following(ctx.target_handle));
            let next = target_following
                .iter()
                .filter(|h| *h != ctx.target_handle && h.as_str() != ctx.caller_handle)
                .filter(|h| !has(&keys::pub_edge(ctx.caller_handle, h)))
                .take(FOLLOW_SUGGESTION_SAMPLE)
                .filter_map(|h| load_agent(h))
                .max_by_key(|a| a.follower_count);
            if let Some(n) = next {
                r["next_suggestion"] = format_suggestion(
                    &n,
                    serde_json::json!(format!("Also followed by {}", ctx.target.handle)),
                );
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

fn execute_social_op(req: &Request, op: SocialOp) -> Response {
    // --- Validate ---
    let (caller, caller_handle) = require_auth!(req);
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
        SocialOp::Follow if has(&edge_key) => {
            return ok_response(serde_json::json!({ "action": "already_following" }))
        }
        SocialOp::Unfollow if !has(&edge_key) => {
            return ok_response(serde_json::json!({ "action": "not_following" }))
        }
        _ => {}
    }
    let ts = require_timestamp!();
    let was_mutual = matches!(op, SocialOp::Unfollow)
        .then(|| has(&keys::pub_edge(&target_handle, &caller_handle)));

    // --- Mutate ---
    let mutation_result = apply_social_mutation(
        req,
        op,
        &caller_handle,
        &target_handle,
        &mut target,
        &edge_key,
        ts,
    );
    if !mutation_result.success {
        return mutation_result;
    }

    // --- Notify + respond ---
    build_social_response(&SocialResponseCtx {
        req,
        op,
        caller: &caller,
        caller_handle: &caller_handle,
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

pub(crate) fn suggestion_reason(visits: u32, shared_tags: &[String]) -> serde_json::Value {
    if visits > 0 && !shared_tags.is_empty() {
        serde_json::json!(format!("Network · shared tags: {}", shared_tags.join(", ")))
    } else if visits > 0 {
        serde_json::json!("Connected through your network")
    } else if !shared_tags.is_empty() {
        serde_json::json!(format!("Shared tags: {}", shared_tags.join(", ")))
    } else {
        serde_json::json!("Popular on the network")
    }
}

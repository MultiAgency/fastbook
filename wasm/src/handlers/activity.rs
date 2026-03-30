//! Handlers for heartbeat, activity deltas, and network stats.

use crate::agent::*;
use crate::notifications::load_notifications_since;
use crate::response::*;
use crate::social_graph::{new_followers_since, new_following_count_since, new_following_since};
use crate::store::*;
use crate::transaction::Transaction;
use crate::types::*;
use crate::{require_agent, require_auth, require_caller, require_handle, require_timestamp};

pub(crate) fn ts_from_suffix(key: &str) -> Option<u64> {
    key.rsplit(':').next()?.parse().ok()
}

pub(crate) fn ts_from_notif_key(key: &str) -> Option<u64> {
    key.split(':').nth(2)?.parse().ok()
}

// RESPONSE: { agent: Agent, delta: { since, new_followers: [{handle, description}],
//   new_followers_count, new_following_count, profile_completeness, notifications: [Notif] },
//   suggested_action: { action, hint } }
pub fn handle_heartbeat(req: &Request) -> Response {
    let (caller, handle) = require_auth!(req);
    if let Err(e) = check_rate_limit(
        "heartbeat",
        &handle,
        HEARTBEAT_RATE_LIMIT,
        HEARTBEAT_RATE_WINDOW_SECS,
    ) {
        return e.into();
    }
    let before = require_agent!(&handle);
    let mut agent = before.clone();

    let _ = index_append(keys::pub_agents(), &handle);

    let previous_active = agent.last_active;
    agent.last_active = require_timestamp!();

    // Probabilistic count reconciliation (~2% of heartbeats).
    // Recomputes follower/following/endorsement counts from actual index lengths
    // to self-heal any drift caused by prior partial failures.
    if agent.last_active % RECONCILE_MODULUS == 0 {
        recount_social(&mut agent);
    }

    let mut txn = Transaction::new();
    if let Some(r) = txn.save_agent("Failed to save agent", &agent, &before) {
        return r;
    }

    increment_rate_limit("heartbeat", &handle, HEARTBEAT_RATE_WINDOW_SECS);

    let new_followers = new_followers_since(&handle, previous_active);
    let new_followers_count = new_followers.len();
    let new_following_count = new_following_count_since(&handle, previous_active);
    let notifications = load_notifications_since(&handle, previous_active);

    let mut warnings = Warnings::new();
    let cutoff = agent.last_active.saturating_sub(NOTIF_RETENTION_SECS);
    warnings.on_err(
        &format!("prune notifications for {handle}"),
        prune_index(&keys::notif_idx(&handle), cutoff, ts_from_notif_key),
    );

    let unfollow_cutoff = agent.last_active.saturating_sub(UNFOLLOW_RETENTION_SECS);
    warnings.on_err(
        &format!("prune unfollow index for {handle}"),
        prune_index(
            &keys::unfollow_idx(&handle),
            unfollow_cutoff,
            ts_from_suffix,
        ),
    );
    warnings.on_err(
        &format!("prune unfollow-by index for {caller}"),
        prune_index(
            &keys::unfollow_idx_by(&caller),
            unfollow_cutoff,
            ts_from_suffix,
        ),
    );
    warnings.on_err(
        &format!("prune suggestion audit for {caller}"),
        prune_index(&keys::suggested_idx(&caller), cutoff, ts_from_suffix),
    );

    let nonce_cutoff = agent.last_active.saturating_sub(NONCE_TTL_SECS);
    warnings.on_err(
        "prune nonces",
        prune_nonce_index(keys::nonce_idx(), nonce_cutoff),
    );

    let mut resp = serde_json::json!({
        "agent": format_agent(&agent),
        "delta": {
            "since": previous_active,
            "new_followers": new_followers,
            "new_followers_count": new_followers_count,
            "new_following_count": new_following_count,
            "profile_completeness": profile_completeness(&agent),
            "notifications": notifications,
        },
        "suggested_action": { "action": "get_suggested", "hint": "Call get_suggested for VRF-fair recommendations." },
    });
    warnings.attach(&mut resp);
    ok_response(resp)
}

// RESPONSE: { since, new_followers: [{handle, description}], new_following: [{handle, description}] }
pub fn handle_get_activity(req: &Request) -> Response {
    let (_caller, handle) = require_auth!(req);

    let now = match now_secs() {
        Ok(t) => t,
        Err(e) => return e.into(),
    };
    let since = match parse_u64_param(
        "since",
        req.cursor.as_ref(),
        now.saturating_sub(SECS_PER_DAY),
    ) {
        Ok(v) => v,
        Err(e) => return e,
    };

    let new_followers = new_followers_since(&handle, since);
    let new_following = new_following_since(&handle, since);

    ok_response(serde_json::json!({
        "since": since,
        "new_followers": new_followers,
        "new_following": new_following,
    }))
}

// RESPONSE: { follower_count, following_count, mutual_count, last_active, created_at }
pub fn handle_get_network(req: &Request) -> Response {
    let (_caller, handle) = require_auth!(req);
    let agent = require_agent!(&handle);

    let following_handles = index_list(&keys::pub_following(&handle));
    let edge_keys: Vec<String> = following_handles
        .iter()
        .filter(|th| th.as_str() != handle)
        .map(|th| keys::pub_edge(th, &handle))
        .collect();
    let mutual_count = has_batch(&edge_keys).into_iter().filter(|&b| b).count();

    ok_response(serde_json::json!({
        "follower_count": agent.follower_count,
        "following_count": agent.following_count,
        "mutual_count": mutual_count,
        "last_active": agent.last_active,
        "created_at": agent.created_at,
    }))
}

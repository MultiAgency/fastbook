//! Handlers for heartbeat, activity deltas, and network stats.

use crate::agent::*;
use crate::registry::{new_followers_since, new_following_count_since, new_following_since};
use crate::store::*;
use crate::types::*;

pub(crate) fn ts_from_notif_key(key: &str) -> Option<u64> {
    key.split(':').nth(2)?.parse().ok()
}

// RESPONSE: { agent: Agent, delta: { since, new_followers: [{handle, description}],
//   new_followers_count, new_following_count, profile_completeness, notifications: [Notif] },
//   suggested_action: { action, hint } }
pub fn handle_heartbeat(req: &Request) -> Response {
    let (_caller, handle) = require_auth!(req);
    if let Err(e) = check_rate_limit(
        "heartbeat",
        &handle,
        HEARTBEAT_RATE_LIMIT,
        HEARTBEAT_RATE_WINDOW_SECS,
    ) {
        return e.into();
    }
    let mut agent = require_agent!(&handle);

    let _ = user_set(&keys::pub_agent_reg(&handle), b"1");

    let previous_active = agent.last_active;
    agent.last_active = require_timestamp!();

    // Probabilistic count reconciliation (~2% of heartbeats).
    // Recomputes follower/following/endorsement counts from actual index lengths
    // to self-heal any drift caused by prior partial failures.
    let counts_changed = if agent.last_active % RECONCILE_MODULUS == 0 {
        let fc_before = agent.follower_count;
        let gc_before = agent.following_count;
        recount_social(&mut agent);
        agent.follower_count != fc_before || agent.following_count != gc_before
    } else {
        false
    };

    let (agent_val, agent_bytes) = match agent_to_value_and_bytes(&agent) {
        Ok(pair) => pair,
        Err(e) => return e.into(),
    };

    if let Err(e) = save_agent_preserialized(&agent_bytes, &agent) {
        return e.into();
    }

    increment_rate_limit("heartbeat", &handle, HEARTBEAT_RATE_WINDOW_SECS);

    // Sync to FastData KV: agent record + sorted/active entry.
    // When reconciliation corrected counts, sync all sorted indices so
    // list_agents ordering reflects the corrected values.
    {
        let mut sync = crate::fastdata::SyncBatch::new();
        if counts_changed {
            sync.agent(&agent);
        } else {
            // Normal heartbeat: only last_active changed, so only sync the
            // agent record and sorted/active (skip other sorted indices).
            sync.push(crate::fastdata::agent_key(&handle), agent_val);
            sync.push(
                format!("sorted/active/{}", agent.handle),
                serde_json::json!({ "ts": agent.last_active }),
            );
        }
        sync.flush();
    }

    let new_followers = new_followers_since(&handle, previous_active);
    let new_followers_count = new_followers.len();
    let new_following_count = new_following_count_since(&handle, previous_active);
    let notifications = load_notifications_since(&handle, previous_active);

    let mut warnings = Warnings::new();
    // Probabilistic notification prune (~10% of heartbeats).
    // 7-day retention; at 3h heartbeat intervals, 10% ≈ prune every ~30h.
    if agent.last_active % 10 == 0 {
        let cutoff = agent.last_active.saturating_sub(NOTIF_RETENTION_SECS);
        warnings.on_err(
            &format!("prune notifications for {handle}"),
            prune_index(&keys::notif_idx(&handle), cutoff, ts_from_notif_key),
        );
    }
    // Nonce GC handled solely by auth.rs (~2% of NEP-413 calls).

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

    let mutual_count = user_counter(&keys::mutual_count(&handle)).max(0);

    ok_response(serde_json::json!({
        "follower_count": agent.follower_count,
        "following_count": agent.following_count,
        "mutual_count": mutual_count,
        "last_active": agent.last_active,
        "created_at": agent.created_at,
    }))
}

//! Handlers for heartbeat, activity deltas, and network stats.

use crate::agent::*;
use crate::registry::{new_followers_since, new_following_count_since, new_following_since};
use crate::store::*;
use crate::types::*;
use outlayer::env;

pub(crate) fn ts_from_notif_key(key: &str) -> Option<u64> {
    key.split(':').nth(2)?.parse().ok()
}

/// Pick the most useful next action for this agent's current state.
/// Only nudges `register_platforms` if the agent has a wallet key (signer
/// matches caller), since verifiable_claim-only agents can't register platforms.
fn suggested_action(agent: &AgentRecord, caller: &str) -> serde_json::Value {
    let completeness = profile_completeness(agent);
    if completeness < 100 {
        return serde_json::json!({
            "action": "update_me",
            "hint": "Complete your profile — add description, tags, and capabilities to improve discoverability.",
            "profile_completeness": completeness,
        });
    }
    // Check if caller authenticated with a wallet key (signer == caller).
    // Server-paid path (verifiable_claim) sets signer to the server account,
    // so signer != caller means no wallet key available for platform registration.
    let has_wallet_key = env::signer_account_id()
        .and_then(|s| {
            // Payment keys: extract owner before first ':'
            let account = if s.contains(':') {
                s.split_once(':')?.0.to_string()
            } else {
                s
            };
            Some(account == caller)
        })
        .unwrap_or(false);
    if agent.platforms.is_empty() && has_wallet_key {
        return serde_json::json!({
            "action": "register_platforms",
            "hint": "Register on external platforms (market.near.ai, near.fm) to expand your presence.",
        });
    }
    serde_json::json!({
        "action": "get_suggested",
        "hint": "Call get_suggested for VRF-fair recommendations.",
    })
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
    let mut agent = require_agent!(&handle);

    let _ = user_set(&keys::pub_agent_reg(&handle), b"1");

    let previous_active = agent.last_active;
    agent.last_active = require_timestamp!();

    // Probabilistic count reconciliation (~2% of heartbeats).
    // Recomputes follower/following/endorsement counts from actual index lengths
    // to self-heal any drift caused by prior partial failures.
    let _counts_changed = if agent.last_active % RECONCILE_MODULUS == 0 {
        let fc_before = agent.follower_count;
        let gc_before = agent.following_count;
        recount_social(&mut agent);
        agent.follower_count != fc_before || agent.following_count != gc_before
    } else {
        false
    };

    if let Err(e) = save_agent(&agent) {
        return e.into();
    }

    increment_rate_limit("heartbeat", &handle, HEARTBEAT_RATE_WINDOW_SECS);

    // FastData KV sync is handled by the proxy layer (fastdata-sync.ts)
    // using the agent's custody wallet, not server-side WASM.

    let new_followers = new_followers_since(&handle, previous_active);
    let new_followers_count = new_followers.len();
    let new_following_count = new_following_count_since(&handle, previous_active);
    let mut notifications = load_notifications_since(&handle, previous_active);
    for n in &mut notifications {
        n["id"] = serde_json::json!(super::notifications::notif_id(n));
    }

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
        "suggested_action": suggested_action(&agent, &caller),
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

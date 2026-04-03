//! Handlers for agent deregistration and account migration.
//!
//! Deregistration proceeds in non-transactional phases (delete record, sever
//! edges, remove endorsements, cleanup aux data).  A crash between phases may
//! leave orphaned data; `reconcile_all` (admin action) repairs any drift.

use crate::agent::*;
use crate::nep413;
use crate::registry::update_tag_counts;
use crate::store::*;
use crate::types::*;
use outlayer::env;
use std::collections::HashSet;

/// Remove all follow edges for a deregistering agent.
///
/// Collects followers and following upfront, then processes each direction
/// with simple decrements (matching the pattern in follow.rs).  Mutual
/// relationships are detected via a HashSet built from the followers list,
/// so mutual_count is decremented exactly once per mutual peer regardless
/// of processing order.
fn remove_follow_edges(handle: &str, warnings: &mut Warnings) {
    let followers = handles_from_prefix(&keys::pub_follower_prefix(handle));
    let following = handles_from_prefix(&keys::pub_following_prefix(handle));
    let following_set: HashSet<&str> = following.iter().map(String::as_str).collect();

    // Peers who follow this agent: decrement their following_count.
    for peer in &followers {
        let _ = delete(&keys::pub_edge(peer, handle));
        user_delete_key(&keys::pub_following_key(peer, handle));

        if let Some(mut peer_agent) = load_agent(peer) {
            peer_agent.following_count = peer_agent.following_count.saturating_sub(1);
            if write_agent_record(&peer_agent).is_err() {
                warnings.push(format!("failed to update follower {peer}"));
            }
        }
        let _ = user_increment(&keys::following_count(peer), -1);

        // Mutual: this peer follows handle AND handle follows this peer.
        // Decremented here only — the following loop skips mutual peers.
        if following_set.contains(peer.as_str()) {
            let _ = user_increment(&keys::mutual_count(peer), -1);
        }
    }

    // Peers this agent follows: decrement their follower_count.
    for peer in &following {
        let _ = delete(&keys::pub_edge(handle, peer));
        user_delete_key(&keys::pub_follower(peer, handle));

        if let Some(mut peer_agent) = load_agent(peer) {
            peer_agent.follower_count = peer_agent.follower_count.saturating_sub(1);
            if write_agent_record(&peer_agent).is_err() {
                warnings.push(format!("failed to update followed {peer}"));
            }
        }
        let _ = user_increment(&keys::follower_count(peer), -1);
    }
}

/// Remove all endorsements given by and received by this agent.
fn remove_endorsements(handle: &str, agent: &AgentRecord, warnings: &mut Warnings) {
    // Endorsements received: iterate agent's endorsable pairs
    let endorsable =
        super::endorse::collect_endorsable(Some(&agent.tags), Some(&agent.capabilities));
    for (ns, val) in &endorsable {
        let endorsers = handles_from_prefix(&keys::pub_endorser_prefix(handle, ns, val));
        for endorser_handle in &endorsers {
            let _ = delete(&keys::endorsement(handle, ns, val, endorser_handle));
            user_delete_key(&keys::pub_endorser(handle, ns, val, endorser_handle));
            user_delete_key(&keys::pub_endorsement_by(endorser_handle, handle, ns, val));
            // If no endorsements remain from this endorser to the deregistering agent,
            // remove the endorsed_target marker.
            if handles_from_prefix(&keys::pub_endorsement_by_prefix(endorser_handle, handle))
                .is_empty()
            {
                user_delete_key(&keys::pub_endorsed_target(endorser_handle, handle));
            }
        }
    }

    // Endorsements given: iterate endorsed_target markers instead of the full registry.
    let targets = handles_from_prefix(&keys::pub_endorsed_target_prefix(handle));
    for target in &targets {
        let prefix = keys::pub_endorsement_by_prefix(handle, target);
        let by_keys = user_list(&prefix);
        if by_keys.is_empty() {
            // Clean up the target marker even if no pairs remain.
            user_delete_key(&keys::pub_endorsed_target(handle, target));
            continue;
        }
        if let Some(mut target_agent) = load_agent(target) {
            let mut changed = false;
            for by_key in &by_keys {
                // Extract ns:val from the full key by stripping the prefix.
                let pair = by_key.strip_prefix(&prefix).unwrap_or(by_key);
                if let Some((ns, val)) = pair.split_once(':') {
                    let ekey = keys::endorsement(target, ns, val, handle);
                    // Guard: only decrement if the record still exists, so that
                    // orphaned keys don't cause spurious decrements.
                    if has(&ekey) {
                        target_agent.endorsements.decrement(ns, val);
                        let _ = delete(&ekey);
                        changed = true;
                    }
                    user_delete_key(&keys::pub_endorser(target, ns, val, handle));
                    user_delete_key(&keys::pub_endorsement_by(handle, target, ns, val));
                }
            }
            if changed {
                target_agent.endorsements.prune_empty();
                if write_agent_record(&target_agent).is_err() {
                    warnings.push(format!("failed to update endorsement target {target}"));
                }
            }
        }
        user_delete_key(&keys::pub_endorsed_target(handle, target));
    }
}

/// Delete notifications, rate limit keys, follower/following keys, and counters.
fn delete_aux_data(handle: &str, caller: &str) {
    purge_index(&keys::notif_idx(handle));
    let _ = delete(&keys::notif_read(handle));
    // Clean up remaining individual follower/following keys for this handle.
    for k in user_list(&keys::pub_follower_prefix(handle)) {
        user_delete_key(&k);
    }
    for k in user_list(&keys::pub_following_prefix(handle)) {
        user_delete_key(&k);
    }
    // Reset atomic counters.
    for counter_fn in [
        keys::follower_count,
        keys::following_count,
        keys::mutual_count,
    ] {
        let ck = counter_fn(handle);
        let cur = user_counter(&ck);
        if cur != 0 {
            let _ = user_increment(&ck, -cur);
        }
    }

    for action in RATE_LIMITED_ACTIONS {
        let _ = delete(&keys::rate(action, handle));
    }
    let _ = delete(&keys::rate("suggested", caller));
}

/// Extract the NEAR account ID from the runtime signer, handling the
/// `owner:subkey` format used by OutLayer custody wallets.
fn parse_signer_account() -> Result<String, Response> {
    let s = env::signer_account_id()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            err_hint(
            "AUTH_REQUIRED",
            "Account migration requires wallet key authentication.",
            "Use your wk_* key (Authorization: Bearer wk_...) to authenticate migration requests.",
        )
        })?;
    if !s.contains(':') {
        return Ok(s);
    }
    s.split_once(':')
        .map(|(owner, _)| owner)
        .filter(|o| !o.is_empty())
        .map(str::to_string)
        .ok_or_else(|| err_coded("AUTH_FAILED", "Invalid signer account ID"))
}

/// Core deregistration logic shared by both user and admin deregister handlers.
///
/// Each phase continues on partial failure (recording warnings) so that later
/// phases still execute.  Any counter drift from a mid-crash is repaired by
/// heartbeat reconciliation or admin reconcile_all.
fn do_deregister(handle: &str, agent: &AgentRecord, account_for_aux: &str) -> Warnings {
    let mut warnings = Warnings::new();

    // Phase 1: Delete agent record and remove from registry.
    // Done first so the agent is invisible even if later cleanup fails.
    let _ = delete(&keys::pub_agent(handle));

    user_delete_key(&keys::pub_agent_reg(handle));
    let count = handles_from_prefix(keys::pub_agent_reg_prefix()).len();
    let _ = set_public(keys::pub_meta_count(), count.to_string().as_bytes());
    update_tag_counts(&agent.tags, &[]);
    let _ = delete(&keys::near_account(&agent.near_account_id));

    // Phase 2: Sever follow edges with simple decrements.
    // Matches the pattern used by follow.rs for unfollow.  Any counter drift
    // from a partial failure is repaired by reconcile_all.
    remove_follow_edges(handle, &mut warnings);

    // Phase 3: Remove endorsements given by and received by this agent.
    remove_endorsements(handle, agent, &mut warnings);

    // FastData KV sync (null-writes for agent + sorted keys) is handled by
    // the proxy layer (fastdata-sync.ts) using the agent's custody wallet.
    // Edge/endorser cleanup in FastData KV is deferred to reconcile_all.

    // Phase 4: Delete auxiliary data and rate limit keys.
    delete_aux_data(handle, account_for_aux);

    warnings
}

// RESPONSE: { action: "deregistered", handle }
pub fn handle_deregister(req: &Request) -> Response {
    let (caller, handle) = require_auth!(req);
    // Rate limit keyed on NEAR account (not handle) so the limit survives
    // deregistration and doesn't penalise a different account reusing the handle.
    if let Err(e) = check_rate_limit(
        "deregister",
        &caller,
        DEREGISTER_RATE_LIMIT,
        DEREGISTER_RATE_WINDOW_SECS,
    ) {
        return e.into();
    }
    let agent = require_agent!(&handle);

    let warnings = do_deregister(&handle, &agent, &caller);

    increment_rate_limit("deregister", &caller, DEREGISTER_RATE_WINDOW_SECS);

    let mut resp = serde_json::json!({
        "action": "deregistered",
        "handle": handle,
    });
    warnings.attach(&mut resp);
    ok_response(resp)
}

// RESPONSE: { action: "admin_deregistered", handle, near_account_id }
pub fn handle_admin_deregister(req: &Request) -> Response {
    let caller = require_caller!(req);
    if let Err(e) = crate::auth::require_admin(&caller) {
        return e;
    }
    let handle = require_field!(req.handle.as_deref(), "Handle is required").to_lowercase();
    let agent = require_agent!(&handle);

    let warnings = do_deregister(&handle, &agent, &agent.near_account_id);

    let mut resp = serde_json::json!({
        "action": "admin_deregistered",
        "handle": handle,
        "near_account_id": agent.near_account_id,
    });
    warnings.attach(&mut resp);
    ok_response(resp)
}

// RESPONSE: { action: "migrated", agent: Agent, old_account, new_account }
pub fn handle_migrate_account(req: &Request) -> Response {
    // Authenticate the OLD account via runtime signer (wk_* key).
    // The verifiable_claim is reserved for proving NEW account ownership
    // below, so we authenticate the caller from NEAR_SENDER_ID directly
    // instead of using require_auth! (which would consume the claim).
    let caller = match parse_signer_account() {
        Ok(c) => c,
        Err(r) => return r,
    };
    let handle = require_handle!(&caller);
    if let Err(e) = check_rate_limit(
        "migrate_account",
        &handle,
        MIGRATE_RATE_LIMIT,
        MIGRATE_RATE_WINDOW_SECS,
    ) {
        return e.into();
    }
    let before = require_agent!(&handle);

    let new_account = require_field!(req.new_account_id.as_deref(), "new_account_id is required");
    if let Err(e) = nep413::validate_near_account_id(new_account) {
        return err_coded("VALIDATION_ERROR", &format!("Invalid new_account_id: {e}"));
    }

    // Verify ownership of the new account via verifiable_claim.
    let Some(claim) = req.verifiable_claim.as_ref() else {
        return err_hint(
            "AUTH_REQUIRED",
            "Account migration requires a verifiable_claim proving ownership of the new account.",
            "Sign a message with action \"migrate_account\" and account_id set to the new_account_id.",
        );
    };
    let now = match now_secs() {
        Ok(t) => t,
        Err(e) => return e.into(),
    };
    if let Err(e) = nep413::verify_auth(claim, now * 1000, req.action.as_str()) {
        return err_hint(
            "AUTH_FAILED",
            &format!("New account claim verification failed: {e}"),
            "The verifiable_claim must be signed for action \"migrate_account\" with the new account's key.",
        );
    }
    if claim.near_account_id != new_account {
        return err_coded(
            "AUTH_FAILED",
            "verifiable_claim.near_account_id must match new_account_id",
        );
    }
    if let Err(e) = nep413::verify_public_key_ownership(&claim.near_account_id, &claim.public_key) {
        return err_hint(
            "AUTH_FAILED",
            &format!("New account key verification failed: {e}"),
            "The public key in verifiable_claim must exist on the new NEAR account with FullAccess permission.",
        );
    }

    let old_account = before.near_account_id.clone();
    if old_account == new_account {
        return err_coded(
            "VALIDATION_ERROR",
            "New account is the same as current account",
        );
    }
    if agent_handle_for_account(new_account).is_some() {
        return err_coded(
            "ALREADY_REGISTERED",
            "New account already has an agent registered",
        );
    }

    // Consume the nonce after all validation passes so that obviously
    // invalid requests (same account, target taken) don't waste nonces.
    // Note: nonce storage is user-scoped (same payment key holder);
    // cross-user replay relies on TLS transport security.
    let nonce_key = keys::nonce(&claim.nonce);
    match set_if_absent(&nonce_key, &now.to_string()) {
        Ok(true) => {
            let _ = index_append(keys::nonce_idx(), &nonce_key);
        }
        Ok(false) => {
            return err_hint(
                "NONCE_REPLAY",
                "This nonce has already been used",
                "Generate a new 32-byte random nonce and re-sign",
            )
        }
        Err(_) => return err_coded("INTERNAL_ERROR", "Nonce verification failed — please retry"),
    }

    // Write order: new mapping → agent record → delete old mapping.
    //
    // New mapping first: if the agent record write fails, the stale new
    // mapping is harmless (points to handle whose agent still says old
    // account) and the old account can retry because before.near_account_id
    // still equals old_account, so the "same account" guard won't fire.
    //
    // Agent record second: once both mapping and record are written, the
    // migration is logically complete even if deleting the old mapping fails
    // (the old mapping becomes a stale pointer that will be overwritten or
    // cleaned up by reconcile_all).
    if let Err(e) = set_public(&keys::near_account(new_account), handle.as_bytes()) {
        return err_coded(
            "INTERNAL_ERROR",
            &format!("Failed to write new account mapping: {e}"),
        );
    }

    let mut agent = before.clone();
    agent.near_account_id = new_account.to_string();
    if save_agent(&agent).is_err() {
        return err_coded("INTERNAL_ERROR", "Failed to save agent");
    }

    // Clear old account mapping so agent_handle_for_account() returns None.
    let _ = delete(&keys::near_account(&old_account));

    increment_rate_limit("migrate_account", &handle, MIGRATE_RATE_WINDOW_SECS);

    ok_response(serde_json::json!({
        "action": "migrated",
        "agent": format_agent(&agent),
        "old_account": old_account,
        "new_account": new_account,
    }))
}

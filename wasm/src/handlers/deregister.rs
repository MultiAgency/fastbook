//! Handlers for agent deregistration and account migration.
//!
//! Deregistration proceeds in multiple non-transactional phases (delete record,
//! sever edges, remove endorsements, cleanup aux data).  A crash between phases
//! may leave orphaned data.  This is safe because `reconcile_all` (admin action)
//! detects and repairs all such orphans: it prunes dead handles from follower/
//! following indices, rebuilds endorsement counts, and reconstructs sorted indices.

use crate::agent::*;
use crate::nep413;
use crate::registry::{remove_sorted_indices, update_tag_counts};
use crate::response::*;
use crate::store::*;
use crate::transaction::Transaction;
use crate::types::*;
use crate::{require_agent, require_auth, require_caller, require_field, require_handle};
use outlayer::env;

/// Sever follow edges in one direction and recount connected agents.
/// `list_key_fn` returns the index to iterate (e.g. followers of handle),
/// `edge_key_fn` returns the edge key for deletion,
/// `peer_index_fn` returns the peer's reverse index to update,
/// `count_field_fn` returns the recount key for the peer's reverse index.
fn sever_edges(
    handle: &str,
    list_key: &str,
    edge_key_fn: impl Fn(&str) -> String,
    peer_index_fn: impl Fn(&str) -> String,
    count_fn: impl Fn(&[String]) -> i64,
    set_count: impl Fn(&mut AgentRecord, i64),
    warnings: &mut Warnings,
) {
    let peers = index_list(list_key);
    for peer in &peers {
        let _ = delete(&edge_key_fn(peer));
        if let Some(mut peer_agent) = load_agent(peer) {
            let peer_idx = peer_index_fn(peer);
            // index_remove returns the remaining entries, avoiding a second read.
            let Ok(remaining) = index_remove(&peer_idx, handle) else {
                warnings.push(format!("failed to update index for {peer}"));
                continue;
            };
            set_count(&mut peer_agent, count_fn(&remaining));
            if write_agent_record(&peer_agent).is_err() {
                warnings.push(format!("failed to update connected agent {peer}"));
            }
        }
    }
}

/// Remove all endorsements given by and received by this agent.
fn remove_endorsements(handle: &str, agent: &AgentRecord, warnings: &mut Warnings) {
    // Endorsements received: iterate agent's endorsable pairs
    let endorsable =
        super::endorse::collect_endorsable(Some(&agent.tags), Some(&agent.capabilities));
    for (ns, val) in &endorsable {
        let endorser_idx_key = keys::endorsers(handle, ns, val);
        let endorsers = index_list(&endorser_idx_key);
        for endorser_handle in &endorsers {
            let _ = delete(&keys::endorsement(handle, ns, val, endorser_handle));
            let _ = index_remove(
                &keys::endorsement_by(endorser_handle, handle),
                &format!("{ns}:{val}"),
            );
            // If no endorsements remain from this endorser to the deregistering agent,
            // remove the target from their endorsed_targets index.
            if index_list(&keys::endorsement_by(endorser_handle, handle)).is_empty() {
                let _ = index_remove(&keys::endorsed_targets(endorser_handle), handle);
            }
        }
        let _ = delete(&endorser_idx_key);
    }

    // Endorsements given: iterate the endorsed_targets index instead of the full registry.
    let targets = index_list(&keys::endorsed_targets(handle));
    for target in &targets {
        let by_key = keys::endorsement_by(handle, target);
        let endorsed_pairs = index_list(&by_key);
        if endorsed_pairs.is_empty() {
            continue;
        }
        if let Some(mut target_agent) = load_agent(target) {
            let mut changed = false;
            for pair in &endorsed_pairs {
                if let Some((ns, val)) = pair.split_once(':') {
                    let ekey = keys::endorsement(target, ns, val, handle);
                    // Guard: only decrement if the record still exists, so that
                    // orphaned index entries don't cause spurious decrements.
                    if has(&ekey) {
                        target_agent.endorsements.decrement(ns, val);
                        let _ = delete(&ekey);
                        changed = true;
                    }
                    let _ = index_remove(&keys::endorsers(target, ns, val), handle);
                }
            }
            if changed {
                target_agent.endorsements.prune_empty();
                if write_agent_record(&target_agent).is_err() {
                    warnings.push(format!("failed to update endorsement target {target}"));
                }
            }
        }
        let _ = delete(&by_key);
    }
}

/// Delete notifications, unfollow history, suggestions, and rate limit keys.
fn delete_aux_data(handle: &str, caller: &str) {
    purge_index(&keys::notif_idx(handle));
    let _ = delete(&keys::notif_read(handle));
    purge_index(&keys::unfollow_idx(handle));
    purge_index(&keys::unfollow_idx_by(caller));
    purge_index(&keys::suggested_idx(caller));
    let _ = delete(&keys::endorsed_targets(handle));

    let _ = delete(&keys::pub_followers(handle));
    let _ = delete(&keys::pub_following(handle));

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

    let mut warnings = Warnings::new();

    // Deregistration runs 4 non-transactional phases. Each phase continues on
    // partial failure (recording warnings) so that later phases still execute.
    // If a crash interrupts mid-deregister, peers may have stale counts until
    // the next heartbeat reconciliation or admin reconcile_all.

    // Phase 1: Delete agent record and remove from registry.
    // Done first so the agent is invisible even if later cleanup fails.
    let _ = delete(&keys::pub_agent(&handle));
    remove_sorted_indices(&agent);
    let _ = index_remove(keys::pub_agents(), &handle);
    let count = index_list(keys::pub_agents()).len();
    let _ = set_public(keys::pub_meta_count(), count.to_string().as_bytes());
    update_tag_counts(&agent.tags, &[]);
    let _ = delete(&keys::near_account(&agent.near_account_id));

    // Phase 2: Sever follow edges and recount connected agents.
    // Counts are derived from the index *after* removal rather than decremented,
    // keeping count and index in agreement even if the count had drifted.
    sever_edges(
        &handle,
        &keys::pub_followers(&handle),
        |peer| keys::pub_edge(peer, &handle),
        keys::pub_following,
        |remaining| remaining.len() as i64,
        |a, c| a.following_count = c,
        &mut warnings,
    );
    sever_edges(
        &handle,
        &keys::pub_following(&handle),
        |peer| keys::pub_edge(&handle, peer),
        keys::pub_followers,
        |remaining| remaining.len() as i64,
        |a, c| a.follower_count = c,
        &mut warnings,
    );

    // Phase 3: Remove endorsements given by and received by this agent.
    remove_endorsements(&handle, &agent, &mut warnings);

    // Phase 4: Delete auxiliary data and rate limit keys.
    delete_aux_data(&handle, &caller);

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

    let mut warnings = Warnings::new();

    // Reuse the same 4-phase deregistration as handle_deregister.
    let _ = delete(&keys::pub_agent(&handle));
    remove_sorted_indices(&agent);
    let _ = index_remove(keys::pub_agents(), &handle);
    let count = index_list(keys::pub_agents()).len();
    let _ = set_public(keys::pub_meta_count(), count.to_string().as_bytes());
    update_tag_counts(&agent.tags, &[]);
    let _ = delete(&keys::near_account(&agent.near_account_id));

    sever_edges(
        &handle,
        &keys::pub_followers(&handle),
        |peer| keys::pub_edge(peer, &handle),
        keys::pub_following,
        |remaining| remaining.len() as i64,
        |a, c| a.following_count = c,
        &mut warnings,
    );
    sever_edges(
        &handle,
        &keys::pub_following(&handle),
        |peer| keys::pub_edge(&handle, peer),
        keys::pub_followers,
        |remaining| remaining.len() as i64,
        |a, c| a.follower_count = c,
        &mut warnings,
    );

    remove_endorsements(&handle, &agent, &mut warnings);
    delete_aux_data(&handle, &agent.near_account_id);

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

    let mut txn = Transaction::new();

    if let Some(r) = txn.set_public(
        "Failed to write new account mapping",
        &keys::near_account(new_account),
        handle.as_bytes(),
    ) {
        return r;
    }

    // Write empty bytes rather than delete: Transaction only supports
    // set_public, and an empty value makes agent_handle_for_account()
    // return None (empty string won't match any handle).
    if let Some(r) = txn.set_public(
        "Failed to clear old account mapping",
        &keys::near_account(&old_account),
        &[],
    ) {
        return r;
    }

    let mut agent = before.clone();
    agent.near_account_id = new_account.to_string();
    if let Some(r) = txn.save_agent("Failed to save agent", &agent, &before) {
        return r;
    }

    increment_rate_limit("migrate_account", &handle, MIGRATE_RATE_WINDOW_SECS);

    // Migrate account-keyed storage (best-effort — these expire naturally if missed)
    let uf_by = index_list(&keys::unfollow_idx_by(&old_account));
    if !uf_by.is_empty() {
        let _ = set_json(&keys::unfollow_idx_by(new_account), &uf_by);
        let _ = delete(&keys::unfollow_idx_by(&old_account));
    }
    let sug = index_list(&keys::suggested_idx(&old_account));
    if !sug.is_empty() {
        let _ = set_json(&keys::suggested_idx(new_account), &sug);
        let _ = delete(&keys::suggested_idx(&old_account));
    }

    ok_response(serde_json::json!({
        "action": "migrated",
        "agent": format_agent(&agent),
        "old_account": old_account,
        "new_account": new_account,
    }))
}

//! Batch handlers: execute multiple social operations in a single WASM invocation.
//!
//! Each batch handler authenticates once, checks rate limits for the full batch,
//! then executes each sub-operation with direct writes.  This reduces
//! the number of serialised WASM invocations from N to 1, which is the primary
//! bottleneck when OutLayer serialises executions per project.

use crate::agent::*;
use crate::keys;
use crate::store::*;
use crate::types::*;
use crate::validation::*;
use std::collections::HashMap;

use super::endorse::collect_endorsable;

/// Maximum targets per batch call.
const MAX_BATCH_SIZE: usize = 20;

/// Build a per-target error entry for batch result arrays.
fn batch_err(handle: &str, reason: &str) -> serde_json::Value {
    serde_json::json!({ "handle": handle, "action": "error", "error": reason })
}

/// Validate and extract targets array, enforcing batch size limit.
fn validated_targets(req: &Request) -> Result<&[String], Response> {
    match req.targets.as_deref() {
        Some(t) if !t.is_empty() && t.len() <= MAX_BATCH_SIZE => Ok(t),
        Some([]) => Err(err_coded(
            "VALIDATION_ERROR",
            "Targets array is required and must not be empty",
        )),
        Some(_) => Err(err_coded(
            "VALIDATION_ERROR",
            &format!("Too many targets (max {MAX_BATCH_SIZE})"),
        )),
        None => Err(err_coded(
            "VALIDATION_ERROR",
            "Targets array is required and must not be empty",
        )),
    }
}

// ---------------------------------------------------------------------------
// batch_follow
// ---------------------------------------------------------------------------

pub fn handle_batch_follow(req: &Request) -> Response {
    let (_caller, caller_handle) = require_auth!(req);
    let targets = match validated_targets(req) {
        Ok(t) => t,
        Err(r) => return r,
    };

    // Rate limit: check remaining budget for the entire batch.
    let follow_budget = match check_rate_limit_budget(
        "follow",
        &caller_handle,
        FOLLOW_RATE_LIMIT,
        FOLLOW_RATE_WINDOW_SECS,
    ) {
        Ok(b) => b,
        Err(e) => return e.into(),
    };

    let ts = require_timestamp!();
    let edge_bytes = match serde_json::to_vec(&serde_json::json!({ "ts": ts })) {
        Ok(b) => b,
        Err(e) => return err_coded("INTERNAL_ERROR", &format!("Serialization error: {e}")),
    };
    let mut results: Vec<serde_json::Value> = Vec::with_capacity(targets.len());
    let mut followed_count: u32 = 0;
    // Collect post-mutation target agents to reuse in FastData sync (avoids re-loading).
    let mut updated_targets: HashMap<String, AgentRecord> = HashMap::new();
    // Load caller agent once; update in-place across iterations.
    let mut caller_agent = load_agent(&caller_handle);

    for raw_target in targets {
        let target_handle = raw_target.trim().to_lowercase();
        if target_handle.is_empty() {
            results.push(batch_err(raw_target, "empty handle"));
            continue;
        }
        if target_handle == caller_handle {
            results.push(batch_err(&target_handle, "cannot follow yourself"));
            continue;
        }

        let edge_key = keys::pub_edge(&caller_handle, &target_handle);
        if has(&edge_key) {
            results.push(serde_json::json!({
                "handle": target_handle,
                "action": "already_following",
            }));
            continue;
        }

        let Some(mut target) = load_agent(&target_handle) else {
            results.push(batch_err(&target_handle, "agent not found"));
            continue;
        };

        // Check per-op rate limit budget (capped to remaining window allowance).
        if followed_count >= follow_budget {
            results.push(batch_err(&target_handle, "rate limit reached within batch"));
            continue;
        }

        if set_public(&edge_key, &edge_bytes).is_err() {
            results.push(batch_err(&target_handle, "storage error"));
            continue;
        }
        let _ = set_public(&keys::pub_follower(&target_handle, &caller_handle), b"1");
        let _ = set_public(
            &keys::pub_following_key(&caller_handle, &target_handle),
            b"1",
        );

        // Counter increments — any drift is self-healed by heartbeat's
        // probabilistic recount (~2% of heartbeats).
        let fc = user_increment(&keys::follower_count(&target_handle), 1).unwrap_or(0);
        let gc = user_increment(&keys::following_count(&caller_handle), 1).unwrap_or(0);

        target.follower_count = fc;
        let _ = save_agent(&target);
        updated_targets.insert(target_handle.clone(), target);

        // Update caller's following count in-place.
        if let Some(ref mut ca) = caller_agent {
            ca.following_count = gc;
            ca.last_active = ts;
            let _ = save_agent(ca);
        }

        increment_rate_limit("follow", &caller_handle, FOLLOW_RATE_WINDOW_SECS);
        followed_count += 1;

        // Fire-and-forget notification + mutual counter.
        let is_mutual = has(&keys::pub_edge(&target_handle, &caller_handle));
        if is_mutual {
            let _ = user_increment(&keys::mutual_count(&caller_handle), 1);
            let _ = user_increment(&keys::mutual_count(&target_handle), 1);
        }
        let _ = store_notification(
            &target_handle,
            NOTIF_FOLLOW,
            &caller_handle,
            is_mutual,
            ts,
            None,
        );

        results.push(serde_json::json!({
            "handle": target_handle,
            "action": "followed",
        }));
    }

    let (my_following, my_followers) = caller_agent
        .as_ref()
        .map(|a| (a.following_count, a.follower_count))
        .unwrap_or((0, 0));

    // Sync to FastData KV: all followed edges, updated agents, sorted entries.
    if followed_count > 0 {
        let mut sync = crate::fastdata::SyncBatch::new();
        if let Some(a) = &caller_agent {
            sync.agent(a);
        }
        for res in &results {
            if res.get("action").and_then(|a| a.as_str()) == Some("followed") {
                if let Some(th) = res.get("handle").and_then(|h| h.as_str()) {
                    sync.edge_follow(&caller_handle, th, ts, None);
                    if let Some(a) = updated_targets.get(th) {
                        sync.agent(a);
                    }
                }
            }
        }
        sync.flush();
    }

    ok_response(serde_json::json!({
        "action": "batch_followed",
        "results": results,
        "your_network": { "following_count": my_following, "follower_count": my_followers },
    }))
}

// ---------------------------------------------------------------------------
// batch_endorse
// ---------------------------------------------------------------------------

pub fn handle_batch_endorse(req: &Request) -> Response {
    let (_caller, caller_handle) = require_auth!(req);
    let targets = match validated_targets(req) {
        Ok(t) => t,
        Err(r) => return r,
    };

    let endorse_budget = match check_rate_limit_budget(
        "endorse",
        &caller_handle,
        ENDORSE_RATE_LIMIT,
        ENDORSE_RATE_WINDOW_SECS,
    ) {
        Ok(b) => b,
        Err(e) => return e.into(),
    };

    let endorse_tags = req.tags.clone().unwrap_or_default();
    if endorse_tags.is_empty()
        && req
            .capabilities
            .as_ref()
            .map(serde_json::Value::is_null)
            .unwrap_or(true)
    {
        return err_coded("VALIDATION_ERROR", "Tags or capabilities are required");
    }

    let ts = require_timestamp!();
    let mut results: Vec<serde_json::Value> = Vec::with_capacity(targets.len());
    let mut endorsed_count: u32 = 0;
    // Collect post-mutation agents and endorsement changes for FastData sync.
    let mut updated_targets: HashMap<String, (AgentRecord, HashMap<String, Vec<String>>)> =
        HashMap::new();

    let record = serde_json::json!({ "ts": ts, "reason": req.reason });
    let record_bytes = match serde_json::to_vec(&record) {
        Ok(b) => b,
        Err(e) => return err_coded("INTERNAL_ERROR", &format!("Serialization error: {e}")),
    };

    for raw_target in targets {
        let target_handle = raw_target.trim().to_lowercase();
        if target_handle.is_empty() || target_handle == caller_handle {
            let reason = if target_handle == caller_handle {
                "cannot endorse yourself"
            } else {
                "empty handle"
            };
            results.push(batch_err(raw_target, reason));
            continue;
        }

        let Some(target) = load_agent(&target_handle) else {
            results.push(batch_err(&target_handle, "agent not found"));
            continue;
        };

        if endorsed_count >= endorse_budget {
            results.push(batch_err(&target_handle, "rate limit reached within batch"));
            continue;
        }

        let endorsable = collect_endorsable(Some(&target.tags), Some(&target.capabilities));

        // Resolve tags for this target (tags namespace wins, then capability fallback).
        let mut resolved: Vec<(String, String)> = Vec::new();
        for tag in &endorse_tags {
            let val = tag.to_lowercase();
            if let Some((ns, v)) = val.split_once(':') {
                if endorsable.contains(&(ns.to_string(), v.to_string())) {
                    resolved.push((ns.to_string(), v.to_string()));
                }
            } else if endorsable.contains(&("tags".to_string(), val.clone())) {
                resolved.push(("tags".to_string(), val));
            } else {
                // Fall back to capability namespaces for bare strings.
                let caps_matches: Vec<&str> = endorsable
                    .iter()
                    .filter(|(ns, v)| *v == val && ns != "tags")
                    .map(|(ns, _)| ns.as_str())
                    .collect();
                if caps_matches.len() == 1 {
                    resolved.push((caps_matches[0].to_string(), val));
                }
                // Ambiguous or no match: silently skip (best-effort batch semantics).
            }
        }
        if let Some(caps) = req.capabilities.as_ref().filter(|c| !c.is_null()) {
            for (ns, val) in extract_capability_pairs(caps) {
                if endorsable.contains(&(ns.clone(), val.clone())) {
                    resolved.push((ns, val));
                }
            }
        }

        if resolved.is_empty() {
            results.push(batch_err(&target_handle, "no endorsable items match"));
            continue;
        }

        let mut agent = target;
        let mut endorsed: HashMap<String, Vec<String>> = HashMap::new();
        let first_endorsement = !has(&keys::pub_endorsed_target(&caller_handle, &target_handle));

        for (ns, v) in &resolved {
            let ekey = keys::endorsement(&target_handle, ns, v, &caller_handle);
            if has(&ekey) {
                continue;
            }
            if set_public(&ekey, &record_bytes).is_err() {
                continue;
            }
            agent.endorsements.increment(ns, v);
            let _ = set_public(
                &keys::pub_endorsement_by(&caller_handle, &target_handle, ns, v),
                b"1",
            );
            let _ = set_public(
                &keys::pub_endorser(&target_handle, ns, v, &caller_handle),
                b"1",
            );
            endorsed.entry(ns.clone()).or_default().push(v.clone());
        }

        if first_endorsement && !endorsed.is_empty() {
            let _ = set_public(
                &keys::pub_endorsed_target(&caller_handle, &target_handle),
                b"1",
            );
        }

        if !endorsed.is_empty() {
            let _ = save_agent(&agent);
            increment_rate_limit("endorse", &caller_handle, ENDORSE_RATE_WINDOW_SECS);
            endorsed_count += 1;
            let _ = store_notification(
                &target_handle,
                NOTIF_ENDORSE,
                &caller_handle,
                false,
                ts,
                Some(serde_json::json!(&endorsed)),
            );
            updated_targets.insert(target_handle.clone(), (agent, endorsed.clone()));
        }

        results.push(serde_json::json!({
            "handle": target_handle,
            "action": "endorsed",
            "endorsed": endorsed,
        }));
    }

    // Sync to FastData KV: reuse already-loaded agents from the loop.
    if endorsed_count > 0 {
        let mut sync = crate::fastdata::SyncBatch::new();
        for (th, (agent, changed)) in &updated_targets {
            sync.agent(agent);
            sync.endorsers(th, changed);
        }
        sync.flush();
    }

    ok_response(serde_json::json!({
        "action": "batch_endorsed",
        "results": results,
    }))
}

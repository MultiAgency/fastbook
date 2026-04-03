//! Handler for personalized follow suggestions via PageRank scoring.

use super::follow::suggestion_reason;
use crate::agent::*;
use crate::registry::load_agents_by_followers;
use crate::store::*;
use crate::suggest;
use crate::types::*;
use std::collections::{HashMap, HashSet};

const SUGGESTION_SALT_KEY: &str = "suggestion_salt";

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() < 2 || !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len() / 2)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16))
        .collect::<Result<Vec<u8>, _>>()
        .ok()
}

fn caller_seed(caller: &str) -> Vec<u8> {
    let mut seed = caller.as_bytes().to_vec();
    // Best-effort entropy: if clock fails, seed is less random but the request
    // will likely fail at require_timestamp!() shortly after anyway.
    seed.extend_from_slice(&now_secs().unwrap_or(0).to_le_bytes());

    let salt = match get_string(SUGGESTION_SALT_KEY) {
        Some(s) => s,
        None => {
            // FNV-1a 64-bit hash for better distribution across similar callers
            let mut h: u64 = 0xcbf29ce484222325;
            for &b in seed.iter() {
                h ^= b as u64;
                h = h.wrapping_mul(0x100000001b3);
            }
            let salt_val = format!("{h:016x}");
            let _ = set_string(SUGGESTION_SALT_KEY, &salt_val);
            salt_val
        }
    };
    seed.extend_from_slice(salt.as_bytes());
    seed
}

// RESPONSE: { agents: [Suggestion], vrf?: { output, proof, alpha } }
pub fn handle_get_suggested(req: &Request) -> Response {
    let caller = require_caller!(req);
    if let Err(e) = check_rate_limit(
        "suggested",
        &caller,
        SUGGEST_RATE_LIMIT,
        SUGGEST_RATE_WINDOW_SECS,
    ) {
        return e.into();
    }
    let limit = req.limit.unwrap_or(10).min(MAX_SUGGESTION_LIMIT) as usize;

    let vrf_result = std::panic::catch_unwind(|| outlayer::vrf::random("suggestions"))
        .ok()
        .and_then(Result::ok);
    let rng_seed: Vec<u8> = vrf_result
        .as_ref()
        .and_then(|vr| decode_hex(&vr.output_hex))
        .unwrap_or_else(|| caller_seed(&caller));
    let mut rng = suggest::Rng::from_bytes(&rng_seed);

    let resolved = agent_handle_for_account(&caller);
    let own_handle = resolved.as_ref().map(|(h, _)| h.as_str());
    let follows: Vec<String> = own_handle
        .map(|h| handles_from_prefix(&keys::pub_following_prefix(h)))
        .unwrap_or_default();
    let follow_set: HashSet<String> = follows.iter().cloned().collect();
    let my_tags: Vec<String> = resolved
        .as_ref()
        .map(|(_, a)| a.tags.clone())
        .unwrap_or_default();

    let mut outgoing_cache: HashMap<String, Vec<String>> = HashMap::new();
    let mut get_outgoing = |handle: &str| -> Vec<String> {
        if let Some(cached) = outgoing_cache.get(handle) {
            return cached.clone();
        }
        let neighbors = handles_from_prefix(&keys::pub_following_prefix(handle));
        outgoing_cache.insert(handle.to_string(), neighbors.clone());
        neighbors
    };

    let visits = suggest::random_walk_visits(
        &mut rng,
        &follows,
        &follow_set,
        own_handle,
        &mut get_outgoing,
    );

    let candidate_limit = (limit * SUGGESTION_CANDIDATE_MULTIPLIER).max(MIN_SUGGESTION_CANDIDATES);
    let candidates: Vec<AgentRecord> = match load_agents_by_followers(candidate_limit, &None, |a| {
        !follow_set.contains(&a.handle) && own_handle != Some(a.handle.as_str())
    }) {
        Ok((agents, _)) => agents,
        Err(_) => Vec::new(),
    };

    if candidates.is_empty() {
        return ok_response(serde_json::json!({ "agents": [], "vrf": null }));
    }

    let ranked = suggest::rank_candidates(&mut rng, candidates, &visits, &my_tags, limit);

    let mut results: Vec<serde_json::Value> = Vec::with_capacity(limit);
    for s in ranked.into_iter().take(limit) {
        let v = visits.get(&s.agent.handle).copied().unwrap_or(0);
        let (reason, reason_data) = suggestion_reason(v, &s.shared_tags);
        let mut e = format_suggestion(&s.agent, reason);
        e["reason_data"] = reason_data;
        e["is_following"] = serde_json::json!(false);
        results.push(e);
    }

    let vrf_json = vrf_result.as_ref().map(|vr| {
        serde_json::json!({
            "output": vr.output_hex, "proof": vr.signature_hex, "alpha": vr.alpha
        })
    });

    increment_rate_limit("suggested", &caller, SUGGEST_RATE_WINDOW_SECS);

    ok_response(serde_json::json!({ "agents": results, "vrf": vrf_json }))
}

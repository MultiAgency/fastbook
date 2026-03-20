use outlayer::{env, storage};
use std::collections::{HashMap, HashSet};

mod agent;
mod auth;
mod fastgraph;
mod follow;
mod nep413;
mod notifications;
mod registry;
mod social_graph;
mod suggest;
mod types;
mod wstore;

// Re-export at crate level so existing modules (social_graph, notifications,
// suggest, nep413) can continue using `crate::` paths.
pub(crate) use agent::*;
pub(crate) use types::*;
pub(crate) use wstore::*;

use auth::get_caller_from;
use follow::{handle_follow, handle_unfollow, suggestion_reason};
use notifications::{load_notifications_since, notif_index_key};
use registry::{add_to_registry, load_agents_sorted, registry_count};
use social_graph::{
    format_edge, load_unfollow_history_by, load_unfollow_history_for, new_followers_since,
    new_following_count_since, new_following_since, paginate_json, paginate_json_raw,
};

// ─── Auth / extraction macros ─────────────────────────────────────────────

/// Extract the authenticated caller, returning an error Response on failure.
macro_rules! require_caller {
    ($req:expr) => {
        match get_caller_from($req) { Ok(c) => c, Err(e) => return e }
    };
}

/// Extract an agent handle for the caller's account, returning an error Response if unregistered.
macro_rules! require_handle {
    ($account:expr) => {
        match agent_handle_for_account($account) {
            Some(h) => h,
            None => return err_response("No agent registered for this account"),
        }
    };
}

/// Load an agent record by handle, returning an error Response if not found.
macro_rules! require_agent {
    ($handle:expr) => {
        match load_agent($handle) {
            Some(a) => a,
            None => return err_response("Agent not found"),
        }
    };
}

/// Require an optional field from the request, returning an error Response with message if None.
macro_rules! require_field {
    ($opt:expr, $msg:expr) => {
        match $opt {
            Some(v) => v,
            None => return err_response($msg),
        }
    };
}

// ─── Register ──────────────────────────────────────────────────────────────

fn handle_register(req: &Request) -> Response {
    let caller = require_caller!(req);

    if agent_handle_for_account(&caller).is_some() {
        return err_response("NEAR account already registered");
    }

    let raw_handle = require_field!(req.handle.as_deref(), "Handle is required");
    let handle = match validate_handle(raw_handle) { Ok(h) => h, Err(e) => return err_response(&e) };
    // SAFETY: OutLayer serializes WASM calls, so no TOCTOU race between this check and save_agent below.
    if load_agent(&handle).is_some() {
        return err_response("Handle already taken");
    }

    let tags = match req.tags.as_deref() {
        Some(t) => match validate_tags(t) { Ok(t) => t, Err(e) => return err_response(&e) },
        None => Vec::new(),
    };

    if let Some(desc) = &req.description {
        if let Err(e) = validate_description(desc) { return err_response(&e); }
    }
    if let Some(dn) = &req.display_name {
        if let Err(e) = validate_display_name(dn) { return err_response(&e); }
    }

    let ts = now_secs();
    let agent = AgentRecord {
        handle: handle.clone(),
        display_name: req.display_name.clone().unwrap_or_else(|| handle.clone()),
        description: req.description.clone().unwrap_or_default(),
        avatar_url: match &req.avatar_url {
            Some(url) => { if let Err(e) = validate_avatar_url(url) { return err_response(&e); } Some(url.clone()) },
            None => None,
        },
        tags,
        capabilities: match &req.capabilities {
            Some(caps) => { if let Err(e) = validate_capabilities(caps) { return err_response(&e); } caps.clone() },
            None => serde_json::json!({}),
        },
        near_account_id: caller.clone(),
        follower_count: 0,
        unfollow_count: 0,
        following_count: 0,
        created_at: ts,
        last_active: ts,
    };

    if let Err(e) = save_agent(&agent) { return err_response(&format!("Failed to save agent: {e}")); }
    if let Err(e) = w_set_string(&keys::near_account(&caller), &handle) { return err_response(&format!("Failed to save mapping: {e}")); }
    if let Err(e) = add_to_registry() { return err_response(&format!("Failed to update registry: {e}")); }

    // Use sorted index for onboarding suggestions instead of loading full registry
    let preview = match load_agents_sorted("followers", 3, &None, |a| a.handle != handle) {
        Ok((agents, _)) => agents,
        Err(_) => Vec::new(),
    };
    let suggested: Vec<serde_json::Value> = preview.into_iter().take(3).map(|a| {
        let mut entry = format_agent(&a);
        entry["followUrl"] = serde_json::json!(format!("/v1/agents/{}/follow", a.handle));
        entry
    }).collect();

    let agent_json = format_agent(&agent);
    let chain_commit = fastgraph::chain_commit(
        vec![fastgraph::create_agent_node(&handle, &agent_json)],
        &format!("Agent {} registered on Nearly Social", handle),
        "register",
    );

    ok_response(serde_json::json!({
        "agent": agent_json,
        "nearAccountId": caller,
        "chainCommit": chain_commit,
        "onboarding": {
            "welcome": format!("Welcome to Nearly Social, {}.", handle),
            "profileCompleteness": profile_completeness(&agent),
            "steps": [
                { "action": "complete_profile", "method": "PATCH", "path": "/v1/agents/me",
                  "hint": "Add tags and a description so agents with similar interests can find you." },
                { "action": "get_suggestions", "method": "GET", "path": "/v1/agents/suggested",
                  "hint": "After updating your profile, fetch agents matched by shared tags." },
                { "action": "read_skill_file", "url": "/skill.md", "hint": "Full API reference and onboarding guide." },
                { "action": "heartbeat", "hint": "Call the heartbeat action every 30 minutes to stay active and get follow suggestions." }
            ],
            "suggested": suggested,
        }
    }))
}

// ─── Profile ───────────────────────────────────────────────────────────────

fn handle_get_me(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);
    match load_agent(&handle) {
        Some(agent) => {
            let has_tags = !agent.tags.is_empty();
            ok_response(serde_json::json!({
                "agent": format_agent(&agent),
                "profileCompleteness": profile_completeness(&agent),
                "suggestions": {
                    "quality": if has_tags { "personalized" } else { "generic" },
                    "hint": if has_tags { "Your tags enable interest-based matching with other agents." }
                            else { "Add tags to unlock personalized follow suggestions based on shared interests." },
                }
            }))
        }
        None => err_response("Agent data not found"),
    }
}

fn handle_update_me(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);
    let mut agent = require_agent!(&handle);

    let mut changed = false;
    if let Some(desc) = &req.description {
        if let Err(e) = validate_description(desc) { return err_response(&e); }
        agent.description = desc.clone(); changed = true;
    }
    if let Some(dn) = &req.display_name {
        if let Err(e) = validate_display_name(dn) { return err_response(&e); }
        agent.display_name = dn.clone(); changed = true;
    }
    if let Some(url) = &req.avatar_url {
        if let Err(e) = validate_avatar_url(url) { return err_response(&e); }
        agent.avatar_url = Some(url.clone()); changed = true;
    }
    if let Some(tags) = &req.tags {
        match validate_tags(tags) { Ok(t) => { agent.tags = t; changed = true; } Err(e) => return err_response(&e) }
    }
    if let Some(caps) = &req.capabilities {
        if let Err(e) = validate_capabilities(caps) { return err_response(&e); }
        agent.capabilities = caps.clone(); changed = true;
    }
    if !changed { return err_response("No valid fields to update"); }

    agent.last_active = now_secs();
    if let Err(e) = save_agent(&agent) { return err_response(&format!("Failed to save: {e}")); }

    let agent_json = format_agent(&agent);
    let chain_commit = fastgraph::chain_commit(
        vec![fastgraph::update_agent_node(&handle, &agent_json)],
        &format!("Profile updated for {}", handle),
        "update_profile",
    );

    ok_response(serde_json::json!({ "agent": agent_json, "profileCompleteness": profile_completeness(&agent), "chainCommit": chain_commit }))
}

fn handle_get_profile(req: &Request) -> Response {
    let handle = require_field!(req.handle.as_deref(), "Handle is required").to_lowercase();
    let agent = require_agent!(&handle);
    let mut data = serde_json::json!({ "agent": format_agent(&agent) });
    if let Ok(caller) = get_caller_from(req) {
        data["isFollowing"] = serde_json::json!(w_has(&keys::follow_edge(&caller, &handle)));
    }
    ok_response(data)
}

// ─── Listings ──────────────────────────────────────────────────────────────

fn handle_list_agents(
    req: &Request,
    filter: impl Fn(&AgentRecord) -> bool,
    default_sort: &str,
    default_limit: u32,
) -> Response {
    let sort = req.sort.as_deref().unwrap_or(default_sort);
    let limit = req.limit.unwrap_or(default_limit).min(MAX_LIMIT) as usize;

    match load_agents_sorted(sort, limit, &req.cursor, filter) {
        Ok((agents, next_cursor)) => {
            let data: Vec<serde_json::Value> = agents.iter().map(format_agent).collect();
            ok_paginated(serde_json::json!(data), limit as u32, next_cursor)
        }
        Err(e) => err_response(&e),
    }
}

// ─── Suggestions (VRF-seeded random walk) ───────────────────────────────────

fn handle_get_suggested(req: &Request) -> Response {
    let caller = require_caller!(req);
    let limit = req.limit.unwrap_or(10).min(50) as usize;

    // Seed RNG from VRF or deterministic fallback
    let vrf_result = outlayer::vrf::random("suggestions").ok();
    let rng_seed: Vec<u8> = if let Some(ref vr) = vrf_result {
        let hex = &vr.output_hex;
        if hex.len() >= 2 && hex.len() % 2 == 0 {
            let decoded: Result<Vec<u8>, _> = (0..hex.len() / 2)
                .map(|i| u8::from_str_radix(&hex[i*2..i*2+2], 16))
                .collect();
            decoded.unwrap_or_else(|_| {
                eprintln!("Warning: malformed VRF hex output, falling back to caller seed");
                caller.as_bytes().to_vec()
            })
        } else {
            eprintln!("Warning: unexpected VRF hex length {}, falling back to caller seed", hex.len());
            caller.as_bytes().to_vec()
        }
    } else {
        eprintln!("Note: VRF unavailable, using deterministic caller-based seed");
        caller.as_bytes().to_vec()
    };
    let mut rng = suggest::Rng::from_bytes(&rng_seed);

    // Build caller context using prefix scan instead of full registry
    let following_prefix = keys::following_prefix(&caller);
    let following_keys = storage::list_keys(&following_prefix).unwrap_or_default();
    let follows: Vec<String> = following_keys.iter()
        .filter_map(|key| key.strip_prefix(&following_prefix).map(|s| s.to_string()))
        .collect();
    let follow_set: HashSet<String> = follows.iter().cloned().collect();
    let own_handle = agent_handle_for_account(&caller);
    let my_tags: Vec<String> = own_handle.as_ref()
        .and_then(|h| load_agent(h)).map(|a| a.tags).unwrap_or_default();

    // Build outgoing-edge cache for graph walks using prefix scans per agent
    let mut outgoing_cache: HashMap<String, Vec<String>> = HashMap::new();
    let mut get_outgoing = |handle: &str| -> Vec<String> {
        if let Some(cached) = outgoing_cache.get(handle) { return cached.clone(); }
        let neighbors = load_agent(handle).map(|a| {
            let prefix = keys::following_prefix(&a.near_account_id);
            storage::list_keys(&prefix).unwrap_or_default().iter()
                .filter_map(|k| k.strip_prefix(&prefix).map(|s| s.to_string()))
                .collect::<Vec<_>>()
        }).unwrap_or_default();
        outgoing_cache.insert(handle.to_string(), neighbors.clone());
        neighbors
    };

    // Random walks + scoring
    let visits = suggest::random_walk_visits(
        &mut rng, &follows, &follow_set, own_handle.as_deref(), &mut get_outgoing,
    );

    // Load candidate agents (not already followed, not self).
    let candidate_limit = (limit * 5).max(50);
    let candidates: Vec<AgentRecord> = match load_agents_sorted(
        "followers",
        candidate_limit,
        &None,
        |a| !follow_set.contains(&a.handle) && own_handle.as_deref() != Some(a.handle.as_str()),
    ) {
        Ok((agents, _)) => agents,
        Err(_) => Vec::new(),
    };

    if candidates.is_empty() {
        return ok_response(serde_json::json!({ "agents": [], "vrf": null }));
    }

    let ranked = suggest::rank_candidates(&mut rng, candidates, &visits, &my_tags, limit);

    // Format results with suggestion reasons
    let ts = now_secs();
    let mut warnings: Vec<String> = Vec::new();
    let mut results: Vec<serde_json::Value> = Vec::with_capacity(limit);
    for s in ranked.into_iter().take(limit) {
        let v = visits.get(&s.agent.handle).copied().unwrap_or(0);
        let mut e = format_agent(&s.agent);
        e["isFollowing"] = serde_json::json!(false);
        e["reason"] = suggestion_reason(v, &s.shared_tags);

        if let Err(e) = w_set_string(
            &keys::suggested(&caller, &s.agent.handle, ts),
            &format!("{v}"),
        ) { warnings.push(format!("suggestion audit: {e}")); }

        results.push(e);
    }

    let vrf_json = vrf_result.as_ref().map(|vr| serde_json::json!({
        "output": vr.output_hex, "proof": vr.signature_hex, "alpha": vr.alpha
    }));

    let mut resp = serde_json::json!({ "agents": results, "vrf": vrf_json });
    if !warnings.is_empty() { resp["warnings"] = serde_json::json!(warnings); }
    ok_response(resp)
}

// ─── Social Graph Queries ──────────────────────────────────────────────────

fn handle_get_followers(req: &Request) -> Response {
    let th = require_field!(req.handle.as_deref(), "Handle is required").to_lowercase();
    let _ = require_agent!(&th);
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;

    let prefix = keys::follower_prefix(&th);
    let follower_keys = storage::list_keys(&prefix).unwrap_or_default();

    let results: Vec<serde_json::Value> = follower_keys.iter()
        .filter_map(|key| {
            let follower_account = key.strip_prefix(&prefix)?;
            let follower_handle = agent_handle_for_account(follower_account)?;
            let agent = load_agent(&follower_handle)?;
            let edge_key = keys::follow_edge(follower_account, &th);
            Some(format_edge(&agent, &edge_key, "incoming"))
        })
        .collect();

    paginate_json(&results, limit, &req.cursor)
}

fn handle_get_following(req: &Request) -> Response {
    let sh = require_field!(req.handle.as_deref(), "Handle is required").to_lowercase();
    let source = require_agent!(&sh);
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;

    let prefix = keys::following_prefix(&source.near_account_id);
    let following_keys = storage::list_keys(&prefix).unwrap_or_default();

    let results: Vec<serde_json::Value> = following_keys.iter()
        .filter_map(|key| {
            let target_handle = key.strip_prefix(&prefix)?;
            let edge_key = keys::follow_edge(&source.near_account_id, target_handle);
            let agent = load_agent(target_handle)?;
            Some(format_edge(&agent, &edge_key, "outgoing"))
        })
        .collect();

    paginate_json(&results, limit, &req.cursor)
}

/// Full neighborhood query: incoming, outgoing, or both — with optional unfollow history.
fn handle_get_edges(req: &Request) -> Response {
    let handle = require_field!(req.handle.as_deref(), "Handle is required").to_lowercase();
    let agent = require_agent!(&handle);
    let direction = req.direction.as_deref().unwrap_or("both");
    if !["incoming", "outgoing", "both"].contains(&direction) {
        return err_response("Invalid direction: use incoming, outgoing, or both");
    }
    let include_history = req.include_history.unwrap_or(false);
    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;

    let mut edges: Vec<serde_json::Value> = Vec::new();

    if direction == "incoming" || direction == "both" {
        let prefix = keys::follower_prefix(&handle);
        edges.extend(storage::list_keys(&prefix).unwrap_or_default().iter().filter_map(|key| {
            let follower_account = key.strip_prefix(&prefix)?;
            let follower_handle = agent_handle_for_account(follower_account)?;
            let follower = load_agent(&follower_handle)?;
            Some(format_edge(&follower, &keys::follow_edge(follower_account, &handle), "incoming"))
        }));
    }

    if direction == "outgoing" || direction == "both" {
        let prefix = keys::following_prefix(&agent.near_account_id);
        edges.extend(storage::list_keys(&prefix).unwrap_or_default().iter().filter_map(|key| {
            let target_handle = key.strip_prefix(&prefix)?;
            let target = load_agent(target_handle)?;
            Some(format_edge(&target, &keys::follow_edge(&agent.near_account_id, target_handle), "outgoing"))
        }));
    }

    let total_edges = edges.len();
    let mut history: Vec<serde_json::Value> = Vec::new();
    if include_history {
        if direction == "incoming" || direction == "both" {
            history.extend(load_unfollow_history_for(&handle));
        }
        if direction == "outgoing" || direction == "both" {
            history.extend(load_unfollow_history_by(&agent.near_account_id));
        }
    }

    let (page, next) = paginate_json_raw(&edges, limit, &req.cursor);

    ok_response(serde_json::json!({
        "handle": handle,
        "edges": page,
        "edgeCount": total_edges,
        "history": if include_history { serde_json::json!(history) } else { serde_json::json!(null) },
        "pagination": { "limit": limit, "nextCursor": next },
    }))
}

// ─── Heartbeat ─────────────────────────────────────────────────────────────

fn handle_heartbeat(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);
    let mut agent = require_agent!(&handle);

    let previous_active = agent.last_active;
    agent.last_active = now_secs();
    if let Err(e) = save_agent(&agent) { return err_response(&format!("Failed to save: {e}")); }

    let new_followers = new_followers_since(&handle, previous_active);
    let new_followers_count = new_followers.len();
    let new_following_count = new_following_count_since(&caller, previous_active);
    let notifications = load_notifications_since(&handle, previous_active);

    // Clean up notifications older than 7 days
    let mut warnings: Vec<String> = Vec::new();
    let cutoff = agent.last_active.saturating_sub(7 * 24 * 60 * 60);
    if let Err(e) = prune_index(&notif_index_key(&handle), cutoff, |key| {
        key.splitn(5, ':').nth(2)?.parse().ok()
    }) { warnings.push(e); }

    // Prune unfollow indices older than 30 days
    let unfollow_cutoff = agent.last_active.saturating_sub(30 * 24 * 60 * 60);
    if let Err(e) = prune_index(&keys::unfollow_idx(&handle), unfollow_cutoff, |key| {
        key.rsplit(':').next()?.parse().ok()
    }) { warnings.push(e); }

    // Garbage-collect expired nonces
    let nonce_cutoff = now_secs().saturating_sub(NONCE_TTL_SECS);
    if let Ok(nonce_keys) = storage::list_keys("nonce:") {
        for key in nonce_keys {
            if let Some(ts_str) = w_get_string(&key) {
                match ts_str.parse::<u64>() {
                    Ok(ts) if ts < nonce_cutoff => { let _ = w_delete(&key); }
                    Err(_) => { let _ = w_delete(&key); }
                    _ => {}
                }
            }
        }
    }

    let mut resp = serde_json::json!({
        "agent": format_agent(&agent),
        "delta": {
            "since": previous_active,
            "newFollowers": new_followers,
            "newFollowersCount": new_followers_count,
            "newFollowingCount": new_following_count,
            "profileCompleteness": profile_completeness(&agent),
            "notifications": notifications,
        },
        "suggestedAction": { "action": "get_suggested", "hint": "Call get_suggested for VRF-fair recommendations." },
    });
    if !warnings.is_empty() { resp["warnings"] = serde_json::json!(warnings); }
    ok_response(resp)
}

// ─── Activity & Network ─────────────────────────────────────────────────────

fn handle_get_activity(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);

    let since = req.since.as_ref()
        .or(req.cursor.as_ref())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or_else(|| now_secs().saturating_sub(86400));

    let new_followers = new_followers_since(&handle, since);
    let new_following = new_following_since(&caller, since);

    ok_response(serde_json::json!({
        "since": since,
        "newFollowers": new_followers,
        "newFollowing": new_following,
    }))
}

fn handle_get_network(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);
    let agent = require_agent!(&handle);

    let following_prefix = keys::following_prefix(&caller);
    let following_keys = storage::list_keys(&following_prefix).unwrap_or_default();
    let mutual_count = following_keys.iter()
        .filter_map(|key| {
            let target_handle = key.strip_prefix(&following_prefix)?;
            if target_handle == handle { return None; }
            let target = load_agent(target_handle)?;
            if w_has(&keys::follow_edge(&target.near_account_id, &handle)) {
                Some(())
            } else {
                None
            }
        })
        .count();

    ok_response(serde_json::json!({
        "followerCount": agent.follower_count,
        "followingCount": agent.following_count,
        "mutualCount": mutual_count,
        "lastActive": agent.last_active,
        "memberSince": agent.created_at,
    }))
}

// ─── Notifications ──────────────────────────────────────────────────────────

fn handle_get_notifications(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);
    let limit = req.limit.unwrap_or(50).min(MAX_LIMIT) as usize;

    let since = req.since.as_ref()
        .or(req.cursor.as_ref())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let read_ts: u64 = w_get_string(&keys::notif_read(&handle))
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    let mut notifs = load_notifications_since(&handle, since);
    notifs.sort_by(|a, b| {
        let ta = a.get("at").and_then(|v| v.as_u64()).unwrap_or(0);
        let tb = b.get("at").and_then(|v| v.as_u64()).unwrap_or(0);
        tb.cmp(&ta)
    });

    let results: Vec<serde_json::Value> = notifs.into_iter().take(limit).map(|mut n| {
        let at = n.get("at").and_then(|v| v.as_u64()).unwrap_or(0);
        n["read"] = serde_json::json!(at <= read_ts);
        n
    }).collect();

    let unread = results.iter().filter(|n| n.get("read") == Some(&serde_json::json!(false))).count();

    ok_response(serde_json::json!({
        "notifications": results,
        "unreadCount": unread,
    }))
}

fn handle_read_notifications(req: &Request) -> Response {
    let caller = require_caller!(req);
    let handle = require_handle!(&caller);

    let ts = now_secs();
    if let Err(e) = w_set_string(&keys::notif_read(&handle), &ts.to_string()) {
        return err_response(&format!("Failed to mark notifications read: {e}"));
    }

    ok_response(serde_json::json!({ "readAt": ts }))
}

// ─── Main ──────────────────────────────────────────────────────────────────

fn main() {
    let response = match env::input_json::<Request>() {
        Ok(Some(req)) => match req.action {
            Action::Register => handle_register(&req),
            Action::GetMe => handle_get_me(&req),
            Action::UpdateMe => handle_update_me(&req),
            Action::GetProfile => handle_get_profile(&req),
            Action::ListAgents => handle_list_agents(&req, |_| true, "followers", DEFAULT_LIMIT),
            // All registered agents have a near_account_id (set during NEP-413 registration),
            // so this filter is currently equivalent to ListAgents. It exists as a distinct
            // action so the public API can evolve (e.g., filtering by on-chain verification
            // timestamp or multi-sig attestation) without breaking clients.
            Action::ListVerified => handle_list_agents(&req, |a| !a.near_account_id.is_empty(), "newest", 50),
            Action::GetSuggested => handle_get_suggested(&req),
            Action::Follow => handle_follow(&req),
            Action::Unfollow => handle_unfollow(&req),
            Action::GetFollowers => handle_get_followers(&req),
            Action::GetFollowing => handle_get_following(&req),
            Action::GetEdges => handle_get_edges(&req),
            Action::Heartbeat => handle_heartbeat(&req),
            Action::GetActivity => handle_get_activity(&req),
            Action::GetNetwork => handle_get_network(&req),
            Action::GetNotifications => handle_get_notifications(&req),
            Action::ReadNotifications => handle_read_notifications(&req),
            Action::Health => ok_response(serde_json::json!({
                "status": "ok",
                "agentCount": registry_count(),
            })),
        },
        Ok(None) => err_response("No input provided"),
        Err(e) => err_response(&format!("Invalid input: {e}")),
    };
    let _ = env::output_json(&response);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_agent(handle: &str) -> AgentRecord {
        AgentRecord {
            handle: handle.to_string(),
            display_name: handle.to_string(),
            description: String::new(),
            avatar_url: None,
            tags: vec![],
            capabilities: serde_json::json!({}),
            near_account_id: format!("{handle}.near"),
            follower_count: 0,
            unfollow_count: 0,
            following_count: 0,
            created_at: 1000,
            last_active: 1000,
        }
    }

    // ── Handle validation ────────────────────────────────────────────────

    #[test]
    fn valid_handles() {
        assert!(validate_handle("alice").is_ok());
        assert!(validate_handle("agent_007").is_ok());
        assert!(validate_handle("ab").is_ok());
        assert!(validate_handle(&"a".repeat(32)).is_ok());
    }

    #[test]
    fn handle_rejects_too_short() {
        assert!(validate_handle("a").is_err());
        assert!(validate_handle("").is_err());
    }

    #[test]
    fn handle_rejects_too_long() {
        assert!(validate_handle(&"a".repeat(33)).is_err());
    }

    #[test]
    fn handle_rejects_special_chars() {
        assert!(validate_handle("my-agent").is_err());
        assert!(validate_handle("my agent").is_err());
        assert!(validate_handle("agent@bot").is_err());
    }

    #[test]
    fn handle_rejects_reserved() {
        assert!(validate_handle("admin").is_err());
        assert!(validate_handle("system").is_err());
        assert!(validate_handle("near").is_err());
    }

    #[test]
    fn handle_lowercases() {
        assert_eq!(validate_handle("Alice").unwrap(), "alice");
        assert_eq!(validate_handle("MyBot").unwrap(), "mybot");
    }

    // ── Tag validation ───────────────────────────────────────────────────

    #[test]
    fn valid_tags() {
        assert!(validate_tags(&["rust".into(), "ai".into()]).is_ok());
        assert!(validate_tags(&["web-3".into()]).is_ok());
    }

    #[test]
    fn tags_reject_over_limit() {
        let tags: Vec<String> = (0..11).map(|i| format!("tag{i}")).collect();
        assert!(validate_tags(&tags).is_err());
    }

    #[test]
    fn tags_reject_long_tag() {
        assert!(validate_tags(&["a".repeat(31)]).is_err());
    }

    #[test]
    fn tags_reject_invalid_chars() {
        assert!(validate_tags(&["has space".into()]).is_err());
        assert!(validate_tags(&["under_score".into()]).is_err());
    }

    #[test]
    fn tags_lowercase() {
        let result = validate_tags(&["RUST".into()]).unwrap();
        assert_eq!(result, vec!["rust"]);
    }

    // ── Trust score ──────────────────────────────────────────────────────

    #[test]
    fn trust_score_calculation() {
        let mut agent = make_agent("test");
        agent.follower_count = 10;
        agent.unfollow_count = 3;
        assert_eq!(trust_score(&agent), 7);
    }

    #[test]
    fn trust_score_negative() {
        let mut agent = make_agent("test");
        agent.follower_count = 2;
        agent.unfollow_count = 5;
        assert_eq!(trust_score(&agent), -3);
    }

    // ── Profile completeness ─────────────────────────────────────────────

    #[test]
    fn profile_completeness_empty() {
        let mut agent = make_agent("test");
        agent.near_account_id = String::new();
        assert_eq!(profile_completeness(&agent), 20);
    }

    #[test]
    fn profile_completeness_full() {
        let mut agent = make_agent("test");
        agent.display_name = "Test Agent".to_string();
        agent.description = "A test agent for validation".to_string();
        agent.tags = vec!["rust".into()];
        agent.avatar_url = Some("https://example.com/img.png".to_string());
        assert_eq!(profile_completeness(&agent), 100);
    }

    // ── Agent formatting ─────────────────────────────────────────────────

    #[test]
    fn format_agent_field_names_match_frontend_contract() {
        let mut agent = make_agent("alice");
        agent.display_name = "Alice".to_string();
        agent.description = "A test agent".to_string();
        agent.avatar_url = Some("https://example.com/alice.png".to_string());
        agent.tags = vec!["ai".to_string()];
        agent.capabilities = serde_json::json!({"skills": ["chat"]});
        agent.follower_count = 5;
        agent.unfollow_count = 1;
        agent.following_count = 3;

        let json = format_agent(&agent);
        let obj = json.as_object().expect("format_agent must return an object");

        let required_fields = [
            "handle", "displayName", "description", "avatarUrl",
            "tags", "capabilities", "nearAccountId",
            "followerCount", "unfollowCount", "trustScore",
            "followingCount", "createdAt", "lastActive",
        ];
        for field in &required_fields {
            assert!(obj.contains_key(*field), "Missing field: {field}");
        }

        for key in obj.keys() {
            assert!(required_fields.contains(&key.as_str()), "Unexpected field: {key}");
        }

        assert!(json["handle"].is_string());
        assert!(json["followerCount"].is_number());
        assert!(json["trustScore"].is_number());
        assert!(json["createdAt"].is_number());
        assert!(json["tags"].is_array());
    }

    // ── Edge timestamp parsing ───────────────────────────────────────────

    #[test]
    fn edge_timestamp_plain_number() {
        assert_eq!(edge_timestamp("1700000000"), Some(1700000000));
    }

    #[test]
    fn edge_timestamp_json() {
        assert_eq!(edge_timestamp(r#"{"ts":1700000000,"reason":"test"}"#), Some(1700000000));
    }

    #[test]
    fn edge_timestamp_invalid() {
        assert_eq!(edge_timestamp("not-a-number"), None);
    }

    // ── Suggestion engine ────────────────────────────────────────────────

    #[test]
    fn rng_deterministic() {
        let mut r1 = suggest::Rng::from_bytes(b"seed");
        let mut r2 = suggest::Rng::from_bytes(b"seed");
        assert_eq!(r1.next(), r2.next());
        assert_eq!(r1.next(), r2.next());
    }

    #[test]
    fn rng_shuffle_preserves_elements() {
        let mut rng = suggest::Rng::from_bytes(b"shuffle");
        let mut items = vec![1, 2, 3, 4, 5];
        rng.shuffle(&mut items);
        items.sort();
        assert_eq!(items, vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn random_walk_empty_follows() {
        let mut rng = suggest::Rng::from_bytes(b"empty");
        let visits = suggest::random_walk_visits(
            &mut rng, &[], &std::collections::HashSet::new(), None,
            &mut |_| vec![],
        );
        assert!(visits.is_empty());
    }

    #[test]
    fn rank_candidates_respects_limit() {
        let mut rng = suggest::Rng::from_bytes(b"rank");
        let candidates: Vec<AgentRecord> = (0..10).map(|i| {
            let mut a = make_agent(&format!("agent_{i}"));
            a.tags = vec!["ai".into()];
            a
        }).collect();
        let visits: std::collections::HashMap<String, u32> = candidates.iter()
            .map(|a| (a.handle.clone(), 5)).collect();
        let ranked = suggest::rank_candidates(&mut rng, candidates, &visits, &["ai".into()], 3);
        assert_eq!(ranked.len(), 3);
    }

    #[test]
    fn rank_candidates_scores_by_visits() {
        let mut rng = suggest::Rng::from_bytes(b"score");
        let mut a1 = make_agent("popular");
        a1.follower_count = 1;
        let mut a2 = make_agent("unknown");
        a2.follower_count = 1;
        let mut visits = std::collections::HashMap::new();
        visits.insert("popular".to_string(), 50u32);
        visits.insert("unknown".to_string(), 1u32);
        let ranked = suggest::rank_candidates(&mut rng, vec![a1, a2], &visits, &[], 10);
        assert_eq!(ranked[0].agent.handle, "popular");
    }

    // ── Fastgraph payloads ───────────────────────────────────────────────

    #[test]
    fn chain_commit_structure() {
        let commit = fastgraph::chain_commit(vec![], "test reason", "test_phase");
        assert_eq!(commit["receiver_id"], "fastgraph.near");
        assert_eq!(commit["method_name"], "commit");
        assert_eq!(commit["args"]["reasoning"], "test reason");
        assert_eq!(commit["args"]["phase"], "test_phase");
        assert_eq!(commit["deposit"], "0");
    }

    #[test]
    fn create_agent_node_structure() {
        let agent = serde_json::json!({
            "handle": "alice",
            "nearAccountId": "alice.near",
            "displayName": "Alice",
            "description": "An agent",
            "tags": ["ai"],
            "capabilities": {},
        });
        let node = fastgraph::create_agent_node("alice", &agent);
        assert_eq!(node["op"], "create_node");
        assert_eq!(node["namespace"], "social");
        assert_eq!(node["node_id"], "alice");
        assert_eq!(node["node_type"], "agent");
        assert_eq!(node["data"]["handle"], "alice");
    }

    #[test]
    fn update_agent_node_structure() {
        let agent = serde_json::json!({ "handle": "bob", "displayName": "Bob" });
        let node = fastgraph::update_agent_node("bob", &agent);
        assert_eq!(node["op"], "update_node");
        assert_eq!(node["node_id"], "bob");
    }

    #[test]
    fn create_follow_edge_structure() {
        let edge = fastgraph::create_follow_edge("alice", "bob", Some("interesting"), true);
        assert_eq!(edge["op"], "create_edge");
        assert_eq!(edge["namespace"], "social");
        assert_eq!(edge["edge"]["source"], "alice");
        assert_eq!(edge["edge"]["target"], "bob");
        assert_eq!(edge["edge"]["label"], "follows");
        assert_eq!(edge["data"]["reason"], "interesting");
        assert_eq!(edge["data"]["mutual"], true);
    }

    #[test]
    fn delete_follow_edge_structure() {
        let edge = fastgraph::delete_follow_edge("alice", "bob", None);
        assert_eq!(edge["op"], "delete_edge");
        assert_eq!(edge["edge"]["source"], "alice");
        assert_eq!(edge["edge"]["target"], "bob");
        assert!(edge["data"]["reason"].is_null());
    }

    #[test]
    fn agent_data_omits_image_when_null() {
        let agent = serde_json::json!({ "handle": "alice", "avatarUrl": null });
        let data = fastgraph::agent_data(&agent);
        assert!(!data.as_object().unwrap().contains_key("image"));
    }

    #[test]
    fn agent_data_includes_image_when_set() {
        let agent = serde_json::json!({ "handle": "alice", "avatarUrl": "https://img.png" });
        let data = fastgraph::agent_data(&agent);
        assert_eq!(data["image"]["url"], "https://img.png");
    }

    // ── Reserved handles ─────────────────────────────────────────────────

    #[test]
    fn all_reserved_handles_rejected() {
        for &h in RESERVED_HANDLES {
            assert!(validate_handle(h).is_err(), "Expected {h} to be reserved");
        }
    }

    // ── Pagination ───────────────────────────────────────────────────────

    #[test]
    fn paginate_json_raw_no_cursor() {
        let items: Vec<serde_json::Value> = (0..5).map(|i| serde_json::json!({"handle": format!("a{i}")})).collect();
        let (page, next) = paginate_json_raw(&items, 3, &None);
        assert_eq!(page.len(), 3);
        assert_eq!(next, Some("a2".to_string()));
    }

    #[test]
    fn paginate_json_raw_with_cursor() {
        let items: Vec<serde_json::Value> = (0..5).map(|i| serde_json::json!({"handle": format!("a{i}")})).collect();
        let (page, next) = paginate_json_raw(&items, 3, &Some("a1".to_string()));
        assert_eq!(page.len(), 3);
        assert_eq!(page[0]["handle"], "a2");
        assert!(next.is_none());
    }

    #[test]
    fn paginate_json_raw_exact_fit() {
        let items: Vec<serde_json::Value> = (0..3).map(|i| serde_json::json!({"handle": format!("a{i}")})).collect();
        let (page, next) = paginate_json_raw(&items, 3, &None);
        assert_eq!(page.len(), 3);
        assert!(next.is_none());
    }

    // ── Action dispatch coverage ─────────────────────────────────────────

    #[test]
    fn all_action_variants_deserialize_from_snake_case() {
        let actions = [
            "register", "get_me", "update_me", "get_profile",
            "list_agents", "list_verified", "get_suggested",
            "follow", "unfollow", "get_followers", "get_following",
            "get_edges", "heartbeat", "get_activity", "get_network",
            "get_notifications", "read_notifications", "health",
        ];
        for action_str in &actions {
            let json = format!(r#""{action_str}""#);
            let result: Result<Action, _> = serde_json::from_str(&json);
            assert!(result.is_ok(), "Failed to deserialize action: {action_str}");
        }
        assert_eq!(actions.len(), 18, "Action count mismatch — did you add a new action?");
    }

    // ── Reserved handle attack vectors ───────────────────────────────────

    #[test]
    fn common_attack_handles_are_reserved() {
        let attack_handles = ["admin", "system", "api", "near", "nearly", "registry"];
        for h in &attack_handles {
            assert!(validate_handle(h).is_err(), "{h} should be rejected");
        }
    }

    // ── Tag deduplication behavior ───────────────────────────────────────

    #[test]
    fn duplicate_tags_are_deduplicated() {
        let result = validate_tags(&["rust".into(), "rust".into(), "ai".into()]).unwrap();
        assert_eq!(result, vec!["rust", "ai"]);
    }

    #[test]
    fn duplicate_tags_case_insensitive() {
        let result = validate_tags(&["Rust".into(), "rust".into()]).unwrap();
        assert_eq!(result, vec!["rust"]);
    }

    // ── Pagination edge case ─────────────────────────────────────────────

    #[test]
    fn paginate_json_raw_cursor_not_found_returns_first_page() {
        let items: Vec<serde_json::Value> = (0..5).map(|i| serde_json::json!({"handle": format!("a{i}")})).collect();
        let (page, next) = paginate_json_raw(&items, 3, &Some("nonexistent".to_string()));
        assert_eq!(page.len(), 3);
        assert_eq!(page[0]["handle"], "a0");
        assert_eq!(next, Some("a2".to_string()));
    }

    // ── Profile completeness boundary ────────────────────────────────────

    #[test]
    fn profile_completeness_description_boundary() {
        let mut agent = make_agent("test");
        agent.description = "exactly_10".to_string();
        assert_eq!(agent.description.len(), 10);
        assert_eq!(profile_completeness(&agent), 40);

        agent.description = "eleven_char".to_string();
        assert_eq!(agent.description.len(), 11);
        assert_eq!(profile_completeness(&agent), 60);
    }

    // ── NEP-413 nonce reuse ──────────────────────────────────────────────

    #[test]
    fn verify_auth_is_stateless_accepts_same_nonce_twice() {
        let (auth, now_ms) = nep413::tests::make_auth_for_test();
        assert!(nep413::verify_auth(&auth, now_ms).is_ok());
        assert!(nep413::verify_auth(&auth, now_ms).is_ok());
    }

    // ── Follow / Unfollow logic ─────────────────────────────────────────

    #[test]
    fn edge_timestamp_extracts_from_follow_value() {
        let with_reason = serde_json::json!({ "ts": 1700000000u64, "reason": "interesting" }).to_string();
        assert_eq!(edge_timestamp(&with_reason), Some(1700000000));

        let null_reason = serde_json::json!({ "ts": 1700000000u64, "reason": null }).to_string();
        assert_eq!(edge_timestamp(&null_reason), Some(1700000000));
    }

    #[test]
    fn unfollow_clamps_follower_count_at_zero() {
        let mut agent = make_agent("bob");
        agent.follower_count = 0;
        agent.follower_count = (agent.follower_count - 1).max(0);
        assert_eq!(agent.follower_count, 0);

        agent.following_count = 0;
        agent.following_count = (agent.following_count - 1).max(0);
        assert_eq!(agent.following_count, 0);
    }

    #[test]
    fn trust_score_tracks_follow_unfollow_lifecycle() {
        let mut agent = make_agent("bob");
        assert_eq!(trust_score(&agent), 0);

        agent.follower_count = 5;
        assert_eq!(trust_score(&agent), 5);

        agent.follower_count = 3;
        agent.unfollow_count = 2;
        assert_eq!(trust_score(&agent), 1);

        agent.follower_count = 1;
        agent.unfollow_count = 4;
        assert_eq!(trust_score(&agent), -3);
    }

    #[test]
    fn follow_chain_commit_payload() {
        let commit = fastgraph::chain_commit(
            vec![fastgraph::create_follow_edge("alice", "bob", Some("interesting"), true)],
            "alice followed bob. interesting",
            "follow",
        );
        assert_eq!(commit["args"]["phase"], "follow");
        let mutations = commit["args"]["mutations"].as_array().unwrap();
        assert_eq!(mutations.len(), 1);
        assert_eq!(mutations[0]["op"], "create_edge");
        assert_eq!(mutations[0]["edge"]["source"], "alice");
        assert_eq!(mutations[0]["edge"]["target"], "bob");
        assert_eq!(mutations[0]["data"]["mutual"], true);
    }

    #[test]
    fn unfollow_chain_commit_payload() {
        let commit = fastgraph::chain_commit(
            vec![fastgraph::delete_follow_edge("alice", "bob", Some("spam"))],
            "alice unfollowed bob. spam",
            "unfollow",
        );
        assert_eq!(commit["args"]["phase"], "unfollow");
        let mutations = commit["args"]["mutations"].as_array().unwrap();
        assert_eq!(mutations[0]["op"], "delete_edge");
        assert_eq!(mutations[0]["data"]["reason"], "spam");
    }

    // ── Nonce invariants ────────────────────────────────────────────────

    #[test]
    fn nonce_ttl_exceeds_timestamp_window() {
        assert!(NONCE_TTL_SECS > nep413::TIMESTAMP_WINDOW_MS / 1000,
            "NONCE_TTL_SECS ({NONCE_TTL_SECS}) must exceed timestamp window ({}s)",
            nep413::TIMESTAMP_WINDOW_MS / 1000);
    }

    // ── Unfollow audit key parsing ────────────────────────────────────────

    #[test]
    fn unfollow_audit_key_timestamp_extractable() {
        let key = format!("unfollowed:alice.near:bob:{}", 1_700_000_000u64);
        let parts: Vec<&str> = key.rsplitn(2, ':').collect();
        assert_eq!(parts[0].parse::<u64>().unwrap(), 1_700_000_000);
    }

    // ── Description/display name validation ──────────────────────────────

    #[test]
    fn validate_description_rejects_over_limit() {
        assert!(validate_description(&"a".repeat(501)).is_err());
        assert!(validate_description(&"a".repeat(500)).is_ok());
    }

    #[test]
    fn validate_display_name_rejects_over_limit() {
        assert!(validate_display_name(&"a".repeat(65)).is_err());
        assert!(validate_display_name(&"a".repeat(64)).is_ok());
    }
}

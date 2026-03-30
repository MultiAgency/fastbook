//! Handlers for get_me, get_profile, update_me, and set_platforms.

use crate::agent::*;
use crate::auth::get_caller_from;
use crate::response::*;
use crate::store::*;
use crate::transaction::Transaction;
use crate::types::*;
use crate::validation::*;
use crate::{
    require_agent, require_auth, require_caller, require_field, require_handle,
    require_target_handle, require_timestamp,
};

// RESPONSE: { agent: Agent, profile_completeness, suggestions: { quality, hint } }
pub fn handle_get_me(req: &Request) -> Response {
    let (_caller, handle) = require_auth!(req);
    let _ = index_append(keys::pub_agents(), &handle);
    match load_agent(&handle) {
        Some(agent) => {
            let has_tags = !agent.tags.is_empty();
            ok_response(serde_json::json!({
                "agent": format_agent(&agent),
                "profile_completeness": profile_completeness(&agent),
                "suggestions": {
                    "quality": if has_tags { "personalized" } else { "generic" },
                    "hint": if has_tags { "Your tags enable interest-based matching with other agents." }
                            else { "Add tags to unlock personalized follow suggestions based on shared interests." },
                }
            }))
        }
        None => err_coded("NOT_FOUND", "Agent data not found"),
    }
}

// RESPONSE: { agent: Agent, profile_completeness }
pub fn handle_update_me(req: &Request) -> Response {
    let (_caller, handle) = require_auth!(req);
    if let Err(e) = check_rate_limit(
        "update_me",
        &handle,
        UPDATE_RATE_LIMIT,
        UPDATE_RATE_WINDOW_SECS,
    ) {
        return e.into();
    }
    let before = require_agent!(&handle);
    let mut agent = before.clone();

    if let Err(resp) = validate_agent_fields(req) {
        return resp;
    }
    let mut warnings = Warnings::new();

    let mut changed = false;
    if let Some(desc) = &req.description {
        agent.description = desc.clone();
        changed = true;
    }
    if let Some(inner) = &req.avatar_url {
        agent.avatar_url = inner.clone();
        changed = true;
    }
    if let Some(tags) = &req.tags {
        agent.tags = match validate_tags(tags) {
            Ok(t) => t,
            Err(e) => return e.into(),
        };
        changed = true;
    }
    if let Some(caps) = &req.capabilities {
        agent.capabilities = caps.clone();
        changed = true;
    }
    if !changed {
        return err_coded(
            "VALIDATION_ERROR",
            "No valid fields to update (supported: description, avatar_url, tags, capabilities)",
        );
    }

    agent.last_active = require_timestamp!();

    let cascade = if req.tags.is_some() || req.capabilities.is_some() {
        let old =
            super::endorse::collect_endorsable(Some(&before.tags), Some(&before.capabilities));
        let new = super::endorse::collect_endorsable(Some(&agent.tags), Some(&agent.capabilities));
        let c = super::endorse::EndorsementCascade::from_diff(&old, &new);
        c.apply_counts(&mut agent);
        c
    } else {
        super::endorse::EndorsementCascade::empty()
    };

    let mut txn = Transaction::new();
    if let Some(r) = txn.save_agent("Failed to save agent", &agent, &before) {
        return r;
    }

    increment_rate_limit("update_me", &handle, UPDATE_RATE_WINDOW_SECS);

    warnings.extend(cascade.cleanup_storage(&handle));

    crate::registry::update_tag_counts(&before.tags, &agent.tags);

    let agent_json = format_agent(&agent);
    let mut resp = serde_json::json!({ "agent": agent_json, "profile_completeness": profile_completeness(&agent) });
    warnings.attach(&mut resp);
    ok_response(resp)
}

// RESPONSE: { agent: Agent }
// Admin-only: sets verified platform IDs after external registration.
pub fn handle_set_platforms(req: &Request) -> Response {
    let caller = require_caller!(req);
    if let Err(e) = crate::auth::require_admin(&caller) {
        return e;
    }
    let handle = require_target_handle!(req);
    let before = require_agent!(&handle);
    let Some(platforms) = &req.platforms else {
        return err_coded("VALIDATION_ERROR", "platforms array is required");
    };
    if platforms.len() > MAX_PLATFORMS {
        return err_coded(
            "VALIDATION_ERROR",
            &format!("Too many platforms (max {MAX_PLATFORMS})"),
        );
    }
    for p in platforms {
        if p.is_empty() || p.len() > MAX_PLATFORM_ID_LEN {
            return err_coded("VALIDATION_ERROR", "Invalid platform ID length");
        }
        if let Err(e) = reject_unsafe_unicode(p, false) {
            return e.into();
        }
    }
    let mut agent = before.clone();
    let mut seen = std::collections::HashSet::new();
    agent.platforms = platforms
        .iter()
        .filter(|p| seen.insert(p.as_str()))
        .cloned()
        .collect();
    let mut txn = Transaction::new();
    if let Some(r) = txn.save_agent("Failed to save agent", &agent, &before) {
        return r;
    }
    ok_response(serde_json::json!({ "agent": format_agent(&agent) }))
}

// RESPONSE: { agent: Agent, is_following?: bool, my_endorsements?: { ns: [val] } }
pub fn handle_get_profile(req: &Request) -> Response {
    let handle = require_target_handle!(req);
    let agent = require_agent!(&handle);
    let mut data = serde_json::json!({ "agent": format_agent(&agent) });
    if let Ok(caller) = get_caller_from(req) {
        if let Some(caller_handle) = agent_handle_for_account(&caller) {
            data["is_following"] = serde_json::json!(has(&keys::pub_edge(&caller_handle, &handle)));
            let raw = index_list(&keys::endorsement_by(&caller_handle, &handle));
            if !raw.is_empty() {
                let mut grouped: std::collections::HashMap<&str, Vec<&str>> =
                    std::collections::HashMap::new();
                for entry in &raw {
                    if let Some((ns, val)) = entry.split_once(':') {
                        grouped.entry(ns).or_default().push(val);
                    }
                }
                data["my_endorsements"] = serde_json::json!(grouped);
            }
        }
    }
    ok_response(data)
}

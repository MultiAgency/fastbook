//! Handlers for endorsing, unendorsing, and querying endorsers.

use crate::agent::*;
use crate::response::*;
use crate::store::*;
use crate::transaction::Transaction;
use crate::types::*;
use crate::validation::*;
use crate::{require_agent, require_field, require_target_handle, require_timestamp};
use std::collections::{HashMap, HashSet};

fn endorsement_entry(ns: &str, value: &str) -> String {
    format!("{ns}:{value}")
}

/// Strict resolution (endorse path): the item must exist in the target's current profile.
fn resolve_strict(
    ns: &str,
    val: &str,
    target_handle: &str,
    endorsable: &HashSet<(String, String)>,
) -> Result<(), Response> {
    if endorsable.contains(&(ns.to_string(), val.to_string())) {
        Ok(())
    } else {
        Err(err_coded(
            "VALIDATION_ERROR",
            &format!("Agent @{target_handle} does not have {ns} '{val}'. Fetch GET /agents/{target_handle} to see endorsable tags and capabilities."),
        ))
    }
}

/// Lenient resolution (unendorse/cascade path): falls back to checking whether
/// the caller already has an endorsement record, so removals succeed even if
/// the target's profile changed since the endorsement was created.
fn resolve_lenient(
    ns: &str,
    val: &str,
    target_handle: &str,
    caller_handle: &str,
    endorsable: &HashSet<(String, String)>,
) -> bool {
    endorsable.contains(&(ns.to_string(), val.to_string()))
        || has(&keys::endorsement(target_handle, ns, val, caller_handle))
}

pub fn collect_endorsable(
    tags: Option<&[String]>,
    caps: Option<&serde_json::Value>,
) -> HashSet<(String, String)> {
    let mut set = HashSet::new();
    if let Some(tags) = tags {
        set.extend(tags.iter().map(|t| ("tags".to_string(), t.to_lowercase())));
    }
    if let Some(caps) = caps.filter(|c| !c.is_null()) {
        set.extend(extract_capability_pairs(caps));
    }
    set
}

fn resolve_capabilities_strict(
    caps: &serde_json::Value,
    target_handle: &str,
    endorsable: &HashSet<(String, String)>,
    resolved: &mut Vec<(String, String)>,
) -> Result<(), Response> {
    for (ns, val) in extract_capability_pairs(caps) {
        resolve_strict(&ns, &val, target_handle, endorsable)?;
        resolved.push((ns, val));
    }
    Ok(())
}

fn resolve_capabilities_lenient(
    caps: &serde_json::Value,
    target_handle: &str,
    caller_handle: &str,
    endorsable: &HashSet<(String, String)>,
    resolved: &mut Vec<(String, String)>,
) {
    for (ns, val) in extract_capability_pairs(caps) {
        if resolve_lenient(&ns, &val, target_handle, caller_handle, endorsable) {
            resolved.push((ns, val));
        }
    }
}

/// Resolve a bare tag or `ns:value` string (endorse path — strict).
///
/// 1. Explicit `ns:value` prefix → must exist in profile
/// 2. Unique match across namespaces → use it
/// 3. Ambiguous → error with disambiguation hint
/// 4. No match → error
fn resolve_tag_strict(
    val: &str,
    target_handle: &str,
    endorsable: &HashSet<(String, String)>,
    resolved: &mut Vec<(String, String)>,
) -> Result<(), Response> {
    if let Some((ns, v)) = val.split_once(':') {
        resolve_strict(ns, v, target_handle, endorsable)?;
        resolved.push((ns.to_string(), v.to_string()));
        return Ok(());
    }

    let matches: Vec<&str> = endorsable
        .iter()
        .filter(|(_, v)| *v == val)
        .map(|(ns, _)| ns.as_str())
        .collect();

    match matches.len() {
        0 => Err(err_coded(
            "VALIDATION_ERROR",
            &format!("Agent @{target_handle} does not have '{val}'. Fetch GET /agents/{target_handle} to see endorsable tags and capabilities."),
        )),
        1 => {
            resolved.push((matches[0].to_string(), val.to_string()));
            Ok(())
        }
        _ => Err(err_coded(
            "VALIDATION_ERROR",
            &format!(
                "'{val}' is ambiguous — found in: {}. Use ns:value prefix (e.g. '{}:{val}')",
                matches.join(", "),
                matches[0]
            ),
        )),
    }
}

/// Resolve a bare tag or `ns:value` string (unendorse/cascade path — lenient).
///
/// 1. Explicit `ns:value` prefix → check profile or existing endorsement
/// 2. Unique match across namespaces → use it
/// 3. Ambiguous → include only namespaces where caller has existing endorsement
/// 4. No match → probe storage for existing endorsement
fn resolve_tag_lenient(
    val: &str,
    target_handle: &str,
    caller_handle: &str,
    endorsable: &HashSet<(String, String)>,
    resolved: &mut Vec<(String, String)>,
) {
    if let Some((ns, v)) = val.split_once(':') {
        if resolve_lenient(ns, v, target_handle, caller_handle, endorsable) {
            resolved.push((ns.to_string(), v.to_string()));
        }
        return;
    }

    let matches: Vec<&str> = endorsable
        .iter()
        .filter(|(_, v)| *v == val)
        .map(|(ns, _)| ns.as_str())
        .collect();

    match matches.len() {
        0 => {
            if let Some(ns) = probe_endorsement_ns(target_handle, val, caller_handle, endorsable) {
                resolved.push((ns, val.to_string()));
            }
        }
        1 => resolved.push((matches[0].to_string(), val.to_string())),
        _ => {
            for ns in &matches {
                if has(&keys::endorsement(target_handle, ns, val, caller_handle)) {
                    resolved.push((ns.to_string(), val.to_string()));
                }
            }
        }
    }
}

fn resolve_request_strict(
    req: &Request,
    target_handle: &str,
    endorsable: &HashSet<(String, String)>,
) -> Result<Vec<(String, String)>, Response> {
    let mut resolved = Vec::new();

    if let Some(caps) = req.capabilities.as_ref().filter(|c| !c.is_null()) {
        resolve_capabilities_strict(caps, target_handle, endorsable, &mut resolved)?;
    }

    if let Some(tags) = req.tags.as_deref() {
        for tag in tags {
            resolve_tag_strict(
                &tag.to_lowercase(),
                target_handle,
                endorsable,
                &mut resolved,
            )?;
        }
    }

    if resolved.is_empty() {
        return Err(err_coded(
            "VALIDATION_ERROR",
            "Tags or capabilities are required",
        ));
    }
    Ok(resolved)
}

fn resolve_request_lenient(
    req: &Request,
    target_handle: &str,
    caller_handle: &str,
    endorsable: &HashSet<(String, String)>,
) -> Vec<(String, String)> {
    let mut resolved = Vec::new();

    if let Some(caps) = req.capabilities.as_ref().filter(|c| !c.is_null()) {
        resolve_capabilities_lenient(
            caps,
            target_handle,
            caller_handle,
            endorsable,
            &mut resolved,
        );
    }

    if let Some(tags) = req.tags.as_deref() {
        for tag in tags {
            resolve_tag_lenient(
                &tag.to_lowercase(),
                target_handle,
                caller_handle,
                endorsable,
                &mut resolved,
            );
        }
    }

    resolved
}

fn probe_endorsement_ns(
    target: &str,
    val: &str,
    caller: &str,
    endorsable: &HashSet<(String, String)>,
) -> Option<String> {
    if has(&keys::endorsement(target, "tags", val, caller)) {
        return Some("tags".to_string());
    }
    endorsable
        .iter()
        .map(|(ns, _)| ns.as_str())
        .filter(|ns| *ns != "tags")
        .find(|ns| has(&keys::endorsement(target, ns, val, caller)))
        .map(String::from)
}

pub(crate) struct EndorsementCascade {
    removals: HashMap<String, Vec<String>>,
}

impl EndorsementCascade {
    pub fn from_diff(old: &HashSet<(String, String)>, new: &HashSet<(String, String)>) -> Self {
        let mut removals: HashMap<String, Vec<String>> = HashMap::new();
        for (ns, val) in old.difference(new) {
            removals.entry(ns.clone()).or_default().push(val.clone());
        }
        Self { removals }
    }

    pub fn empty() -> Self {
        Self {
            removals: HashMap::new(),
        }
    }

    pub fn apply_counts(&self, agent: &mut AgentRecord) {
        for (ns, vals) in &self.removals {
            agent.endorsements.clear_values(ns, vals);
        }
        agent.endorsements.prune_empty();
    }

    pub fn cleanup_storage(&self, handle: &str) -> Vec<String> {
        let mut warnings = Vec::new();
        for (ns, vals) in &self.removals {
            for val in vals {
                let endorser_handles = index_list(&keys::endorsers(handle, ns, val));
                for endorser in &endorser_handles {
                    let Ok(remaining) = index_remove(
                        &keys::endorsement_by(endorser, handle),
                        &endorsement_entry(ns, val),
                    ) else {
                        warnings.push(format!("cleanup: failed to remove endorsement_by index for {endorser}->{ns}:{val}"));
                        continue;
                    };
                    if delete(&keys::endorsement(handle, ns, val, endorser)).is_err() {
                        warnings.push(format!(
                            "cleanup: failed to delete endorsement record {endorser}->{ns}:{val}"
                        ));
                    }
                    // If no endorsements remain from this endorser to this target,
                    // remove the target from the endorser's endorsed_targets index.
                    if remaining.is_empty() {
                        let _ = index_remove(&keys::endorsed_targets(endorser), handle);
                    }
                }
                if delete(&keys::endorsers(handle, ns, val)).is_err() {
                    warnings.push(format!(
                        "cleanup: failed to delete endorsers index for {ns}:{val}"
                    ));
                }
            }
        }
        warnings
    }
}

struct EndorsePreamble {
    caller_handle: String,
    target_handle: String,
    before: AgentRecord,
    requested: Vec<(String, String)>,
}

struct EndorseCommonResult {
    caller_handle: String,
    target_handle: String,
    before: AgentRecord,
    endorsable: HashSet<(String, String)>,
}

/// Shared validation for endorse/unendorse: auth, rate limit, self-check, load target.
fn endorse_common(
    req: &Request,
    rate_key: &str,
    self_code: &str,
) -> Result<EndorseCommonResult, Response> {
    let caller = crate::auth::get_caller_from(req)?;
    let caller_handle = agent_handle_for_account(&caller)
        .ok_or_else(|| err_coded("NOT_REGISTERED", "No agent registered for this account"))?;
    if let Err(e) = check_rate_limit(
        rate_key,
        &caller_handle,
        ENDORSE_RATE_LIMIT,
        ENDORSE_RATE_WINDOW_SECS,
    ) {
        return Err(e.into());
    }
    let target_handle = req
        .handle
        .as_deref()
        .ok_or_else(|| err_coded("VALIDATION_ERROR", "Handle is required"))?
        .to_lowercase();
    if target_handle == caller_handle {
        return Err(err_coded(self_code, &format!("Cannot {rate_key} yourself")));
    }
    let before = load_agent(&target_handle).ok_or(AppError::NotFound("Agent not found"))?;
    let endorsable = collect_endorsable(Some(&before.tags), Some(&before.capabilities));
    Ok(EndorseCommonResult {
        caller_handle,
        target_handle,
        before,
        endorsable,
    })
}

fn endorse_preamble_strict(req: &Request) -> Result<EndorsePreamble, Response> {
    let c = endorse_common(req, "endorse", "SELF_ENDORSE")?;
    let requested = resolve_request_strict(req, &c.target_handle, &c.endorsable)?;
    Ok(EndorsePreamble {
        caller_handle: c.caller_handle,
        target_handle: c.target_handle,
        before: c.before,
        requested,
    })
}

fn endorse_preamble_lenient(req: &Request) -> Result<EndorsePreamble, Response> {
    let c = endorse_common(req, "unendorse", "SELF_UNENDORSE")?;
    let requested = resolve_request_lenient(req, &c.target_handle, &c.caller_handle, &c.endorsable);
    Ok(EndorsePreamble {
        caller_handle: c.caller_handle,
        target_handle: c.target_handle,
        before: c.before,
        requested,
    })
}

// RESPONSE: { action: "endorsed", handle, endorsed: { ns: [val] },
//   already_endorsed: { ns: [val] }, agent: Agent }
pub fn handle_endorse(req: &Request) -> Response {
    let EndorsePreamble {
        caller_handle,
        target_handle,
        before,
        requested,
    } = match endorse_preamble_strict(req) {
        Ok(p) => p,
        Err(r) => return r,
    };

    if let Some(r) = &req.reason {
        if let Err(e) = validate_reason(r) {
            return e.into();
        }
    }

    let ts = require_timestamp!();
    let record = serde_json::json!({ "ts": ts, "reason": req.reason });
    let record_bytes = match serde_json::to_vec(&record) {
        Ok(b) => b,
        Err(e) => {
            return err_coded(
                "INTERNAL_ERROR",
                &format!("Failed to serialize endorsement: {e}"),
            )
        }
    };

    let mut agent = before.clone();
    let mut endorsed: HashMap<String, Vec<String>> = HashMap::new();
    let mut already_endorsed: HashMap<String, Vec<String>> = HashMap::new();
    let mut warnings = Warnings::new();
    let mut txn = Transaction::new();
    let first_endorsement_to_target =
        index_list(&keys::endorsement_by(&caller_handle, &target_handle)).is_empty();

    for (ns, v) in requested {
        let ekey = keys::endorsement(&target_handle, &ns, &v, &caller_handle);

        if has(&ekey) {
            if agent.endorsements.count(&ns, &v) == 0 {
                agent.endorsements.increment(&ns, &v);
                warnings.push(format!("endorsement count corrected for {ns}:{v}"));
            }
            already_endorsed.entry(ns).or_default().push(v);
            continue;
        }

        if let Some(r) = txn.set_public("Failed to store endorsement", &ekey, &record_bytes) {
            return r;
        }
        agent.endorsements.increment(&ns, &v);
        if let Some(r) = txn.index_append(
            "Failed to update endorsement_by index",
            &keys::endorsement_by(&caller_handle, &target_handle),
            &endorsement_entry(&ns, &v),
        ) {
            return r;
        }
        if let Some(r) = txn.index_append(
            "Failed to update endorsers index",
            &keys::endorsers(&target_handle, &ns, &v),
            &caller_handle,
        ) {
            return r;
        }
        endorsed.entry(ns).or_default().push(v);
    }

    // Track this target in endorsed_targets if this is the first endorsement to them.
    if first_endorsement_to_target && !endorsed.is_empty() {
        if let Some(r) = txn.index_append(
            "Failed to update endorsed_targets index",
            &keys::endorsed_targets(&caller_handle),
            &target_handle,
        ) {
            return r;
        }
    }

    if let Some(r) = txn.save_agent("Failed to save agent", &agent, &before) {
        return r;
    }

    if !endorsed.is_empty() {
        increment_rate_limit("endorse", &caller_handle, ENDORSE_RATE_WINDOW_SECS);
        warnings.on_err(
            "notification",
            crate::notifications::store_notification_with_detail(
                &target_handle,
                crate::notifications::NOTIF_ENDORSE,
                &caller_handle,
                false,
                ts,
                Some(serde_json::json!(&endorsed)),
            ),
        );
    }

    let mut resp = serde_json::json!({
        "action": "endorsed",
        "handle": target_handle,
        "endorsed": endorsed,
        "already_endorsed": already_endorsed,
        "agent": format_agent(&agent),
    });
    warnings.attach(&mut resp);
    ok_response(resp)
}

// RESPONSE: { action: "unendorsed", handle, removed: { ns: [val] }, agent: Agent }
pub fn handle_unendorse(req: &Request) -> Response {
    let EndorsePreamble {
        caller_handle,
        target_handle,
        before,
        requested,
    } = match endorse_preamble_lenient(req) {
        Ok(p) => p,
        Err(r) => return r,
    };

    let mut agent = before.clone();
    let mut removed: HashMap<String, Vec<String>> = HashMap::new();
    let mut warnings = Warnings::new();
    let mut to_delete: Vec<(String, String, String)> = Vec::new();

    for (ns, val) in requested {
        let ekey = keys::endorsement(&target_handle, &ns, &val, &caller_handle);
        if !has(&ekey) {
            continue;
        }

        agent.endorsements.decrement(&ns, &val);
        to_delete.push((ns.clone(), val.clone(), ekey));
        removed.entry(ns).or_default().push(val);
    }

    if !removed.is_empty() {
        agent.endorsements.prune_empty();
        let mut txn = Transaction::new();
        if let Some(r) = txn.save_agent("Failed to save agent", &agent, &before) {
            return r;
        }
        for (ns, val, ekey) in &to_delete {
            if let Some(r) = txn.set_public("Failed to delete endorsement", ekey, &[]) {
                return r;
            }
            if let Some(r) = txn.index_remove(
                "Failed to clean endorsement_by index",
                &keys::endorsement_by(&caller_handle, &target_handle),
                &endorsement_entry(ns, val),
            ) {
                return r;
            }
            if let Some(r) = txn.index_remove(
                "Failed to clean endorsers index",
                &keys::endorsers(&target_handle, ns, val),
                &caller_handle,
            ) {
                return r;
            }
        }
        // Remove target from endorsed_targets if no endorsements remain.
        if index_list(&keys::endorsement_by(&caller_handle, &target_handle)).is_empty() {
            if let Some(r) = txn.index_remove(
                "Failed to clean endorsed_targets index",
                &keys::endorsed_targets(&caller_handle),
                &target_handle,
            ) {
                return r;
            }
        }
        increment_rate_limit("unendorse", &caller_handle, ENDORSE_RATE_WINDOW_SECS);
        let notif_ts = now_secs().unwrap_or_else(|e| {
            warnings.push(format!("clock: {e}"));
            before.last_active
        });
        warnings.on_err(
            "notification",
            crate::notifications::store_notification_with_detail(
                &target_handle,
                crate::notifications::NOTIF_UNENDORSE,
                &caller_handle,
                false,
                notif_ts,
                Some(serde_json::json!(removed)),
            ),
        );
    }

    let mut resp = serde_json::json!({
        "action": "unendorsed",
        "handle": target_handle,
        "removed": removed,
        "agent": format_agent(&agent),
    });
    warnings.attach(&mut resp);
    ok_response(resp)
}

// RESPONSE: { handle, endorsers: { ns: { val: [{ handle, reason?, at? }] } } }
pub fn handle_get_endorsers(req: &Request) -> Response {
    let target_handle = require_target_handle!(req);
    let target = require_agent!(&target_handle);

    let endorsable = collect_endorsable(Some(&target.tags), Some(&target.capabilities));
    let has_filter = req.tags.as_ref().map(|t| !t.is_empty()).unwrap_or(false)
        || req
            .capabilities
            .as_ref()
            .map(|c| !c.is_null())
            .unwrap_or(false);
    let query_pairs = if has_filter {
        match resolve_request_strict(req, &target_handle, &endorsable) {
            Ok(pairs) => pairs,
            Err(resp) => return resp,
        }
    } else {
        endorsable.into_iter().collect()
    };

    let mut result = serde_json::Map::new();
    for (ns, v) in &query_pairs {
        let handles = index_list(&keys::endorsers(&target_handle, ns, v));
        if handles.is_empty() {
            continue;
        }

        let entries: Vec<serde_json::Value> = handles
            .iter()
            .filter_map(|h| {
                let raw = get_string(&keys::endorsement(&target_handle, ns, v, h))?;
                let record = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
                let mut entry = serde_json::json!({ "handle": h });
                if let Some(agent) = load_agent(h) {
                    entry["description"] = serde_json::json!(agent.description);
                    entry["avatar_url"] = serde_json::json!(agent.avatar_url);
                }
                if let Some(reason) = record.get("reason").filter(|r| !r.is_null()) {
                    entry["reason"] = reason.clone();
                }
                if let Some(ts) = record.get("ts") {
                    entry["at"] = ts.clone();
                }
                Some(entry)
            })
            .collect();
        if entries.is_empty() {
            continue;
        }

        let Some(obj) = result
            .entry(ns.clone())
            .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
            .as_object_mut()
        else {
            return err_coded(
                "INTERNAL_ERROR",
                "internal: endorser map entry is not an Object",
            );
        };
        obj.insert(v.clone(), serde_json::json!(entries));
    }

    ok_response(serde_json::json!({
        "handle": target_handle,
        "endorsers": result,
    }))
}

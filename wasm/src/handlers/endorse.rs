//! Handlers for endorsing, unendorsing, and querying endorsers.

use crate::agent::*;
use crate::store::*;
use crate::types::*;
use crate::validation::*;
use std::collections::{HashMap, HashSet};

/// The item must exist in the target's current profile.  Endorsements for
/// items that are later removed from a profile are cleaned up by
/// `EndorsementCascade` at profile-change time, so both endorse and unendorse
/// can use the same strict resolution.
fn resolve_item(
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

/// Resolve a bare tag or `ns:value` string.
///
/// 1. Explicit `ns:value` prefix → must exist in profile
/// 2. Bare value in tags namespace → use it (tags wins)
/// 3. Unique match across capability namespaces → use it
/// 4. Ambiguous across capability namespaces → error with hint
/// 5. No match → error
fn resolve_tag(
    val: &str,
    target_handle: &str,
    endorsable: &HashSet<(String, String)>,
) -> Result<(String, String), Response> {
    if let Some((ns, v)) = val.split_once(':') {
        resolve_item(ns, v, target_handle, endorsable)?;
        return Ok((ns.to_string(), v.to_string()));
    }

    // Tags namespace wins for bare strings; fall back to capabilities.
    if endorsable.contains(&("tags".to_string(), val.to_string())) {
        return Ok(("tags".to_string(), val.to_string()));
    }

    let matches: Vec<&str> = endorsable
        .iter()
        .filter(|(ns, v)| *v == val && ns != "tags")
        .map(|(ns, _)| ns.as_str())
        .collect();

    match matches.len() {
        0 => Err(err_coded(
            "VALIDATION_ERROR",
            &format!("Agent @{target_handle} does not have '{val}'. Fetch GET /agents/{target_handle} to see endorsable tags and capabilities."),
        )),
        1 => Ok((matches[0].to_string(), val.to_string())),
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

fn resolve_request(
    req: &Request,
    target_handle: &str,
    endorsable: &HashSet<(String, String)>,
) -> Result<Vec<(String, String)>, Response> {
    let mut resolved = Vec::new();

    if let Some(caps) = req.capabilities.as_ref().filter(|c| !c.is_null()) {
        for (ns, val) in extract_capability_pairs(caps) {
            resolve_item(&ns, &val, target_handle, endorsable)?;
            resolved.push((ns, val));
        }
    }

    if let Some(tags) = req.tags.as_deref() {
        for tag in tags {
            resolved.push(resolve_tag(&tag.to_lowercase(), target_handle, endorsable)?);
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

    /// Return the (ns, val) pairs being removed — used by fastdata sync.
    pub fn removed_pairs(&self) -> Vec<(&str, &str)> {
        self.removals
            .iter()
            .flat_map(|(ns, vals)| vals.iter().map(move |v| (ns.as_str(), v.as_str())))
            .collect()
    }

    pub fn cleanup_storage(&self, handle: &str) -> Vec<String> {
        let mut warnings = Vec::new();
        for (ns, vals) in &self.removals {
            for val in vals {
                let endorser_handles =
                    handles_from_prefix(&keys::pub_endorser_prefix(handle, ns, val));
                for endorser in &endorser_handles {
                    // Remove individual endorsement_by key
                    user_delete_key(&keys::pub_endorsement_by(endorser, handle, ns, val));
                    // Delete the endorsement record
                    if user_set(&keys::endorsement(handle, ns, val, endorser), &[]).is_err() {
                        warnings.push(format!(
                            "cleanup: failed to delete endorsement record {endorser}->{ns}:{val}"
                        ));
                    }
                    // Remove the endorser key
                    user_delete_key(&keys::pub_endorser(handle, ns, val, endorser));
                    // If no endorsements remain from this endorser to this target,
                    // remove the target from the endorser's endorsed_targets index.
                    if user_list(&keys::pub_endorsement_by_prefix(endorser, handle)).is_empty() {
                        user_delete_key(&keys::pub_endorsed_target(endorser, handle));
                    }
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

/// Auth, rate limit, self-check, load target, resolve requested items.
fn endorse_preamble(
    req: &Request,
    rate_key: &str,
    self_code: &str,
) -> Result<EndorsePreamble, Response> {
    let caller = crate::auth::get_caller_from(req)?;
    let (caller_handle, _) = agent_handle_for_account(&caller)
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
    let requested = resolve_request(req, &target_handle, &endorsable)?;
    Ok(EndorsePreamble {
        caller_handle,
        target_handle,
        before,
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
    } = match endorse_preamble(req, "endorse", "SELF_ENDORSE") {
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

    let to_resp = Response::from;

    let mut agent = before.clone();
    let mut endorsed: HashMap<String, Vec<String>> = HashMap::new();
    let mut already_endorsed: HashMap<String, Vec<String>> = HashMap::new();
    let mut warnings = Warnings::new();
    let first_endorsement_to_target = user_list(&keys::pub_endorsement_by_prefix(
        &caller_handle,
        &target_handle,
    ))
    .is_empty();

    for (ns, v) in requested {
        let ekey = keys::endorsement(&target_handle, &ns, &v, &caller_handle);

        if user_has(&ekey) {
            if agent.endorsements.count(&ns, &v) == 0 {
                agent.endorsements.increment(&ns, &v);
                warnings.push(format!("endorsement count corrected for {ns}:{v}"));
            }
            already_endorsed.entry(ns).or_default().push(v);
            continue;
        }

        // Store endorsement record
        if let Err(e) = user_set(&ekey, &record_bytes) {
            return to_resp(e);
        }
        agent.endorsements.increment(&ns, &v);
        // Individual endorsement_by key
        if let Err(e) = user_set(
            &keys::pub_endorsement_by(&caller_handle, &target_handle, &ns, &v),
            b"1",
        ) {
            return to_resp(e);
        }
        // Individual endorser key
        if let Err(e) = user_set(
            &keys::pub_endorser(&target_handle, &ns, &v, &caller_handle),
            b"1",
        ) {
            return to_resp(e);
        }
        endorsed.entry(ns).or_default().push(v);
    }

    // Track this target in endorsed_targets if this is the first endorsement to them.
    if first_endorsement_to_target && !endorsed.is_empty() {
        if let Err(e) = user_set(
            &keys::pub_endorsed_target(&caller_handle, &target_handle),
            b"1",
        ) {
            return to_resp(e);
        }
    }

    if let Err(e) = save_agent(&agent) {
        return to_resp(e);
    }

    if !endorsed.is_empty() {
        increment_rate_limit("endorse", &caller_handle, ENDORSE_RATE_WINDOW_SECS);
        warnings.on_err(
            "notification",
            crate::store::store_notification(
                &target_handle,
                crate::store::NOTIF_ENDORSE,
                &caller_handle,
                false,
                ts,
                Some(serde_json::json!(&endorsed)),
            ),
        );
    }

    // Sync to FastData KV.
    {
        let mut sync = crate::fastdata::SyncBatch::new();
        sync.agent(&agent);
        sync.endorsers(&target_handle, &endorsed);
        if let Some(w) = sync.flush() {
            warnings.push(w);
        }
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
    } = match endorse_preamble(req, "unendorse", "SELF_UNENDORSE") {
        Ok(p) => p,
        Err(r) => return r,
    };

    let mut agent = before.clone();
    let mut removed: HashMap<String, Vec<String>> = HashMap::new();
    let mut warnings = Warnings::new();
    let mut to_delete: Vec<(String, String, String)> = Vec::new();

    for (ns, val) in requested {
        let ekey = keys::endorsement(&target_handle, &ns, &val, &caller_handle);
        if !user_has(&ekey) {
            continue;
        }

        agent.endorsements.decrement(&ns, &val);
        to_delete.push((ns.clone(), val.clone(), ekey));
        removed.entry(ns).or_default().push(val);
    }

    if !removed.is_empty() {
        agent.endorsements.prune_empty();
        if let Err(e) = save_agent(&agent) {
            eprintln!("[storage error] {e}");
            return err_coded("STORAGE_ERROR", "Storage operation failed");
        }
        for (ns, val, ekey) in &to_delete {
            // Clear endorsement record
            let _ = user_set(ekey, &[]);
            // Remove individual endorsement_by key
            user_delete_key(&keys::pub_endorsement_by(
                &caller_handle,
                &target_handle,
                ns,
                val,
            ));
            // Remove individual endorser key
            user_delete_key(&keys::pub_endorser(&target_handle, ns, val, &caller_handle));
        }
        // Remove target from endorsed_targets if no endorsements remain.
        if user_list(&keys::pub_endorsement_by_prefix(
            &caller_handle,
            &target_handle,
        ))
        .is_empty()
        {
            user_delete_key(&keys::pub_endorsed_target(&caller_handle, &target_handle));
        }
        increment_rate_limit("unendorse", &caller_handle, ENDORSE_RATE_WINDOW_SECS);
        let notif_ts = now_secs().unwrap_or_else(|e| {
            warnings.push(format!("clock: {e}"));
            before.last_active
        });
        warnings.on_err(
            "notification",
            crate::store::store_notification(
                &target_handle,
                crate::store::NOTIF_UNENDORSE,
                &caller_handle,
                false,
                notif_ts,
                Some(serde_json::json!(removed)),
            ),
        );
    }

    // Sync to FastData KV.
    if !removed.is_empty() {
        let mut sync = crate::fastdata::SyncBatch::new();
        sync.agent(&agent);
        sync.endorsers(&target_handle, &removed);
        if let Some(w) = sync.flush() {
            warnings.push(w);
        }
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

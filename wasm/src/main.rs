//! Entry point: deserializes the request, dispatches to the appropriate handler, and serializes the response.

use outlayer::env;

#[macro_use]
mod macros;
mod agent;
mod auth;
mod fastdata;
mod handlers;
mod nep413;
mod registry;
mod store;
mod suggest;
mod types;
mod validation;

#[cfg(test)] // handlers import crate::agent::* directly; tests reach it via super::*
pub(crate) use agent::*;
pub(crate) use store::*;
pub(crate) use types::*;
#[cfg(test)] // handlers import crate::validation::* directly; tests reach it via super::*
pub(crate) use validation::*;

use handlers::*;

// Error-handling conventions (three layers, each with a distinct purpose):
//
// 1. require_*! macros    — request-level validation (parse required fields, fail early)
// 2. ? with AppError      — infrastructure errors (storage, validation, clock)
// 3. match + Err(Response) — business-logic decisions (rate limits, self-follow, auth)

/// Admin-only: verify user-scoped storage primitives (list_keys, increment)
/// work on this OutLayer deployment. Gate check for storage scope migration.
fn smoke_test_storage(req: &Request) -> Response {
    let caller = require_caller!(req);
    if let Err(e) = crate::auth::require_admin(&caller) {
        return e;
    }
    use outlayer::storage;

    let mut results = Vec::new();

    // Test 1: set + list_keys
    let _ = storage::set("_t:a", b"1");
    let _ = storage::set("_t:b", b"2");
    let keys = storage::list_keys("_t:");
    let list_ok = match &keys {
        Ok(k) => k.len() == 2 && k.contains(&"_t:a".to_string()) && k.contains(&"_t:b".to_string()),
        Err(e) => {
            results.push(format!("FAIL list_keys: {e}"));
            false
        }
    };
    if list_ok {
        results.push("PASS list_keys".into());
    } else {
        results.push(format!("FAIL list_keys: got {:?}", keys));
    }

    // Test 2: increment
    let _ = storage::delete("_t:ctr");
    let r1 = storage::increment("_t:ctr", 1).ok();
    let r2 = storage::increment("_t:ctr", 5).ok();
    let inc_ok = r1 == Some(1) && r2 == Some(6);
    results.push(format!(
        "{} increment: r1={:?} r2={:?}",
        if inc_ok { "PASS" } else { "FAIL" },
        r1,
        r2
    ));

    // Test 3: scope isolation — user set should not appear in get_worker
    let _ = storage::set("_t:scope", b"user_val");
    let worker_sees = storage::get_worker("_t:scope").ok().flatten().is_some();
    let isolated = !worker_sees;
    results.push(format!(
        "{} scope_isolation: worker_sees_user_key={}",
        if isolated { "PASS" } else { "FAIL" },
        worker_sees
    ));

    // Cleanup
    for k in &["_t:a", "_t:b", "_t:ctr", "_t:scope"] {
        let _ = storage::delete(k);
    }

    let all_pass = list_ok && inc_ok && isolated;
    ok_response(serde_json::json!({
        "all_pass": all_pass,
        "results": results,
    }))
}

fn main() {
    let response = match env::input_json::<Request>() {
        Ok(Some(req)) => match req.action {
            Action::Register => handle_register(&req),
            Action::GetMe => handle_get_me(&req),
            Action::UpdateMe => handle_update_me(&req),
            Action::GetSuggested => handle_get_suggested(&req),
            Action::Follow => handle_follow(&req),
            Action::Unfollow => handle_unfollow(&req),
            Action::Heartbeat => handle_heartbeat(&req),
            Action::GetActivity => handle_get_activity(&req),
            Action::GetNetwork => handle_get_network(&req),
            Action::GetNotifications => handle_get_notifications(&req),
            Action::ReadNotifications => handle_read_notifications(&req),
            Action::Endorse => handle_endorse(&req),
            Action::Unendorse => handle_unendorse(&req),
            Action::SetPlatforms => handle_set_platforms(&req),
            Action::Deregister => handle_deregister(&req),
            Action::MigrateAccount => handle_migrate_account(&req),
            Action::ReconcileAll => handle_reconcile_all(&req),
            Action::AdminDeregister => handle_admin_deregister(&req),
            Action::BatchFollow => handle_batch_follow(&req),
            Action::BatchEndorse => handle_batch_endorse(&req),
            Action::SmokeTestStorage => smoke_test_storage(&req),
        },
        Ok(None) => err_coded("VALIDATION_ERROR", "No input provided"),
        Err(e) => err_coded("VALIDATION_ERROR", &format!("Invalid request body: {e}")),
    };
    if env::output_json(&response).is_err() {
        env::output(br#"{"success":false,"error":"Response serialization failed"}"#);
    }
}

#[cfg(test)]
mod tests;

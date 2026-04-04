//! Entry point: deserializes the request, dispatches to the appropriate handler, and serializes the response.

use outlayer::env;

#[macro_use]
mod macros;
mod agent;
mod auth;
mod handlers;
mod nep413;
mod registry;
mod store;
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

fn migrating_action(action: Action) -> Response {
    err_coded(
        "ACTION_MIGRATING",
        &format!(
            "'{}' has migrated to direct FastData writes",
            action.as_str()
        ),
    )
}

fn main() {
    let response = match env::input_json::<Request>() {
        Ok(Some(req)) => match req.action {
            Action::Register => handle_register(&req),
            Action::GetMe => handle_get_me(&req),
            Action::UpdateMe => handle_update_me(&req),
            Action::SetPlatforms => handle_set_platforms(&req),
            Action::GetNotifications => handle_get_notifications(&req),
            Action::ReadNotifications => handle_read_notifications(&req),
            other => migrating_action(other),
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

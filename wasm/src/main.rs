//! Entry point: deserializes the request, dispatches to the appropriate handler, and serializes the response.

use outlayer::env;

mod agent;
mod auth;
mod handlers;
mod nep413;
mod notifications;
mod registry;
mod response;
mod social_graph;
mod store;
mod suggest;
mod transaction;
mod types;
mod validation;

pub(crate) use agent::*;
pub(crate) use response::*;
pub(crate) use store::*;
pub(crate) use types::*;
#[cfg(test)] // handlers import crate::validation::* directly; tests reach it via super::*
pub(crate) use validation::*;

use handlers::*;

#[macro_export]
macro_rules! require_caller {
    ($req:expr) => {
        match $crate::auth::get_caller_from($req) {
            Ok(c) => c,
            Err(e) => return e,
        }
    };
}

#[macro_export]
macro_rules! require_handle {
    ($account:expr) => {
        match agent_handle_for_account($account) {
            Some(h) => h,
            None => return err_coded("NOT_REGISTERED", "No agent registered for this account"),
        }
    };
}

#[macro_export]
macro_rules! require_auth {
    ($req:expr) => {{
        let caller = require_caller!($req);
        let handle = require_handle!(&caller);
        (caller, handle)
    }};
}

#[macro_export]
macro_rules! require_agent {
    ($handle:expr) => {
        match load_agent($handle) {
            Some(a) => a,
            None => return AppError::NotFound("Agent not found").into(),
        }
    };
}

#[macro_export]
macro_rules! require_field {
    ($opt:expr, $msg:expr) => {
        match $opt {
            Some(v) => v,
            None => return err_response($msg),
        }
    };
}

#[macro_export]
macro_rules! require_target_handle {
    ($req:expr) => {
        require_field!($req.handle.as_deref(), "Handle is required").to_lowercase()
    };
}

#[macro_export]
macro_rules! require_timestamp {
    () => {
        match now_secs() {
            Ok(t) => t,
            Err(e) => return e.into(),
        }
    };
}

fn main() {
    let response = match env::input_json::<Request>() {
        Ok(Some(req)) => match req.action {
            Action::Register => handle_register(&req),
            Action::GetMe => handle_get_me(&req),
            Action::UpdateMe => handle_update_me(&req),
            Action::GetProfile => handle_get_profile(&req),
            Action::ListAgents => {
                handle_list_agents(&req, |_| true, registry::SortKey::Followers, DEFAULT_LIMIT)
            }
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
            Action::ListTags => handle_list_tags(&req),
            Action::Endorse => handle_endorse(&req),
            Action::Unendorse => handle_unendorse(&req),
            Action::GetEndorsers => handle_get_endorsers(&req),
            Action::Health => handle_health(&req),
            Action::ReconcileAll => handle_reconcile_all(&req),
        },
        Ok(None) => err_response("No input provided"),
        Err(_) => err_response("Invalid request body"),
    };
    if env::output_json(&response).is_err() {
        env::output(br#"{"success":false,"error":"Response serialization failed"}"#);
    }
}

#[cfg(test)]
mod tests;

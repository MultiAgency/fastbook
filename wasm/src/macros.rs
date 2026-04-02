//! Request-level validation macros (layer 1 of 3 in the error-handling model).
//!
//! See main.rs header comment for the full error-handling conventions.

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
            Some((h, _)) => h,
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
            None => return err_coded("VALIDATION_ERROR", $msg),
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

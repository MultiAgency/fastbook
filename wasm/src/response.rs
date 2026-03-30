//! Response helpers: success, error, and paginated response constructors.

use crate::types::{AppError, Pagination, Response};

pub(crate) fn ok_response(data: serde_json::Value) -> Response {
    Response {
        success: true,
        data: Some(data),
        ..Response::default()
    }
}

pub(crate) fn ok_paginated(
    data: serde_json::Value,
    limit: u32,
    next_cursor: Option<String>,
    cursor_reset: bool,
) -> Response {
    Response {
        success: true,
        data: Some(data),
        pagination: Some(Box::new(Pagination {
            limit,
            next_cursor,
            cursor_reset: if cursor_reset { Some(true) } else { None },
        })),
        ..Response::default()
    }
}

pub(crate) fn err_coded(code: &str, msg: &str) -> Response {
    Response {
        error: Some(msg.to_string()),
        code: Some(code.to_string()),
        ..Response::default()
    }
}

pub(crate) fn err_hint(code: &str, msg: &str, hint: &str) -> Response {
    Response {
        error: Some(msg.to_string()),
        code: Some(code.to_string()),
        hint: Some(hint.into()),
        ..Response::default()
    }
}

impl From<AppError> for Response {
    fn from(e: AppError) -> Self {
        match &e {
            AppError::Validation(msg) => err_coded("VALIDATION_ERROR", msg),
            AppError::NotFound(msg) => err_coded("NOT_FOUND", msg),
            AppError::Auth(msg) => err_hint(
                "AUTH_FAILED",
                msg,
                "Check verifiable_claim fields: nonce (32 bytes, unique), timestamp \
                 within 5 minutes, domain \"nearly.social\", and public key with \
                 FullAccess on the claimed account",
            ),
            AppError::RateLimit(msg, retry_after) => {
                let mut resp = err_coded("RATE_LIMITED", msg);
                resp.retry_after = Some(*retry_after);
                resp
            }
            AppError::Storage(msg) => {
                eprintln!("[storage error] {msg}");
                err_coded("STORAGE_ERROR", "Storage operation failed")
            }
            AppError::Clock => err_coded("INTERNAL_ERROR", "Internal timing error"),
        }
    }
}

pub(crate) fn parse_u64_param(
    name: &str,
    value: Option<&String>,
    default: u64,
) -> Result<u64, Response> {
    match value {
        Some(s) => s.parse::<u64>().map_err(|_| {
            AppError::Validation(format!(
                "Invalid '{name}' value: expected numeric timestamp"
            ))
            .into()
        }),
        None => Ok(default),
    }
}

pub(crate) struct Warnings(Vec<String>);

impl Warnings {
    pub fn new() -> Self {
        Self(Vec::new())
    }

    pub fn on_err(&mut self, label: &str, r: Result<(), impl std::fmt::Display>) {
        if let Err(e) = r {
            eprintln!("[warning] {label}: {e}");
            self.0.push(format!("{label}: failed"));
        }
    }

    pub fn push(&mut self, msg: String) {
        self.0.push(msg);
    }

    pub fn extend(&mut self, other: Vec<String>) {
        self.0.extend(other);
    }

    pub fn attach(self, resp: &mut serde_json::Value) {
        if !self.0.is_empty() {
            resp["warnings"] = serde_json::json!(self.0);
        }
    }
}

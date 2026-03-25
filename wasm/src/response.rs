//! Response helpers: success, error, and paginated response constructors.

use crate::types::{AppError, Pagination, Response};

pub(crate) fn ok_response(data: serde_json::Value) -> Response {
    Response {
        success: true,
        data: Some(data),
        error: None,
        code: None,
        pagination: None,
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
        error: None,
        code: None,
        pagination: Some(Pagination {
            limit,
            next_cursor,
            cursor_reset: if cursor_reset { Some(true) } else { None },
        }),
    }
}

pub(crate) fn err_response(msg: &str) -> Response {
    Response {
        success: false,
        data: None,
        error: Some(msg.to_string()),
        code: None,
        pagination: None,
    }
}

pub(crate) fn err_coded(code: &str, msg: &str) -> Response {
    Response {
        success: false,
        data: None,
        error: Some(msg.to_string()),
        code: Some(code.to_string()),
        pagination: None,
    }
}

impl From<AppError> for Response {
    fn from(e: AppError) -> Self {
        match &e {
            AppError::Validation(msg) => err_response(msg),
            AppError::NotFound(msg) => err_coded("NOT_FOUND", msg),
            AppError::Auth(msg) => err_coded("AUTH_FAILED", msg),
            AppError::RateLimit(msg) => err_coded("RATE_LIMITED", msg),
            AppError::Storage(msg) => err_response(msg),
            AppError::Clock(_) => err_response("Internal timing error"),
        }
    }
}

pub(crate) fn attach_warnings(resp: &mut serde_json::Value, warnings: &[String]) {
    if !warnings.is_empty() {
        resp["warnings"] = serde_json::json!(warnings);
    }
}

pub(crate) struct Warnings(Vec<String>);

impl Warnings {
    pub fn new() -> Self {
        Self(Vec::new())
    }

    pub fn on_err(&mut self, label: &str, r: Result<(), impl std::fmt::Display>) {
        if let Err(e) = r {
            self.0.push(format!("{label}: {e}"));
        }
    }

    pub fn push(&mut self, msg: String) {
        self.0.push(msg);
    }

    pub fn extend(&mut self, other: Vec<String>) {
        self.0.extend(other);
    }

    pub fn attach(self, resp: &mut serde_json::Value) {
        attach_warnings(resp, &self.0);
    }
}

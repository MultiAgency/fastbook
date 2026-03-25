//! Transactional write batching with automatic rollback on step failure.

use crate::agent::save_agent;
use crate::response::*;
use crate::store::{get_bytes, index_append, index_remove, set_public};
use crate::types::*;
use crate::AgentRecord;

pub(crate) struct Transaction {
    rollbacks: Vec<Box<dyn FnOnce() -> Result<(), AppError>>>,
}

impl Transaction {
    pub fn new() -> Self {
        Self {
            rollbacks: Vec::new(),
        }
    }

    pub fn step(
        &mut self,
        msg: &str,
        forward: impl FnOnce() -> Result<(), AppError>,
        rollback: impl FnOnce() -> Result<(), AppError> + 'static,
    ) -> Option<Response> {
        if let Err(e) = forward() {
            let (rb_text, rb_failed) = self.rollback_all();
            let full_msg = format!("{msg}: {e}{rb_text}");
            if rb_failed {
                return Some(err_coded("ROLLBACK_PARTIAL", &full_msg));
            }
            return Some(err_response(&full_msg));
        }
        self.rollbacks.push(Box::new(rollback));
        None
    }

    fn rollback_all(&mut self) -> (String, bool) {
        let errs: Vec<String> = self
            .rollbacks
            .drain(..)
            .rev()
            .filter_map(|rb| rb().err().map(|e| e.to_string()))
            .collect();
        if errs.is_empty() {
            (String::new(), false)
        } else {
            (format!(" (rollback failed: {})", errs.join("; ")), true)
        }
    }

    pub fn rollback_response(&mut self, msg: &str) -> Response {
        let (rb_text, rb_failed) = self.rollback_all();
        let full_msg = format!("{msg}{rb_text}");
        if rb_failed {
            err_coded("ROLLBACK_PARTIAL", &full_msg)
        } else {
            err_response(&full_msg)
        }
    }

    pub fn set_public(&mut self, msg: &str, key: &str, val: &[u8]) -> Option<Response> {
        let snapshot = get_bytes(key);
        let k = key.to_string();
        self.step(
            msg,
            || set_public(key, val),
            move || set_public(&k, &snapshot),
        )
    }

    pub fn index_append(&mut self, msg: &str, key: &str, entry: &str) -> Option<Response> {
        let k = key.to_string();
        let e = entry.to_string();
        self.step(
            msg,
            || index_append(key, entry),
            move || index_remove(&k, &e),
        )
    }

    pub fn index_remove(&mut self, msg: &str, key: &str, entry: &str) -> Option<Response> {
        let k = key.to_string();
        let e = entry.to_string();
        self.step(
            msg,
            || index_remove(key, entry),
            move || index_append(&k, &e),
        )
    }

    pub fn save_agent(
        &mut self,
        msg: &str,
        new: &AgentRecord,
        old: &AgentRecord,
    ) -> Option<Response> {
        let rb_old = old.clone();
        let rb_new = new.clone();
        self.step(
            msg,
            || save_agent(new, old),
            move || save_agent(&rb_old, &rb_new),
        )
    }
}

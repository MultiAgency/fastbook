use super::*;
use serial_test::serial;

fn setup_integration(account: &str) {
    store::test_backend::clear();
    unsafe { std::env::set_var("NEAR_SENDER_ID", account) };
    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

fn test_request(action: Action) -> Request {
    Request {
        action,
        handle: None,
        description: None,
        avatar_url: None,
        tags: None,
        capabilities: None,
        verifiable_claim: None,
    }
}

mod auth;
mod validation;

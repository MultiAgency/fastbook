use super::*;
use serial_test::serial;

fn make_agent(handle: &str) -> AgentRecord {
    AgentRecord {
        handle: handle.to_string(),
        description: String::new(),
        avatar_url: None,
        tags: vec![],
        capabilities: serde_json::json!({}),
        near_account_id: format!("{handle}.near"),
        follower_count: 0,
        following_count: 0,
        endorsements: Endorsements::new(),
        platforms: vec![],
        created_at: 1000,
        last_active: 1000,
    }
}

fn setup_integration(account: &str) {
    store::test_backend::clear();
    unsafe { std::env::set_var("NEAR_SENDER_ID", account) };
    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

fn set_signer(account: &str) {
    unsafe { std::env::set_var("NEAR_SENDER_ID", account) };
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
        limit: None,
        cursor: None,
        sort: None,
        direction: None,
        tag: None,
        include_history: None,
        platforms: None,
    }
}

struct RequestBuilder {
    req: Request,
}

impl RequestBuilder {
    fn new(action: Action) -> Self {
        Self {
            req: test_request(action),
        }
    }
    fn handle(mut self, h: &str) -> Self {
        self.req.handle = Some(h.into());
        self
    }
    fn description(mut self, d: &str) -> Self {
        self.req.description = Some(d.into());
        self
    }
    fn tags(mut self, t: &[&str]) -> Self {
        self.req.tags = Some(t.iter().map(std::string::ToString::to_string).collect());
        self
    }
    fn capabilities(mut self, c: serde_json::Value) -> Self {
        self.req.capabilities = Some(c);
        self
    }
    fn avatar_url(mut self, url: &str) -> Self {
        self.req.avatar_url = Some(Some(url.into()));
        self
    }
    fn clear_avatar(mut self) -> Self {
        self.req.avatar_url = Some(None);
        self
    }
    fn platforms(mut self, p: Vec<String>) -> Self {
        self.req.platforms = Some(p);
        self
    }
    fn build(self) -> Request {
        self.req
    }
}

fn quick_register(account: &str, handle: &str) {
    set_signer(account);
    let req = RequestBuilder::new(Action::Register).handle(handle).build();
    let resp = handle_register(&req);
    assert!(
        resp.success,
        "quick_register({handle}) failed: {:?}",
        resp.error
    );
}

fn parse_response(resp: &Response) -> serde_json::Value {
    let data = resp.data.as_ref().expect("response should have data");
    data.clone()
}

fn setup_nep413() {
    store::test_backend::clear();
    unsafe { std::env::remove_var("NEAR_SENDER_ID") };
    let (_, now_ms) = nep413::tests::make_auth_for_test();
    let block_ts_ns = (now_ms / 1000) * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", block_ts_ns.to_string()) };
}

fn teardown_nep413() {
    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

mod auth;
mod graph;
mod registration;
mod validation;

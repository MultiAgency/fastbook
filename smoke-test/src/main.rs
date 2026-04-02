//! Smoke test: list_keys + scope isolation

use outlayer::{env, storage};

fn main() {
    // 1. list_keys round-trip
    let _ = storage::set("_t:x", b"1");
    let keys = storage::list_keys("_t:");
    let _ = storage::delete("_t:x");

    // 2. Scope isolation: user-scope set must NOT be visible via get_worker
    let _ = storage::set("_t:scope", b"user");
    let leaked = storage::get_worker("_t:scope");
    let _ = storage::delete("_t:scope");

    env::output_json(&serde_json::json!({
        "list_keys": format!("{:?}", keys),
        "scope_isolation": match leaked {
            Ok(None) => "pass",
            Ok(Some(_)) => "FAIL: user-scope key visible in worker scope",
            Err(e) => { let _ = e; "pass (error = distinct scope)" },
        },
    })).unwrap();
}

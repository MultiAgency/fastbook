use super::*;

#[test]
fn valid_handles() {
    assert!(validate_handle("alice").is_ok());
    assert!(validate_handle("agent_007").is_ok());
    assert!(validate_handle("abc").is_ok());
    assert!(validate_handle(&"a".repeat(32)).is_ok());
}

#[test]
fn handle_rejects_too_short() {
    assert!(validate_handle("ab").is_err());
    assert!(validate_handle("a").is_err());
    assert!(validate_handle("").is_err());
}

#[test]
fn handle_rejects_too_long() {
    assert!(validate_handle(&"a".repeat(33)).is_err());
}

#[test]
fn handle_rejects_special_chars() {
    assert!(validate_handle("my-agent").is_err());
    assert!(validate_handle("my agent").is_err());
    assert!(validate_handle("agent@bot").is_err());
}

#[test]
fn handle_rejects_reserved() {
    assert!(validate_handle("admin").is_err());
    assert!(validate_handle("system").is_err());
    assert!(validate_handle("near").is_err());
}

#[test]
fn handle_lowercases() {
    assert_eq!(validate_handle("Alice").unwrap(), "alice");
    assert_eq!(validate_handle("MyBot").unwrap(), "mybot");
}

#[test]
fn valid_tags() {
    assert!(validate_tags(&["rust".into(), "ai".into()]).is_ok());
    assert!(validate_tags(&["web-3".into()]).is_ok());
}

#[test]
fn tags_reject_over_limit() {
    let tags: Vec<String> = (0..11).map(|i| format!("tag{i}")).collect();
    assert!(validate_tags(&tags).is_err());
}

#[test]
fn tags_reject_long_tag() {
    assert!(validate_tags(&["a".repeat(31)]).is_err());
}

#[test]
fn tags_reject_invalid_chars() {
    assert!(validate_tags(&["has space".into()]).is_err());
    assert!(validate_tags(&["under_score".into()]).is_err());
}

#[test]
fn tags_reject_empty_string() {
    assert!(validate_tags(&["".into()]).is_err());
    assert!(validate_tags(&["ai".into(), "".into()]).is_err());
}

#[test]
fn tags_lowercase() {
    let result = validate_tags(&["RUST".into()]).unwrap();
    assert_eq!(result, vec!["rust"]);
}

#[test]
fn profile_completeness_empty() {
    let agent = make_agent("test");
    assert_eq!(profile_completeness(&agent), 0);
}

#[test]
fn profile_completeness_full() {
    let mut agent = make_agent("test");
    agent.description = "A test agent for validation".to_string();
    agent.tags = vec!["rust".into()];
    agent.capabilities = serde_json::json!({"skills": ["chat"]});
    assert_eq!(profile_completeness(&agent), 100);
}

#[test]
fn profile_completeness_description_boundary() {
    let mut agent = make_agent("test");
    agent.description = "exactly_10".to_string();
    assert_eq!(agent.description.len(), 10);
    assert_eq!(profile_completeness(&agent), 0); // not > 10

    agent.description = "eleven_char".to_string();
    assert_eq!(agent.description.len(), 11);
    assert_eq!(profile_completeness(&agent), 30);
}

#[test]
fn profile_completeness_tags_add_score() {
    let mut agent = make_agent("test");
    let without_tags = profile_completeness(&agent);
    agent.tags = vec!["ai".into()];
    let with_tags = profile_completeness(&agent);
    assert!(with_tags > without_tags);
}

#[test]
fn all_reserved_handles_rejected() {
    for &h in RESERVED_HANDLES {
        assert!(validate_handle(h).is_err(), "Expected {h} to be reserved");
    }
}

#[test]
fn all_action_variants_deserialize_from_snake_case() {
    let actions = [
        "register",
        "get_me",
        "update_me",
        "get_suggested",
        "follow",
        "unfollow",
        "heartbeat",
        "get_activity",
        "get_network",
        "get_notifications",
        "read_notifications",
        "endorse",
        "unendorse",
        "deregister",
        "migrate_account",
        "set_platforms",
        "reconcile_all",
        "admin_deregister",
        "batch_follow",
        "batch_endorse",
        "smoke_test_storage",
    ];
    for action_str in &actions {
        let json = format!(r#""{action_str}""#);
        let result: Result<Action, _> = serde_json::from_str(&json);
        assert!(result.is_ok(), "Failed to deserialize action: {action_str}");
    }
    assert_eq!(
        actions.len(),
        21,
        "Action count mismatch — did you add a new action?"
    );
}

#[test]
fn duplicate_tags_are_deduplicated() {
    let result = validate_tags(&["rust".into(), "rust".into(), "ai".into()]).unwrap();
    assert_eq!(result, vec!["rust", "ai"]);
}

#[test]
fn duplicate_tags_case_insensitive() {
    let result = validate_tags(&["Rust".into(), "rust".into()]).unwrap();
    assert_eq!(result, vec!["rust"]);
}

#[test]
fn validate_reason_accepts_valid() {
    assert!(validate_reason("Interesting agent").is_ok());
    assert!(validate_reason("").is_ok());
    assert!(validate_reason("Multi-line\nreason").is_ok());
    assert!(validate_reason(&"a".repeat(280)).is_ok());
}

#[test]
fn validate_reason_rejects_over_limit() {
    assert!(validate_reason(&"a".repeat(281)).is_err());
}

#[test]
fn validate_reason_rejects_control_chars() {
    assert!(validate_reason("has\x00null").is_err());
    assert!(validate_reason("has\ttab").is_err());
}

#[test]
fn validate_description_rejects_over_limit() {
    assert!(validate_description(&"a".repeat(501)).is_err());
    assert!(validate_description(&"a".repeat(500)).is_ok());
}

#[test]
fn validate_capabilities_rejects_zero_width_in_keys() {
    let caps = serde_json::json!({"\u{200B}tools": "rust"});
    assert!(validate_capabilities(&caps).is_err());
}

#[test]
fn validate_capabilities_rejects_bidi_override_in_values() {
    let caps = serde_json::json!({"tools": {"lang": "rust\u{202E}go"}});
    assert!(validate_capabilities(&caps).is_err());
}

#[test]
fn validate_capabilities_rejects_zero_width_in_array_values() {
    let caps = serde_json::json!({"lang": ["rust", "py\u{200B}thon"]});
    assert!(validate_capabilities(&caps).is_err());
}

#[test]
fn validate_capabilities_accepts_valid_nested() {
    let caps = serde_json::json!({"tools": {"lang": ["rust", "python"], "infra": "docker"}});
    assert!(validate_capabilities(&caps).is_ok());
}

#[test]
fn validate_capabilities_rejects_colons_in_keys() {
    let caps = serde_json::json!({"tools:lang": "rust"});
    assert!(validate_capabilities(&caps).is_err());
    let nested = serde_json::json!({"tools": {"lang:version": "stable"}});
    assert!(validate_capabilities(&nested).is_err());
}

#[test]
fn validate_capabilities_rejects_colons_in_values() {
    let caps = serde_json::json!({"protocols": "near:mainnet"});
    assert!(validate_capabilities(&caps).is_err());
    let nested = serde_json::json!({"tools": {"url": "https://example.com"}});
    assert!(validate_capabilities(&nested).is_err());
    let arr = serde_json::json!({"langs": ["rust", "near:sdk"]});
    assert!(validate_capabilities(&arr).is_err());
}

// ── platform unicode ────────────────────────────────────────────────

#[test]
fn reject_unsafe_unicode_catches_control_chars() {
    assert!(reject_unsafe_unicode("has\x00null", false).is_err());
    assert!(reject_unsafe_unicode("has\ttab", false).is_err());
}

#[test]
fn reject_unsafe_unicode_catches_zero_width() {
    assert!(reject_unsafe_unicode("ab\u{200B}cd", false).is_err());
    assert!(reject_unsafe_unicode("ab\u{FEFF}cd", false).is_err());
}

#[test]
fn reject_unsafe_unicode_accepts_clean_string() {
    assert!(reject_unsafe_unicode("near-protocol", false).is_ok());
    assert!(reject_unsafe_unicode("agent.ai", false).is_ok());
}

#[test]
fn avatar_url_rejects_ssrf_vectors() {
    let reject = [
        "https://localhost/",
        "https://localhost:8080/",
        "https://127.0.0.1/",
        "https://127.0.0.1:8080/",
        "https://0.0.0.0/",
        "https://[::1]/",
        "https://[0:0:0:0:0:0:0:1]/",
        "https://[fe80::1]/",
        "https://[fc00::1]/",
        "https://[fd00::1]/",
        "https://[::ffff:127.0.0.1]/",
        "https://[::ffff:10.0.0.1]/",
        "https://[::ffff:192.168.1.1]/",
        "https://0x7f000001/",
        "https://2130706433/",
        "https://169.254.169.254/",
        "https://foo.local/",
        "https://foo.internal/",
        "http://example.com/avatar.png",
        "https://user:pass@example.com/",
        "https://0177.0.0.1/",
    ];
    for url in &reject {
        assert!(validate_avatar_url(url).is_err(), "should reject: {url}");
    }
    assert!(validate_avatar_url("https://example.com/avatar.png").is_ok());
    assert!(validate_avatar_url("https://cdn.github.com/photo.jpg").is_ok());
    assert!(
        validate_avatar_url("https://52.7.3.1/avatar.png").is_ok(),
        "public IP with octal-range digits should be allowed"
    );
}

use super::*;

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
fn active_actions_deserialize_to_named_variants() {
    assert_eq!(
        serde_json::from_str::<Action>(r#""get_vrf_seed""#).unwrap(),
        Action::GetVrfSeed,
    );
}

#[test]
fn retired_actions_deserialize_to_other() {
    assert_eq!(
        serde_json::from_str::<Action>(r#""register""#).unwrap(),
        Action::Other,
    );
    assert_eq!(
        serde_json::from_str::<Action>(r#""get_bootstrap""#).unwrap(),
        Action::Other,
    );
}

#[test]
fn migrated_actions_deserialize_to_other() {
    for action_str in &[
        "register",
        "get_bootstrap",
        "get_me",
        "update_me",
        "follow",
        "unfollow",
        "heartbeat",
        "endorse",
        "unendorse",
        "deregister",
    ] {
        let json = format!(r#""{action_str}""#);
        let result: Action = serde_json::from_str(&json)
            .unwrap_or_else(|_| panic!("Failed to deserialize: {action_str}"));
        assert_eq!(
            result,
            Action::Other,
            "{action_str} should deserialize to Other"
        );
    }
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

use super::*;

#[test]
fn edge_timestamp_plain_number() {
    assert_eq!(edge_timestamp("1700000000"), Some(1700000000));
}

#[test]
fn edge_timestamp_json() {
    assert_eq!(
        edge_timestamp(r#"{"ts":1700000000,"reason":"test"}"#),
        Some(1700000000)
    );
    // null reason variant
    let null_reason = serde_json::json!({ "ts": 1700000000u64, "reason": null }).to_string();
    assert_eq!(edge_timestamp(&null_reason), Some(1700000000));
}

#[test]
fn edge_timestamp_invalid() {
    assert_eq!(edge_timestamp("not-a-number"), None);
}

#[test]
#[serial]
fn walk_edges_since_scans_past_non_monotonic_timestamps() {
    setup_integration("mono_a.near");
    quick_register("mono_a.near", "mono_a");
    quick_register("mono_b.near", "mono_b");
    quick_register("mono_c.near", "mono_c");
    quick_register("mono_d.near", "mono_d");

    // Write individual follower keys (replaces the old JSON array pattern).
    user_set(&keys::pub_follower("mono_a", "mono_b"), b"1").unwrap();
    user_set(&keys::pub_follower("mono_a", "mono_c"), b"1").unwrap();
    user_set(&keys::pub_follower("mono_a", "mono_d"), b"1").unwrap();

    set_public(
        &keys::pub_edge("mono_b", "mono_a"),
        serde_json::to_string(&serde_json::json!({"ts": 200}))
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    set_public(
        &keys::pub_edge("mono_c", "mono_a"),
        serde_json::to_string(&serde_json::json!({"ts": 100}))
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    set_public(
        &keys::pub_edge("mono_d", "mono_a"),
        serde_json::to_string(&serde_json::json!({"ts": 300}))
            .unwrap()
            .as_bytes(),
    )
    .unwrap();

    let new = registry::new_followers_since("mono_a", 150);
    let handles: Vec<&str> = new
        .iter()
        .filter_map(|v| v.get("handle").and_then(|h| h.as_str()))
        .collect();

    assert!(
        handles.contains(&"mono_d"),
        "mono_d (ts=300) should be found"
    );
    assert!(
        handles.contains(&"mono_b"),
        "mono_b (ts=200) should be found even with non-monotonic list order"
    );
    assert!(
        !handles.contains(&"mono_c"),
        "mono_c (ts=100) is before since=150"
    );
    assert_eq!(handles.len(), 2);
}

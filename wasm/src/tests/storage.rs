use super::*;

#[test]
#[serial]
fn storage_scope_pub_keys_are_public_private_keys_are_private() {
    setup_integration("scope.near");
    quick_register("scope.near", "scopetest");

    // pub: keys must be written as public (unencrypted, cross-project readable).
    store::test_backend::assert_scope(&keys::pub_agent("scopetest"), true);
    store::test_backend::assert_scope(&keys::pub_agent_reg("scopetest"), true);
    store::test_backend::assert_scope(&keys::near_account("scope.near"), true);
    store::test_backend::assert_scope(keys::pub_meta_count(), true);

    // Follow to generate private keys.
    quick_register("other.near", "othertest");
    set_signer("scope.near");
    let req = RequestBuilder::new(Action::Follow)
        .handle("othertest")
        .build();
    let resp = handle_follow(&req);
    assert!(resp.success, "follow should succeed: {:?}", resp.error);

    // Follow-generated pub: keys must be public (now in user scope).
    store::test_backend::assert_scope(&keys::pub_edge("scopetest", "othertest"), true);
    store::test_backend::assert_scope(&keys::pub_follower("othertest", "scopetest"), true);
    store::test_backend::assert_scope(&keys::pub_following_key("scopetest", "othertest"), true);

    // Rate limit and notification keys must be private.
    store::test_backend::assert_scope(&keys::rate("follow", "scopetest"), false);
    store::test_backend::assert_scope(&keys::notif_idx("othertest"), false);
}

#[test]
#[serial]
fn storage_scope_endorsement_keys_are_public() {
    setup_integration("escope_a.near");
    register_endorsable_agent("escope_a.near", "escope_alice", &["security"], &[]);
    register_endorsable_agent("escope_b.near", "escope_bob", &[], &[]);

    set_signer("escope_b.near");
    let req = RequestBuilder::new(Action::Endorse)
        .handle("escope_alice")
        .tags(&["security"])
        .build();
    let resp = handle_endorse(&req);
    assert!(resp.success, "endorse should succeed: {:?}", resp.error);

    // Endorsement record must be public (now in user scope).
    store::test_backend::assert_scope(
        &keys::endorsement("escope_alice", "tags", "security", "escope_bob"),
        true,
    );
    // Individual endorsement_by key must be public.
    store::test_backend::assert_scope(
        &keys::pub_endorsement_by("escope_bob", "escope_alice", "tags", "security"),
        true,
    );
    // Individual endorser key must be public.
    store::test_backend::assert_scope(
        &keys::pub_endorser("escope_alice", "tags", "security", "escope_bob"),
        true,
    );
    // Tag counts must be public.
    store::test_backend::assert_scope(keys::pub_tag_counts(), true);
}

#[test]
#[serial]
fn prune_index_removes_expired_entries() {
    store::test_backend::clear();

    let index_key = "test_prune_idx";

    let keys = vec![
        "entry_old_1".to_string(),
        "entry_old_2".to_string(),
        "entry_fresh_1".to_string(),
        "entry_fresh_2".to_string(),
    ];
    set_json(index_key, &keys).unwrap();

    set_string("entry_old_1", "100").unwrap();
    set_string("entry_old_2", "200").unwrap();
    set_string("entry_fresh_1", "500").unwrap();
    set_string("entry_fresh_2", "600").unwrap();

    let result = prune_index(index_key, 300, |key| {
        get_string(key).and_then(|v| v.parse::<u64>().ok())
    });
    assert!(result.is_ok(), "prune_index should succeed");

    let remaining: Vec<String> = get_json(index_key).unwrap_or_default();
    assert_eq!(
        remaining.len(),
        2,
        "should have 2 remaining entries, got {:?}",
        remaining
    );
    assert!(remaining.contains(&"entry_fresh_1".to_string()));
    assert!(remaining.contains(&"entry_fresh_2".to_string()));

    assert!(
        get_string("entry_old_1").is_none(),
        "old entry blob should be deleted"
    );
    assert!(
        get_string("entry_old_2").is_none(),
        "old entry blob should be deleted"
    );

    assert_eq!(get_string("entry_fresh_1").as_deref(), Some("500"));
    assert_eq!(get_string("entry_fresh_2").as_deref(), Some("600"));
}

#[test]
#[serial]
fn prune_index_noop_when_nothing_expired() {
    store::test_backend::clear();

    let index_key = "test_prune_noop";
    let keys = vec!["k1".to_string(), "k2".to_string()];
    set_json(index_key, &keys).unwrap();
    set_string("k1", "500").unwrap();
    set_string("k2", "600").unwrap();

    prune_index(index_key, 100, |key| {
        get_string(key).and_then(|v| v.parse::<u64>().ok())
    })
    .unwrap();

    let remaining: Vec<String> = get_json(index_key).unwrap_or_default();
    assert_eq!(remaining.len(), 2);
}

/// Soft-delete pattern: writing empty bytes must make user_has return false.
///
/// Follow/unfollow and endorse/unendorse use `user_set(key, &[])` as a
/// soft-delete.  Subsequent `user_has(key)` calls must return false so that
/// idempotency checks (e.g. "already_following") and re-endorsement work
/// correctly.  If this test fails, replace all `user_set(key, &[])` calls
/// with `user_delete_key(key)` in follow.rs and endorse.rs.
#[test]
#[serial]
fn soft_delete_empty_bytes_returns_false_for_has() {
    store::test_backend::clear();

    // Write a non-empty value, confirm has() returns true.
    let key = "pub:test:soft_delete";
    store::user_set(key, b"data").unwrap();
    assert!(
        store::user_has(key),
        "user_has must return true for non-empty value"
    );

    // Overwrite with empty bytes (soft-delete pattern used by unfollow/unendorse).
    store::user_set(key, &[]).unwrap();
    assert!(
        !store::user_has(key),
        "user_has must return false after writing empty bytes — \
        if this fails, the soft-delete pattern in follow.rs:69, endorse.rs:156, and \
        endorse.rs:368 is broken and must be replaced with user_delete_key()"
    );

    // Confirm actual deletion also works.
    store::user_set(key, b"data").unwrap();
    store::user_delete_key(key);
    assert!(
        !store::user_has(key),
        "user_has must return false after delete"
    );
}

/// Storage errors must never leak backend details to clients.
/// The internal message should be logged (eprintln) but the response
/// must contain only the generic "Storage operation failed" text.
#[test]
#[serial]
fn storage_errors_never_leak_internal_details() {
    setup_integration("leak.near");
    quick_register("leak.near", "leaktest");

    // Register a second agent to follow.
    quick_register("target.near", "leaktarget");

    // Now break storage and attempt follow.
    set_signer("leak.near");
    store::test_backend::fail_next_writes(100);
    let resp = handle_follow(
        &RequestBuilder::new(Action::Follow)
            .handle("leaktarget")
            .build(),
    );
    store::test_backend::fail_next_writes(0);

    assert!(!resp.success, "follow should fail under storage failure");
    let err_msg = resp.error.as_deref().unwrap_or("");
    assert_eq!(
        err_msg, "Storage operation failed",
        "error must be generic, got: {err_msg}"
    );
    assert!(
        !err_msg.contains("set_worker"),
        "must not leak backend function names"
    );
    assert!(
        !err_msg.contains("simulated"),
        "must not leak test backend details"
    );
}

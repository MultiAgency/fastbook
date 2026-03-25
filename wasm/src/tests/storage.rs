use super::*;

#[test]
#[serial]
fn storage_scope_pub_keys_are_public_private_keys_are_private() {
    setup_integration("scope.near");
    quick_register("scope.near", "scopetest");

    // pub: keys must be written as public (unencrypted, cross-project readable).
    store::test_backend::assert_scope(&keys::pub_agent("scopetest"), true);
    store::test_backend::assert_scope(keys::pub_agents(), true);
    store::test_backend::assert_scope(&keys::near_account("scope.near"), true);
    store::test_backend::assert_scope(keys::pub_meta_count(), true);
    store::test_backend::assert_scope(keys::pub_meta_updated(), true);
    store::test_backend::assert_scope(&keys::pub_sorted("followers"), true);
    store::test_backend::assert_scope(&keys::pub_sorted("endorsements"), true);
    store::test_backend::assert_scope(&keys::pub_sorted("created"), true);
    store::test_backend::assert_scope(&keys::pub_sorted("active"), true);

    // Follow to generate private keys.
    quick_register("other.near", "othertest");
    set_signer("scope.near");
    let req = RequestBuilder::new(Action::Follow)
        .handle("othertest")
        .build();
    let resp = handle_follow(&req);
    assert!(resp.success, "follow should succeed: {:?}", resp.error);

    // Follow-generated pub: keys must be public.
    store::test_backend::assert_scope(&keys::pub_edge("scopetest", "othertest"), true);
    store::test_backend::assert_scope(&keys::pub_followers("othertest"), true);
    store::test_backend::assert_scope(&keys::pub_following("scopetest"), true);

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

    // Endorsement record must be public (readable by other projects).
    store::test_backend::assert_scope(
        &keys::endorsement("escope_alice", "tags", "security", "escope_bob"),
        true,
    );
    // Endorsement-by index must be public.
    store::test_backend::assert_scope(&keys::endorsement_by("escope_bob", "escope_alice"), true);
    // Endorsers index must be public.
    store::test_backend::assert_scope(&keys::endorsers("escope_alice", "tags", "security"), true);
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

use super::*;

#[test]
#[serial]
fn integration_list_agents_returns_registered() {
    setup_integration("agent_a.near");
    quick_register("agent_a.near", "agent_a");
    quick_register("agent_b.near", "agent_b");

    let req = RequestBuilder::new(Action::ListAgents).build();
    let resp = handle_list_agents(
        &req,
        |_| true,
        crate::registry::SortKey::Followers,
        DEFAULT_LIMIT,
    );
    assert!(resp.success);

    let data = parse_response(&resp);
    let agents = data.as_array().expect("data should be array");
    assert_eq!(agents.len(), 2);
}

#[test]
#[serial]
fn integration_list_agents_pagination() {
    setup_integration("pg_a.near");
    quick_register("pg_a.near", "pg_alice");
    quick_register("pg_b.near", "pg_bob");
    quick_register("pg_c.near", "pg_carol");

    let mut req = RequestBuilder::new(Action::ListAgents).limit(2).build();
    let resp = handle_list_agents(
        &req,
        |_| true,
        crate::registry::SortKey::Followers,
        DEFAULT_LIMIT,
    );
    assert!(resp.success);

    let data = parse_response(&resp);
    let agents = data.as_array().expect("data should be array");
    assert_eq!(agents.len(), 2, "first page should have 2 agents");

    let pagination = resp.pagination.as_ref().expect("should have pagination");
    let next_cursor = pagination
        .next_cursor
        .as_ref()
        .expect("should have next_cursor");

    req.cursor = Some(next_cursor.clone());
    let resp2 = handle_list_agents(
        &req,
        |_| true,
        crate::registry::SortKey::Followers,
        DEFAULT_LIMIT,
    );
    assert!(resp2.success);

    let data2 = parse_response(&resp2);
    let agents2 = data2.as_array().expect("data should be array");
    assert_eq!(
        agents2.len(),
        1,
        "second page should have remaining 1 agent"
    );

    let pagination2 = resp2.pagination.as_ref().expect("should have pagination");
    assert!(pagination2.next_cursor.is_none(), "should be no more pages");
}

#[test]
#[serial]
fn integration_tag_counts_track_registrations_and_updates() {
    setup_integration("tag_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("tag_a".into());
    reg.tags = Some(vec!["rust".into(), "ai".into()]);
    handle_register(&reg);

    set_signer("tag_b.near");
    reg.handle = Some("tag_b".into());
    reg.tags = Some(vec!["ai".into(), "defi".into()]);
    handle_register(&reg);

    let tags = registry::list_tags();
    let ai_count = tags.iter().find(|(t, _)| t == "ai").map(|(_, c)| *c);
    let rust_count = tags.iter().find(|(t, _)| t == "rust").map(|(_, c)| *c);
    let defi_count = tags.iter().find(|(t, _)| t == "defi").map(|(_, c)| *c);
    assert_eq!(ai_count, Some(2), "ai tag should have count 2");
    assert_eq!(rust_count, Some(1), "rust tag should have count 1");
    assert_eq!(defi_count, Some(1), "defi tag should have count 1");

    set_signer("tag_a.near");
    let mut update = test_request(Action::UpdateMe);
    update.tags = Some(vec!["ai".into(), "defi".into()]);
    let resp = handle_update_me(&update);
    assert!(resp.success);

    let tags = registry::list_tags();
    let rust_after = tags.iter().find(|(t, _)| t == "rust").map(|(_, c)| *c);
    let defi_after = tags.iter().find(|(t, _)| t == "defi").map(|(_, c)| *c);
    assert_eq!(rust_after, None, "rust tag should be removed (count 0)");
    assert_eq!(defi_after, Some(2), "defi tag should have count 2");
}

#[test]
#[serial]
fn integration_tag_counts_handle_removal_to_empty() {
    setup_integration("notag.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("notag".into());
    reg.tags = Some(vec!["ai".into()]);
    handle_register(&reg);

    assert_eq!(registry::list_tags().len(), 1);

    let mut update = test_request(Action::UpdateMe);
    update.tags = Some(vec![]);
    let resp = handle_update_me(&update);
    assert!(resp.success);

    assert!(registry::list_tags().is_empty(), "all tags removed");
}

#[test]
#[serial]
fn integration_list_tags_migration_fallback() {
    setup_integration("mig_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("mig_a".into());
    reg.tags = Some(vec!["rust".into()]);
    handle_register(&reg);

    let _ = delete(keys::pub_tag_counts());

    let tags = registry::list_tags();
    assert_eq!(tags.len(), 1);
    assert_eq!(tags[0], ("rust".to_string(), 1));

    let tags2 = registry::list_tags();
    assert_eq!(tags2, tags);
}

#[test]
#[serial]
fn integration_health_returns_agent_count() {
    setup_integration("health_a.near");
    quick_register("health_a.near", "health_alice");
    quick_register("health_b.near", "health_bob");

    let req = test_request(Action::Health);
    let resp = handle_health(&req);
    assert!(resp.success, "health should succeed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert_eq!(data["status"], "ok");
    assert_eq!(data["agent_count"], 2);
}

#[test]
#[serial]
fn integration_reconcile_all_requires_admin() {
    setup_integration("nonadmin.near");
    quick_register("nonadmin.near", "nonadmin");

    let req = test_request(Action::ReconcileAll);
    let resp = handle_reconcile_all(&req);
    assert!(!resp.success, "reconcile should fail without admin env var");
    assert_eq!(resp.code.unwrap(), "AUTH_FAILED");
}

#[test]
#[serial]
fn integration_reconcile_all_corrects_counts() {
    setup_integration("rec_a.near");
    unsafe { std::env::set_var("OUTLAYER_ADMIN_ACCOUNT", "rec_a.near") };

    quick_register("rec_a.near", "rec_alice");
    quick_register("rec_b.near", "rec_bob");

    // Create a follow so there are counts to reconcile
    set_signer("rec_a.near");
    let req = RequestBuilder::new(Action::Follow)
        .handle("rec_bob")
        .build();
    let resp = handle_follow(&req);
    assert!(resp.success, "follow should succeed: {:?}", resp.error);

    // Run reconcile
    set_signer("rec_a.near");
    let req = test_request(Action::ReconcileAll);
    let resp = handle_reconcile_all(&req);
    assert!(resp.success, "reconcile should succeed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert_eq!(data["agents_checked"], 2);
    assert_eq!(data["sorted_rebuilt"], true);
    assert_eq!(data["near_mappings_rebuilt"], 2);

    // Verify agent counts are correct after reconciliation
    let alice = load_agent("rec_alice").unwrap();
    assert_eq!(alice.following_count, 1);
    assert_eq!(alice.follower_count, 0);

    let bob = load_agent("rec_bob").unwrap();
    assert_eq!(bob.follower_count, 1);
    assert_eq!(bob.following_count, 0);

    unsafe { std::env::remove_var("OUTLAYER_ADMIN_ACCOUNT") };
}

/// L5: reconcile_all actually corrects an artificially corrupted follower count.
#[test]
#[serial]
fn integration_reconcile_all_corrects_miscount() {
    setup_integration("mis_a.near");
    unsafe { std::env::set_var("OUTLAYER_ADMIN_ACCOUNT", "mis_a.near") };

    quick_register("mis_a.near", "mis_alice");
    quick_register("mis_b.near", "mis_bob");

    // Create a follow so bob has 1 real follower
    set_signer("mis_a.near");
    handle_follow(
        &RequestBuilder::new(Action::Follow)
            .handle("mis_bob")
            .build(),
    );

    // Corrupt bob's follower_count to an incorrect value
    let mut bob = load_agent("mis_bob").unwrap();
    assert_eq!(bob.follower_count, 1, "bob should have 1 real follower");
    bob.follower_count = 99;
    let bytes = serde_json::to_vec(&bob).unwrap();
    set_public(&keys::pub_agent("mis_bob"), &bytes).unwrap();

    // Verify corruption
    let bob_corrupted = load_agent("mis_bob").unwrap();
    assert_eq!(
        bob_corrupted.follower_count, 99,
        "count should be corrupted"
    );

    // Run reconcile
    set_signer("mis_a.near");
    let resp = handle_reconcile_all(&test_request(Action::ReconcileAll));
    assert!(resp.success, "reconcile should succeed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert!(
        data["counts_corrected"].as_u64().unwrap() > 0,
        "reconcile should report counts_corrected > 0"
    );

    // Verify correction
    let bob_fixed = load_agent("mis_bob").unwrap();
    assert_eq!(
        bob_fixed.follower_count, 1,
        "reconcile should have corrected follower_count from 99 to 1"
    );

    unsafe { std::env::remove_var("OUTLAYER_ADMIN_ACCOUNT") };
}

/// When the sorted index is empty, list_agents falls back to loading all
/// agents from the registry and sorting in memory.
#[test]
#[serial]
fn integration_list_agents_fallback_when_sorted_index_empty() {
    setup_integration("fb_a.near");
    quick_register("fb_a.near", "fb_alice");
    quick_register("fb_b.near", "fb_bob");

    // Verify sorted index was populated during registration
    let sorted = index_list(&keys::pub_sorted("followers"));
    assert!(
        !sorted.is_empty(),
        "sorted index should exist after registration"
    );

    // Delete the sorted index to trigger fallback path
    let _ = delete(&keys::pub_sorted("followers"));
    let sorted_after = index_list(&keys::pub_sorted("followers"));
    assert!(
        sorted_after.is_empty(),
        "sorted index should be empty after delete"
    );

    // list_agents should still work via load_all_agents fallback
    let req = RequestBuilder::new(Action::ListAgents).build();
    let resp = handle_list_agents(
        &req,
        |_| true,
        crate::registry::SortKey::Followers,
        DEFAULT_LIMIT,
    );
    assert!(
        resp.success,
        "list_agents should succeed via fallback: {:?}",
        resp.error
    );

    let data = parse_response(&resp);
    let agents = data.as_array().expect("data should be array");
    assert_eq!(
        agents.len(),
        2,
        "fallback should return all registered agents"
    );
}

/// ReconcileAll Phase 1b: orphaned endorser index entries are pruned and
/// endorsement counts are corrected when the endorsement record is missing.
#[test]
#[serial]
fn integration_reconcile_all_corrects_endorsement_orphans() {
    setup_integration("eo_a.near");
    unsafe { std::env::set_var("OUTLAYER_ADMIN_ACCOUNT", "eo_a.near") };

    register_endorsable_agent("eo_a.near", "eo_alice", &["security"], &[]);
    register_endorsable_agent("eo_b.near", "eo_bob", &["security"], &[]);

    // Bob endorses Alice's "security" tag
    set_signer("eo_b.near");
    let req = RequestBuilder::new(Action::Endorse)
        .handle("eo_alice")
        .tags(&["security"])
        .build();
    let resp = handle_endorse(&req);
    assert!(resp.success, "endorse failed: {:?}", resp.error);

    let alice = load_agent("eo_alice").unwrap();
    assert_eq!(alice.endorsements["tags"]["security"], 1);

    // Simulate partial failure: delete the endorsement record but leave the
    // endorsers index and agent count intact (as if deregister failed midway).
    let _ = delete(&keys::endorsement("eo_alice", "tags", "security", "eo_bob"));

    // Verify the record is gone but index still has the entry
    assert!(!has(&keys::endorsement(
        "eo_alice", "tags", "security", "eo_bob"
    )));
    let endorsers = index_list(&keys::endorsers("eo_alice", "tags", "security"));
    assert!(
        endorsers.contains(&"eo_bob".to_string()),
        "endorser index should still have eo_bob"
    );

    // Run reconcile
    set_signer("eo_a.near");
    let resp = handle_reconcile_all(&test_request(Action::ReconcileAll));
    assert!(resp.success, "reconcile should succeed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert!(
        data["endorsement_indices_pruned"].as_u64().unwrap() > 0,
        "reconcile should report endorsement_indices_pruned > 0"
    );
    assert!(
        data["endorsements_corrected"].as_u64().unwrap() > 0,
        "reconcile should report endorsements_corrected > 0"
    );

    // Verify correction: endorser index pruned and count zeroed
    let endorsers_after = index_list(&keys::endorsers("eo_alice", "tags", "security"));
    assert!(
        !endorsers_after.contains(&"eo_bob".to_string()),
        "orphaned endorser should be removed from index"
    );

    let alice_fixed = load_agent("eo_alice").unwrap();
    assert_eq!(
        alice_fixed.endorsements.total_count(),
        0,
        "endorsement count should be 0 after orphan removal"
    );

    // Also verify the reverse index was cleaned
    let by_idx = index_list(&keys::endorsement_by("eo_bob", "eo_alice"));
    assert!(
        !by_idx.contains(&"tags:security".to_string()),
        "endorsement_by reverse index should be cleaned"
    );

    unsafe { std::env::remove_var("OUTLAYER_ADMIN_ACCOUNT") };
}

#[test]
#[serial]
fn list_agents_rejects_invalid_cursor() {
    setup_integration("lcur.near");
    quick_register("lcur.near", "lcur_agent");

    let mut req = RequestBuilder::new(Action::ListAgents).build();
    req.cursor = Some("UPPER_CASE".into());
    let resp = handle_list_agents(
        &req,
        |_| true,
        crate::registry::SortKey::Followers,
        DEFAULT_LIMIT,
    );
    assert!(!resp.success, "should reject uppercase cursor");
    assert_eq!(resp.code.as_deref(), Some("VALIDATION_ERROR"));
}

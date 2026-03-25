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

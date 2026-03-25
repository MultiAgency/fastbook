use super::*;

#[test]
#[serial]
fn endorsement_basic_flow() {
    setup_integration("end_a.near");
    register_endorsable_agent(
        "end_a.near",
        "end_alice",
        &["security", "defi"],
        &["code-review"],
    );
    register_endorsable_agent("end_b.near", "end_bob", &["security"], &[]);

    set_signer("end_b.near");
    let req = RequestBuilder::new(Action::Endorse)
        .handle("end_alice")
        .tags(&["security"])
        .reason("worked together on audit")
        .build();
    let resp = handle_endorse(&req);
    assert!(resp.success, "endorse failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert_eq!(data["endorsed"]["tags"], serde_json::json!(["security"]));

    let agent = load_agent("end_alice").unwrap();
    assert_eq!(agent.endorsements["tags"]["security"], 1);
}

/// L3: Endorsing a capability (e.g. "code-review") resolves to the "skills"
/// namespace, not "tags". This tests the namespace resolution logic in
/// collect_endorsable — capabilities are endorsable under their namespace key.
#[test]
#[serial]
fn endorsement_capabilities_resolve_to_skills_namespace() {
    setup_integration("ec_a.near");
    register_endorsable_agent(
        "ec_a.near",
        "ec_alice",
        &["defi"],
        &["code-review", "audit"],
    );
    register_endorsable_agent("ec_b.near", "ec_bob", &["defi"], &[]);

    set_signer("ec_b.near");
    let mut req = test_request(Action::Endorse);
    req.handle = Some("ec_alice".into());
    req.tags = Some(vec!["code-review".into()]);
    let resp = handle_endorse(&req);
    assert!(resp.success, "endorse failed: {:?}", resp.error);

    let agent = load_agent("ec_alice").unwrap();
    assert_eq!(agent.endorsements["skills"]["code-review"], 1);
    assert!(agent.endorsements.get("tags").is_none());
}

#[test]
#[serial]
fn endorsement_self_blocked() {
    setup_integration("es_a.near");
    register_endorsable_agent("es_a.near", "es_alice", &["security"], &[]);

    let mut req = test_request(Action::Endorse);
    req.handle = Some("es_alice".into());
    req.tags = Some(vec!["security".into()]);
    let resp = handle_endorse(&req);
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("SELF_ENDORSE"));
    assert!(resp.error.as_deref().unwrap().contains("endorse"));
}

#[test]
#[serial]
fn unendorsement_self_blocked() {
    setup_integration("ues_a.near");
    register_endorsable_agent("ues_a.near", "ues_alice", &["security"], &[]);

    let mut req = test_request(Action::Unendorse);
    req.handle = Some("ues_alice".into());
    req.tags = Some(vec!["security".into()]);
    let resp = handle_unendorse(&req);
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("SELF_UNENDORSE"));
    assert!(resp.error.as_deref().unwrap().contains("unendorse"));
}

#[test]
#[serial]
fn endorsement_invalid_tag_rejected() {
    setup_integration("ei_a.near");
    register_endorsable_agent("ei_a.near", "ei_alice", &["security"], &[]);
    register_endorsable_agent("ei_b.near", "ei_bob", &[], &[]);

    set_signer("ei_b.near");
    let mut req = test_request(Action::Endorse);
    req.handle = Some("ei_alice".into());
    req.tags = Some(vec!["nonexistent".into()]);
    let resp = handle_endorse(&req);
    assert!(!resp.success);
}

#[test]
#[serial]
fn endorsement_idempotent() {
    setup_integration("id_a.near");
    register_endorsable_agent("id_a.near", "id_alice", &["security"], &[]);
    register_endorsable_agent("id_b.near", "id_bob", &[], &[]);

    set_signer("id_b.near");
    let mut req = test_request(Action::Endorse);
    req.handle = Some("id_alice".into());
    req.tags = Some(vec!["security".into()]);

    let resp1 = handle_endorse(&req);
    assert!(resp1.success);
    let resp2 = handle_endorse(&req);
    assert!(resp2.success);

    let agent = load_agent("id_alice").unwrap();
    assert_eq!(agent.endorsements["tags"]["security"], 1);
}

#[test]
#[serial]
fn endorsement_unendorse() {
    setup_integration("ue_a.near");
    register_endorsable_agent("ue_a.near", "ue_alice", &["security", "defi"], &[]);
    register_endorsable_agent("ue_b.near", "ue_bob", &[], &[]);

    set_signer("ue_b.near");
    let mut req = test_request(Action::Endorse);
    req.handle = Some("ue_alice".into());
    req.tags = Some(vec!["security".into(), "defi".into()]);
    handle_endorse(&req);

    let agent = load_agent("ue_alice").unwrap();
    assert_eq!(agent.endorsements["tags"]["security"], 1);
    assert_eq!(agent.endorsements["tags"]["defi"], 1);

    let mut unreq = test_request(Action::Unendorse);
    unreq.handle = Some("ue_alice".into());
    unreq.tags = Some(vec!["security".into()]);
    let resp = handle_unendorse(&unreq);
    assert!(resp.success);

    let agent = load_agent("ue_alice").unwrap();
    assert!(
        agent
            .endorsements
            .get("tags")
            .unwrap()
            .get("security")
            .is_none(),
        "unendorsed key should be pruned, not left as zero"
    );
    assert_eq!(agent.endorsements["tags"]["defi"], 1);
}

#[test]
#[serial]
fn endorsement_cleared_on_tag_removal() {
    setup_integration("cr_a.near");
    register_endorsable_agent("cr_a.near", "cr_alice", &["security", "defi"], &[]);
    register_endorsable_agent("cr_b.near", "cr_bob", &[], &[]);

    set_signer("cr_b.near");
    let mut req = test_request(Action::Endorse);
    req.handle = Some("cr_alice".into());
    req.tags = Some(vec!["security".into(), "defi".into()]);
    handle_endorse(&req);

    set_signer("cr_a.near");
    let mut update = test_request(Action::UpdateMe);
    update.tags = Some(vec!["defi".into()]);
    let resp = handle_update_me(&update);
    assert!(resp.success);

    let agent = load_agent("cr_alice").unwrap();
    assert!(agent
        .endorsements
        .get("tags")
        .and_then(|m| m.get("security"))
        .is_none());
    assert_eq!(agent.endorsements["tags"]["defi"], 1);

    assert!(
        !has(&keys::endorsement("cr_alice", "tags", "security", "cr_bob")),
        "endorsement record should be deleted"
    );
    assert!(
        index_list(&keys::endorsers("cr_alice", "tags", "security")).is_empty(),
        "endorsers index should be empty"
    );
    let bob_endorsements = index_list(&keys::endorsement_by("cr_bob", "cr_alice"));
    assert!(
        !bob_endorsements.contains(&"tags:security".to_string()),
        "endorsement_by should not contain removed tag"
    );

    assert!(
        has(&keys::endorsement("cr_alice", "tags", "defi", "cr_bob")),
        "defi endorsement record should remain"
    );
    assert!(
        !index_list(&keys::endorsers("cr_alice", "tags", "defi")).is_empty(),
        "defi endorsers index should remain"
    );
}

#[test]
#[serial]
fn endorsement_namespace_no_collision() {
    setup_integration("nc_a.near");
    set_signer("nc_a.near");
    let mut req = test_request(Action::Register);
    req.handle = Some("nc_alice".into());
    req.tags = Some(vec!["rust".into()]);
    req.capabilities = Some(serde_json::json!({ "languages": ["rust"] }));
    let resp = handle_register(&req);
    assert!(resp.success);

    register_endorsable_agent("nc_b.near", "nc_bob", &[], &[]);

    set_signer("nc_b.near");
    let mut ereq = test_request(Action::Endorse);
    ereq.handle = Some("nc_alice".into());
    ereq.tags = Some(vec!["rust".into()]);
    let resp = handle_endorse(&ereq);
    assert!(!resp.success, "should reject ambiguous value");
    assert!(resp.error.as_deref().unwrap_or("").contains("ambiguous"));

    let mut ereq1 = test_request(Action::Endorse);
    ereq1.handle = Some("nc_alice".into());
    ereq1.tags = Some(vec!["tags:rust".into()]);
    let resp1 = handle_endorse(&ereq1);
    assert!(resp1.success, "endorse tags:rust failed: {:?}", resp1.error);

    let mut ereq2 = test_request(Action::Endorse);
    ereq2.handle = Some("nc_alice".into());
    ereq2.tags = Some(vec!["languages:rust".into()]);
    let resp2 = handle_endorse(&ereq2);
    assert!(
        resp2.success,
        "endorse languages:rust failed: {:?}",
        resp2.error
    );

    let agent = load_agent("nc_alice").unwrap();
    assert_eq!(agent.endorsements["tags"]["rust"], 1);
    assert_eq!(agent.endorsements["languages"]["rust"], 1);
}

#[test]
#[serial]
fn endorsement_get_endorsers_with_reason() {
    setup_integration("ge_a.near");
    register_endorsable_agent("ge_a.near", "ge_alice", &["security"], &[]);
    register_endorsable_agent("ge_b.near", "ge_bob", &[], &[]);

    set_signer("ge_b.near");
    let req = RequestBuilder::new(Action::Endorse)
        .handle("ge_alice")
        .tags(&["security"])
        .reason("excellent auditor")
        .build();
    handle_endorse(&req);

    let greq = RequestBuilder::new(Action::GetEndorsers)
        .handle("ge_alice")
        .build();
    let resp = handle_get_endorsers(&greq);
    assert!(resp.success);

    let data = parse_response(&resp);
    let endorsers = &data["endorsers"]["tags"]["security"];
    assert_eq!(endorsers[0]["handle"], "ge_bob");
    assert_eq!(endorsers[0]["reason"], "excellent auditor");
}

#[test]
#[serial]
fn endorsement_profile_shows_my_endorsements() {
    setup_integration("mp_a.near");
    register_endorsable_agent("mp_a.near", "mp_alice", &["security"], &["audit"]);
    register_endorsable_agent("mp_b.near", "mp_bob", &[], &[]);

    set_signer("mp_b.near");
    let mut req = test_request(Action::Endorse);
    req.handle = Some("mp_alice".into());
    req.tags = Some(vec!["security".into(), "audit".into()]);
    handle_endorse(&req);

    let mut preq = test_request(Action::GetProfile);
    preq.handle = Some("mp_alice".into());
    let resp = handle_get_profile(&preq);
    assert!(resp.success);

    let data = parse_response(&resp);
    let my = &data["my_endorsements"];
    assert!(my["tags"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("security")));
    assert!(my["skills"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("audit")));
}

#[test]
#[serial]
fn integration_endorse_with_injected_failure_rolls_back() {
    setup_integration("endfail_a.near");
    quick_register("endfail_a.near", "endfail_a");

    set_signer("endfail_b.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("endfail_b".into());
    reg.tags = Some(vec!["ai".into(), "defi".into()]);
    handle_register(&reg);

    let before = load_agent("endfail_b").unwrap();
    assert_eq!(before.endorsements.total_count(), 0);

    set_signer("endfail_a.near");
    store::test_backend::fail_next_writes(10);

    let endorse_req = RequestBuilder::new(Action::Endorse)
        .handle("endfail_b")
        .tags(&["ai"])
        .build();
    let resp = handle_endorse(&endorse_req);
    assert!(
        !resp.success,
        "endorse should fail with injected write failures"
    );

    store::test_backend::fail_next_writes(0);

    let after = load_agent("endfail_b").unwrap();
    assert_eq!(
        after.endorsements.total_count(),
        before.endorsements.total_count(),
        "endorsement count should not change on failed endorse"
    );
}

#[test]
#[serial]
fn integration_endorse_generates_notification() {
    setup_integration("en_a.near");
    register_endorsable_agent("en_a.near", "en_alice", &["security"], &[]);
    register_endorsable_agent("en_b.near", "en_bob", &[], &[]);

    set_signer("en_b.near");
    let mut req = test_request(Action::Endorse);
    req.handle = Some("en_alice".into());
    req.tags = Some(vec!["security".into()]);
    let resp = handle_endorse(&req);
    assert!(resp.success, "endorse should succeed: {:?}", resp.error);

    set_signer("en_a.near");
    let notif_req = test_request(Action::GetNotifications);
    let notif_resp = handle_get_notifications(&notif_req);
    assert!(notif_resp.success);

    let notif_data = parse_response(&notif_resp);
    let notifications = notif_data["notifications"]
        .as_array()
        .expect("should have notifications");
    assert!(
        !notifications.is_empty(),
        "should have at least one notification"
    );

    let endorse_notif = notifications
        .iter()
        .find(|n| n["type"] == "endorse")
        .expect("should have an endorse notification");
    assert_eq!(endorse_notif["from"], "en_bob");
    assert!(
        endorse_notif["detail"].is_object(),
        "endorse notification should have detail"
    );
}

#[test]
#[serial]
fn integration_endorse_save_failure_reports_partial_rollback() {
    setup_integration("eidxrb_a.near");
    quick_register("eidxrb_a.near", "eidxrb_a");

    set_signer("eidxrb_b.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("eidxrb_b".into());
    reg.tags = Some(vec!["rust".into()]);
    handle_register(&reg);

    let before = load_agent("eidxrb_b").unwrap();
    assert_eq!(before.endorsements.total_count(), 0);

    // Let the endorsement record + two index appends succeed (3 writes),
    // then fail everything after — which hits save_agent.
    // Since fail_after_writes blocks ALL subsequent writes (including rollback),
    // the rollback writes also fail → ROLLBACK_PARTIAL.
    set_signer("eidxrb_a.near");
    store::test_backend::fail_after_writes(Some(3), u32::MAX);

    let endorse_req = RequestBuilder::new(Action::Endorse)
        .handle("eidxrb_b")
        .tags(&["rust"])
        .build();
    let resp = handle_endorse(&endorse_req);
    assert!(!resp.success, "endorse should fail when save_agent fails");
    assert_eq!(
        resp.code.as_deref(),
        Some("ROLLBACK_PARTIAL"),
        "rollback writes are also blocked, so rollback should be partial"
    );

    store::test_backend::fail_after_writes(None, 0);
    store::test_backend::fail_next_writes(0);

    // Agent endorsement count must be unchanged — save_agent never succeeded
    let after = load_agent("eidxrb_b").unwrap();
    assert_eq!(
        after.endorsements.total_count(),
        0,
        "endorsement count should be 0 since save_agent failed"
    );
}

#[test]
#[serial]
fn integration_endorse_indices_consistent_after_success() {
    setup_integration("eidx_a.near");
    quick_register("eidx_a.near", "eidx_a");

    set_signer("eidx_b.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("eidx_b".into());
    reg.tags = Some(vec!["rust".into()]);
    handle_register(&reg);

    set_signer("eidx_a.near");
    let endorse_req = RequestBuilder::new(Action::Endorse)
        .handle("eidx_b")
        .tags(&["rust"])
        .build();
    let resp = handle_endorse(&endorse_req);
    assert!(resp.success, "endorse should succeed: {:?}", resp.error);

    // All three storage locations must agree
    let endorsers = index_list(&keys::endorsers("eidx_b", "tags", "rust"));
    assert!(
        endorsers.contains(&"eidx_a".to_string()),
        "endorsers index should contain eidx_a"
    );
    let by_idx = index_list(&keys::endorsement_by("eidx_a", "eidx_b"));
    assert!(
        by_idx.contains(&"tags:rust".to_string()),
        "endorsement_by index should contain tags:rust"
    );
    assert!(
        has(&keys::endorsement("eidx_b", "tags", "rust", "eidx_a")),
        "endorsement record should exist"
    );
    let agent = load_agent("eidx_b").unwrap();
    assert_eq!(agent.endorsements.total_count(), 1);
}

#[test]
#[serial]
fn integration_unendorse_rollback_on_failure_preserves_state() {
    setup_integration("ueidx_a.near");
    quick_register("ueidx_a.near", "ueidx_a");

    set_signer("ueidx_b.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("ueidx_b".into());
    reg.tags = Some(vec!["python".into()]);
    handle_register(&reg);

    // Endorse successfully first
    set_signer("ueidx_a.near");
    let endorse_req = RequestBuilder::new(Action::Endorse)
        .handle("ueidx_b")
        .tags(&["python"])
        .build();
    let resp = handle_endorse(&endorse_req);
    assert!(resp.success, "endorse should succeed: {:?}", resp.error);

    let before = load_agent("ueidx_b").unwrap();
    assert_eq!(before.endorsements.total_count(), 1);

    // Fail all writes — save_agent is the first write in unendorse,
    // so the transaction will fail and roll back
    store::test_backend::fail_next_writes(10);
    let unendorse_req = RequestBuilder::new(Action::Unendorse)
        .handle("ueidx_b")
        .tags(&["python"])
        .build();
    let resp = handle_unendorse(&unendorse_req);
    assert!(
        !resp.success,
        "unendorse should fail with injected failures"
    );
    store::test_backend::fail_next_writes(0);

    // Agent count should be unchanged since save_agent was rolled back
    let after = load_agent("ueidx_b").unwrap();
    assert_eq!(
        after.endorsements.total_count(),
        before.endorsements.total_count(),
        "endorsement count should not change on failed unendorse"
    );

    // Indices and record should still be intact (deletions are transactional now)
    let endorsers = index_list(&keys::endorsers("ueidx_b", "tags", "python"));
    assert!(
        endorsers.contains(&"ueidx_a".to_string()),
        "endorsers index should still contain ueidx_a"
    );
    let by_idx = index_list(&keys::endorsement_by("ueidx_a", "ueidx_b"));
    assert!(
        by_idx.contains(&"tags:python".to_string()),
        "endorsement_by index should still contain tags:python"
    );
    assert!(
        has(&keys::endorsement("ueidx_b", "tags", "python", "ueidx_a")),
        "endorsement record should still exist"
    );
}

#[test]
#[serial]
fn endorsement_reendorse_after_unendorse() {
    setup_integration("re_a.near");
    register_endorsable_agent("re_a.near", "re_alice", &["security", "defi"], &[]);
    register_endorsable_agent("re_b.near", "re_bob", &[], &[]);

    set_signer("re_b.near");

    // Endorse
    let req = RequestBuilder::new(Action::Endorse)
        .handle("re_alice")
        .tags(&["security"])
        .reason("great auditor")
        .build();
    let resp = handle_endorse(&req);
    assert!(resp.success, "first endorse failed: {:?}", resp.error);
    assert_eq!(
        load_agent("re_alice").unwrap().endorsements["tags"]["security"],
        1
    );

    // Unendorse
    let unreq = RequestBuilder::new(Action::Unendorse)
        .handle("re_alice")
        .tags(&["security"])
        .build();
    let resp = handle_unendorse(&unreq);
    assert!(resp.success, "unendorse failed: {:?}", resp.error);
    let agent = load_agent("re_alice").unwrap();
    assert!(
        agent
            .endorsements
            .get("tags")
            .and_then(|m| m.get("security"))
            .is_none(),
        "endorsement should be pruned after unendorse"
    );
    assert!(!has(&keys::endorsement(
        "re_alice", "tags", "security", "re_bob"
    )));

    // Re-endorse
    let req2 = RequestBuilder::new(Action::Endorse)
        .handle("re_alice")
        .tags(&["security"])
        .reason("still great")
        .build();
    let resp2 = handle_endorse(&req2);
    assert!(resp2.success, "re-endorse failed: {:?}", resp2.error);

    let data = parse_response(&resp2);
    assert_eq!(
        data["endorsed"]["tags"],
        serde_json::json!(["security"]),
        "should be newly endorsed, not already_endorsed"
    );

    let agent = load_agent("re_alice").unwrap();
    assert_eq!(agent.endorsements["tags"]["security"], 1);
    assert!(has(&keys::endorsement(
        "re_alice", "tags", "security", "re_bob"
    )));

    let endorsers = index_list(&keys::endorsers("re_alice", "tags", "security"));
    assert!(endorsers.contains(&"re_bob".to_string()));
    let by_idx = index_list(&keys::endorsement_by("re_bob", "re_alice"));
    assert!(by_idx.contains(&"tags:security".to_string()));
}

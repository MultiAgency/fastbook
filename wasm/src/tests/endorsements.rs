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
        handles_from_prefix(&keys::pub_endorser_prefix("cr_alice", "tags", "security")).is_empty(),
        "endorsers index should be empty"
    );
    assert!(
        !user_has(&keys::pub_endorsement_by(
            "cr_bob", "cr_alice", "tags", "security"
        )),
        "endorsement_by key should not exist for removed tag"
    );

    assert!(
        has(&keys::endorsement("cr_alice", "tags", "defi", "cr_bob")),
        "defi endorsement record should remain"
    );
    assert!(
        !handles_from_prefix(&keys::pub_endorser_prefix("cr_alice", "tags", "defi")).is_empty(),
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

    // Bare "rust" resolves to tags namespace (tags wins over capabilities).
    let mut ereq = test_request(Action::Endorse);
    ereq.handle = Some("nc_alice".into());
    ereq.tags = Some(vec!["rust".into()]);
    let resp = handle_endorse(&ereq);
    assert!(
        resp.success,
        "bare rust should resolve to tags: {:?}",
        resp.error
    );

    let agent = load_agent("nc_alice").unwrap();
    assert_eq!(agent.endorsements["tags"]["rust"], 1);
    assert!(
        agent.endorsements.get("languages").is_none(),
        "bare rust must not touch languages ns"
    );

    // Explicit ns:value prefix still works for capabilities.
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

    let endorsers = handles_from_prefix(&keys::pub_endorser_prefix("ge_alice", "tags", "security"));
    assert_eq!(endorsers.len(), 1);
    assert_eq!(endorsers[0], "ge_bob");

    // Verify endorsement record has the reason
    let record_bytes = get_bytes(&keys::endorsement("ge_alice", "tags", "security", "ge_bob"));
    let record: serde_json::Value = serde_json::from_slice(&record_bytes).unwrap();
    assert_eq!(record["reason"], "excellent auditor");
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

    let agent = load_agent("mp_alice").unwrap();
    assert_eq!(agent.endorsements["tags"]["security"], 1);
    assert_eq!(agent.endorsements["skills"]["audit"], 1);

    // Verify endorsement records exist
    assert!(has(&keys::endorsement(
        "mp_alice", "tags", "security", "mp_bob"
    )));
    assert!(has(&keys::endorsement(
        "mp_alice", "skills", "audit", "mp_bob"
    )));
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
fn integration_endorse_save_failure_reports_storage_error() {
    setup_integration("eidxrb_a.near");
    quick_register("eidxrb_a.near", "eidxrb_a");

    set_signer("eidxrb_b.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("eidxrb_b".into());
    reg.tags = Some(vec!["rust".into()]);
    handle_register(&reg);

    let before = load_agent("eidxrb_b").unwrap();
    assert_eq!(before.endorsements.total_count(), 0);

    // Let the endorsement record + individual keys succeed (3 writes),
    // then fail everything after — which hits save_agent.
    // With direct writes (no Transaction), save_agent failure returns STORAGE_ERROR.
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
        Some("STORAGE_ERROR"),
        "direct-write save_agent failure should produce STORAGE_ERROR"
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
    let endorsers = handles_from_prefix(&keys::pub_endorser_prefix("eidx_b", "tags", "rust"));
    assert!(
        endorsers.contains(&"eidx_a".to_string()),
        "endorsers index should contain eidx_a"
    );
    assert!(
        user_has(&keys::pub_endorsement_by(
            "eidx_a", "eidx_b", "tags", "rust"
        )),
        "endorsement_by key should exist for tags:rust"
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

    // Indices and record should still be intact
    let endorsers = handles_from_prefix(&keys::pub_endorser_prefix("ueidx_b", "tags", "python"));
    assert!(
        endorsers.contains(&"ueidx_a".to_string()),
        "endorsers index should still contain ueidx_a"
    );
    assert!(
        user_has(&keys::pub_endorsement_by(
            "ueidx_a", "ueidx_b", "tags", "python"
        )),
        "endorsement_by key should still exist for tags:python"
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

    let endorsers = handles_from_prefix(&keys::pub_endorser_prefix("re_alice", "tags", "security"));
    assert!(endorsers.contains(&"re_bob".to_string()));
    assert!(
        user_has(&keys::pub_endorsement_by(
            "re_bob", "re_alice", "tags", "security"
        )),
        "endorsement_by key should exist for tags:security"
    );
}

// ---------------------------------------------------------------------------
// batch_endorse: basic flow — endorse multiple targets in a single call
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn batch_endorse_basic_flow() {
    setup_integration("be_caller.near");
    register_endorsable_agent("be_caller.near", "be_caller", &["security"], &[]);
    register_endorsable_agent("be_t0.near", "be_t0", &["security", "defi"], &[]);
    register_endorsable_agent("be_t1.near", "be_t1", &["security"], &[]);
    register_endorsable_agent("be_t2.near", "be_t2", &["defi"], &[]); // no "security" tag

    set_signer("be_caller.near");
    let targets = vec!["be_t0".into(), "be_t1".into(), "be_t2".into()];
    let req = RequestBuilder::new(Action::BatchEndorse)
        .targets(targets)
        .tags(&["security"])
        .build();
    let resp = handle_batch_endorse(&req);
    assert!(
        resp.success,
        "batch_endorse should succeed: {:?}",
        resp.error
    );

    let data = parse_response(&resp);
    let results = data["results"].as_array().expect("results should be array");

    // be_t0 and be_t1 have "security" tag — should be endorsed.
    let endorsed: Vec<_> = results
        .iter()
        .filter(|r| r["action"] == "endorsed")
        .collect();
    assert_eq!(
        endorsed.len(),
        2,
        "2 targets should be endorsed, got {}",
        endorsed.len()
    );

    // be_t2 has no "security" tag — should fail with "no endorsable items match".
    let no_match: Vec<_> = results
        .iter()
        .filter(|r| {
            r["action"] == "error" && r["error"].as_str().unwrap_or("").contains("no endorsable")
        })
        .collect();
    assert_eq!(
        no_match.len(),
        1,
        "1 target should have no matching endorsable items"
    );

    // Verify storage: endorsement records exist for successful targets.
    let agent_t0 = load_agent("be_t0").unwrap();
    assert_eq!(agent_t0.endorsements["tags"]["security"], 1);
    let agent_t1 = load_agent("be_t1").unwrap();
    assert_eq!(agent_t1.endorsements["tags"]["security"], 1);
}

// ---------------------------------------------------------------------------
// batch_endorse: rate limit budget respects existing usage
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn batch_endorse_respects_remaining_rate_budget() {
    setup_integration("ber_caller.near");
    register_endorsable_agent("ber_caller.near", "ber_caller", &["security"], &[]);

    let individual_count = (ENDORSE_RATE_LIMIT - 2) as usize; // leave budget of 2
    let batch_count = 5usize;
    let total_targets = individual_count + batch_count;
    for i in 0..total_targets {
        let acct = format!("ber_t{i}.near");
        let handle = format!("ber_t{i}");
        register_endorsable_agent(&acct, &handle, &["security"], &[]);
    }

    // Consume (ENDORSE_RATE_LIMIT - 2) endorsements individually.
    set_signer("ber_caller.near");
    for i in 0..individual_count {
        let req = RequestBuilder::new(Action::Endorse)
            .handle(&format!("ber_t{i}"))
            .tags(&["security"])
            .build();
        let resp = handle_endorse(&req);
        assert!(resp.success, "individual endorse {i} should succeed");
    }

    // Now batch_endorse 5 targets — only 2 should succeed (remaining budget).
    let batch_targets: Vec<String> = (individual_count..total_targets)
        .map(|i| format!("ber_t{i}"))
        .collect();
    let req = RequestBuilder::new(Action::BatchEndorse)
        .targets(batch_targets)
        .tags(&["security"])
        .build();
    let resp = handle_batch_endorse(&req);
    assert!(
        resp.success,
        "batch_endorse should return success (partial results)"
    );

    let data = parse_response(&resp);
    let results = data["results"].as_array().expect("results should be array");
    let endorsed: Vec<_> = results
        .iter()
        .filter(|r| r["action"] == "endorsed")
        .collect();
    let rate_limited: Vec<_> = results
        .iter()
        .filter(|r| {
            r["action"] == "error" && r["error"].as_str().unwrap_or("").contains("rate limit")
        })
        .collect();

    assert_eq!(
        endorsed.len(),
        2,
        "only 2 endorsements should succeed (remaining budget), got {}",
        endorsed.len()
    );
    assert_eq!(
        rate_limited.len(),
        3,
        "3 targets should hit rate limit within batch, got {}",
        rate_limited.len()
    );
}

// ---------------------------------------------------------------------------
// batch_endorse: idempotent — re-endorsing already-endorsed targets is a no-op
// ---------------------------------------------------------------------------

#[test]
#[serial]
fn batch_endorse_idempotent() {
    setup_integration("bei_caller.near");
    register_endorsable_agent("bei_caller.near", "bei_caller", &["security"], &[]);
    register_endorsable_agent("bei_t0.near", "bei_t0", &["security"], &[]);

    set_signer("bei_caller.near");

    // First endorsement.
    let req = RequestBuilder::new(Action::Endorse)
        .handle("bei_t0")
        .tags(&["security"])
        .build();
    let resp = handle_endorse(&req);
    assert!(resp.success, "first endorse should succeed");

    // Batch endorse the same target again.
    let req = RequestBuilder::new(Action::BatchEndorse)
        .targets(vec!["bei_t0".into()])
        .tags(&["security"])
        .build();
    let resp = handle_batch_endorse(&req);
    assert!(resp.success, "batch re-endorse should succeed");

    // Count should still be 1 (not 2).
    let agent = load_agent("bei_t0").unwrap();
    assert_eq!(
        agent.endorsements["tags"]["security"], 1,
        "endorsement count should remain 1 after re-endorsement"
    );
}

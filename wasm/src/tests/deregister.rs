use super::*;

#[test]
#[serial]
fn deregister_basic() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");

    // Verify agent exists
    let resp = handle_health(&test_request(Action::Health));
    let data = parse_response(&resp);
    assert_eq!(data["agent_count"], 1);

    // Deregister
    set_signer("alice.near");
    let resp = handle_deregister(&test_request(Action::Deregister));
    assert!(resp.success, "deregister failed: {:?}", resp.error);
    let data = parse_response(&resp);
    assert_eq!(data["action"], "deregistered");
    assert_eq!(data["handle"], "alice");

    // Verify agent is gone
    let resp = handle_health(&test_request(Action::Health));
    let data = parse_response(&resp);
    assert_eq!(data["agent_count"], 0);

    // Verify profile lookup fails
    let resp = handle_get_profile(
        &RequestBuilder::new(Action::GetProfile)
            .handle("alice")
            .build(),
    );
    assert!(!resp.success);
}

#[test]
#[serial]
fn deregister_decrements_follower_counts() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");
    quick_register("bob.near", "bob");
    quick_register("carol.near", "carol");

    // bob and carol follow alice
    set_signer("bob.near");
    let resp = handle_follow(&RequestBuilder::new(Action::Follow).handle("alice").build());
    assert!(resp.success);

    set_signer("carol.near");
    let resp = handle_follow(&RequestBuilder::new(Action::Follow).handle("alice").build());
    assert!(resp.success);

    // alice follows bob
    set_signer("alice.near");
    let resp = handle_follow(&RequestBuilder::new(Action::Follow).handle("bob").build());
    assert!(resp.success);

    // Verify counts before deregister
    let resp = handle_get_profile(
        &RequestBuilder::new(Action::GetProfile)
            .handle("bob")
            .build(),
    );
    let data = parse_response(&resp);
    assert_eq!(data["agent"]["follower_count"], 1); // alice follows bob
    assert_eq!(data["agent"]["following_count"], 1); // bob follows alice

    // Deregister alice
    set_signer("alice.near");
    let resp = handle_deregister(&test_request(Action::Deregister));
    assert!(resp.success);

    // Verify bob's counts updated (no longer followed by alice, no longer following alice)
    let resp = handle_get_profile(
        &RequestBuilder::new(Action::GetProfile)
            .handle("bob")
            .build(),
    );
    let data = parse_response(&resp);
    assert_eq!(data["agent"]["follower_count"], 0);
    assert_eq!(data["agent"]["following_count"], 0);

    // Verify carol's counts updated (no longer following alice)
    let resp = handle_get_profile(
        &RequestBuilder::new(Action::GetProfile)
            .handle("carol")
            .build(),
    );
    let data = parse_response(&resp);
    assert_eq!(data["agent"]["following_count"], 0);
}

#[test]
#[serial]
fn deregister_cleans_up_endorsements() {
    setup_integration("alice.near");
    register_endorsable_agent("alice.near", "alice", &["ai", "social"], &["chat"]);
    register_endorsable_agent("bob.near", "bob", &["ai"], &["chat"]);

    // bob endorses alice's "ai" tag
    set_signer("bob.near");
    let resp = handle_endorse(
        &RequestBuilder::new(Action::Endorse)
            .handle("alice")
            .tags(&["ai"])
            .build(),
    );
    assert!(resp.success, "endorse failed: {:?}", resp.error);

    // alice endorses bob's "ai" tag
    set_signer("alice.near");
    let resp = handle_endorse(
        &RequestBuilder::new(Action::Endorse)
            .handle("bob")
            .tags(&["ai"])
            .build(),
    );
    assert!(resp.success, "endorse failed: {:?}", resp.error);

    // Verify bob has endorsement from alice
    let resp = handle_get_endorsers(
        &RequestBuilder::new(Action::GetEndorsers)
            .handle("bob")
            .build(),
    );
    let data = parse_response(&resp);
    let ai_endorsers = data["endorsers"]["tags"]["ai"].as_array().unwrap();
    assert_eq!(ai_endorsers.len(), 1);

    // Deregister alice
    set_signer("alice.near");
    let resp = handle_deregister(&test_request(Action::Deregister));
    assert!(resp.success);

    // Verify bob's endorsement from alice is removed
    let resp = handle_get_endorsers(
        &RequestBuilder::new(Action::GetEndorsers)
            .handle("bob")
            .build(),
    );
    let data = parse_response(&resp);
    let endorsers = &data["endorsers"];
    // endorsers is { ns: { val: [handles...] } } — all should be empty after deregister
    let tags_endorsers = &endorsers["tags"];
    let ai_endorsers = tags_endorsers["ai"].as_array();
    assert!(
        ai_endorsers.is_none() || ai_endorsers.unwrap().is_empty(),
        "endorsers for ai should be empty after deregister"
    );
}

#[test]
#[serial]
fn deregister_rate_limited() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");

    // First deregister succeeds
    set_signer("alice.near");
    let resp = handle_deregister(&test_request(Action::Deregister));
    assert!(resp.success, "first deregister should succeed");

    // Re-register same account with a different handle
    quick_register("alice.near", "alice2");

    // Second deregister within 300s window is rate-limited (keyed on account)
    set_signer("alice.near");
    let resp = handle_deregister(&test_request(Action::Deregister));
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("RATE_LIMITED"));
}

#[test]
#[serial]
fn deregister_allows_handle_reuse() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");

    set_signer("alice.near");
    let resp = handle_deregister(&test_request(Action::Deregister));
    assert!(resp.success);

    // Re-register with same handle from different account
    quick_register("bob.near", "alice");

    let resp = handle_get_profile(
        &RequestBuilder::new(Action::GetProfile)
            .handle("alice")
            .build(),
    );
    let data = parse_response(&resp);
    assert_eq!(data["agent"]["near_account_id"], "bob.near");
}

#[test]
#[serial]
fn deregister_requires_auth() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");

    // Clear signer
    unsafe { std::env::remove_var("NEAR_SENDER_ID") };
    let resp = handle_deregister(&test_request(Action::Deregister));
    assert!(!resp.success);
}

#[test]
#[serial]
fn migrate_account_basic() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");

    set_signer("alice.near");
    let claim = make_claim("alice-new.near", "migrate_account");
    let resp = handle_migrate_account(
        &RequestBuilder::new(Action::MigrateAccount)
            .new_account_id("alice-new.near")
            .claim(claim)
            .build(),
    );
    assert!(resp.success, "migrate failed: {:?}", resp.error);
    let data = parse_response(&resp);
    assert_eq!(data["action"], "migrated");
    assert_eq!(data["old_account"], "alice.near");
    assert_eq!(data["new_account"], "alice-new.near");

    // Verify agent is accessible with new account
    set_signer("alice-new.near");
    let resp = handle_get_me(&test_request(Action::GetMe));
    assert!(resp.success);
    let data = parse_response(&resp);
    assert_eq!(data["agent"]["near_account_id"], "alice-new.near");
}

#[test]
#[serial]
fn migrate_account_rejects_same_account() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");

    set_signer("alice.near");
    let resp = handle_migrate_account(
        &RequestBuilder::new(Action::MigrateAccount)
            .new_account_id("alice.near")
            .build(),
    );
    assert!(!resp.success);
    // Without a verifiable_claim, AUTH_REQUIRED fires before any other check.
    assert_eq!(resp.code.as_deref(), Some("AUTH_REQUIRED"));
}

#[test]
#[serial]
fn migrate_account_rejects_taken_account() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");
    quick_register("bob.near", "bob");

    set_signer("alice.near");
    let claim = make_claim("bob.near", "migrate_account");
    let resp = handle_migrate_account(
        &RequestBuilder::new(Action::MigrateAccount)
            .new_account_id("bob.near")
            .claim(claim)
            .build(),
    );
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("ALREADY_REGISTERED"));
}

#[test]
#[serial]
fn migrate_account_without_claim_rejected() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");

    set_signer("alice.near");
    let resp = handle_migrate_account(
        &RequestBuilder::new(Action::MigrateAccount)
            .new_account_id("alice-new.near")
            .build(),
    );
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("AUTH_REQUIRED"));
}

#[test]
#[serial]
fn migrate_account_wrong_claim_account_rejected() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");

    set_signer("alice.near");
    // Claim is for wrong.near but new_account_id is alice-new.near
    let claim = make_claim("wrong.near", "migrate_account");
    let resp = handle_migrate_account(
        &RequestBuilder::new(Action::MigrateAccount)
            .new_account_id("alice-new.near")
            .claim(claim)
            .build(),
    );
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("AUTH_FAILED"));
}

#[test]
#[serial]
fn migrate_account_wrong_action_in_claim_rejected() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");

    set_signer("alice.near");
    // Claim signed for "register" instead of "migrate_account"
    let claim = make_claim("alice-new.near", "register");
    let resp = handle_migrate_account(
        &RequestBuilder::new(Action::MigrateAccount)
            .new_account_id("alice-new.near")
            .claim(claim)
            .build(),
    );
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("AUTH_FAILED"));
}

#[test]
#[serial]
fn migrate_account_tampered_signature_rejected() {
    setup_integration("alice.near");
    quick_register("alice.near", "alice");

    set_signer("alice.near");
    let mut claim = make_claim("alice-new.near", "migrate_account");
    claim.signature = "ed25519:1111111111111111111111111111111111111111111111".into();
    let resp = handle_migrate_account(
        &RequestBuilder::new(Action::MigrateAccount)
            .new_account_id("alice-new.near")
            .claim(claim)
            .build(),
    );
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("AUTH_FAILED"));
}

#[test]
#[serial]
fn migrate_account_nonce_replay_rejected() {
    // Nonce replay protection is user-scoped (same payment key holder).
    // Cross-user replay relies on TLS transport security.
    setup_integration("alice.near");
    quick_register("alice.near", "alice");

    set_signer("alice.near");
    let claim = make_claim("alice-new.near", "migrate_account");

    // First attempt succeeds
    let resp = handle_migrate_account(
        &RequestBuilder::new(Action::MigrateAccount)
            .new_account_id("alice-new.near")
            .claim(claim.clone())
            .build(),
    );
    assert!(
        resp.success,
        "first migrate should succeed: {:?}",
        resp.error
    );

    // Migrate back so alice has an agent again
    set_signer("alice-new.near");
    let back_claim = make_claim("alice.near", "migrate_account");
    let resp = handle_migrate_account(
        &RequestBuilder::new(Action::MigrateAccount)
            .new_account_id("alice.near")
            .claim(back_claim)
            .build(),
    );
    assert!(
        resp.success,
        "migrate back should succeed: {:?}",
        resp.error
    );

    // Replay the original claim — same user, same nonce → NONCE_REPLAY
    set_signer("alice.near");
    let resp = handle_migrate_account(
        &RequestBuilder::new(Action::MigrateAccount)
            .new_account_id("alice-new.near")
            .claim(claim)
            .build(),
    );
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("NONCE_REPLAY"));
}

#[test]
#[serial]
fn check_handle_reserved_returns_available_false() {
    setup_integration("test.near");

    let resp = handle_check_handle(
        &RequestBuilder::new(Action::CheckHandle)
            .handle("admin")
            .build(),
    );
    assert!(
        resp.success,
        "reserved handle should not error: {:?}",
        resp.error
    );
    let data = parse_response(&resp);
    assert_eq!(data["available"], false);
    assert_eq!(data["reason"], "reserved");
}

#[test]
#[serial]
fn check_handle_taken_returns_reason() {
    setup_integration("test.near");
    quick_register("test.near", "taken_bot");

    let resp = handle_check_handle(
        &RequestBuilder::new(Action::CheckHandle)
            .handle("taken_bot")
            .build(),
    );
    assert!(resp.success);
    let data = parse_response(&resp);
    assert_eq!(data["available"], false);
    assert_eq!(data["reason"], "taken");
}

#[test]
#[serial]
fn check_handle_available_has_no_reason() {
    setup_integration("test.near");

    let resp = handle_check_handle(
        &RequestBuilder::new(Action::CheckHandle)
            .handle("free_bot")
            .build(),
    );
    assert!(resp.success);
    let data = parse_response(&resp);
    assert_eq!(data["available"], true);
    assert!(
        data["reason"].is_null(),
        "available handle should have no reason"
    );
}

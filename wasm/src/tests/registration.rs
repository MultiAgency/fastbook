use super::*;

#[test]
#[serial]
fn integration_register_creates_agent_in_storage() {
    setup_integration("alice.near");
    let req = RequestBuilder::new(Action::Register)
        .handle("alice")
        .description("Test agent")
        .tags(&["ai", "rust"])
        .build();

    let resp = handle_register(&req);
    assert!(resp.success, "register should succeed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert_eq!(data["agent"]["handle"], "alice");
    assert_eq!(data["agent"]["description"], "Test agent");
    assert_eq!(data["near_account_id"], "alice.near");

    let agent = load_agent("alice").expect("agent should be in storage");
    assert_eq!(agent.handle, "alice");
    assert_eq!(agent.near_account_id, "alice.near");
    assert_eq!(agent.tags, vec!["ai", "rust"]);
}

#[test]
#[serial]
fn integration_register_rejects_duplicate_account() {
    setup_integration("bob.near");
    quick_register("bob.near", "bob");

    let req = RequestBuilder::new(Action::Register).handle("bob2").build();
    let resp2 = handle_register(&req);
    assert!(!resp2.success);
    assert_eq!(resp2.code.as_deref(), Some("ALREADY_REGISTERED"));
}

#[test]
#[serial]
fn integration_register_rejects_duplicate_handle() {
    setup_integration("carol.near");
    quick_register("carol.near", "shared_handle");

    let req = RequestBuilder::new(Action::Register)
        .handle("shared_handle")
        .build();
    set_signer("dave.near");
    let resp2 = handle_register(&req);
    assert!(!resp2.success);
    assert_eq!(resp2.code.as_deref(), Some("HANDLE_TAKEN"));
}

#[test]
#[serial]
fn integration_get_me_returns_registered_agent() {
    setup_integration("eve.near");
    quick_register("eve.near", "eve");

    let req = RequestBuilder::new(Action::GetMe).build();
    let resp = handle_get_me(&req);
    assert!(resp.success);

    let data = parse_response(&resp);
    assert_eq!(data["agent"]["handle"], "eve");
    assert!(data["profile_completeness"].is_number());
}

#[test]
#[serial]
fn integration_get_me_fails_for_unregistered() {
    setup_integration("nobody.near");
    let req = RequestBuilder::new(Action::GetMe).build();
    let resp = handle_get_me(&req);
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("NOT_REGISTERED"));
}

#[test]
#[serial]
fn integration_update_me_changes_fields() {
    setup_integration("updater.near");
    quick_register("updater.near", "updater");

    let update = RequestBuilder::new(Action::UpdateMe)
        .description("Updated description")
        .tags(&["new-tag"])
        .build();
    let resp = handle_update_me(&update);
    assert!(resp.success, "update should succeed: {:?}", resp.error);

    let agent = load_agent("updater").unwrap();
    assert_eq!(agent.description, "Updated description");
    assert_eq!(agent.tags, vec!["new-tag"]);
}

#[test]
#[serial]
fn update_me_can_set_and_clear_avatar_url() {
    setup_integration("avatar.near");
    quick_register("avatar.near", "avatar_test");

    // Set avatar
    let update = RequestBuilder::new(Action::UpdateMe)
        .avatar_url("https://example.com/pic.png")
        .build();
    let resp = handle_update_me(&update);
    assert!(resp.success);
    let agent = load_agent("avatar_test").unwrap();
    assert_eq!(
        agent.avatar_url.as_deref(),
        Some("https://example.com/pic.png")
    );

    // Clear avatar (null)
    let update = RequestBuilder::new(Action::UpdateMe).clear_avatar().build();
    let resp = handle_update_me(&update);
    assert!(resp.success);
    let agent = load_agent("avatar_test").unwrap();
    assert_eq!(agent.avatar_url, None);
}

#[test]
fn format_agent_field_names_match_frontend_contract() {
    let mut agent = make_agent("alice");
    agent.description = "A test agent".to_string();
    agent.avatar_url = Some("https://example.com/alice.png".to_string());
    agent.tags = vec!["ai".to_string()];
    agent.capabilities = serde_json::json!({"skills": ["chat"]});
    agent.follower_count = 5;
    agent.following_count = 3;

    let json = format_agent(&agent);
    let obj = json
        .as_object()
        .expect("format_agent must return an object");

    let required_fields = [
        "handle",
        "description",
        "avatar_url",
        "tags",
        "capabilities",
        "endorsements",
        "platforms",
        "near_account_id",
        "follower_count",
        "following_count",
        "created_at",
        "last_active",
    ];
    for field in &required_fields {
        assert!(obj.contains_key(*field), "Missing field: {field}");
    }

    for key in obj.keys() {
        assert!(
            required_fields.contains(&key.as_str()),
            "Unexpected field: {key}"
        );
    }

    assert!(json["handle"].is_string());
    assert!(json["follower_count"].is_number());
    assert!(json["created_at"].is_number());
    assert!(json["tags"].is_array());
}

#[test]
#[serial]
fn integration_register_with_injected_failure_rolls_back() {
    setup_integration("regfail.near");

    store::test_backend::fail_next_writes(0);
    let mut req = test_request(Action::Register);
    req.handle = Some("regfail".into());

    store::test_backend::fail_next_writes(0);
    let resp = handle_register(&req);
    assert!(
        resp.success,
        "baseline register should succeed: {:?}",
        resp.error
    );

    set_signer("regfail2.near");
    store::test_backend::fail_next_writes(10);
    req.handle = Some("regfail2".into());
    let resp = handle_register(&req);
    assert!(
        !resp.success,
        "register should fail with injected write failures"
    );

    store::test_backend::fail_next_writes(0);

    assert!(
        load_agent("regfail2").is_none(),
        "agent should not exist after failed register"
    );

    assert!(
        agent_handle_for_account("regfail2.near").is_none(),
        "account mapping should not exist after failed register"
    );
}

#[test]
#[serial]
fn integration_register_rollback_cleans_registry() {
    setup_integration("regrb_a.near");
    quick_register("regrb_a.near", "regrb_a");

    let registry_before = index_list(keys::pub_agents());
    let count_before = registry_before.len();

    // Fail all writes for second registration — save_agent is the first txn step,
    // so the entire registration will fail before modifying any state
    set_signer("regrb_b.near");
    store::test_backend::fail_next_writes(10);
    let mut req = test_request(Action::Register);
    req.handle = Some("regrb_b".into());
    let resp = handle_register(&req);
    assert!(!resp.success, "register should fail with injected failures");
    store::test_backend::fail_next_writes(0);

    // Registry should be unchanged
    let registry_after = index_list(keys::pub_agents());
    assert_eq!(
        registry_after.len(),
        count_before,
        "registry should not grow after failed registration"
    );
    assert!(
        !registry_after.contains(&"regrb_b".to_string()),
        "failed registration should not leave handle in registry"
    );

    // Agent should not exist
    assert!(
        load_agent("regrb_b").is_none(),
        "failed registration should not create agent record"
    );

    // Account mapping should not exist
    assert!(
        agent_handle_for_account("regrb_b.near").is_none(),
        "failed registration should not create account mapping"
    );
}

/// Registration rollback when step 2 (account mapping) fails after step 1 (save_agent) succeeded.
/// Step 1 performs 5 writes: 1 agent record + 4 sorted index inserts.
/// fail_after_writes(Some(5), 1) lets those succeed, then fails the account mapping write.
/// The rollback should cleanly undo the agent record and sorted indices.
#[test]
#[serial]
fn integration_register_rollback_after_agent_saved() {
    setup_integration("rb2.near");

    // Let step 1 (5 writes) succeed, then fail step 2 (account mapping)
    store::test_backend::fail_after_writes(Some(5), 1);

    let req = RequestBuilder::new(Action::Register)
        .handle("rb2_agent")
        .build();
    let resp = handle_register(&req);

    assert!(!resp.success, "registration should fail");
    assert_ne!(
        resp.code.as_deref(),
        Some("ROLLBACK_PARTIAL"),
        "rollback should succeed cleanly (not partial)"
    );

    store::test_backend::fail_after_writes(None, 0);

    // All step 1 writes should be rolled back
    assert!(
        load_agent("rb2_agent").is_none(),
        "agent record should be cleaned up by rollback"
    );
    assert!(
        agent_handle_for_account("rb2.near").is_none(),
        "account mapping should not exist"
    );
    assert!(
        !index_list(keys::pub_agents()).contains(&"rb2_agent".to_string()),
        "registry should not contain the handle"
    );
}

/// M4: update_me rejects capabilities containing zero-width characters.
#[test]
#[serial]
fn integration_update_me_rejects_invalid_capabilities() {
    setup_integration("badcap.near");
    quick_register("badcap.near", "badcap");

    let update = RequestBuilder::new(Action::UpdateMe)
        .capabilities(serde_json::json!({"skills": ["zero\u{200B}width"]}))
        .build();
    let resp = handle_update_me(&update);
    assert!(
        !resp.success,
        "update_me with zero-width char in capabilities should fail"
    );
    assert!(
        resp.error
            .as_deref()
            .unwrap_or("")
            .to_lowercase()
            .contains("unicode")
            || resp.error.as_deref().unwrap_or("").contains("U+200B"),
        "error should mention disallowed unicode, got: {:?}",
        resp.error
    );
}

#[test]
#[serial]
fn integration_update_me_ignores_platforms() {
    setup_integration("plat.near");
    quick_register("plat.near", "plat_agent");

    // update_me with only platforms should fail — platforms is no longer a valid field
    let req = RequestBuilder::new(Action::UpdateMe)
        .platforms(vec!["market.near.ai".into()])
        .build();
    let resp = handle_update_me(&req);
    assert!(
        !resp.success,
        "update_me should reject platforms-only update"
    );
    assert_eq!(resp.code.as_deref(), Some("VALIDATION_ERROR"));
}

#[test]
#[serial]
fn integration_set_platforms_requires_admin() {
    setup_integration("plat2.near");
    quick_register("plat2.near", "plat_nonadmin");

    let req = RequestBuilder::new(Action::SetPlatforms)
        .handle("plat_nonadmin")
        .platforms(vec!["market.near.ai".into()])
        .build();
    let resp = handle_set_platforms(&req);
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("AUTH_FAILED"));
}

#[test]
#[serial]
fn integration_set_platforms_admin_succeeds() {
    setup_integration("plat3.near");
    quick_register("plat3.near", "plat_admin");
    unsafe { std::env::set_var("OUTLAYER_ADMIN_ACCOUNT", "plat3.near") };

    let req = RequestBuilder::new(Action::SetPlatforms)
        .handle("plat_admin")
        .platforms(vec!["market.near.ai".into(), "near.fm".into()])
        .build();
    let resp = handle_set_platforms(&req);
    assert!(
        resp.success,
        "set_platforms should succeed: {:?}",
        resp.error
    );

    let data = parse_response(&resp);
    let platforms = data["agent"]["platforms"]
        .as_array()
        .expect("platforms should be array");
    assert_eq!(platforms.len(), 2);
    assert_eq!(platforms[0], "market.near.ai");
    assert_eq!(platforms[1], "near.fm");

    unsafe { std::env::remove_var("OUTLAYER_ADMIN_ACCOUNT") };
}

#[test]
#[serial]
fn integration_set_platforms_rejects_empty_id() {
    setup_integration("plat4.near");
    quick_register("plat4.near", "plat_empty");
    unsafe { std::env::set_var("OUTLAYER_ADMIN_ACCOUNT", "plat4.near") };

    let req = RequestBuilder::new(Action::SetPlatforms)
        .handle("plat_empty")
        .platforms(vec!["".into()])
        .build();
    let resp = handle_set_platforms(&req);
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("VALIDATION_ERROR"));

    unsafe { std::env::remove_var("OUTLAYER_ADMIN_ACCOUNT") };
}

#[test]
#[serial]
fn integration_set_platforms_rejects_too_many() {
    setup_integration("plat5.near");
    quick_register("plat5.near", "plat_many");
    unsafe { std::env::set_var("OUTLAYER_ADMIN_ACCOUNT", "plat5.near") };

    let many: Vec<String> = (0..11).map(|i| format!("platform{i}.near")).collect();
    let req = RequestBuilder::new(Action::SetPlatforms)
        .handle("plat_many")
        .platforms(many)
        .build();
    let resp = handle_set_platforms(&req);
    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("VALIDATION_ERROR"));

    unsafe { std::env::remove_var("OUTLAYER_ADMIN_ACCOUNT") };
}

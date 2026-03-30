//! Contract tests: verify the exact JSON shape of every handler response.
//! These tests pin the backend's response contract so that frontend type
//! definitions stay aligned — any shape change here must be mirrored in
//! frontend/src/types/index.ts.

use super::*;

// ---------------------------------------------------------------------------
// get_me: must include profile_completeness and suggestions
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_get_me_includes_profile_completeness_and_suggestions() {
    setup_integration("cgm.near");
    quick_register("cgm.near", "cgm_agent");

    let req = test_request(Action::GetMe);
    let resp = handle_get_me(&req);
    assert!(resp.success, "get_me failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert!(data["agent"].is_object(), "must have agent");
    assert!(
        data["profile_completeness"].is_number(),
        "must have profile_completeness as number, got: {}",
        data["profile_completeness"]
    );
    assert!(
        data["suggestions"].is_object(),
        "must have suggestions object"
    );
    assert!(
        data["suggestions"]["quality"].is_string(),
        "suggestions.quality must be string"
    );
    assert!(
        data["suggestions"]["hint"].is_string(),
        "suggestions.hint must be string"
    );
}

// ---------------------------------------------------------------------------
// update_me: must include profile_completeness
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_update_me_includes_profile_completeness() {
    setup_integration("cum.near");
    quick_register("cum.near", "cum_agent");

    let req = RequestBuilder::new(Action::UpdateMe)
        .description("updated description")
        .build();
    let resp = handle_update_me(&req);
    assert!(resp.success, "update_me failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert!(data["agent"].is_object(), "must have agent");
    assert!(
        data["profile_completeness"].is_number(),
        "must have profile_completeness as number, got: {}",
        data["profile_completeness"]
    );
}

// ---------------------------------------------------------------------------
// update_me: warnings must be absent or array of strings
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_update_me_warnings_shape() {
    setup_integration("cumw.near");
    quick_register("cumw.near", "cumw_agent");

    let req = RequestBuilder::new(Action::UpdateMe)
        .description("no warnings expected")
        .build();
    let resp = handle_update_me(&req);
    assert!(resp.success, "update_me failed: {:?}", resp.error);

    let data = parse_response(&resp);
    if let Some(warnings) = data.get("warnings") {
        assert!(
            warnings.is_array(),
            "warnings must be array, got: {warnings}"
        );
        for w in warnings.as_array().unwrap() {
            assert!(w.is_string(), "each warning must be string, got: {w}");
        }
    }
    // absent is also valid
}

// ---------------------------------------------------------------------------
// heartbeat: full response shape
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_heartbeat_response_shape() {
    setup_integration("chb_a.near");
    quick_register("chb_a.near", "chb_alice");
    quick_register("chb_b.near", "chb_bob");

    // Bob follows Alice
    set_signer("chb_b.near");
    let freq = RequestBuilder::new(Action::Follow)
        .handle("chb_alice")
        .build();
    handle_follow(&freq);

    // Advance time for heartbeat
    let future_ns = 1_700_002_000u64 * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", future_ns.to_string()) };

    set_signer("chb_a.near");
    let resp = handle_heartbeat(&test_request(Action::Heartbeat));
    assert!(resp.success, "heartbeat failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert!(data["agent"].is_object(), "must have agent");

    let delta = &data["delta"];
    assert!(delta.is_object(), "must have delta");
    assert!(delta["since"].is_number(), "delta.since must be number");
    assert!(
        delta["new_followers"].is_array(),
        "delta.new_followers must be array"
    );
    assert!(
        delta["new_followers_count"].is_number(),
        "delta.new_followers_count must be number"
    );
    assert!(
        delta["new_following_count"].is_number(),
        "delta.new_following_count must be number"
    );
    assert!(
        delta["profile_completeness"].is_number(),
        "delta.profile_completeness must be number"
    );
    assert!(
        delta["notifications"].is_array(),
        "delta.notifications must be array"
    );

    let sa = &data["suggested_action"];
    assert!(sa.is_object(), "must have suggested_action");
    assert!(
        sa["action"].is_string(),
        "suggested_action.action must be string"
    );
    assert!(
        sa["hint"].is_string(),
        "suggested_action.hint must be string"
    );

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

// ---------------------------------------------------------------------------
// get_profile: is_following absent when unauthenticated
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_get_profile_is_following_absent_unauthenticated() {
    setup_integration("cpf.near");
    quick_register("cpf.near", "cpf_target");

    // Clear signer to simulate unauthenticated access
    unsafe { std::env::remove_var("NEAR_SENDER_ID") };

    let req = RequestBuilder::new(Action::GetProfile)
        .handle("cpf_target")
        .build();
    let resp = handle_get_profile(&req);
    assert!(resp.success, "get_profile failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert!(data["agent"].is_object(), "must have agent");
    assert!(
        data.get("is_following").is_none() || data["is_following"].is_null(),
        "is_following must be absent for unauthenticated calls, got: {}",
        data["is_following"]
    );
}

// ---------------------------------------------------------------------------
// get_profile: includes my_endorsements when caller has endorsed target
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_get_profile_includes_my_endorsements() {
    setup_integration("cpe.near");
    register_endorsable_agent("cpe.near", "cpe_endorser", &["ai"], &["review"]);
    register_endorsable_agent("cpe_t.near", "cpe_target", &["ai", "ml"], &["audit"]);

    // Endorser endorses target
    set_signer("cpe.near");
    let ereq = RequestBuilder::new(Action::Endorse)
        .handle("cpe_target")
        .tags(&["ai"])
        .build();
    let eresp = handle_endorse(&ereq);
    assert!(eresp.success, "endorse failed: {:?}", eresp.error);

    // Now get_profile as the endorser
    let req = RequestBuilder::new(Action::GetProfile)
        .handle("cpe_target")
        .build();
    let resp = handle_get_profile(&req);
    assert!(resp.success, "get_profile failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert!(
        data["my_endorsements"].is_object(),
        "must include my_endorsements when caller has endorsed target, got: {}",
        data["my_endorsements"]
    );
}

// ---------------------------------------------------------------------------
// get_suggested: vrf key must be present (even if null in test env)
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_get_suggested_includes_vrf_key() {
    setup_integration("csg.near");
    quick_register("csg.near", "csg_agent");

    let req = RequestBuilder::new(Action::GetSuggested).limit(5).build();
    let resp = handle_get_suggested(&req);
    assert!(resp.success, "get_suggested failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert!(data["agents"].is_array(), "must have agents array");
    // vrf key must exist in the response (value may be null in test env)
    assert!(
        data.get("vrf").is_some(),
        "response must include vrf key (may be null), keys present: {:?}",
        data.as_object().map(|m| m.keys().collect::<Vec<_>>())
    );
}

// ---------------------------------------------------------------------------
// get_followers: returns Edge objects with direction, follow_reason, followed_at
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_get_followers_returns_edges() {
    setup_integration("cgfr.near");
    quick_register("cgfr.near", "cgfr_target");
    quick_register("cgfr_f.near", "cgfr_follower");

    set_signer("cgfr_f.near");
    let freq = RequestBuilder::new(Action::Follow)
        .handle("cgfr_target")
        .reason("shared interests")
        .build();
    handle_follow(&freq);

    set_signer("cgfr.near");
    let req = RequestBuilder::new(Action::GetFollowers)
        .handle("cgfr_target")
        .build();
    let resp = handle_get_followers(&req);
    assert!(resp.success, "get_followers failed: {:?}", resp.error);

    let data = resp.data.as_ref().expect("must have data");
    let edges = data.as_array().expect("data must be array of edges");
    assert!(!edges.is_empty(), "should have at least one edge");

    let edge = &edges[0];
    // Standard agent fields
    assert!(edge["handle"].is_string(), "edge must have handle");
    assert!(
        edge["follower_count"].is_number(),
        "edge must have follower_count"
    );

    // Edge-specific fields
    assert!(
        edge["direction"].is_string(),
        "edge must have direction, got: {}",
        edge["direction"]
    );
    assert_eq!(edge["direction"], "incoming");

    // follow_reason and followed_at must be present (may be null)
    assert!(
        edge.get("follow_reason").is_some(),
        "edge must have follow_reason key"
    );
    assert!(
        edge.get("followed_at").is_some(),
        "edge must have followed_at key"
    );
}

// ---------------------------------------------------------------------------
// register: onboarding present, warnings absent or array
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_register_response_shape() {
    setup_integration("crr.near");

    let req = RequestBuilder::new(Action::Register)
        .handle("crr_agent")
        .description("a new agent")
        .tags(&["ai"])
        .build();
    let resp = handle_register(&req);
    assert!(resp.success, "register failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert!(data["agent"].is_object(), "must have agent");
    assert!(
        data["near_account_id"].is_string(),
        "must have near_account_id"
    );

    let onboarding = &data["onboarding"];
    assert!(onboarding.is_object(), "must have onboarding");
    assert!(
        onboarding["welcome"].is_string(),
        "onboarding.welcome must be string"
    );
    assert!(
        onboarding["profile_completeness"].is_number(),
        "onboarding.profile_completeness must be number"
    );
    assert!(
        onboarding["steps"].is_array(),
        "onboarding.steps must be array"
    );
    assert!(
        onboarding["suggested"].is_array(),
        "onboarding.suggested must be array"
    );

    if let Some(warnings) = data.get("warnings") {
        assert!(
            warnings.is_array(),
            "warnings must be array, got: {warnings}"
        );
    }
}

// ---------------------------------------------------------------------------
// follow: warnings absent or array
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_follow_response_warnings_shape() {
    setup_integration("cfw.near");
    quick_register("cfw.near", "cfw_source");
    quick_register("cfw_t.near", "cfw_target");

    set_signer("cfw.near");
    let req = RequestBuilder::new(Action::Follow)
        .handle("cfw_target")
        .build();
    let resp = handle_follow(&req);
    assert!(resp.success, "follow failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert!(data["action"].is_string(), "must have action");

    if let Some(warnings) = data.get("warnings") {
        assert!(
            warnings.is_array(),
            "warnings must be array, got: {warnings}"
        );
        for w in warnings.as_array().unwrap() {
            assert!(w.is_string(), "each warning must be string");
        }
    }
}

// ---------------------------------------------------------------------------
// notifications: read field is always boolean
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_notification_always_includes_read() {
    setup_integration("cno.near");
    quick_register("cno.near", "cno_target");
    quick_register("cno_f.near", "cno_follower");

    // Generate a follow notification
    set_signer("cno_f.near");
    let freq = RequestBuilder::new(Action::Follow)
        .handle("cno_target")
        .build();
    handle_follow(&freq);

    // Fetch notifications for target
    set_signer("cno.near");
    let req = test_request(Action::GetNotifications);
    let resp = handle_get_notifications(&req);
    assert!(resp.success, "get_notifications failed: {:?}", resp.error);

    let data = parse_response(&resp);
    let notifs = data["notifications"]
        .as_array()
        .expect("notifications must be array");
    assert!(!notifs.is_empty(), "should have at least one notification");

    for notif in notifs {
        assert!(
            notif["read"].is_boolean(),
            "notification.read must be boolean, got: {}",
            notif["read"]
        );
        assert!(
            notif["type"].is_string(),
            "notification.type must be string"
        );
        assert!(
            notif["from"].is_string(),
            "notification.from must be string"
        );
        assert!(notif["at"].is_number(), "notification.at must be number");
        assert!(
            notif["is_mutual"].is_boolean(),
            "notification.is_mutual must be boolean"
        );
    }
}

// ---------------------------------------------------------------------------
// agent summaries in activity: description is always present
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_agent_summary_always_includes_description() {
    setup_integration("cas_a.near");
    quick_register("cas_a.near", "cas_alice");

    // Register bob with a description
    set_signer("cas_b.near");
    let req = RequestBuilder::new(Action::Register)
        .handle("cas_bob")
        .description("Bob the agent")
        .build();
    let resp = handle_register(&req);
    assert!(resp.success, "register bob failed: {:?}", resp.error);

    // Bob follows Alice
    let freq = RequestBuilder::new(Action::Follow)
        .handle("cas_alice")
        .build();
    handle_follow(&freq);

    // Alice checks activity
    set_signer("cas_a.near");
    let mut req = test_request(Action::GetActivity);
    req.cursor = Some("0".into());
    let resp = handle_get_activity(&req);
    assert!(resp.success, "get_activity failed: {:?}", resp.error);

    let data = parse_response(&resp);
    let new_followers = data["new_followers"]
        .as_array()
        .expect("new_followers must be array");
    assert!(
        !new_followers.is_empty(),
        "should have at least one follower"
    );

    for summary in new_followers {
        assert!(
            summary["handle"].is_string(),
            "summary.handle must be string"
        );
        assert!(
            summary["description"].is_string(),
            "summary.description must always be string (not optional), got: {}",
            summary["description"]
        );
    }
}

// ---------------------------------------------------------------------------
// deregister: action, handle, warnings shape
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_deregister_response_shape() {
    setup_integration("cdr.near");
    quick_register("cdr.near", "cdr_agent");

    let req = test_request(Action::Deregister);
    let resp = handle_deregister(&req);
    assert!(resp.success, "deregister failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert_eq!(
        data["action"], "deregistered",
        "action must be 'deregistered'"
    );
    assert_eq!(data["handle"], "cdr_agent", "handle must match");

    if let Some(warnings) = data.get("warnings") {
        assert!(
            warnings.is_array(),
            "warnings must be array, got: {warnings}"
        );
        for w in warnings.as_array().unwrap() {
            assert!(w.is_string(), "each warning must be string");
        }
    }
}

// ---------------------------------------------------------------------------
// migrate_account: action, agent, old_account, new_account
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_migrate_account_response_shape() {
    setup_integration("cma.near");
    quick_register("cma.near", "cma_agent");

    let claim = make_claim("cma-new.near", "migrate_account");
    let req = RequestBuilder::new(Action::MigrateAccount)
        .new_account_id("cma-new.near")
        .claim(claim)
        .build();
    let resp = handle_migrate_account(&req);
    assert!(resp.success, "migrate_account failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert_eq!(data["action"], "migrated", "action must be 'migrated'");
    assert!(data["agent"].is_object(), "must have agent");
    assert_eq!(
        data["old_account"], "cma.near",
        "old_account must match original"
    );
    assert_eq!(
        data["new_account"], "cma-new.near",
        "new_account must match target"
    );
    assert_eq!(
        data["agent"]["near_account_id"], "cma-new.near",
        "agent.near_account_id must reflect new account"
    );
}

// ---------------------------------------------------------------------------
// endorse: action, handle, agent, endorsed, already_endorsed, warnings shape
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_endorse_response_shape() {
    setup_integration("cen.near");
    register_endorsable_agent("cen.near", "cen_endorser", &["ai"], &["review"]);
    register_endorsable_agent("cen_t.near", "cen_target", &["ai", "ml"], &["audit"]);

    set_signer("cen.near");
    let req = RequestBuilder::new(Action::Endorse)
        .handle("cen_target")
        .tags(&["ai"])
        .build();
    let resp = handle_endorse(&req);
    assert!(resp.success, "endorse failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert_eq!(data["action"], "endorsed", "action must be 'endorsed'");
    assert_eq!(data["handle"], "cen_target", "handle must match target");
    assert!(data["agent"].is_object(), "must have agent");
    assert!(data["endorsed"].is_object(), "must have endorsed object");

    if let Some(warnings) = data.get("warnings") {
        assert!(
            warnings.is_array(),
            "warnings must be array, got: {warnings}"
        );
        for w in warnings.as_array().unwrap() {
            assert!(w.is_string(), "each warning must be string");
        }
    }
}

// ---------------------------------------------------------------------------
// unendorse: action, handle, agent, removed, warnings shape
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_unendorse_response_shape() {
    setup_integration("cue.near");
    register_endorsable_agent("cue.near", "cue_endorser", &["ai"], &["review"]);
    register_endorsable_agent("cue_t.near", "cue_target", &["ai"], &["audit"]);

    // First endorse, then unendorse
    set_signer("cue.near");
    let ereq = RequestBuilder::new(Action::Endorse)
        .handle("cue_target")
        .tags(&["ai"])
        .build();
    handle_endorse(&ereq);

    let req = RequestBuilder::new(Action::Unendorse)
        .handle("cue_target")
        .tags(&["ai"])
        .build();
    let resp = handle_unendorse(&req);
    assert!(resp.success, "unendorse failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert_eq!(data["action"], "unendorsed", "action must be 'unendorsed'");
    assert_eq!(data["handle"], "cue_target", "handle must match target");
    assert!(data["agent"].is_object(), "must have agent");
    assert!(data["removed"].is_object(), "must have removed object");

    if let Some(warnings) = data.get("warnings") {
        assert!(
            warnings.is_array(),
            "warnings must be array, got: {warnings}"
        );
        for w in warnings.as_array().unwrap() {
            assert!(w.is_string(), "each warning must be string");
        }
    }
}

// ---------------------------------------------------------------------------
// check_handle: handle, available
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_check_handle_response_shape() {
    setup_integration("cch.near");
    quick_register("cch.near", "cch_taken");

    // Check a taken handle
    let req = RequestBuilder::new(Action::CheckHandle)
        .handle("cch_taken")
        .build();
    let resp = handle_check_handle(&req);
    assert!(resp.success, "check_handle failed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert_eq!(data["handle"], "cch_taken", "handle must match");
    assert_eq!(
        data["available"], false,
        "taken handle must not be available"
    );
    assert_eq!(data["reason"], "taken", "taken handle must have reason");

    // Check an available handle
    let req2 = RequestBuilder::new(Action::CheckHandle)
        .handle("cch_free")
        .build();
    let resp2 = handle_check_handle(&req2);
    assert!(resp2.success, "check_handle failed: {:?}", resp2.error);

    let data2 = parse_response(&resp2);
    assert_eq!(data2["handle"], "cch_free");
    assert_eq!(data2["available"], true, "free handle must be available");
}

// ---------------------------------------------------------------------------
// list_tags: { tags: [{ tag, count }] }
// ---------------------------------------------------------------------------
#[test]
#[serial]
fn contract_list_tags_response_shape() {
    setup_integration("clt.near");
    register_endorsable_agent("clt.near", "clt_agent", &["ai", "defi"], &[]);

    let req = test_request(Action::ListTags);
    let resp = handle_list_tags(&req);
    assert!(resp.success, "list_tags failed: {:?}", resp.error);

    let data = parse_response(&resp);
    let tags = data["tags"].as_array().expect("tags must be array");
    assert!(!tags.is_empty(), "should have at least one tag");

    for tag in tags {
        assert!(tag["tag"].is_string(), "tag.tag must be string");
        assert!(tag["count"].is_number(), "tag.count must be number");
    }
}

use super::*;

#[test]
#[serial]
fn integration_heartbeat_updates_last_active() {
    setup_integration("hb.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("hb_agent".into());
    handle_register(&reg);

    let before = load_agent("hb_agent").unwrap();

    let future_ns = (before.last_active + 1800) * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", future_ns.to_string()) };

    let req = test_request(Action::Heartbeat);
    let resp = handle_heartbeat(&req);
    assert!(resp.success, "heartbeat should succeed: {:?}", resp.error);

    let data = parse_response(&resp);
    assert!(data["agent"].is_object(), "heartbeat should return agent");
    assert!(data["delta"].is_object(), "heartbeat should return delta");

    let after = load_agent("hb_agent").unwrap();
    assert!(
        after.last_active > before.last_active,
        "last_active should advance: {} -> {}",
        before.last_active,
        after.last_active
    );

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

#[test]
#[serial]
fn integration_heartbeat_delta_contains_new_followers() {
    setup_integration("hbd_a.near");
    quick_register("hbd_a.near", "hbd_alice");
    quick_register("hbd_b.near", "hbd_bob");

    let alice_before = load_agent("hbd_alice").unwrap();

    let follow_ts_ns = (alice_before.last_active + 600) * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", follow_ts_ns.to_string()) };

    set_signer("hbd_b.near");
    let freq = RequestBuilder::new(Action::Follow)
        .handle("hbd_alice")
        .build();
    handle_follow(&freq);

    let heartbeat_ts_ns = (alice_before.last_active + 1800) * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", heartbeat_ts_ns.to_string()) };
    set_signer("hbd_a.near");
    let req = test_request(Action::Heartbeat);
    let resp = handle_heartbeat(&req);
    assert!(resp.success, "heartbeat should succeed: {:?}", resp.error);

    let data = parse_response(&resp);
    let delta = &data["delta"];
    assert!(delta["since"].is_number(), "delta.since should be a number");
    assert_eq!(
        delta["new_followers_count"], 1,
        "should have 1 new follower"
    );

    let new_followers = delta["new_followers"]
        .as_array()
        .expect("new_followers should be array");
    assert_eq!(
        new_followers.len(),
        1,
        "should have 1 new follower in array"
    );
    assert_eq!(
        new_followers[0]["handle"], "hbd_bob",
        "new follower should be bob"
    );

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

#[test]
#[serial]
fn integration_get_activity_returns_delta() {
    setup_integration("ga_a.near");
    quick_register("ga_a.near", "ga_alice");

    let future_ns = 2_000_000_000_000_000_000u64;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", future_ns.to_string()) };
    set_signer("ga_a.near");
    let hb = test_request(Action::Heartbeat);
    let hb_resp = handle_heartbeat(&hb);
    assert!(
        hb_resp.success,
        "heartbeat should succeed: {:?}",
        hb_resp.error
    );

    let mut req = test_request(Action::GetActivity);
    req.cursor = Some("0".into());
    let resp = handle_get_activity(&req);
    assert!(
        resp.success,
        "get_activity should succeed: {:?}",
        resp.error
    );
    let data = parse_response(&resp);
    assert!(data["since"].is_number());
    assert!(data["new_followers"].is_array());
    assert!(data["new_following"].is_array());

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

#[test]
#[serial]
fn integration_get_activity_returns_follower_handles() {
    setup_integration("gav_a.near");
    quick_register("gav_a.near", "gav_alice");
    quick_register("gav_b.near", "gav_bob");

    set_signer("gav_b.near");
    let freq = RequestBuilder::new(Action::Follow)
        .handle("gav_alice")
        .build();
    handle_follow(&freq);

    set_signer("gav_a.near");
    let mut req = test_request(Action::GetActivity);
    req.cursor = Some("0".into());
    let resp = handle_get_activity(&req);
    assert!(
        resp.success,
        "get_activity should succeed: {:?}",
        resp.error
    );

    let data = parse_response(&resp);
    let new_followers = data["new_followers"]
        .as_array()
        .expect("new_followers should be array");
    assert_eq!(new_followers.len(), 1, "should have 1 new follower");
    assert_eq!(
        new_followers[0]["handle"], "gav_bob",
        "new follower should be bob"
    );
}

#[test]
#[serial]
fn integration_get_network_returns_counts() {
    setup_integration("gn_a.near");
    quick_register("gn_a.near", "gn_alice");
    quick_register("gn_b.near", "gn_bob");

    set_signer("gn_a.near");
    let freq = RequestBuilder::new(Action::Follow).handle("gn_bob").build();
    handle_follow(&freq);

    let req = test_request(Action::GetNetwork);
    let resp = handle_get_network(&req);
    assert!(resp.success, "get_network should succeed: {:?}", resp.error);
    let data = parse_response(&resp);
    assert_eq!(data["following_count"], 1);
    assert_eq!(data["follower_count"], 0);
    assert_eq!(data["mutual_count"], 0);

    set_signer("gn_b.near");
    let freq2 = RequestBuilder::new(Action::Follow)
        .handle("gn_alice")
        .build();
    handle_follow(&freq2);

    set_signer("gn_a.near");
    let resp2 = handle_get_network(&test_request(Action::GetNetwork));
    let data2 = parse_response(&resp2);
    assert_eq!(data2["mutual_count"], 1);
}

/// Heartbeat probabilistic reconciliation corrects corrupted counts.
/// When `last_active % RECONCILE_MODULUS == 0`, the handler recomputes
/// follower/following counts from actual index lengths.
#[test]
#[serial]
fn integration_heartbeat_reconciles_corrupted_counts() {
    setup_integration("hbr.near");

    // Register at a known timestamp so we can control the heartbeat timestamp
    let reg_ts_ns = 1_700_000_000u64 * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", reg_ts_ns.to_string()) };

    quick_register("hbr.near", "hbr_agent");
    quick_register("hbr_f.near", "hbr_follower");

    // Create a real follow so the follower index has 1 entry
    set_signer("hbr_f.near");
    handle_follow(
        &RequestBuilder::new(Action::Follow)
            .handle("hbr_agent")
            .build(),
    );

    let agent = load_agent("hbr_agent").unwrap();
    assert_eq!(agent.follower_count, 1, "should have 1 real follower");

    // Corrupt the stored follower_count to 99
    let mut corrupted = agent;
    corrupted.follower_count = 99;
    let bytes = serde_json::to_vec(&corrupted).unwrap();
    set_public(&keys::pub_agent("hbr_agent"), &bytes).unwrap();
    assert_eq!(load_agent("hbr_agent").unwrap().follower_count, 99);

    // Set heartbeat timestamp so last_active % 50 == 0 (triggers reconciliation)
    // 1_700_000_050 % 50 == 0
    let hb_ts_ns = 1_700_000_050u64 * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", hb_ts_ns.to_string()) };

    set_signer("hbr.near");
    let resp = handle_heartbeat(&test_request(Action::Heartbeat));
    assert!(resp.success, "heartbeat should succeed: {:?}", resp.error);

    // Verify counts were corrected from actual index lengths
    let fixed = load_agent("hbr_agent").unwrap();
    assert_eq!(
        fixed.follower_count, 1,
        "reconciliation should correct follower_count from 99 to 1"
    );
    assert_eq!(
        fixed.following_count, 0,
        "following_count should also be reconciled"
    );

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

/// Heartbeat rate limit: 5 per 60s. The 6th call within the same window
/// must return RATE_LIMITED with a positive retry_after.
#[test]
#[serial]
fn heartbeat_rate_limited_after_five() {
    setup_integration("hrl.near");

    let reg_ts_ns = 1_700_000_000u64 * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", reg_ts_ns.to_string()) };

    quick_register("hrl.near", "hrl_agent");

    // 5 heartbeats should succeed (advance timestamp by 1s each to avoid
    // identical last_active, but stay within the same 60s rate window).
    for i in 1..=5u64 {
        let ts_ns = (1_700_000_000 + i) * NANOS_PER_SEC;
        unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", ts_ns.to_string()) };
        let resp = handle_heartbeat(&test_request(Action::Heartbeat));
        assert!(
            resp.success,
            "heartbeat #{i} should succeed: {:?}",
            resp.error
        );
    }

    // 6th heartbeat in the same 60s window should be rate limited.
    let ts_ns = 1_700_000_006u64 * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", ts_ns.to_string()) };
    let resp = handle_heartbeat(&test_request(Action::Heartbeat));
    assert!(!resp.success, "6th heartbeat should be rate limited");
    assert_eq!(resp.code.as_deref(), Some("RATE_LIMITED"));
    assert!(
        resp.retry_after.unwrap_or(0) > 0,
        "retry_after should be positive"
    );

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

/// Heartbeat delta.notifications includes follow notifications created
/// since the previous heartbeat.
#[test]
#[serial]
fn heartbeat_delta_includes_notifications() {
    setup_integration("hbn_a.near");

    let reg_ts_ns = 1_700_000_000u64 * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", reg_ts_ns.to_string()) };

    quick_register("hbn_a.near", "hbn_alice");
    quick_register("hbn_b.near", "hbn_bob");

    // Bob follows Alice — generates a follow notification for Alice.
    let follow_ts = 1_700_000_600u64;
    let follow_ts_ns = follow_ts * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", follow_ts_ns.to_string()) };
    set_signer("hbn_b.near");
    handle_follow(
        &RequestBuilder::new(Action::Follow)
            .handle("hbn_alice")
            .build(),
    );

    // Alice heartbeats — should see the notification in delta.
    let hb_ts_ns = 1_700_001_800u64 * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", hb_ts_ns.to_string()) };
    set_signer("hbn_a.near");
    let resp = handle_heartbeat(&test_request(Action::Heartbeat));
    assert!(resp.success, "heartbeat should succeed: {:?}", resp.error);

    let data = parse_response(&resp);
    let notifications = data["delta"]["notifications"]
        .as_array()
        .expect("notifications should be array");
    assert!(
        !notifications.is_empty(),
        "should have at least 1 notification"
    );
    let notif = &notifications[0];
    assert_eq!(
        notif["type"], "follow",
        "notification type should be follow"
    );
    assert_eq!(notif["from"], "hbn_bob", "notification from should be bob");
    assert!(
        notif["at"].as_u64().unwrap() >= follow_ts,
        "notification at should be >= follow timestamp"
    );

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

#[test]
#[serial]
fn get_activity_rejects_non_numeric_since() {
    setup_integration("sinv.near");
    quick_register("sinv.near", "sinv_agent");

    let mut req = test_request(Action::GetActivity);
    req.cursor = Some("not-a-number".into());
    let resp = handle_get_activity(&req);
    assert!(!resp.success, "should reject non-numeric since");
    assert_eq!(resp.code.as_deref(), Some("VALIDATION_ERROR"));
}

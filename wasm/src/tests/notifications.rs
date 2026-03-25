use super::*;

#[test]
#[serial]
fn integration_notifications_created_on_follow() {
    setup_integration("notif_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("notif_a".into());
    handle_register(&reg);

    set_signer("notif_b.near");
    reg.handle = Some("notif_b".into());
    handle_register(&reg);

    set_signer("notif_a.near");
    let mut follow_req = test_request(Action::Follow);
    follow_req.handle = Some("notif_b".into());
    handle_follow(&follow_req);

    set_signer("notif_b.near");
    let req = test_request(Action::GetNotifications);
    let resp = handle_get_notifications(&req);
    assert!(resp.success);
    let data = parse_response(&resp);
    let notifs = data["notifications"]
        .as_array()
        .expect("should have notifications array");
    assert!(!notifs.is_empty(), "should have at least one notification");
    assert_eq!(notifs[0]["type"], "follow");
    assert_eq!(notifs[0]["from"], "notif_a");

    let read_resp = handle_read_notifications(&test_request(Action::ReadNotifications));
    assert!(read_resp.success);

    let resp2 = handle_get_notifications(&req);
    let data2 = parse_response(&resp2);
    assert_eq!(data2["unread_count"], 0);
}

#[test]
#[serial]
fn notification_dedup_within_window() {
    // Dedup is implemented in notifications::store_notification_with_detail (lines 70-89):
    // same type + same from + within DEDUP_WINDOW_SECS (3600s) → suppressed.
    setup_integration("dedup_a.near");
    quick_register("dedup_a.near", "dedup_alice");
    quick_register("dedup_b.near", "dedup_bob");

    // Follow, unfollow, re-follow — all within the same second (no NEAR_BLOCK_TIMESTAMP set,
    // so now_secs() returns the same value). The second follow notification from dedup_alice
    // to dedup_bob should be suppressed by the dedup window.
    set_signer("dedup_a.near");
    let freq = RequestBuilder::new(Action::Follow)
        .handle("dedup_bob")
        .build();
    handle_follow(&freq);

    let ureq = RequestBuilder::new(Action::Unfollow)
        .handle("dedup_bob")
        .build();
    handle_unfollow(&ureq);

    handle_follow(&freq);

    set_signer("dedup_b.near");
    let notif_req = test_request(Action::GetNotifications);
    let resp = handle_get_notifications(&notif_req);
    assert!(resp.success);

    let data = parse_response(&resp);
    let notifs = data["notifications"].as_array().expect("should be array");
    let follow_notifs: Vec<_> = notifs.iter().filter(|n| n["type"] == "follow").collect();

    assert_eq!(
        follow_notifs.len(),
        1,
        "second follow notification should be suppressed by dedup window (DEDUP_WINDOW_SECS=3600), got {}",
        follow_notifs.len()
    );
}

/// M5: Endorsing an agent creates an endorsement notification for the target.
#[test]
#[serial]
fn integration_endorse_creates_notification() {
    setup_integration("en_a.near");
    register_endorsable_agent("en_a.near", "en_alice", &["defi"], &[]);
    register_endorsable_agent("en_b.near", "en_bob", &["defi"], &[]);

    set_signer("en_b.near");
    let req = RequestBuilder::new(Action::Endorse)
        .handle("en_alice")
        .tags(&["defi"])
        .build();
    let resp = handle_endorse(&req);
    assert!(resp.success, "endorse should succeed: {:?}", resp.error);

    // Check alice's notifications for an endorsement
    set_signer("en_a.near");
    let notif_req = test_request(Action::GetNotifications);
    let notif_resp = handle_get_notifications(&notif_req);
    assert!(notif_resp.success);

    let data = parse_response(&notif_resp);
    let notifs = data["notifications"]
        .as_array()
        .expect("should have notifications array");
    let endorse_notifs: Vec<_> = notifs.iter().filter(|n| n["type"] == "endorse").collect();
    assert!(
        !endorse_notifs.is_empty(),
        "endorsement should create a notification for the target"
    );
    assert_eq!(endorse_notifs[0]["from"], "en_bob");
}

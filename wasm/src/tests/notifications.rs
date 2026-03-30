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

#[test]
#[serial]
fn notification_cursor_pagination_advances() {
    setup_integration("pag_a.near");
    quick_register("pag_a.near", "pag_alice");
    quick_register("pag_b.near", "pag_bob");
    quick_register("pag_c.near", "pag_carol");
    quick_register("pag_d.near", "pag_dave");

    // Three different agents follow pag_alice at distinct timestamps.
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", "1000000000000") };
    set_signer("pag_b.near");
    handle_follow(
        &RequestBuilder::new(Action::Follow)
            .handle("pag_alice")
            .build(),
    );

    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", "2000000000000") };
    set_signer("pag_c.near");
    handle_follow(
        &RequestBuilder::new(Action::Follow)
            .handle("pag_alice")
            .build(),
    );

    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", "3000000000000") };
    set_signer("pag_d.near");
    handle_follow(
        &RequestBuilder::new(Action::Follow)
            .handle("pag_alice")
            .build(),
    );

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
    set_signer("pag_a.near");

    // Page 1: limit=2, should get 2 newest and a cursor
    let mut req = test_request(Action::GetNotifications);
    req.limit = Some(2);
    let resp = handle_get_notifications(&req);
    assert!(resp.success);
    let data = parse_response(&resp);
    let notifs = data["notifications"].as_array().unwrap();
    assert_eq!(notifs.len(), 2, "page 1 should have 2 notifications");
    let cursor = resp.pagination.as_ref().unwrap().next_cursor.clone();
    assert!(cursor.is_some(), "page 1 should have a next_cursor");

    // Page 2: use cursor, should get the remaining notification
    let mut req2 = test_request(Action::GetNotifications);
    req2.limit = Some(2);
    req2.cursor = cursor;
    let resp2 = handle_get_notifications(&req2);
    assert!(resp2.success);
    let data2 = parse_response(&resp2);
    let notifs2 = data2["notifications"].as_array().unwrap();
    assert_eq!(notifs2.len(), 1, "page 2 should have 1 notification");
    assert!(
        resp2.pagination.as_ref().unwrap().next_cursor.is_none(),
        "page 2 should have no next_cursor"
    );

    // Verify pages don't overlap
    let page1_from: Vec<&str> = notifs.iter().map(|n| n["from"].as_str().unwrap()).collect();
    let page2_from: Vec<&str> = notifs2
        .iter()
        .map(|n| n["from"].as_str().unwrap())
        .collect();
    for h in &page2_from {
        assert!(
            !page1_from.contains(h),
            "page 2 notification from '{h}' should not appear in page 1"
        );
    }
}

#[test]
#[serial]
fn notification_rejects_non_numeric_cursor() {
    setup_integration("ncur.near");
    quick_register("ncur.near", "ncur_agent");

    let mut req = test_request(Action::GetNotifications);
    req.cursor = Some("not_a_timestamp".into());
    let resp = handle_get_notifications(&req);
    assert!(!resp.success, "should reject non-numeric cursor");
    assert_eq!(resp.code.as_deref(), Some("VALIDATION_ERROR"));
}

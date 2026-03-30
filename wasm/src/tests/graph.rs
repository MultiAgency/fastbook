use super::*;

#[test]
fn edge_timestamp_plain_number() {
    assert_eq!(edge_timestamp("1700000000"), Some(1700000000));
}

#[test]
fn edge_timestamp_json() {
    assert_eq!(
        edge_timestamp(r#"{"ts":1700000000,"reason":"test"}"#),
        Some(1700000000)
    );
    // null reason variant
    let null_reason = serde_json::json!({ "ts": 1700000000u64, "reason": null }).to_string();
    assert_eq!(edge_timestamp(&null_reason), Some(1700000000));
}

#[test]
fn edge_timestamp_invalid() {
    assert_eq!(edge_timestamp("not-a-number"), None);
}

#[test]
fn cursor_offset_returns_zero_when_no_cursor() {
    let handles: Vec<String> = vec!["alice".into(), "bob".into()];
    assert_eq!(cursor_offset_by(&handles, &None, |h| h.as_str()).0, 0);
}

#[test]
fn cursor_offset_returns_position_after_match() {
    let handles: Vec<String> = vec!["alice".into(), "bob".into(), "carol".into()];
    assert_eq!(
        cursor_offset_by(&handles, &Some("bob".into()), |h| h.as_str()).0,
        2
    );
}

#[test]
fn cursor_offset_returns_zero_when_cursor_not_found() {
    let handles: Vec<String> = vec!["alice".into(), "bob".into()];
    assert_eq!(
        cursor_offset_by(&handles, &Some("unknown".into()), |h| h.as_str()).0,
        0
    );
}

#[test]
#[serial]
fn integration_get_followers_and_following_lists() {
    setup_integration("gf_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("gf_a".into());
    handle_register(&reg);

    set_signer("gf_b.near");
    reg.handle = Some("gf_b".into());
    handle_register(&reg);

    set_signer("gf_c.near");
    reg.handle = Some("gf_c".into());
    handle_register(&reg);

    set_signer("gf_a.near");
    let mut follow_req = test_request(Action::Follow);
    follow_req.handle = Some("gf_b".into());
    handle_follow(&follow_req);

    set_signer("gf_c.near");
    follow_req.handle = Some("gf_b".into());
    handle_follow(&follow_req);

    let mut req = test_request(Action::GetFollowers);
    req.handle = Some("gf_b".into());
    let resp = handle_get_followers(&req);
    assert!(resp.success);
    let data = parse_response(&resp);
    let followers = data.as_array().expect("should be array");
    assert_eq!(followers.len(), 2);

    set_signer("gf_a.near");
    let mut req = test_request(Action::GetFollowing);
    req.handle = Some("gf_a".into());
    let resp = handle_get_following(&req);
    assert!(resp.success);
    let data = parse_response(&resp);
    let following = data.as_array().expect("should be array");
    assert_eq!(following.len(), 1);
    assert_eq!(following[0]["handle"], "gf_b");
}

#[test]
#[serial]
fn integration_get_profile_shows_following_status() {
    setup_integration("gp_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("gp_a".into());
    handle_register(&reg);

    set_signer("gp_b.near");
    reg.handle = Some("gp_b".into());
    handle_register(&reg);

    set_signer("gp_a.near");
    let mut req = test_request(Action::GetProfile);
    req.handle = Some("gp_b".into());
    let resp = handle_get_profile(&req);
    assert!(resp.success);
    let data = parse_response(&resp);
    assert_eq!(data["is_following"], false);

    let mut follow_req = test_request(Action::Follow);
    follow_req.handle = Some("gp_b".into());
    handle_follow(&follow_req);

    let resp2 = handle_get_profile(&req);
    let data2 = parse_response(&resp2);
    assert_eq!(data2["is_following"], true);
}

#[test]
#[serial]
fn integration_get_edges_by_direction() {
    setup_integration("ge_a.near");
    quick_register("ge_a.near", "ge_alice");
    quick_register("ge_b.near", "ge_bob");

    set_signer("ge_a.near");
    handle_follow(&RequestBuilder::new(Action::Follow).handle("ge_bob").build());
    set_signer("ge_b.near");
    handle_follow(
        &RequestBuilder::new(Action::Follow)
            .handle("ge_alice")
            .build(),
    );

    set_signer("ge_a.near");
    let req_in = RequestBuilder::new(Action::GetEdges)
        .handle("ge_alice")
        .direction("incoming")
        .build();
    let resp_in = handle_get_edges(&req_in);
    assert!(resp_in.success);
    let data_in = parse_response(&resp_in);
    assert_eq!(data_in["edges"].as_array().unwrap().len(), 1);

    let req_out = RequestBuilder::new(Action::GetEdges)
        .handle("ge_alice")
        .direction("outgoing")
        .build();
    let resp_out = handle_get_edges(&req_out);
    assert!(resp_out.success);
    let data_out = parse_response(&resp_out);
    assert_eq!(data_out["edges"].as_array().unwrap().len(), 1);

    let req_both = RequestBuilder::new(Action::GetEdges)
        .handle("ge_alice")
        .direction("both")
        .build();
    let resp_both = handle_get_edges(&req_both);
    assert!(resp_both.success);
    let data_both = parse_response(&resp_both);
    assert!(!data_both["edges"].as_array().unwrap().is_empty());
    assert_eq!(
        data_both["truncated"], false,
        "small graph should not be truncated"
    );
}

#[test]
#[serial]
fn walk_edges_since_scans_past_non_monotonic_timestamps() {
    setup_integration("mono_a.near");
    quick_register("mono_a.near", "mono_a");
    quick_register("mono_b.near", "mono_b");
    quick_register("mono_c.near", "mono_c");
    quick_register("mono_d.near", "mono_d");

    let followers_key = keys::pub_followers("mono_a");
    set_json(&followers_key, &vec!["mono_b", "mono_c", "mono_d"]).unwrap();

    set_public(
        &keys::pub_edge("mono_b", "mono_a"),
        serde_json::to_string(&serde_json::json!({"ts": 200}))
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    set_public(
        &keys::pub_edge("mono_c", "mono_a"),
        serde_json::to_string(&serde_json::json!({"ts": 100}))
            .unwrap()
            .as_bytes(),
    )
    .unwrap();
    set_public(
        &keys::pub_edge("mono_d", "mono_a"),
        serde_json::to_string(&serde_json::json!({"ts": 300}))
            .unwrap()
            .as_bytes(),
    )
    .unwrap();

    let new = social_graph::new_followers_since("mono_a", 150);
    let handles: Vec<&str> = new
        .iter()
        .filter_map(|v| v.get("handle").and_then(|h| h.as_str()))
        .collect();

    assert!(
        handles.contains(&"mono_d"),
        "mono_d (ts=300) should be found"
    );
    assert!(
        handles.contains(&"mono_b"),
        "mono_b (ts=200) should be found even with non-monotonic list order"
    );
    assert!(
        !handles.contains(&"mono_c"),
        "mono_c (ts=100) is before since=150"
    );
    assert_eq!(handles.len(), 2);
}

/// M1: include_history=true should return unfollow history in the response.
#[test]
#[serial]
fn integration_get_edges_include_history() {
    setup_integration("eh_a.near");
    quick_register("eh_a.near", "eh_alice");
    quick_register("eh_b.near", "eh_bob");

    // A follows B, then unfollows — this creates unfollow history
    set_signer("eh_a.near");
    handle_follow(&RequestBuilder::new(Action::Follow).handle("eh_bob").build());
    handle_unfollow(
        &RequestBuilder::new(Action::Unfollow)
            .handle("eh_bob")
            .build(),
    );

    let req = RequestBuilder::new(Action::GetEdges)
        .handle("eh_alice")
        .include_history()
        .build();
    let resp = handle_get_edges(&req);
    assert!(resp.success, "get_edges should succeed: {:?}", resp.error);

    let data = parse_response(&resp);
    let history = data["history"]
        .as_array()
        .expect("history should be an array");
    assert!(
        !history.is_empty(),
        "history should contain unfollow records after follow+unfollow"
    );
}

/// M2: Follower/following pagination via cursor and limit.
#[test]
#[serial]
fn integration_get_followers_pagination() {
    setup_integration("fp_a.near");
    quick_register("fp_a.near", "fp_target");
    quick_register("fp_b.near", "fp_one");
    quick_register("fp_c.near", "fp_two");
    quick_register("fp_d.near", "fp_three");

    // Three agents follow the target
    for (account, _) in &[
        ("fp_b.near", "fp_one"),
        ("fp_c.near", "fp_two"),
        ("fp_d.near", "fp_three"),
    ] {
        set_signer(account);
        handle_follow(
            &RequestBuilder::new(Action::Follow)
                .handle("fp_target")
                .build(),
        );
    }

    // Page 1: limit=1
    let mut req = RequestBuilder::new(Action::GetFollowers)
        .handle("fp_target")
        .limit(1)
        .build();
    let resp1 = handle_get_followers(&req);
    assert!(resp1.success);
    let data1 = parse_response(&resp1);
    let page1 = data1.as_array().expect("should be array");
    assert_eq!(page1.len(), 1, "first page should have 1 follower");

    let pagination1 = resp1.pagination.as_ref().expect("should have pagination");
    let cursor = pagination1
        .next_cursor
        .as_ref()
        .expect("should have next_cursor for more pages");

    // Page 2: use cursor
    req.cursor = Some(cursor.clone());
    let resp2 = handle_get_followers(&req);
    assert!(resp2.success);
    let data2 = parse_response(&resp2);
    let page2 = data2.as_array().expect("should be array");
    assert_eq!(page2.len(), 1, "second page should have 1 follower");
    assert_ne!(
        page1[0]["handle"], page2[0]["handle"],
        "pages should return different followers"
    );
}

/// When a cursor handle is removed from the follower index between
/// paginated calls, the response should include cursor_reset: true
/// and restart from the beginning.
#[test]
#[serial]
fn integration_get_followers_cursor_reset_on_missing_handle() {
    setup_integration("cr_target.near");
    quick_register("cr_target.near", "cr_target");
    quick_register("cr_f1.near", "cr_f1");
    quick_register("cr_f2.near", "cr_f2");
    quick_register("cr_f3.near", "cr_f3");

    for account in &["cr_f1.near", "cr_f2.near", "cr_f3.near"] {
        set_signer(account);
        handle_follow(
            &RequestBuilder::new(Action::Follow)
                .handle("cr_target")
                .build(),
        );
    }

    // Page 1: limit=1, get first follower and cursor
    let mut req = RequestBuilder::new(Action::GetFollowers)
        .handle("cr_target")
        .limit(1)
        .build();
    let resp1 = handle_get_followers(&req);
    assert!(resp1.success);
    let pagination1 = resp1.pagination.as_ref().expect("should have pagination");
    let cursor = pagination1
        .next_cursor
        .as_ref()
        .expect("should have next_cursor")
        .clone();

    // Remove the cursor handle from the follower index (simulates deregistration)
    index_remove(&keys::pub_followers("cr_target"), &cursor).unwrap();

    // Page 2: stale cursor should trigger cursor_reset
    req.cursor = Some(cursor);
    let resp2 = handle_get_followers(&req);
    assert!(resp2.success);
    let pagination2 = resp2.pagination.as_ref().expect("should have pagination");
    assert_eq!(
        pagination2.cursor_reset,
        Some(true),
        "should signal cursor_reset when cursor handle not found in index"
    );
}

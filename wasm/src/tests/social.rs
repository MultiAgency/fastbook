use super::*;

#[test]
#[serial]
fn integration_follow_and_unfollow_updates_counts() {
    setup_integration("follower.near");
    quick_register("follower.near", "follower_agent");
    quick_register("target.near", "target_agent");

    set_signer("follower.near");
    let follow_req = RequestBuilder::new(Action::Follow)
        .handle("target_agent")
        .build();
    let resp = handle_follow(&follow_req);
    assert!(resp.success, "follow should succeed: {:?}", resp.error);

    let target = load_agent("target_agent").unwrap();
    assert_eq!(target.follower_count, 1);
    let follower = load_agent("follower_agent").unwrap();
    assert_eq!(follower.following_count, 1);

    let unfollow_req = RequestBuilder::new(Action::Unfollow)
        .handle("target_agent")
        .build();
    let resp = handle_unfollow(&unfollow_req);
    assert!(resp.success, "unfollow should succeed: {:?}", resp.error);

    let target = load_agent("target_agent").unwrap();
    assert_eq!(target.follower_count, 0);
    assert_eq!(target.unfollow_count, 1);
}

#[test]
#[serial]
fn integration_follow_self_is_rejected() {
    setup_integration("selfish.near");
    quick_register("selfish.near", "selfish");

    let follow_req = RequestBuilder::new(Action::Follow)
        .handle("selfish")
        .build();
    let resp = handle_follow(&follow_req);
    assert!(!resp.success);
}

#[test]
#[serial]
fn integration_follow_returns_next_suggestion() {
    setup_integration("sug_a.near");
    quick_register("sug_a.near", "sug_a");
    quick_register("sug_b.near", "sug_b");
    quick_register("sug_c.near", "sug_c");

    set_signer("sug_b.near");
    let follow_c = RequestBuilder::new(Action::Follow).handle("sug_c").build();
    let resp = handle_follow(&follow_c);
    assert!(resp.success);

    set_signer("sug_a.near");
    let follow_b = RequestBuilder::new(Action::Follow).handle("sug_b").build();
    let resp = handle_follow(&follow_b);
    assert!(resp.success);

    let data = parse_response(&resp);
    assert_eq!(data["action"], "followed");
    assert!(
        data["next_suggestion"].is_object(),
        "follow response should include an inline suggestion when target has followings"
    );
    assert_eq!(
        data["next_suggestion"]["handle"], "sug_c",
        "suggestion should be sug_c (followed by sug_b, not yet followed by sug_a)"
    );
    assert!(data["next_suggestion"]["follow_url"]
        .as_str()
        .unwrap()
        .contains("/sug_c/follow"));
}

#[test]
#[serial]
fn integration_follow_omits_suggestion_when_none_available() {
    setup_integration("nos_a.near");
    quick_register("nos_a.near", "nos_a");
    quick_register("nos_b.near", "nos_b");

    set_signer("nos_a.near");
    let follow_b = RequestBuilder::new(Action::Follow).handle("nos_b").build();
    let resp = handle_follow(&follow_b);
    assert!(resp.success);

    let data = parse_response(&resp);
    assert!(
        data["next_suggestion"].is_null(),
        "should omit next_suggestion when target follows nobody"
    );
}

#[test]
#[serial]
fn integration_follow_already_following_is_idempotent() {
    setup_integration("idem_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("idem_a".into());
    handle_register(&reg);

    set_signer("idem_b.near");
    reg.handle = Some("idem_b".into());
    handle_register(&reg);

    set_signer("idem_a.near");
    let mut follow_req = test_request(Action::Follow);
    follow_req.handle = Some("idem_b".into());
    let resp1 = handle_follow(&follow_req);
    assert!(resp1.success);
    let data1 = parse_response(&resp1);
    assert_eq!(data1["action"], "followed");

    let resp2 = handle_follow(&follow_req);
    assert!(resp2.success);
    let data2 = parse_response(&resp2);
    assert_eq!(data2["action"], "already_following");

    let target = load_agent("idem_b").unwrap();
    assert_eq!(target.follower_count, 1);
}

#[test]
#[serial]
fn integration_unfollow_not_following_is_idempotent() {
    setup_integration("nf_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("nf_a".into());
    handle_register(&reg);

    set_signer("nf_b.near");
    reg.handle = Some("nf_b".into());
    handle_register(&reg);

    set_signer("nf_a.near");
    let mut unfollow_req = test_request(Action::Unfollow);
    unfollow_req.handle = Some("nf_b".into());
    let resp = handle_unfollow(&unfollow_req);
    assert!(resp.success);
    let data = parse_response(&resp);
    assert_eq!(data["action"], "not_following");
}

#[test]
#[serial]
fn integration_mutual_follow_detected() {
    setup_integration("mut_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("mut_a".into());
    handle_register(&reg);

    set_signer("mut_b.near");
    reg.handle = Some("mut_b".into());
    handle_register(&reg);

    set_signer("mut_a.near");
    let mut follow_req = test_request(Action::Follow);
    follow_req.handle = Some("mut_b".into());
    handle_follow(&follow_req);

    set_signer("mut_b.near");
    follow_req.handle = Some("mut_a".into());
    let resp = handle_follow(&follow_req);
    assert!(resp.success);

    let notifs = crate::notifications::load_notifications_since("mut_a", 0);
    let mutual_notif = notifs.iter().find(|n: &&serde_json::Value| {
        n.get("from").and_then(|f| f.as_str()) == Some("mut_b")
            && n.get("type").and_then(|t| t.as_str()) == Some("follow")
    });
    assert!(
        mutual_notif.is_some(),
        "should have follow notification from mut_b"
    );
    assert_eq!(
        mutual_notif.unwrap()["is_mutual"],
        true,
        "notification should flag mutual follow"
    );
}

#[test]
#[serial]
fn integration_follow_unfollow_maintains_index_consistency() {
    setup_integration("idx_a.near");
    quick_register("idx_a.near", "idx_a");
    quick_register("idx_b.near", "idx_b");

    set_signer("idx_a.near");
    let follow_req = RequestBuilder::new(Action::Follow).handle("idx_b").build();
    handle_follow(&follow_req);

    let target = load_agent("idx_b").unwrap();
    let followers_idx = index_list(&keys::pub_followers("idx_b"));
    assert_eq!(
        target.follower_count as usize,
        followers_idx.len(),
        "follower_count ({}) must match followers index length ({})",
        target.follower_count,
        followers_idx.len()
    );

    let follower = load_agent("idx_a").unwrap();
    let following_idx = index_list(&keys::pub_following("idx_a"));
    assert_eq!(
        follower.following_count as usize,
        following_idx.len(),
        "following_count ({}) must match following index length ({})",
        follower.following_count,
        following_idx.len()
    );

    assert!(has(&keys::pub_edge("idx_a", "idx_b")));

    let unfollow_req = RequestBuilder::new(Action::Unfollow)
        .handle("idx_b")
        .build();
    handle_unfollow(&unfollow_req);

    let target = load_agent("idx_b").unwrap();
    let followers_idx = index_list(&keys::pub_followers("idx_b"));
    assert_eq!(target.follower_count as usize, followers_idx.len());
    assert!(
        !has(&keys::pub_edge("idx_a", "idx_b")),
        "edge should be deleted"
    );
}

#[test]
#[serial]
fn integration_follow_with_injected_failure_rolls_back() {
    setup_integration("fail_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("fail_a".into());
    handle_register(&reg);

    set_signer("fail_b.near");
    reg.handle = Some("fail_b".into());
    handle_register(&reg);

    let before_target = load_agent("fail_b").unwrap();

    set_signer("fail_a.near");
    store::test_backend::fail_next_writes(10);

    let mut follow_req = test_request(Action::Follow);
    follow_req.handle = Some("fail_b".into());
    let resp = handle_follow(&follow_req);

    assert!(!resp.success, "follow should fail when storage fails");

    store::test_backend::fail_next_writes(0);

    let after_target = load_agent("fail_b");
    if let Some(agent) = after_target {
        assert_eq!(
            agent.follower_count, before_target.follower_count,
            "follower count should not increase on failed follow"
        );
    }
}

#[test]
#[serial]
fn integration_unfollow_with_injected_failure_rolls_back() {
    setup_integration("uf_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("uf_a".into());
    handle_register(&reg);

    set_signer("uf_b.near");
    reg.handle = Some("uf_b".into());
    handle_register(&reg);

    set_signer("uf_a.near");
    let mut follow_req = test_request(Action::Follow);
    follow_req.handle = Some("uf_b".into());
    let resp = handle_follow(&follow_req);
    assert!(resp.success, "setup follow should succeed");

    let before_target = load_agent("uf_b").unwrap();
    assert_eq!(before_target.follower_count, 1);
    assert!(
        has(&keys::pub_edge("uf_a", "uf_b")),
        "edge should exist before unfollow"
    );
    let before_followers = index_list(&keys::pub_followers("uf_b"));
    assert_eq!(before_followers.len(), 1);

    store::test_backend::fail_next_writes(10);

    let mut unfollow_req = test_request(Action::Unfollow);
    unfollow_req.handle = Some("uf_b".into());
    let resp = handle_unfollow(&unfollow_req);

    assert!(!resp.success, "unfollow should fail when storage fails");

    store::test_backend::fail_next_writes(0);

    assert!(
        has(&keys::pub_edge("uf_a", "uf_b")),
        "edge should be restored after failed unfollow"
    );

    let after_followers = index_list(&keys::pub_followers("uf_b"));
    assert_eq!(
        after_followers.len(),
        before_followers.len(),
        "follower index should be restored after failed unfollow"
    );

    let after_target = load_agent("uf_b").unwrap();
    assert_eq!(
        after_target.follower_count, before_target.follower_count,
        "follower count should not change on failed unfollow"
    );
}

#[test]
#[serial]
fn integration_follow_partial_index_failure_rolls_back() {
    setup_integration("pi_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("pi_a".into());
    handle_register(&reg);

    set_signer("pi_b.near");
    reg.handle = Some("pi_b".into());
    handle_register(&reg);

    let before_target = load_agent("pi_b").unwrap();

    set_signer("pi_a.near");
    store::test_backend::fail_next_writes(3);

    let mut follow_req = test_request(Action::Follow);
    follow_req.handle = Some("pi_b".into());
    let resp = handle_follow(&follow_req);

    assert!(
        !resp.success,
        "follow should fail with injected write failures"
    );

    store::test_backend::fail_next_writes(0);

    assert!(
        !has(&keys::pub_edge("pi_a", "pi_b")),
        "edge should not exist after failed follow"
    );

    let followers = index_list(&keys::pub_followers("pi_b"));
    assert!(
        followers.is_empty(),
        "follower index should be empty after failed follow"
    );

    let following = index_list(&keys::pub_following("pi_a"));
    assert!(
        following.is_empty(),
        "following index should be empty after failed follow"
    );

    let after_target = load_agent("pi_b").unwrap();
    assert_eq!(
        after_target.follower_count, before_target.follower_count,
        "follower count should not change on failed follow"
    );
}

#[test]
#[serial]
fn integration_follow_rate_limited() {
    setup_integration("rl_alice.near");
    quick_register("rl_alice.near", "rl_alice");
    for i in 0..12 {
        quick_register(&format!("rl_target{i}.near"), &format!("rl_target{i}"));
    }

    set_signer("rl_alice.near");
    for i in 0..FOLLOW_RATE_LIMIT {
        let req = RequestBuilder::new(Action::Follow)
            .handle(&format!("rl_target{i}"))
            .build();
        let resp = handle_follow(&req);
        assert!(resp.success, "follow #{i} should succeed: {:?}", resp.error);
    }

    let req = RequestBuilder::new(Action::Follow)
        .handle(&format!("rl_target{}", FOLLOW_RATE_LIMIT))
        .build();
    let resp = handle_follow(&req);
    assert!(!resp.success, "follow should be rate-limited");
    assert_eq!(resp.code.as_deref(), Some("RATE_LIMITED"));
}

#[test]
#[serial]
fn integration_rate_limit_check_utility() {
    store::test_backend::clear();

    for _ in 0..5 {
        assert!(check_rate_limit("test_action", "caller_a", 5, 60).is_ok());
        increment_rate_limit("test_action", "caller_a", 60);
    }
    assert!(check_rate_limit("test_action", "caller_a", 5, 60).is_err());
    assert!(check_rate_limit("test_action", "caller_b", 5, 60).is_ok());
    assert!(check_rate_limit("other_action", "caller_a", 5, 60).is_ok());
}

#[test]
#[serial]
fn integration_unfollow_partial_index_failure_reports_partial_rollback() {
    setup_integration("upf_a.near");
    quick_register("upf_a.near", "upf_a");
    quick_register("upf_b.near", "upf_b");

    set_signer("upf_a.near");
    let freq = RequestBuilder::new(Action::Follow).handle("upf_b").build();
    let resp = handle_follow(&freq);
    assert!(resp.success, "follow should succeed");

    let before_target = load_agent("upf_b").unwrap();
    assert_eq!(before_target.follower_count, 1);

    // Let edge deletion succeed (1 write), then fail ALL subsequent writes
    // including rollback writes. This means the edge write can't be rolled back.
    store::test_backend::fail_after_writes(Some(1), u32::MAX);

    let ureq = RequestBuilder::new(Action::Unfollow)
        .handle("upf_b")
        .build();
    let resp = handle_unfollow(&ureq);
    assert!(!resp.success, "unfollow should fail with partial injection");
    assert_eq!(
        resp.code.as_deref(),
        Some("ROLLBACK_PARTIAL"),
        "rollback writes are also blocked, so rollback should be partial"
    );

    store::test_backend::fail_after_writes(None, 0);
    store::test_backend::fail_next_writes(0);

    // Agent record was never updated (save_agent failed), so follower_count
    // remains unchanged — the only state that persists is the edge deletion
    // which couldn't be rolled back.
    let after_target = load_agent("upf_b").unwrap();
    assert_eq!(
        after_target.follower_count, before_target.follower_count,
        "follower count should be unchanged since save_agent never succeeded"
    );
}

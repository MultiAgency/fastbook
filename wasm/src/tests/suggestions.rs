use super::*;

#[test]
fn rng_deterministic() {
    let mut r1 = suggest::Rng::from_bytes(b"seed");
    let mut r2 = suggest::Rng::from_bytes(b"seed");
    assert_eq!(r1.next(), r2.next());
    assert_eq!(r1.next(), r2.next());
}

#[test]
fn rng_shuffle_preserves_elements() {
    let mut rng = suggest::Rng::from_bytes(b"shuffle");
    let mut items = vec![1, 2, 3, 4, 5];
    rng.shuffle(&mut items);
    items.sort();
    assert_eq!(items, vec![1, 2, 3, 4, 5]);
}

#[test]
fn random_walk_empty_follows() {
    let mut rng = suggest::Rng::from_bytes(b"empty");
    let visits = suggest::random_walk_visits(
        &mut rng,
        &[],
        &std::collections::HashSet::new(),
        None,
        &mut |_| vec![],
    );
    assert!(visits.is_empty());
}

#[test]
fn rank_candidates_respects_limit() {
    let mut rng = suggest::Rng::from_bytes(b"rank");
    let candidates: Vec<AgentRecord> = (0..10)
        .map(|i| {
            let mut a = make_agent(&format!("agent_{i}"));
            a.tags = vec!["ai".into()];
            a
        })
        .collect();
    let visits: std::collections::HashMap<String, u32> =
        candidates.iter().map(|a| (a.handle.clone(), 5)).collect();
    let ranked = suggest::rank_candidates(&mut rng, candidates, &visits, &["ai".into()], 3);
    assert_eq!(ranked.len(), 3);
}

#[test]
fn rank_candidates_scores_by_visits() {
    let mut rng = suggest::Rng::from_bytes(b"score");
    let mut a1 = make_agent("popular");
    a1.follower_count = 1;
    let mut a2 = make_agent("unknown");
    a2.follower_count = 1;
    let mut visits = std::collections::HashMap::new();
    visits.insert("popular".to_string(), 50u32);
    visits.insert("unknown".to_string(), 1u32);
    let ranked = suggest::rank_candidates(&mut rng, vec![a1, a2], &visits, &[], 10);
    assert_eq!(ranked[0].agent.handle, "popular");
}

#[test]
fn different_seeds_produce_different_rankings() {
    let candidates: Vec<AgentRecord> = (0..5)
        .map(|i| {
            let mut a = make_agent(&format!("ent_{i}"));
            a.tags = vec!["ai".into()];
            a.follower_count = 1;
            a
        })
        .collect();
    let visits: std::collections::HashMap<String, u32> =
        candidates.iter().map(|a| (a.handle.clone(), 3)).collect();

    let mut rng_a = suggest::Rng::from_bytes(b"seed_alpha");
    let ranked_a =
        suggest::rank_candidates(&mut rng_a, candidates.clone(), &visits, &["ai".into()], 5);

    let mut rng_b = suggest::Rng::from_bytes(b"seed_bravo");
    let ranked_b = suggest::rank_candidates(&mut rng_b, candidates, &visits, &["ai".into()], 5);

    let order_a: Vec<&str> = ranked_a.iter().map(|s| s.agent.handle.as_str()).collect();
    let order_b: Vec<&str> = ranked_b.iter().map(|s| s.agent.handle.as_str()).collect();
    assert_ne!(
        order_a, order_b,
        "different seeds should produce different orderings"
    );
}

#[test]
fn diversify_caps_per_tag() {
    let mut rng = suggest::Rng::from_bytes(b"div");
    let limit = 6;

    let candidates: Vec<AgentRecord> = (0..10)
        .map(|i| {
            let mut a = make_agent(&format!("mono_{i}"));
            a.tags = vec!["ai".into()];
            a.follower_count = 1;
            a
        })
        .collect();

    let visits: std::collections::HashMap<String, u32> =
        candidates.iter().map(|a| (a.handle.clone(), 5)).collect();

    let ranked = suggest::rank_candidates(&mut rng, candidates, &visits, &[], limit);

    assert_eq!(ranked.len(), limit, "should return {limit} results");

    assert!(
        ranked.len() > limit / 2,
        "diversify should backfill beyond the per-tag cap"
    );
}

#[test]
fn diversify_preserves_order_within_cap() {
    let mut rng = suggest::Rng::from_bytes(b"order");
    let limit = 4;

    let mut a1 = make_agent("high_score");
    a1.tags = vec!["ai".into()];
    a1.follower_count = 1;

    let mut a2 = make_agent("low_score");
    a2.tags = vec!["defi".into()];
    a2.follower_count = 1;

    let mut visits = std::collections::HashMap::new();
    visits.insert("high_score".to_string(), 50u32);
    visits.insert("low_score".to_string(), 1u32);

    let ranked = suggest::rank_candidates(&mut rng, vec![a1, a2], &visits, &[], limit);

    assert_eq!(ranked.len(), 2);
    assert_eq!(
        ranked[0].agent.handle, "high_score",
        "higher-scoring agent should come first"
    );
}

#[test]
#[serial]
fn integration_suggested_walks_graph_neighbors() {
    setup_integration("sug_a.near");
    let mut reg = test_request(Action::Register);
    reg.handle = Some("sug_a".into());
    reg.tags = Some(vec!["ai".into()]);
    handle_register(&reg);

    set_signer("sug_b.near");
    reg.handle = Some("sug_b".into());
    reg.tags = Some(vec!["ai".into()]);
    handle_register(&reg);

    set_signer("sug_c.near");
    reg.handle = Some("sug_c".into());
    reg.tags = Some(vec!["ai".into()]);
    handle_register(&reg);

    set_signer("sug_b.near");
    let mut follow_req = test_request(Action::Follow);
    follow_req.handle = Some("sug_c".into());
    handle_follow(&follow_req);

    set_signer("sug_a.near");
    follow_req.handle = Some("sug_b".into());
    handle_follow(&follow_req);

    let follows = index_list(&keys::pub_following("sug_a"));
    let follow_set: std::collections::HashSet<String> = follows.iter().cloned().collect();
    let my_tags = load_agent("sug_a").unwrap().tags;

    let mut outgoing_cache: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    let mut get_outgoing = |handle: &str| -> Vec<String> {
        if let Some(cached) = outgoing_cache.get(handle) {
            return cached.clone();
        }
        let neighbors = index_list(&keys::pub_following(handle));
        outgoing_cache.insert(handle.to_string(), neighbors.clone());
        neighbors
    };

    let mut rng = suggest::Rng::from_bytes(b"test_seed");
    let visits = suggest::random_walk_visits(
        &mut rng,
        &follows,
        &follow_set,
        Some("sug_a"),
        &mut get_outgoing,
    );

    assert!(
        visits.contains_key("sug_c"),
        "C should be visited via A→B→C walk, visits: {:?}",
        visits
    );

    let candidates = vec![load_agent("sug_c").unwrap()];
    let ranked = suggest::rank_candidates(&mut rng, candidates, &visits, &my_tags, 10);
    assert!(!ranked.is_empty(), "C should appear in ranked suggestions");
    assert_eq!(ranked[0].agent.handle, "sug_c");
}

#[test]
fn rng_pick_distribution_is_reasonable() {
    let mut rng = suggest::Rng::from_bytes(b"bias_test_seed");
    let n = 3usize;
    let samples = 30_000usize;
    let mut counts = vec![0usize; n];

    for _ in 0..samples {
        let idx = rng.pick(n).unwrap();
        assert!(idx < n, "pick should return index < n");
        counts[idx] += 1;
    }

    let expected = samples as f64 / n as f64;
    for (i, &count) in counts.iter().enumerate() {
        let deviation = (count as f64 - expected).abs() / expected;
        assert!(deviation < 0.05,
            "bucket {i} has {count} hits (expected ~{expected:.0}), deviation {deviation:.3} exceeds 5%");
    }
}

#[test]
fn rng_pick_covers_full_range() {
    let mut rng = suggest::Rng::from_bytes(b"range_test");
    let n = 7usize;
    let mut seen = std::collections::HashSet::new();

    for _ in 0..1000 {
        seen.insert(rng.pick(n).unwrap());
        if seen.len() == n {
            break;
        }
    }
    assert_eq!(
        seen.len(),
        n,
        "pick({n}) should cover all indices 0..{n}, got {:?}",
        seen
    );
}

/// M3: handle_get_suggested end-to-end through the handler.
#[test]
#[serial]
fn integration_handle_get_suggested_response_shape() {
    setup_integration("hs_a.near");
    quick_register("hs_a.near", "hs_alice");

    set_signer("hs_b.near");
    let req = RequestBuilder::new(Action::Register)
        .handle("hs_bob")
        .tags(&["ai", "rust"])
        .build();
    handle_register(&req);

    set_signer("hs_c.near");
    let req = RequestBuilder::new(Action::Register)
        .handle("hs_carol")
        .tags(&["ai", "defi"])
        .build();
    handle_register(&req);

    // A follows B so the graph has edges for the walk
    set_signer("hs_a.near");
    handle_follow(&RequestBuilder::new(Action::Follow).handle("hs_bob").build());

    // Call the handler directly
    let req = RequestBuilder::new(Action::GetSuggested).limit(5).build();
    let resp = handle_get_suggested(&req);
    assert!(
        resp.success,
        "get_suggested should succeed: {:?}",
        resp.error
    );

    let data = parse_response(&resp);
    let agents = data["agents"].as_array().expect("should have agents array");
    assert!(
        !agents.is_empty(),
        "should return at least one suggestion (carol is eligible)"
    );
    // Should not suggest self or already-followed agents
    for agent in agents {
        assert_ne!(agent["handle"], "hs_alice", "should not suggest self");
        assert_ne!(
            agent["handle"], "hs_bob",
            "should not suggest already-followed"
        );
    }
}

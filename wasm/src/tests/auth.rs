use super::*;
use crate::auth as crate_auth;
use crate::store;

#[test]
fn verify_auth_is_stateless_accepts_same_nonce_twice() {
    let (auth, now_ms) = nep413::tests::make_auth_for_test();
    assert!(nep413::verify_auth(&auth, now_ms, "register").is_ok());
    assert!(nep413::verify_auth(&auth, now_ms, "register").is_ok());
}

#[test]
#[serial]
fn integration_nonce_replay_rejected() {
    store::test_backend::clear();
    unsafe { std::env::remove_var("NEAR_SENDER_ID") };

    let (auth, now_ms) = nep413::tests::make_auth_for_test();
    let block_ts_ns = (now_ms / 1000) * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", block_ts_ns.to_string()) };

    let result1 = crate_auth::get_caller_from(&Request {
        action: Action::Register,
        verifiable_claim: Some(auth.clone()),
        ..test_request(Action::Register)
    });
    assert!(
        result1.is_ok(),
        "first auth should succeed: {:?}",
        result1.err().map(|r| r.error)
    );

    let result2 = crate_auth::get_caller_from(&Request {
        action: Action::Register,
        verifiable_claim: Some(auth),
        ..test_request(Action::Register)
    });
    assert!(result2.is_err(), "second auth with same nonce should fail");
    let err_resp = result2.unwrap_err();
    assert_eq!(err_resp.code.as_deref(), Some("NONCE_REPLAY"));

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

/// C1: When NEAR_SENDER_ID is set to a different account (e.g. from a
/// server payment key) but a valid verifiable_claim is present, auth
/// falls through to NEP-413 in-WASM verification and returns the
/// claim's account — enabling the server-paid path where the server
/// pays for the OutLayer call while the agent's identity is verified
/// cryptographically.
#[test]
#[serial]
fn integration_server_paid_verifiable_claim_falls_through_to_nep413() {
    store::test_backend::clear();
    // Simulate: OutLayer sets NEAR_SENDER_ID to the payment key owner (server)
    unsafe { std::env::set_var("NEAR_SENDER_ID", "server.near") };

    let (auth, now_ms) = nep413::tests::make_auth_for_test(); // signs as alice.near
    let block_ts_ns = (now_ms / 1000) * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", block_ts_ns.to_string()) };

    let result = crate_auth::get_caller_from(&Request {
        action: Action::Register,
        verifiable_claim: Some(auth),
        ..test_request(Action::Register)
    });
    match result {
        Ok(caller) => assert_eq!(
            caller, "alice.near",
            "should return claim's account, not server's"
        ),
        Err(resp) => panic!(
            "server-paid claim should succeed via NEP-413, got: {:?}",
            resp.error
        ),
    }

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

/// C1b: Server-paid path with an invalid signature must still reject.
/// Ensures the fallthrough actually verifies the claim cryptographically.
#[test]
#[serial]
fn integration_server_paid_invalid_signature_rejected() {
    store::test_backend::clear();
    unsafe { std::env::set_var("NEAR_SENDER_ID", "server.near") };

    let (mut auth, now_ms) = nep413::tests::make_auth_for_test();
    let block_ts_ns = (now_ms / 1000) * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", block_ts_ns.to_string()) };

    // Corrupt the signature
    auth.signature = "ed25519:1111111111111111111111111111111111111111111111".into();

    let result = crate_auth::get_caller_from(&Request {
        action: Action::Register,
        verifiable_claim: Some(auth),
        ..test_request(Action::Register)
    });
    assert!(result.is_err(), "invalid signature should be rejected");
    let err_resp = result.unwrap_err();
    assert_eq!(err_resp.code.as_deref(), Some("AUTH_FAILED"));

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

/// When NEAR_SENDER_ID matches the verifiable_claim account, the fast path
/// should succeed and return the signer.
#[test]
#[serial]
fn integration_matching_verifiable_claim_accepted() {
    store::test_backend::clear();
    // Simulate: OutLayer sets NEAR_SENDER_ID from the user's wk_* key
    unsafe { std::env::set_var("NEAR_SENDER_ID", "alice.near") };

    let (auth, _) = nep413::tests::make_auth_for_test(); // signs as alice.near

    let result = crate_auth::get_caller_from(&Request {
        action: Action::Register,
        verifiable_claim: Some(auth),
        ..test_request(Action::Register)
    });
    match result {
        Ok(caller) => assert_eq!(caller, "alice.near"),
        Err(resp) => panic!("matching claim should be accepted, got: {:?}", resp.error),
    }
}

#[test]
#[serial]
fn integration_register_via_nep413_creates_agent() {
    setup_nep413();
    let (auth, _) = nep413::tests::make_auth_for_test();

    let mut req = test_request(Action::Register);
    req.handle = Some("nep_alice".into());
    req.description = Some("Registered via NEP-413".into());
    req.verifiable_claim = Some(auth);

    let resp = handle_register(&req);
    assert!(
        resp.success,
        "NEP-413 register should succeed: {:?}",
        resp.error
    );

    let data = parse_response(&resp);
    assert_eq!(data["agent"]["handle"], "nep_alice");
    assert_eq!(data["near_account_id"], "alice.near");

    let agent = load_agent("nep_alice").expect("agent should exist");
    assert_eq!(agent.near_account_id, "alice.near");

    teardown_nep413();
}

#[test]
#[serial]
fn nonce_replay_uses_user_scoped_storage() {
    setup_nep413();
    let (auth, _) = nep413::tests::make_auth_for_test();

    let mut req = test_request(Action::Register);
    req.handle = Some("nonce_scope_test".into());
    req.verifiable_claim = Some(auth.clone());
    let resp = handle_register(&req);
    assert!(resp.success, "register should succeed: {:?}", resp.error);

    // The nonce key should be in USER_STORE, not STORE.
    let nonce_key = keys::nonce(&auth.nonce);
    assert!(
        store::test_backend::user_get(&nonce_key).unwrap().is_some(),
        "nonce should be stored in user-scoped storage"
    );

    teardown_nep413();
}

/// H1a: Server-paid path with colon signer (payment key) and valid
/// verifiable_claim falls through to NEP-413 and returns the claim's account.
#[test]
#[serial]
fn integration_colon_signer_with_claim_falls_through() {
    store::test_backend::clear();
    unsafe { std::env::set_var("NEAR_SENDER_ID", "owner.near:1:secret") };

    let (auth, now_ms) = nep413::tests::make_auth_for_test(); // signs as alice.near
    let block_ts_ns = (now_ms / 1000) * NANOS_PER_SEC;
    unsafe { std::env::set_var("NEAR_BLOCK_TIMESTAMP", block_ts_ns.to_string()) };

    let result = crate_auth::get_caller_from(&Request {
        action: Action::Register,
        verifiable_claim: Some(auth),
        ..test_request(Action::Register)
    });
    match result {
        Ok(caller) => assert_eq!(
            caller, "alice.near",
            "should return claim's account, not payment key owner"
        ),
        Err(resp) => panic!(
            "colon signer + valid claim should succeed via NEP-413, got: {:?}",
            resp.error
        ),
    }

    unsafe { std::env::remove_var("NEAR_BLOCK_TIMESTAMP") };
}

/// H1b: Colon signer without verifiable_claim extracts owner (direct payment-key path).
#[test]
#[serial]
fn integration_colon_signer_without_claim_returns_owner() {
    setup_integration("owner.near:1:secret");
    let result = crate_auth::get_caller_from(&test_request(Action::GetMe));
    match result {
        Ok(caller) => assert_eq!(caller, "owner.near"),
        Err(resp) => panic!("should extract owner, got: {:?}", resp.error),
    }
}

/// H1c: Colon signer with empty owner prefix must be rejected.
#[test]
#[serial]
fn integration_colon_signer_empty_owner_rejected() {
    setup_integration(":1:secret");
    let result = crate_auth::get_caller_from(&test_request(Action::GetMe));
    assert!(result.is_err());
    assert_eq!(result.unwrap_err().code.as_deref(), Some("AUTH_FAILED"));
}

/// H2: prune_nonce_index deletes expired nonces while preserving fresh ones.
#[test]
#[serial]
fn integration_nonce_gc_prunes_expired() {
    store::test_backend::clear();

    // Manually store nonces with known timestamps in user-scoped storage
    let nonce_a = keys::nonce("expired_100");
    let nonce_b = keys::nonce("expired_200");
    let nonce_c = keys::nonce("fresh_500");

    store::test_backend::user_set_if_absent(&nonce_a, b"100").unwrap();
    store::test_backend::user_set_if_absent(&nonce_b, b"200").unwrap();
    store::test_backend::user_set_if_absent(&nonce_c, b"500").unwrap();

    // Add all three to the nonce index
    index_append(keys::nonce_idx(), &nonce_a).unwrap();
    index_append(keys::nonce_idx(), &nonce_b).unwrap();
    index_append(keys::nonce_idx(), &nonce_c).unwrap();

    // Prune with cutoff=300: nonces with value < 300 are deleted
    prune_nonce_index(keys::nonce_idx(), 300).unwrap();

    assert!(
        store::test_backend::user_get(&nonce_a).unwrap().is_none(),
        "nonce with ts=100 should be pruned"
    );
    assert!(
        store::test_backend::user_get(&nonce_b).unwrap().is_none(),
        "nonce with ts=200 should be pruned"
    );
    assert!(
        store::test_backend::user_get(&nonce_c).unwrap().is_some(),
        "nonce with ts=500 should survive (above cutoff)"
    );
}

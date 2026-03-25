use super::*;

#[test]
#[serial]
fn transaction_rollback_partial_when_rollback_write_fails() {
    use super::super::transaction::Transaction;

    store::test_backend::clear();

    let key = "pub:txn_test:data";

    let mut txn = Transaction::new();
    assert!(txn.set_public("write data", key, b"hello").is_none());

    assert_eq!(get_string(key).as_deref(), Some("hello"));

    store::test_backend::fail_next_writes(100);

    let result = txn.set_public("write more", key, b"world");

    store::test_backend::fail_next_writes(0);

    let resp = result.expect("step 2 should fail and return a Response");
    assert!(!resp.success);
    assert_eq!(
        resp.code.as_deref(),
        Some("ROLLBACK_PARTIAL"),
        "should signal ROLLBACK_PARTIAL when rollback write also fails"
    );
    assert!(
        resp.error.as_ref().unwrap().contains("rollback failed"),
        "error message should mention rollback failure"
    );
}

#[test]
#[serial]
fn transaction_clean_rollback_on_step_failure() {
    use super::super::transaction::Transaction;

    store::test_backend::clear();

    let key = "pub:txn_test:clean";

    let mut txn = Transaction::new();
    assert!(txn.set_public("write data", key, b"original").is_none());
    assert_eq!(get_string(key).as_deref(), Some("original"));

    store::test_backend::fail_next_writes(1);

    let result = txn.set_public("write more", key, b"updated");

    store::test_backend::fail_next_writes(0);

    let resp = result.expect("step 2 should fail");
    assert!(!resp.success);
    assert!(
        resp.code.is_none(),
        "clean rollback should not produce an error code, got: {:?}",
        resp.code
    );

    assert_eq!(
        get_string(key),
        None,
        "rollback should restore pre-step-1 state"
    );
}

#[test]
#[serial]
fn transaction_rollback_response_partial() {
    use super::super::transaction::Transaction;

    store::test_backend::clear();

    let key = "pub:txn_test:manual";

    let mut txn = Transaction::new();
    assert!(txn.set_public("write", key, b"data").is_none());

    store::test_backend::fail_next_writes(100);
    let resp = txn.rollback_response("manual abort");
    store::test_backend::fail_next_writes(0);

    assert!(!resp.success);
    assert_eq!(resp.code.as_deref(), Some("ROLLBACK_PARTIAL"));
    assert!(resp.error.as_ref().unwrap().contains("manual abort"));
}

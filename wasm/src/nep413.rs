//! NEP-413 signature construction and verification for ed25519-signed messages.

use crate::types::AppError;
use crate::Nep413Auth;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

/// NEP-413 Borsh discriminant tag (2³¹ + 413).
const NEP413_TAG: u32 = 2_147_484_061;
const RECIPIENT: &str = "nearly.social";
pub(crate) const TIMESTAMP_WINDOW_MS: u64 = 5 * 60 * 1000;
/// Maximum clock skew tolerated for timestamps in the future.
const FUTURE_TS_TOLERANCE_MS: u64 = 60_000;

pub(crate) fn build_nep413_payload(message: &[u8], nonce: &[u8], recipient: &[u8]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&NEP413_TAG.to_le_bytes());
    payload.extend_from_slice(&(message.len() as u32).to_le_bytes());
    payload.extend_from_slice(message);
    payload.extend_from_slice(nonce);
    payload.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
    payload.extend_from_slice(recipient);
    payload.push(0);
    payload
}

/// Validate NEAR account ID format: 2-64 chars, alphanumeric plus `.`, `-`, `_`.
pub(crate) fn validate_near_account_id(account_id: &str) -> Result<(), AppError> {
    if account_id.len() < 2
        || account_id.len() > 64
        || !account_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err(AppError::Auth("Invalid NEAR account ID format".into()));
    }
    Ok(())
}

#[cfg(test)]
pub fn verify_public_key_ownership(account_id: &str, _public_key: &str) -> Result<(), AppError> {
    validate_near_account_id(account_id)
}

/// Check whether `account_id` is an implicit account cryptographically
/// bound to `public_key`. Supports two implicit schemes:
///
/// 1. **Raw public key** (OutLayer custody wallets): account_id = hex(pubkey)
/// 2. **NEAR implicit** (on-chain): account_id = hex(sha256(pubkey))
///
/// Both are 64 hex chars. If either matches, no on-chain lookup is needed.
#[allow(dead_code)] // Called from #[cfg(not(test))] verify_public_key_ownership + tested directly
fn is_implicit_owner(account_id: &str, public_key: &str) -> Result<bool, AppError> {
    if account_id.len() != 64 || !account_id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(false);
    }
    let pub_bytes = decode_ed25519_key(public_key)?;
    // Scheme 1: raw pubkey hex (OutLayer custody)
    let raw_hex: String = pub_bytes.iter().map(|b| format!("{b:02x}")).collect();
    if raw_hex == account_id {
        return Ok(true);
    }
    // Scheme 2: sha256(pubkey) hex (NEAR implicit accounts)
    let hash = Sha256::digest(&pub_bytes);
    let hash_hex: String = hash.iter().map(|b| format!("{b:02x}")).collect();
    Ok(hash_hex == account_id)
}

#[cfg(not(test))]
pub fn verify_public_key_ownership(account_id: &str, public_key: &str) -> Result<(), AppError> {
    validate_near_account_id(account_id)?;
    // Implicit accounts (64 hex chars = sha256 of ed25519 pubkey) can be
    // verified mathematically — no on-chain lookup needed. This supports
    // OutLayer custody wallets which may not have on-chain accounts.
    if is_implicit_owner(account_id, public_key)? {
        return Ok(());
    }
    let (result, error) = outlayer::raw::rpc::view_access_key(account_id, public_key, "final");
    if !error.is_empty() {
        return Err(AppError::Auth(
            "RPC unreachable while verifying public key".into(),
        ));
    }
    if result.is_empty() {
        return Err(AppError::Auth(
            "Public key not found on the specified account".into(),
        ));
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&result)
        .map_err(|_| AppError::Auth("Failed to parse RPC response".into()))?;
    let perm = parsed.get("permission");
    let is_full_access = perm
        .and_then(|p| p.as_str())
        .map(|s| s == "FullAccess")
        .unwrap_or(false);
    if !is_full_access {
        return Err(AppError::Auth(
            "Only FullAccess keys can prove account ownership".into(),
        ));
    }
    Ok(())
}

pub fn verify_auth(auth: &Nep413Auth, now_ms: u64, expected_action: &str) -> Result<(), AppError> {
    let parsed: serde_json::Value = serde_json::from_str(&auth.message)
        .map_err(|_| AppError::Auth("Message must be valid JSON".into()))?;

    if parsed.get("domain").and_then(|v| v.as_str()) != Some(RECIPIENT) {
        return Err(AppError::Auth(format!(
            "Message domain must be \"{RECIPIENT}\""
        )));
    }

    let msg_action = parsed
        .get("action")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Auth("Message must contain an action field".into()))?;
    if msg_action != expected_action {
        return Err(AppError::Auth(format!(
            "Message action \"{msg_action}\" does not match expected \"{expected_action}\""
        )));
    }

    let msg_account = parsed.get("account_id").and_then(|v| v.as_str());
    if msg_account != Some(&auth.near_account_id) {
        return Err(AppError::Auth(
            "Message account_id must match near_account_id".into(),
        ));
    }

    let ts = parsed
        .get("timestamp")
        .and_then(serde_json::Value::as_u64)
        .ok_or(AppError::Auth(
            "Message must contain a numeric timestamp field".into(),
        ))?;
    if now_ms > ts && now_ms - ts > TIMESTAMP_WINDOW_MS {
        return Err(AppError::Auth("Timestamp expired".into()));
    }
    if ts > now_ms + FUTURE_TS_TOLERANCE_MS {
        return Err(AppError::Auth("Timestamp is in the future".into()));
    }

    let pub_key_bytes = decode_ed25519_key(&auth.public_key)?;
    let sig_bytes = decode_ed25519_key(&auth.signature)?;

    let nonce_bytes =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &auth.nonce)
            .map_err(|_| AppError::Auth("Invalid base64 nonce".into()))?;

    if nonce_bytes.len() != 32 {
        return Err(AppError::Auth("Nonce must be 32 bytes".into()));
    }

    let payload = build_nep413_payload(auth.message.as_bytes(), &nonce_bytes, RECIPIENT.as_bytes());

    let hash = Sha256::digest(&payload);

    let verifying_key = VerifyingKey::from_bytes(
        pub_key_bytes
            .as_slice()
            .try_into()
            .map_err(|_| AppError::Auth("Invalid public key length".into()))?,
    )
    .map_err(|_| AppError::Auth("Invalid public key".into()))?;

    let signature = Signature::from_bytes(
        sig_bytes
            .as_slice()
            .try_into()
            .map_err(|_| AppError::Auth("Invalid signature length".into()))?,
    );

    verifying_key
        .verify_strict(&hash, &signature)
        .map_err(|_| AppError::Auth("ed25519 signature verification failed".into()))?;

    Ok(())
}

fn decode_ed25519_key(key_str: &str) -> Result<Vec<u8>, AppError> {
    let encoded = key_str
        .strip_prefix("ed25519:")
        .ok_or_else(|| AppError::Auth("Key must start with \"ed25519:\"".into()))?;
    bs58::decode(encoded)
        .into_vec()
        .map_err(|e| AppError::Auth(format!("Invalid base58: {e}")))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub fn make_auth_for_test() -> (Nep413Auth, u64) {
        let now_ms = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        (auth, now_ms)
    }

    /// Build a signed NEP-413 claim for an arbitrary account and action.
    pub fn make_auth(account_id: &str, action: &str, now_ms: u64) -> Nep413Auth {
        let (auth, _) = sign_auth_with_action(account_id, "nearly.social", action, now_ms);
        auth
    }

    fn sign_auth(account_id: &str, domain: &str, now_ms: u64) -> (Nep413Auth, SigningKey) {
        sign_auth_with_action(account_id, domain, "register", now_ms)
    }

    fn sign_auth_with_action(
        account_id: &str,
        domain: &str,
        action: &str,
        now_ms: u64,
    ) -> (Nep413Auth, SigningKey) {
        let secret_bytes: [u8; 32] = [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
            25, 26, 27, 28, 29, 30, 31, 32,
        ];
        let signing_key = SigningKey::from_bytes(&secret_bytes);
        let verifying_key = signing_key.verifying_key();

        let pub_key_str = format!(
            "ed25519:{}",
            bs58::encode(verifying_key.as_bytes()).into_string()
        );

        let message = serde_json::json!({
            "action": action,
            "domain": domain,
            "account_id": account_id,
            "version": 1,
            "timestamp": now_ms,
        })
        .to_string();

        // Derive a deterministic but unique nonce from the action + account so
        // that different calls within the same test don't collide.
        let mut nonce_bytes = [0u8; 32];
        for (i, b) in action.bytes().chain(account_id.bytes()).enumerate() {
            nonce_bytes[i % 32] ^= b;
        }
        // Ensure non-zero first byte for GC sampling predictability in tests.
        nonce_bytes[0] |= 42;
        let nonce_b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, nonce_bytes);

        let payload = build_nep413_payload(message.as_bytes(), &nonce_bytes, RECIPIENT.as_bytes());
        let hash = Sha256::digest(&payload);
        let signature = signing_key.sign(&hash);
        let sig_str = format!(
            "ed25519:{}",
            bs58::encode(signature.to_bytes()).into_string()
        );

        let auth = Nep413Auth {
            near_account_id: account_id.to_string(),
            public_key: pub_key_str,
            signature: sig_str,
            nonce: nonce_b64,
            message,
        };
        (auth, signing_key)
    }

    #[test]
    fn valid_signature_succeeds() {
        let now_ms = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        assert!(verify_auth(&auth, now_ms, "register").is_ok());
    }

    #[test]
    fn wrong_domain_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "evil.site", now_ms);
        let err = verify_auth(&auth, now_ms, "register")
            .unwrap_err()
            .to_string();
        assert!(err.contains("domain"), "expected domain error, got: {err}");
    }

    #[test]
    fn wrong_account_id_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (mut auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        auth.near_account_id = "bob.near".to_string();
        let err = verify_auth(&auth, now_ms, "register")
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("account_id"),
            "expected account_id error, got: {err}"
        );
    }

    #[test]
    fn expired_timestamp_rejected() {
        let sign_time = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "nearly.social", sign_time);
        let err = verify_auth(&auth, sign_time + 6 * 60 * 1000, "register")
            .unwrap_err()
            .to_string();
        assert!(err.contains("expired"), "expected expiry error, got: {err}");
    }

    #[test]
    fn future_timestamp_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "nearly.social", now_ms + 2 * 60 * 1000);
        let err = verify_auth(&auth, now_ms, "register")
            .unwrap_err()
            .to_string();
        assert!(err.contains("future"), "expected future error, got: {err}");
    }

    #[test]
    fn tampered_message_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (mut auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        auth.message = auth.message.replace("register", "steal");
        let err = verify_auth(&auth, now_ms, "steal").unwrap_err().to_string();
        assert!(
            err.contains("verification failed"),
            "expected sig error, got: {err}"
        );
    }

    #[test]
    fn invalid_public_key_format_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (mut auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        auth.public_key = "rsa:AAAA".to_string();
        let err = verify_auth(&auth, now_ms, "register")
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("ed25519:"),
            "expected prefix error, got: {err}"
        );
    }

    #[test]
    fn invalid_nonce_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (mut auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        auth.nonce = "not-valid-base64!!!".to_string();
        let err = verify_auth(&auth, now_ms, "register")
            .unwrap_err()
            .to_string();
        assert!(err.contains("nonce"), "expected nonce error, got: {err}");
    }

    #[test]
    fn within_timestamp_window_succeeds() {
        let sign_time = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "nearly.social", sign_time);
        assert!(verify_auth(&auth, sign_time + 4 * 60 * 1000, "register").is_ok());
    }

    #[test]
    fn slight_future_timestamp_succeeds() {
        let now_ms = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "nearly.social", now_ms + 30_000);
        assert!(verify_auth(&auth, now_ms, "register").is_ok());
    }

    #[test]
    fn wrong_action_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        let err = verify_auth(&auth, now_ms, "follow")
            .unwrap_err()
            .to_string();
        assert!(err.contains("action"), "expected action error, got: {err}");
    }

    #[test]
    fn nonce_wrong_length_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (mut auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        // 31 bytes — valid base64 but wrong length
        auth.nonce = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [1u8; 31]);
        let err = verify_auth(&auth, now_ms, "register")
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("32 bytes"),
            "expected nonce length error, got: {err}"
        );
    }

    #[test]
    fn public_key_wrong_length_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (mut auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        // 16 bytes — valid base58 but wrong length for ed25519
        auth.public_key = format!("ed25519:{}", bs58::encode([0u8; 16]).into_string());
        let err = verify_auth(&auth, now_ms, "register")
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("public key length"),
            "expected public key length error, got: {err}"
        );
    }

    #[test]
    fn signature_wrong_length_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (mut auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        // 32 bytes — valid base58 but wrong length for ed25519 signature (needs 64)
        auth.signature = format!("ed25519:{}", bs58::encode([0u8; 32]).into_string());
        let err = verify_auth(&auth, now_ms, "register")
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("signature length"),
            "expected signature length error, got: {err}"
        );
    }

    // H3: validate_near_account_id — extracted from verify_public_key_ownership
    #[test]
    fn account_id_rejects_invalid() {
        assert!(validate_near_account_id("a").is_err()); // too short
        assert!(validate_near_account_id(&"a".repeat(65)).is_err()); // too long
        assert!(validate_near_account_id("alice@near").is_err()); // bad char
        assert!(validate_near_account_id("alice near").is_err()); // space
        assert!(validate_near_account_id("alice:near").is_err()); // colon
    }

    #[test]
    fn account_id_accepts_valid() {
        assert!(validate_near_account_id("alice.near").is_ok());
        assert!(validate_near_account_id("a-b_c.near").is_ok());
        assert!(validate_near_account_id("ab").is_ok()); // min length
        assert!(validate_near_account_id(&"a".repeat(64)).is_ok()); // max length
    }

    fn test_pub_key_str() -> (String, Vec<u8>) {
        let secret_bytes: [u8; 32] = [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
            25, 26, 27, 28, 29, 30, 31, 32,
        ];
        let signing_key = SigningKey::from_bytes(&secret_bytes);
        let pk_bytes = signing_key.verifying_key().to_bytes();
        let pub_key_str = format!("ed25519:{}", bs58::encode(&pk_bytes).into_string());
        (pub_key_str, pk_bytes.to_vec())
    }

    #[test]
    fn implicit_owner_raw_pubkey_hex() {
        let (pub_key_str, pk_bytes) = test_pub_key_str();
        let account_id: String = pk_bytes.iter().map(|b| format!("{b:02x}")).collect();
        assert!(is_implicit_owner(&account_id, &pub_key_str).unwrap());
    }

    #[test]
    fn implicit_owner_sha256_hex() {
        let (pub_key_str, pk_bytes) = test_pub_key_str();
        let hash = Sha256::digest(&pk_bytes);
        let account_id: String = hash.iter().map(|b| format!("{b:02x}")).collect();
        assert!(is_implicit_owner(&account_id, &pub_key_str).unwrap());
    }

    #[test]
    fn implicit_owner_named_account_returns_false() {
        let (pub_key_str, _) = test_pub_key_str();
        assert!(!is_implicit_owner("alice.near", &pub_key_str).unwrap());
    }

    #[test]
    fn implicit_owner_wrong_hex_returns_false() {
        let (pub_key_str, _) = test_pub_key_str();
        let wrong = "aa".repeat(32);
        assert!(!is_implicit_owner(&wrong, &pub_key_str).unwrap());
    }
}

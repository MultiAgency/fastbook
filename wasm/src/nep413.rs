//! NEP-413 signature verification for Payment Key HTTPS mode.
//!
//! Verifies ed25519 signatures over the NEP-413 Borsh-serialized payload
//! to authenticate users when the platform can't provide signer_account_id().

use crate::Nep413Auth;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Sha256, Digest};

const NEP413_TAG: u32 = 2_147_484_061; // 2^31 + 413
const RECIPIENT: &str = "nearly.social";
pub(crate) const TIMESTAMP_WINDOW_MS: u64 = 5 * 60 * 1000; // 5 minutes

/// Build the Borsh-serialized NEP-413 payload for signing/verification.
pub(crate) fn build_nep413_payload(message: &[u8], nonce: &[u8], recipient: &[u8]) -> Vec<u8> {
    let mut payload = Vec::new();
    payload.extend_from_slice(&NEP413_TAG.to_le_bytes());
    payload.extend_from_slice(&(message.len() as u32).to_le_bytes());
    payload.extend_from_slice(message);
    payload.extend_from_slice(nonce);
    payload.extend_from_slice(&(recipient.len() as u32).to_le_bytes());
    payload.extend_from_slice(recipient);
    payload.push(0); // callbackUrl: None
    payload
}

/// Verify that the given public key is an access key on the claimed NEAR account.
/// Uses the NEAR RPC `view-access-key` endpoint.
pub fn verify_public_key_ownership(account_id: &str, public_key: &str) -> Result<(), String> {
    // Validate account_id format: alphanumeric, dots, dashes, underscores; 2-64 chars
    if account_id.len() < 2
        || account_id.len() > 64
        || !account_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return Err("Invalid NEAR account ID format".to_string());
    }
    let (result, error) = outlayer::raw::rpc::view_access_key(account_id, public_key, "final");
    if !error.is_empty() {
        return Err("RPC error verifying public key".to_string());
    }
    if result.is_empty() {
        return Err("Public key not found on the specified account".to_string());
    }
    Ok(())
}

/// Verify a NEP-413 authentication claim.
/// `now_ms` is the current time in milliseconds (caller-provided for TEE consistency).
/// Returns Ok(()) if the signature is valid, Err(message) otherwise.
pub fn verify_auth(auth: &Nep413Auth, now_ms: u64) -> Result<(), String> {
    let parsed: serde_json::Value = serde_json::from_str(&auth.message)
        .map_err(|_| "Message must be valid JSON")?;

    if parsed.get("domain").and_then(|v| v.as_str()) != Some(RECIPIENT) {
        return Err(format!("Message domain must be \"{RECIPIENT}\""));
    }

    // The message must contain the account ID the caller claims to be.
    // This binds the signature to a specific account — the signer can't
    // reuse a signature to impersonate a different account.
    let msg_account = parsed.get("account_id").and_then(|v| v.as_str());
    if msg_account != Some(&auth.near_account_id) {
        return Err("Message account_id must match near_account_id".to_string());
    }

    let ts = parsed.get("timestamp").and_then(|v| v.as_u64())
        .ok_or("Message must contain a numeric timestamp field")?;
    if now_ms > ts && now_ms - ts > TIMESTAMP_WINDOW_MS {
        return Err("Timestamp expired".to_string());
    }
    if ts > now_ms + 60_000 {
        return Err("Timestamp is in the future".to_string());
    }

    // 2. Decode public key from "ed25519:<base58>" format
    let pub_key_bytes = decode_ed25519_key(&auth.public_key)?;
    if pub_key_bytes.len() != 32 {
        return Err("Public key must be 32 bytes".to_string());
    }

    // 3. Decode signature from "ed25519:<base58>" format
    let sig_bytes = decode_ed25519_key(&auth.signature)?;
    if sig_bytes.len() != 64 {
        return Err("Signature must be 64 bytes".to_string());
    }

    // 4. Decode nonce from base64 (must be 32 bytes)
    let nonce_bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        &auth.nonce,
    ).map_err(|_| "Invalid base64 nonce")?;

    if nonce_bytes.len() != 32 {
        return Err("Nonce must be 32 bytes".to_string());
    }

    // 5. Build NEP-413 Borsh payload
    let payload = build_nep413_payload(auth.message.as_bytes(), &nonce_bytes, RECIPIENT.as_bytes());

    // 6. SHA-256 hash the payload
    let hash = Sha256::digest(&payload);

    // 7. Verify ed25519 signature
    let verifying_key = VerifyingKey::from_bytes(
        pub_key_bytes.as_slice().try_into().map_err(|_| "Invalid public key length")?
    ).map_err(|_| "Invalid public key")?;

    let signature = Signature::from_bytes(
        sig_bytes.as_slice().try_into().map_err(|_| "Invalid signature length")?
    );

    verifying_key
        .verify_strict(&hash, &signature)
        .map_err(|_| "ed25519 signature verification failed")?;

    Ok(())
}

/// Decode a NEAR-style "ed25519:<base58>" key string to raw bytes.
fn decode_ed25519_key(key_str: &str) -> Result<Vec<u8>, String> {
    let prefix = "ed25519:";
    if !key_str.starts_with(prefix) {
        return Err(format!("Key must start with \"{prefix}\""));
    }
    let encoded = &key_str[prefix.len()..];
    bs58::decode(encoded)
        .into_vec()
        .map_err(|e| format!("Invalid base58: {e}"))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    /// Return a valid (auth, now_ms) pair for cross-module tests.
    pub fn make_auth_for_test() -> (Nep413Auth, u64) {
        let now_ms = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        (auth, now_ms)
    }

    /// Build a valid Nep413Auth by signing with a known keypair.
    fn sign_auth(account_id: &str, domain: &str, now_ms: u64) -> (Nep413Auth, SigningKey) {
        let secret_bytes: [u8; 32] = [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
            17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32,
        ];
        let signing_key = SigningKey::from_bytes(&secret_bytes);
        let verifying_key = signing_key.verifying_key();

        let pub_key_str = format!("ed25519:{}", bs58::encode(verifying_key.as_bytes()).into_string());

        let message = serde_json::json!({
            "action": "register",
            "domain": domain,
            "account_id": account_id,
            "version": 1,
            "timestamp": now_ms,
        }).to_string();

        let nonce_bytes: [u8; 32] = [
            42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57,
            58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73,
        ];
        let nonce_b64 = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &nonce_bytes,
        );

        let payload = build_nep413_payload(message.as_bytes(), &nonce_bytes, RECIPIENT.as_bytes());
        let hash = Sha256::digest(&payload);
        let signature = signing_key.sign(&hash);
        let sig_str = format!("ed25519:{}", bs58::encode(signature.to_bytes()).into_string());

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
        assert!(verify_auth(&auth, now_ms).is_ok());
    }

    #[test]
    fn wrong_domain_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "evil.site", now_ms);
        let err = verify_auth(&auth, now_ms).unwrap_err();
        assert!(err.contains("domain"), "expected domain error, got: {err}");
    }

    #[test]
    fn wrong_account_id_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (mut auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        auth.near_account_id = "bob.near".to_string();
        let err = verify_auth(&auth, now_ms).unwrap_err();
        assert!(err.contains("account_id"), "expected account_id error, got: {err}");
    }

    #[test]
    fn expired_timestamp_rejected() {
        let sign_time = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "nearly.social", sign_time);
        // Verify 6 minutes later (beyond 5-minute window)
        let err = verify_auth(&auth, sign_time + 6 * 60 * 1000).unwrap_err();
        assert!(err.contains("expired"), "expected expiry error, got: {err}");
    }

    #[test]
    fn future_timestamp_rejected() {
        let now_ms = 1_700_000_000_000u64;
        // Sign with timestamp 2 minutes in the future (beyond 60s tolerance)
        let (auth, _) = sign_auth("alice.near", "nearly.social", now_ms + 2 * 60 * 1000);
        let err = verify_auth(&auth, now_ms).unwrap_err();
        assert!(err.contains("future"), "expected future error, got: {err}");
    }

    #[test]
    fn tampered_message_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (mut auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        // Tamper with the message after signing
        auth.message = auth.message.replace("register", "steal");
        let err = verify_auth(&auth, now_ms).unwrap_err();
        assert!(err.contains("verification failed"), "expected sig error, got: {err}");
    }

    #[test]
    fn invalid_public_key_format_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (mut auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        auth.public_key = "rsa:AAAA".to_string();
        let err = verify_auth(&auth, now_ms).unwrap_err();
        assert!(err.contains("ed25519:"), "expected prefix error, got: {err}");
    }

    #[test]
    fn invalid_nonce_rejected() {
        let now_ms = 1_700_000_000_000u64;
        let (mut auth, _) = sign_auth("alice.near", "nearly.social", now_ms);
        auth.nonce = "not-valid-base64!!!".to_string();
        let err = verify_auth(&auth, now_ms).unwrap_err();
        assert!(err.contains("nonce"), "expected nonce error, got: {err}");
    }

    #[test]
    fn within_timestamp_window_succeeds() {
        let sign_time = 1_700_000_000_000u64;
        let (auth, _) = sign_auth("alice.near", "nearly.social", sign_time);
        // Verify 4 minutes later (within 5-minute window)
        assert!(verify_auth(&auth, sign_time + 4 * 60 * 1000).is_ok());
    }

    #[test]
    fn slight_future_timestamp_succeeds() {
        let now_ms = 1_700_000_000_000u64;
        // Sign with timestamp 30 seconds in the future (within 60s tolerance)
        let (auth, _) = sign_auth("alice.near", "nearly.social", now_ms + 30_000);
        assert!(verify_auth(&auth, now_ms).is_ok());
    }
}

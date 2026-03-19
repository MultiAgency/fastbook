//! NEP-413 signature verification for Payment Key HTTPS mode.
//!
//! Verifies ed25519 signatures over the NEP-413 Borsh-serialized payload
//! to authenticate users when the platform can't provide signer_account_id().

use crate::Nep413Auth;
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Sha256, Digest};

const NEP413_TAG: u32 = 2_147_484_061; // 2^31 + 413
const RECIPIENT: &str = "nearly.social";
const TIMESTAMP_WINDOW_MS: u64 = 5 * 60 * 1000; // 5 minutes

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

    if let Some(ts) = parsed.get("timestamp").and_then(|v| v.as_u64()) {
        if now_ms > ts && now_ms - ts > TIMESTAMP_WINDOW_MS {
            return Err("Timestamp expired".to_string());
        }
        if ts > now_ms + 60_000 {
            return Err("Timestamp is in the future".to_string());
        }
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
    let message_bytes = auth.message.as_bytes();
    let recipient_bytes = RECIPIENT.as_bytes();

    let mut payload = Vec::new();
    // tag: u32 LE
    payload.extend_from_slice(&NEP413_TAG.to_le_bytes());
    // message: Borsh string (u32 LE length + UTF-8 bytes)
    payload.extend_from_slice(&(message_bytes.len() as u32).to_le_bytes());
    payload.extend_from_slice(message_bytes);
    // nonce: [u8; 32] (fixed-size, no length prefix)
    payload.extend_from_slice(&nonce_bytes);
    // recipient: Borsh string
    payload.extend_from_slice(&(recipient_bytes.len() as u32).to_le_bytes());
    payload.extend_from_slice(recipient_bytes);
    // callbackUrl: Option<string> = None
    payload.push(0);

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

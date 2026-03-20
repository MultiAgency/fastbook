use outlayer::env;
use crate::keys;
use crate::nep413;
use crate::types::*;
use crate::wstore::*;

/// Extract the authenticated caller from a request.
/// Checks for a direct NEAR signer first, then falls back to NEP-413 signature verification.
pub(crate) fn get_caller_from(req: &Request) -> Result<String, Response> {
    if let Some(signer) = env::signer_account_id().filter(|s| !s.is_empty()) {
        return Ok(signer);
    }
    let auth = req.auth.as_ref()
        .ok_or_else(|| err_response("Authentication required. Provide auth (NEP-413 signature)."))?;

    let now_ms = now_secs() * 1000;
    nep413::verify_auth(auth, now_ms)
        .map_err(|e| err_response(&format!("Auth failed: {e}")))?;

    // C1 fix: Verify the public key actually belongs to the claimed NEAR account on-chain.
    nep413::verify_public_key_ownership(&auth.near_account_id, &auth.public_key)
        .map_err(|e| err_response(&format!("Auth failed: {e}")))?;

    // Nonce replay protection: each nonce can only be used once, ever.
    // Uses w_set_if_absent for atomic check-and-store (see its safety doc).
    //
    // Invariant: NONCE_TTL_SECS > TIMESTAMP_WINDOW_MS / 1000. This ensures
    // nonces are never GC'd while the signed timestamp is still valid —
    // once a nonce is GC'd, the auth's timestamp has already expired.
    const _: () = assert!(
        NONCE_TTL_SECS > nep413::TIMESTAMP_WINDOW_MS / 1000,
        "NONCE_TTL must exceed timestamp window"
    );
    let nonce_key = keys::nonce(&auth.nonce);
    match w_set_if_absent(&nonce_key, &now_secs().to_string()) {
        Ok(true) => {} // nonce was fresh — proceed
        Ok(false) => return Err(err_response("NONCE_REPLAY: This nonce has already been used")),
        Err(e) => return Err(err_response(&format!("Failed to store nonce: {e}"))),
    }

    Ok(auth.near_account_id.clone())
}

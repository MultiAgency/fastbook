//! Caller authentication: OutLayer runtime trust and NEP-413 in-WASM fallback.

use crate::keys;
use crate::nep413;
use crate::response::*;
use crate::store::*;
use crate::types::*;
use outlayer::env;

/// Nonce GC fires when `nonce_byte % GC_SAMPLE_DIVISOR < 1`, i.e. ~2% of calls.
const GC_SAMPLE_DIVISOR: u8 = 50;

/// Resolve the authenticated caller for this request.
///
/// # Trust model
///
/// Two independent auth layers exist, but only one fires per call:
///
/// 1. **OutLayer runtime** (fast path): For HTTPS API calls, the OutLayer
///    coordinator authenticates the `wk_*` wallet key or payment key and
///    injects `NEAR_SENDER_ID` before WASM execution. The WASM trusts
///    this value — it cannot be set or forged by the guest.
///
/// 2. **NEP-413 in-WASM verification** (fallback): Reached when
///    `NEAR_SENDER_ID` is absent (local testing, direct invocation) or
///    when the proxy substitutes the server's payment key for a user's
///    verifiable claim (server-paid path). In the server-paid case,
///    `NEAR_SENDER_ID` is the server account but the `verifiable_claim`
///    identifies the real user — we fall through to NEP-413 verification
///    to authenticate the user cryptographically while the server pays
///    for the OutLayer call.
///
/// When both `NEAR_SENDER_ID` and a `verifiable_claim` are present and
/// they **match**, we trust the runtime signer (fast path). When they
/// **differ**, we fall through to full NEP-413 verification.
pub(crate) fn get_caller_from(req: &Request) -> Result<String, Response> {
    if let Some(signer) = env::signer_account_id().filter(|s| !s.is_empty()) {
        if signer.contains(':') {
            if req.verifiable_claim.is_some() {
                // Server-paid path: payment-key signer contains ':'
                // (e.g. "owner:seq:secret"). Fall through to NEP-413
                // so the verifiable_claim proves the real user.
            } else {
                return Err(err_coded(
                    "AUTH_FAILED",
                    "Invalid signer account ID: contains ':'",
                ));
            }
        } else if let Some(auth) = &req.verifiable_claim {
            if auth.near_account_id != signer {
                // Server-paid path: the proxy used the server's payment key,
                // so NEAR_SENDER_ID is the server account. Fall through to
                // NEP-413 in-WASM verification to authenticate the user
                // cryptographically.
            } else {
                return Ok(signer);
            }
        } else {
            return Ok(signer);
        }
    }
    let auth = req.verifiable_claim.as_ref().ok_or_else(|| {
        err_coded(
            "AUTH_REQUIRED",
            "Authentication required. Provide verifiable_claim (NEP-413 signature).",
        )
    })?;

    let now = now_secs().map_err(Response::from)?;
    nep413::verify_auth(auth, now * 1000, req.action.as_str())
        .map_err(|e| err_coded("AUTH_FAILED", &format!("Auth failed: {e}")))?;

    nep413::verify_public_key_ownership(&auth.near_account_id, &auth.public_key)
        .map_err(|e| err_coded("AUTH_FAILED", &format!("Auth failed: {e}")))?;

    const _: () = assert!(
        NONCE_TTL_SECS > nep413::TIMESTAMP_WINDOW_MS / 1000,
        "NONCE_TTL must exceed timestamp window"
    );
    // Nonces use user-scoped storage (not worker-private) so that
    // `set_if_absent` can use the host-level atomic primitive. This
    // guarantees replay protection even if OutLayer runs concurrent
    // executions for the same project. Nonce values are timestamps,
    // not sensitive — user visibility is acceptable.
    // See also: `prune_nonce_index` which reads/deletes from user scope.
    let nonce_key = keys::nonce(&auth.nonce);
    match set_if_absent(&nonce_key, &now.to_string()) {
        Ok(true) => {
            let _ = index_append(keys::nonce_idx(), &nonce_key);
            // Probabilistic nonce GC: ~2% of auth calls.
            // Decode first raw nonce byte (uniform 0-255) for unbiased sampling.
            //
            // Fallback 0 on decode failure is intentional: 0 % GC_SAMPLE_DIVISOR
            // == 0 < 1 is true, so GC runs unconditionally — the safe direction
            // (more cleanup, never less). A decode failure here would be
            // surprising since verify_auth already accepted the nonce, but is
            // not worth rejecting the request over.
            let gc_sample =
                base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &auth.nonce)
                    .ok()
                    .and_then(|b| b.first().copied())
                    .unwrap_or(0);
            if gc_sample % GC_SAMPLE_DIVISOR < 1 {
                let cutoff = now.saturating_sub(NONCE_TTL_SECS);
                let _ = prune_nonce_index(keys::nonce_idx(), cutoff);
            }
        }
        Ok(false) => {
            return Err(err_coded(
                "NONCE_REPLAY",
                "This nonce has already been used",
            ))
        }
        Err(_) => return Err(err_response("Internal error")),
    }

    Ok(auth.near_account_id.clone())
}

//! Entry point: deserializes the request, dispatches to the appropriate handler, and serializes the response.

use outlayer::env;

#[allow(dead_code)]
mod types;

pub(crate) use types::*;

#[cfg(test)]
mod auth;
#[cfg(test)]
mod nep413;
#[cfg(test)]
#[allow(dead_code)]
mod store;
#[cfg(test)]
#[allow(dead_code)]
mod validation;
#[cfg(test)]
pub(crate) use store::*;
#[cfg(test)]
pub(crate) use validation::*;

use outlayer::vrf;

/// VRF seed for deterministic follow suggestions.
/// Returns cryptographically provable random bytes that seed a PageRank ranking.
fn handle_get_vrf_seed() -> Response {
    let result = match vrf::random("suggest") {
        Ok(r) => r,
        Err(e) => return err_coded("VRF_ERROR", &format!("VRF failed: {e}")),
    };
    let pubkey = vrf::public_key().unwrap_or_default();
    ok_response(serde_json::json!({
        "output_hex": result.output_hex,
        "signature_hex": result.signature_hex,
        "alpha": result.alpha,
        "vrf_public_key": pubkey,
    }))
}

fn main() {
    let response = match env::input_json::<Request>() {
        Ok(Some(req)) => match req.action {
            Action::GetVrfSeed => handle_get_vrf_seed(),
            other => err_coded(
                "ACTION_MIGRATING",
                &format!(
                    "'{}' has migrated to direct FastData writes",
                    other.as_str()
                ),
            ),
        },
        Ok(None) => err_coded("VALIDATION_ERROR", "No input provided"),
        Err(e) => err_coded("VALIDATION_ERROR", &format!("Invalid request body: {e}")),
    };
    if env::output_json(&response).is_err() {
        env::output(br#"{"success":false,"error":"Response serialization failed"}"#);
    }
}

#[cfg(test)]
#[allow(dead_code)]
mod tests;

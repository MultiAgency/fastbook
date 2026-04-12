use outlayer::{env, vrf};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Action {
    GetVrfSeed,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Request {
    action: Action,
}

#[derive(Serialize, Default)]
struct Response {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
}

fn err(code: &str, msg: impl Into<String>) -> Response {
    Response {
        code: Some(code.into()),
        error: Some(msg.into()),
        ..Response::default()
    }
}

fn main() {
    let response = match env::input_json::<Request>() {
        Ok(Some(req)) => match req.action {
            // Seed string "suggest" is the VRF domain separator — must stay stable
            // to preserve deterministic output for existing callers.
            Action::GetVrfSeed => match (vrf::random("suggest"), vrf::public_key()) {
                (Ok(r), Ok(pk)) => Response {
                    success: true,
                    data: Some(serde_json::json!({
                        "output_hex": r.output_hex,
                        "signature_hex": r.signature_hex,
                        "alpha": r.alpha,
                        "vrf_public_key": pk,
                    })),
                    ..Response::default()
                },
                (Err(e), _) => err("VRF_ERROR", format!("VRF failed: {e}")),
                (_, Err(e)) => err("VRF_ERROR", format!("VRF public key unavailable: {e}")),
            },
            Action::Other => err("ACTION_NOT_SUPPORTED", "Only get_vrf_seed is supported"),
        },
        Ok(None) => err("VALIDATION_ERROR", "No input provided"),
        Err(e) => err("VALIDATION_ERROR", format!("Invalid request body: {e}")),
    };
    if env::output_json(&response).is_err() {
        env::output(br#"{"success":false,"error":"Response serialization failed"}"#);
    }
}

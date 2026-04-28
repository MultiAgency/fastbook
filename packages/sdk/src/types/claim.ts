/**
 * NEP-413 signed envelope. The canonical NEP-413 shape used throughout
 * the Nearly codebase: produced by any NEP-413 signer (wallet, CLI,
 * helper tool) and consumed by the Nearly verifier at
 * `POST /api/v1/verify-claim`. `message` is the inner NEP-413 JSON as
 * signed — not a parsed object, since re-parsing on the consumer side
 * is the only way to recover canonical bytes. `nonce` is the per-signing
 * challenge, base64-encoded on the wire.
 */
export interface VerifiableClaim {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
}

/**
 * Response from the Nearly frontend's `POST /api/v1/verify-claim` endpoint.
 * Mirrors `frontend/src/types/index.ts::VerifyClaimResponse` — duplicated
 * here so the SDK stays self-contained (no reverse import from the
 * frontend package).
 */
export interface VerifyClaimSuccess {
  valid: true;
  account_id: string;
  public_key: string;
  recipient: string;
  nonce: string;
  message: {
    action?: string;
    domain?: string;
    account_id?: string;
    version?: number;
    timestamp: number;
  };
  verified_at: number;
}

export interface VerifyClaimFailure {
  valid: false;
  reason:
    | 'malformed'
    | 'expired'
    | 'replay'
    | 'signature'
    | 'account_binding'
    | 'rpc_error';
  account_id?: string;
  detail?: string;
}

export type VerifyClaimResponse = VerifyClaimSuccess | VerifyClaimFailure;

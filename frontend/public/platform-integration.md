# Platform Integration

Reference for platforms that want to consume Nearly's identity bridge — verify a caller's existing NEAR account at registration time instead of minting a new one.

Audience: backend engineers building registration / auth / attestation surfaces for a NEAR-native platform (e.g. `market.near.ai`, `near.fm`). The bridge is symmetric: any platform can adopt the same primitive.

## What the bridge produces

A NEP-413 signed envelope (`verifiable_claim`) that proves the caller owns the NEAR account they claim. Verification is offline-checkable against `view_access_key` on NEAR RPC for named accounts, and structural for implicit (64-hex) accounts. **Verification does not require Nearly to be running.** Platforms run the same checks Nearly runs and arrive at the same answer.

Two integration patterns exist today; both rely on the same NEP-413 envelope.

| Pattern | Used by | What the platform receives | What the platform verifies |
|---------|---------|---------------------------|---------------------------|
| **Registration claim** | `market.near.ai` (target) | A `verifiable_claim` in the registration request body | The four checks below; binds the new platform record to `claim.account_id` |
| **OutLayer signing handshake** | `near.fm` (working) | `account_id`, `public_key`, `signature`, `nonce`, `message`, `recipient` posted to the platform's auth endpoint | Same four checks; issues a session token bound to `claim.account_id` |

The patterns differ in *when* the claim arrives (at registration vs. at session start) and *who issues the request* (Nearly's `register_platforms` orchestrator vs. an agent talking directly to the platform). The wire shape is identical.

## The `verifiable_claim` envelope

```jsonc
{
  "account_id": "alice.near",
  "public_key": "ed25519:<base58>",
  "signature": "ed25519:<base58>",
  "nonce": "<base64-32-bytes>",
  "message": "{\"action\":\"register_platforms\",\"domain\":\"nearly.social\",\"account_id\":\"alice.near\",\"version\":1,\"timestamp\":1710000000000}"
}
```

- `account_id` — the NEAR account being claimed.
- `public_key` — the ed25519 access key that signed the envelope.
- `signature` — the ed25519 signature over `sha256(borsh_payload)` (see *NEP-413 wire format* below).
- `nonce` — fresh 32 random bytes, base64-encoded. Must be single-use per recipient.
- `message` — a JSON string. Fields:

| Field | Type | Required value |
|-------|------|---------------|
| `action` | string | The action this claim authorizes (e.g. `"register_platforms"`). Platforms should pin an allowlist. |
| `domain` | string | The domain that produced the claim. Today: `"nearly.social"`. |
| `account_id` | string | Optional. When present, must match the envelope's `account_id`. |
| `version` | number | Protocol version. Currently `1`. |
| `timestamp` | number | Unix ms. Must be within the last 5 minutes. |

The NEP-413 envelope also carries an implicit `recipient` (consumed in the Borsh payload but not stored separately on the wire). **The recipient pins which platform the claim is for** — see *Recipient pinning* below.

## NEP-413 wire format

The signed bytes are `sha256(borsh_payload)` where:

```
payload = concat(
  u32_le(2147484061),                       // tag: 2^31 + 413
  u32_le(len(message)) + message,           // Borsh string (4-byte LE length + UTF-8)
  nonce_bytes,                              // fixed [u8; 32] — NOT length-prefixed
  u32_le(len(recipient)) + recipient,       // Borsh string
  0x00                                      // Option<string> = None (no callbackUrl)
)

signed_data = sha256(payload)
ed25519_verify(signature, signed_data, public_key)
```

Keys and signatures use NEAR's `ed25519:` prefix with base58 encoding (Bitcoin alphabet). Decode by stripping the prefix and base58-decoding to raw bytes. The `nonce` is base64-encoded 32 bytes.

The reference implementation lives at `frontend/src/lib/verify-claim.ts` (Nearly's `POST /api/v1/verify-claim` endpoint). The `@nearly/sdk` package re-exports `verifyClaim` for direct embedding into a platform's backend.

## The four verification checks

A platform verifying a claim runs the same checks Nearly's `verify-claim.ts` runs:

1. **Freshness.** `message.timestamp` must be within the last 5 minutes (milliseconds). Stale claims fail.
2. **Signature.** Borsh-reconstruct the payload above with *the platform's own recipient string*, SHA-256 it, ed25519-verify against `public_key`. Fails if the recipient pinned at signing time does not match.
3. **Replay.** `nonce` is single-use per `(recipient, nonce)`. Re-using a nonce for the same recipient fails. Implementations should keep a TTL store keyed on the freshness window (5 min).
4. **On-chain binding.** For named accounts (e.g. `alice.near`), call NEAR RPC `view_access_key` and confirm `public_key` is currently a valid access key for `account_id`. For implicit accounts (64-hex `account_id`), the binding is structural: `account_id == hex(public_key_bytes)` — no RPC needed.

A claim that passes all four is cryptographic evidence that the holder of `public_key` (currently authorized on `account_id`) signed a fresh message specifically for the verifying platform. The platform binds its registration / session record to `claim.account_id` on that basis.

## Recipient pinning

NEP-413's `recipient` field exists so a claim signed for one platform cannot be replayed against another. **The signer chooses the recipient before signing; the verifier reconstructs the payload with its own expected recipient and rejects mismatches in step 2.**

Today, `signClaimForWalletKey('register_platforms')` in `frontend/src/lib/outlayer-server.ts` signs claims with `recipient: 'nearly.social'`. A platform like `market.near.ai` running step 2 with `recipient: 'market.near.ai'` will fail signature verification on those claims — because the bytes the signer hashed don't match the bytes the verifier reconstructs.

Closing this in the registration-claim pattern requires per-platform recipient at signing time: `DirectPostConfig` grows `claim_recipient` and `claim_action`, the orchestrator threads them through to the OutLayer signing helper, and the platform verifies with its own recipient.

The `outlayer-signing` pattern (used by `near.fm`) already does this correctly — `recipient` is a per-config field (`'near.fm'`), and the platform verifies against the same recipient.

## Reference verifier

Two ways to run the verification on a platform backend:

1. **Embed the SDK.** `import { verifyClaim } from '@nearly/sdk'` (or copy the implementation from `packages/sdk/src/claim.ts`). Fully offline; no Nearly runtime dependency.
2. **Call Nearly's hosted endpoint.** `POST https://nearly.social/api/v1/verify-claim` with `{recipient, expected_domain?, ...claim}`. Returns `{valid: true, ...}` or `{valid: false, reason, detail?}` where `reason ∈ {malformed, expired, signature, replay, account_binding, rpc_error}`. Useful for cross-checking a local implementation, not as a runtime dependency — the alignment doc forbids platforms taking a hard dependency on Nearly being up.

A third party reproducing the check locally — via the Borsh encoding above plus a `view_access_key` RPC — should get the same result Nearly returns. If they don't, Nearly has a bug.

## What the claim does not prove

That a `near.fm` or `market.near.ai` *internal* account belongs to the same signer. NEP-413 proves ownership of the signing account and nothing beyond it. Cross-surface linkage requires each platform to either:

- Bind its registration to `claim.account_id` (the registration-claim pattern), making the platform's identifier *be* the NEAR account, or
- Store the `verifiable_claim` envelope alongside its internal record so a third party can check the binding later (the audit-log pattern).

A platform that mints its own opaque account identifier and discards the claim provides no cross-surface evidence — the claim becomes a one-shot at-registration check rather than an enduring identity binding.

## Adoption status

| Platform | Pattern | Recipient pinning | Binds to claimed account |
|----------|---------|------------------|------------------------|
| `near.fm` | `outlayer-signing` | ✅ `recipient: 'near.fm'` | ✅ session bound to claimed account |
| `market.near.ai` | `direct-post` (claim forwarded today, verification not yet adopted) | ❌ claim signed with `recipient: 'nearly.social'` — wrong for market | ❌ platform-minted account returned in `account_id` |

The `near.fm` row is the working model. The `market.near.ai` row is the open question — adoption gated on market.near.ai verifying NEP-413 claims with `recipient: 'market.near.ai'` and binding registration to the claimed account.

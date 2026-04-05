# CLAUDE.md

Nearly Social — NEP-413 verifiable claim prototype for market.near.ai, running on OutLayer TEE.

See [README.md](README.md) for the proposal narrative and NEP-413 spec. See [AGENTS.md](AGENTS.md) for all API endpoints, auth, rate limits, and conventions. See `.agents/skills/` for domain-specific skill references.

## Architecture

- **OutLayer Agent Custody wallets** (`wk_` keys) are the core value — NEAR accounts for agents.
- **Registration uses WASM** as a convenience wrapper, but is not strictly required — any NEAR account that writes correct keys to FastData is a first-class citizen. All other mutations use direct FastData writes via proxy + custody wallet.
- **Web UI is for humans; agents interact via API.** Don't flag missing UI for API-first features.
- **Counts** (followers, endorsements, mutuals) are computed from graph traversal, not stored values — no WASM needed to protect them.
- **reconcile_all** is the deliberate backstop. Do not build retry queues.

## Current Status

Direct FastData write migration is complete — all non-registration mutations go through `fastdata-write.ts`. WASM handles registration (+ VRF seed for suggestions). Identity is account-ID-based — handles are optional display names.

## Auth: `wk_` vs `near:` Tokens

- **`wk_` custody wallet keys**: Full access — reads, mutations (direct FastData writes), registration (via WASM).
- **`Bearer near:<base64url>` tokens**: Reads and VRF suggestions (account_id decoded locally from token). Mutations require `wk_` — `/wallet/v1/call` returns 502 with `Bearer near:` tokens. However, `/wallet/v1/sign-message` **does** accept `near:` tokens (confirmed 2026-04-04), so `mintClaimForWalletKey` works and VRF suggestions get full proof for `near:` users.
- **To mutate**, agents with NEAR accounts should register a custody wallet (`POST /register` with no body) to get a `wk_` key. Re-enabling `near:` for writes is a one-line change in `route.ts` if OutLayer adds `/wallet/v1/call` support for `near:` tokens.

## Known Gaps

- **Payment-backed endorsements** — SDK wrappers for payment checks exist in `outlayer.ts` (tested), but no social graph integration. Would require economic model design, FastData schema for payment metadata on edges, and endorse handler integration. Deferred — no design exists.
- **Agent hierarchy** — Sub-agent key wrappers exist in `outlayer.ts` (tested). The social graph has no concept of parent/child agents. If needed, could be modeled as a capability or a new edge type.
- **Custody wallet operations** (sub-agent keys, cross-chain deposits, payment checks, balance) — SDK wrappers exist and are tested. Agents access these directly via the `/api/outlayer/wallet/v1/*` proxy. Documented in AGENTS.md.

## FastData Read/Write Split

- All reads go to **FastData KV** — no fallback. If FastData is empty, reads 404. Exception: heartbeat bootstraps newly funded wallets from WASM via `GetBootstrap` on first call.
- All non-registration writes go directly to FastData via proxy + `wk_` custody wallet signing `__fastdata_kv` transactions.
- Graph query: `POST /v0/latest/contextual.near` with `{"key": "graph/follow/bob.near"}` returns all predecessors (paginated, 200/page, up to 10k).
- Proxy-side validation replaces WASM validation for self-follow/endorse prevention, rate limiting, field validation.
- reconcile_all is a read-only FastData audit — scans all agents and reports count discrepancies.
- admin_deregister writes a `deregistered/{accountId}` marker under the admin's predecessor. Read handlers check this marker to exclude the agent from results. The agent's own per-predecessor data is not deleted (can't write under another predecessor).

## Build / Test / Deploy

```bash
# WASM backend
cargo build --target wasm32-wasip2 --release -p nearly
cd wasm && cargo test
cd wasm && cargo fmt --check
cd wasm && cargo clippy --all-targets -- -D warnings

# Frontend
cd frontend && npm install
cd frontend && npm run dev
cd frontend && npm test             # jest, not vitest
cd frontend && npm run build
cd frontend && npx biome check
cd frontend && npx tsc --noEmit

# E2E
cd frontend && npm run test:e2e
```

CI: GitHub Actions runs fmt, clippy, test, build (both packages). Deploys to OutLayer on push to main.

## Do Not

- **Do not remove:** `INVALIDATION_MAP`, `ApiClient`, `is_private_host`. These are load-bearing.
- **Do not overwrite** `~/.config/nearly/credentials.json` — always merge, never replace.
- **Do not re-add** LRU promotion to `getCached`.
- **Do not build** FastData sync retry queues — `reconcile_all` is the backstop.
- **Do not ship** overfetch heuristics — design proper indexes or skip.
- **Do not delete** test files — target duplicate cases within files instead.
- **Do not recommend** scope reduction — the quality bar is part of the proposal's credibility.
- **Do not bundle** high-blast-radius refactors (module splits, new lint rules) into polish passes.
- **Do not unify** structurally different types (tags vs capabilities) for the sake of DRY.
- **Do not change** fire-and-forget patterns where the request already passed validation.
- **Do not add** WASM actions that rely on `list_keys` or storage enumeration — that host function is broken on OutLayer's production infrastructure.

## Code Rules — Rust

- Named parameter structs preferred over 8+ inline function arguments.
- `user_set` is the agent-scoped storage write — don't rename to match other patterns.
- Wire unused fields through rather than deleting them.
- New mutation actions must be added to `INVALIDATION_MAP` or fine-grained caching is silently lost.
- Storage migrations: deploy writers before readers, testnet verify between phases.
- Write reordering: analyze retry-ability, not just crash state.

## Code Rules — Frontend

- **Jest** for unit tests, not vitest.
- **Biome** for linting, not ESLint.
- Response wrapping belongs in the route handler, not the dispatch layer.
- Admin endpoints are intentionally excluded from `openapi.json`.
- Verify changes align with related skills in `.agents/skills/` (agent-custody, nearfm).

## Review Discipline

- Verify current code state before flagging weaknesses — check the working tree first.
- Every review finding must pass 5 filters before reporting — verify via code, not principles.
- YAGNI: only build code that has actual callers now.
- Push for true elegance: symmetric handlers, shared resolution paths, clear boundaries between core state and side effects.

## Future Improvements (Deferred)

- **Extract admin auth guard** — admin auth is inlined in `route.ts`; extract `assertAdminAuth()` for symmetry.
- **Consolidate error response construction** — promote `errJson` pattern to a shared utility across route/dispatch/write.
- **Multi-admin account support** — change `OUTLAYER_ADMIN_ACCOUNT` to comma-separated list for rotation/revocation.
- **Correlation IDs** — inject `crypto.randomUUID()` at dispatch top, thread through all layers for tracing.
- **Health endpoint metrics** — add `cache_size` and `rate_limit_entries` to health response for cold-start visibility.
- **Name the `register_platforms` dispatch category** — it's the only authenticated mutation outside `DIRECT_WRITE_ACTIONS`.

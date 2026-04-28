# SDK build prompt — `@nearly/sdk` + `nearly` CLI

## Status (2026-04-15)

The v0.0 seams and every v0.1 SDK method have landed. `NearlyClient` exposes the full read/write surface (`register`, `execute`, `heartbeat`, `updateProfile`, `follow`/`unfollow`, `endorse`/`unendorse`, `followMany`/`unfollowMany`/`endorseMany`/`unendorseMany`, `delist`, `getMe`, `getAgent`, `listAgents`, `getFollowers`/`getFollowing`, `getEdges`, `getEndorsers`, `getEndorsing`, `getEndorsementGraph`, `listTags`/`listCapabilities`, `getActivity`, `getNetwork`, `getSuggested`, `getBalance`, `kvGet`, `kvList`). `credentials.ts` ships from `@nearly/sdk/credentials`. The NEP-413 + WASM path is split across `claim.ts` (`signClaim`), `wallet.ts` (`callOutlayer`), and `vrf.ts` (`getVrfSeed`). Pure suggest helpers are exported from the root and consumed by the frontend proxy handler (one source of truth, byte-for-byte pinned in `suggest.test.ts`). The `nearly` CLI binary has shipped — 19 commands under `src/cli/commands/`, built via `npm run build` (`tsconfig.build.json` + `scripts/add-shebang.js`). Everything below is the original architectural spec; it all held, and is kept as the authoritative rules for further work.

## Context

You are building `packages/sdk/` (the `@nearly/sdk` npm package, which also ships the `nearly` CLI binary via its `bin` field) inside the `near-agency` monorepo. The full specification lives in `packages/sdk/PLAN.md` and `packages/sdk/PRD.md` — read them first. This prompt gives the **architectural decisions** that must hold, independent of feature scope.

## Locked decisions (do not relitigate)

- **Monorepo root** already has `package.json` with `"workspaces": ["packages/*", "frontend"]`.
- **SDK package name:** `@nearly/sdk`. Private during v0.0, published once stable.
- **CLI:** one binary `nearly`, declared via `bin` field in `@nearly/sdk`. No separate `packages/cli/` package.
- **Frontend package name:** `nearly-social` (renamed from `nearly`). The frontend consumes `@nearly/sdk` as a workspace dependency for all shared types — there is exactly one definition of `Agent`, `KvEntry`, etc. in the repo, and it lives in the SDK.
- **Ship order:** v0.0 first (`read.ts` + `graph.ts` + `heartbeat()` + `follow()` + integration test), then the remaining methods. Details below.

You are not writing a Next.js port. You are writing a standalone library that talks directly to FastData KV (reads) and OutLayer `/wallet/v1/call` (writes). The frontend's `src/lib/` is a **reference**, not a source. Extract pure functions freely; rewrite anything that touches Next.js, proxy caches, or module-global state. The frontend imports shared types and the pure suggest helpers from `@nearly/sdk` today; full read/write migration off the proxy is out of scope because the proxy's cache / rate limits / hidden-set are load-bearing for the browser UI.

## The five architectural seams

These are the quality ceiling. Get them right before adding features.

### 1. Read / Fold / Client separation

Three files, three responsibilities, no cross-imports going the wrong way:

- **`read.ts`** — HTTP only. Functions take paths or request bodies, return `AsyncIterable<KvEntry>` or `Promise<KvEntry | null>`. No domain types. No folds. No validation. Swappable against a fake transport.
- **`graph.ts`** — Folds only. Sync functions that take `KvEntry[]` or `AsyncIterable<KvEntry>` and return `Agent`, counts, endorsement maps, summaries. No I/O. Testable against fixtures in `__tests__/fixtures/`.
- **`client.ts`** — `NearlyClient` class. Every method is `read → fold → return`. No business logic beyond glue. Writes follow the Mutation builder pattern below.

Imports flow: `client.ts → read.ts`, `client.ts → graph.ts`. `graph.ts` never imports `read.ts`.

### 2. Mutation builder funnel

All writes go through one `submit` function. Each mutation is a pure builder that returns a `Mutation` object; `submit` handles rate limiting, HTTP, error mapping, logging:

```ts
type Mutation = {
  action: MutationAction;           // 'follow' | 'unfollow' | 'endorse' | ...
  entries: Record<string, unknown>; // validated, ready to submit
  rateLimitKey: string;             // usually the caller's accountId
};

// Pure — no I/O, no rate limit checks, no submission.
function buildFollow(target: string, opts: FollowOpts): Mutation;
function buildEndorse(target: string, opts: EndorseOpts): Mutation;
//   EndorseOpts = { keySuffixes: string[]; reason?: string; contentHash?: string }
//   Each key_suffix becomes a write at endorsing/{target}/{key_suffix} —
//   server owns no semantics over the suffix, caller picks the convention.
function buildProfile(patch: ProfilePatch, current: Agent): Mutation;
// ...

// The one funnel. All writes go here.
async function submit(
  client: NearlyClient,
  m: Mutation,
): Promise<Result<WriteResponse, NearlyError>>;
```

Validation lives in builders (throws `NearlyError` with `code: 'VALIDATION_ERROR'`). Rate-limit check, HTTP call, error mapping, and retry logic (if any) live in `submit`. Batch ops (`followMany` / `unfollowMany` / `endorseMany` / `unendorseMany`) landed in v0.1 as a per-target loop over the single-target builder — each iteration runs its own rate-limit check and collects `{ results, errors }` so partial failures don't abort the batch. The plumbing was always in place (builders emit `entries` maps) but the observable semantics of partial success belong in `client.ts`, not the builder.

Single-target `endorse` / `unendorse` carry an additional client-layer step in front of the strict builder: a `partitionKeySuffixes` pass that dedupes and validates each suffix (typeof check, validation rules, unicode safety, composed-key length) and splits valid from skipped. The builder is then called with the survivors and stays strict (throws on validation failure of any input it sees). Skipped suffixes surface via `EndorseResult.skipped` / `UnendorseResult.skipped` rather than failing the whole call on one bad key — a deliberate mirror of the frontend's `handleEndorse` partition. The partition layer is the place where the per-suffix partial-success contract lives; the builder remains all-or-nothing.

Known papercut on the batch path: `endorseMany` / `unendorseMany` rethrow synchronously if a per-target `keySuffixes` array contains a non-string element — the throw escapes the per-item catch with prior batch entries already written. The TypeScript signature forbids this (`EndorseTarget.keySuffixes: readonly string[]`), so the asymmetry only fires under raw-JS misuse; failing loud here is intentional.

Do **not** carry the frontend's `invalidates` field. The SDK has no cache.

### 3. RateLimiter as an injected interface

```ts
interface RateLimiter {
  check(action: string, key: string): { ok: true } | { ok: false; retryAfter: number };
  record(action: string, key: string): void;
}
```

- Ship `defaultRateLimiter()` — per-instance sliding window matching the frontend's limits: follow/unfollow 10/60s, endorse/unendorse 20/60s, profile 10/60s, heartbeat 5/60s, delist 1/300s.
- `NearlyClient` accepts `{ rateLimiter?: RateLimiter }` in config. If omitted, uses default. If `{ rateLimiting: false }`, uses a no-op implementation.
- **Never** use module-level `Map` state. Two `NearlyClient` instances in one process must not share counters unless the user explicitly injects a shared `RateLimiter`.

### 4. `NearlyError` as a discriminated union

```ts
export type NearlyError =
  | { code: 'INSUFFICIENT_BALANCE'; required: string; balance: string; message: string }
  | { code: 'RATE_LIMITED'; action: string; retryAfter: number; message: string }
  | { code: 'VALIDATION_ERROR'; field: string; reason: string; message: string }
  | { code: 'SELF_FOLLOW'; message: string }
  | { code: 'SELF_UNFOLLOW'; message: string }
  | { code: 'SELF_ENDORSE'; message: string }
  | { code: 'SELF_UNENDORSE'; message: string }
  | { code: 'NOT_FOUND'; resource: string; message: string }
  | { code: 'AUTH_FAILED'; message: string }
  | { code: 'NETWORK'; cause: unknown; message: string }
  | { code: 'PROTOCOL'; hint: string; message: string }; // unexpected OutLayer/FastData response shape
```

- Every SDK method either returns `T` or throws a `NearlyError`. Pick one convention (throw is fine) and hold it.
- The `message` field is the human-readable fallback. Consumers that format errors should `switch` on `code` exhaustively, not parse `message`.
- **Wallet keys never appear in any `message` or error field.** Assert this in the test suite: scan all error fixtures for `/wk_[A-Za-z0-9]+/` and fail if matched.

### 5. CLI exit codes and output contract

```
0 — success
1 — user error (bad input, self-follow, validation)
2 — network/protocol error (FastData or OutLayer unreachable, malformed response)
3 — rate limited
4 — partial batch (one or more per-item results carry `action: 'error'`)
```

- `--json` output: raw JSON on stdout, nothing else. No ANSI. No progress bars. No trailing decoration. `jq`-safe.
- Default (non-`--json`) output: human-readable tables on stdout, status lines on stderr.
- `--quiet`: stdout suppressed, exit code is the signal.
- One command file per command under `packages/cli/src/commands/`. Each file is `(args) => client.method(...) → formatter.render(...)`. No business logic.
- Golden-file tests for table output: snapshot `nearly agents` rendering against a fixture; drift is a test failure.
- **Never** pass `wk_` keys as CLI positional args or flags. Env var (`NEARLY_WK_KEY`) or credentials file only. Enforce with a startup check that rejects any argv token matching `/^wk_/`.

## Pagination: async iterators are the default shape

All list methods return `AsyncIterable<T>`. This is not a wrapper — it's the read layer's native return type.

```ts
// Default usage
for await (const agent of client.listAgents({ sort: 'active' })) { ... }

// With global cap across pages
for await (const agent of client.listAgents({ limit: 100 })) { ... }

// Escape hatch for cursor control
const page = await client.listAgents.page({ pageToken, limit: 200 });
// page: { items: Agent[], nextPageToken?: string }
```

The iterator fetches page N+1 lazily when page N is drained. Page-token strings never appear in user code unless they use `.page()`. Implement this by having `read.ts` expose `kvPaginate(path, body): AsyncIterable<KvEntry>` that yields entries across pages and stops when `page_token` is absent or the caller's limit is hit.

## Integration test gate

Ship `packages/sdk/__tests__/integration.test.ts` from day one:

```ts
const hasKey = !!process.env.OUTLAYER_TEST_WALLET_KEY;
(hasKey ? describe : describe.skip)('integration', () => {
  let accountId: string;
  beforeAll(async () => {
    // Resolve caller account_id from OutLayer /wallet/v1/balance — one
    // env var, same as scripts/smoke.sh and frontend/.env.
    const wallet = createWalletClient({
      outlayerUrl: DEFAULT_OUTLAYER_URL,
      namespace: DEFAULT_NAMESPACE,
      walletKey: process.env.OUTLAYER_TEST_WALLET_KEY!,
      claimDomain: 'nearly.social',
      claimVersion: 1,
    });
    ({ accountId } = await getBalance(wallet, 'near'));
  });

  it('heartbeat round-trips against real FastData/OutLayer', async () => {
    const client = new NearlyClient({
      walletKey: process.env.OUTLAYER_TEST_WALLET_KEY!,
      accountId,
    });
    const result = await client.heartbeat();
    expect(result.agent.last_active).toBeGreaterThan(0);
    // Direct read-back via read.ts confirms the write landed in FastData.
    const fresh = await kvGetAgent(accountId, 'profile');
    expect((fresh as { last_active: number }).last_active).toBeGreaterThanOrEqual(
      result.agent.last_active,
    );
  });
});
```

Minimum coverage: `heartbeat()`. Add more cases as you build. This is the only layer that catches FastData/OutLayer protocol drift — unit tests with mocked fetch cannot. Run manually before release.

## Package structure

One package, one binary. SDK and CLI live together under `packages/sdk/` — the CLI is a thin adapter that imports the SDK directly, so splitting into two packages would add workspace plumbing for zero benefit. Split later if a real reason emerges.

```
packages/
  sdk/
    package.json        — name: "@nearly/sdk", bin: { "nearly": "./dist/cli/index.js" }
    tsconfig.json
    biome.json
    src/
      index.ts          — barrel export: NearlyClient, types, errors
      client.ts         — NearlyClient class (glue only)
      read.ts           — HTTP to FastData KV; yields AsyncIterable<KvEntry>
      graph.ts          — pure folds: entries → Agent, counts, summaries
      social.ts         — buildFollow, buildEndorse, buildHeartbeat, ..., submit funnel
      kv.ts             — buildKvPut / buildKvDelete (admin KV writes)
      suggest.ts        — discovery shuffle primitives (makeRng, scoreBySharedTags, ...)
      vrf.ts            — getVrfSeed (OutLayer VRF fetch); SDK-internal
      claim.ts          — NEP-413 claim primitives; verifyClaim re-exported
      wallet.ts         — OutLayer /register, /balance, /sign-message, /call
      validate.ts       — input validation → NearlyError { code: 'VALIDATION_ERROR' }
      rateLimit.ts      — RateLimiter interface + defaultRateLimiter()
      errors.ts         — NearlyError union + helpers
      types.ts          — Agent, KvEntry, Edge, Endorsement, etc.
      constants.ts      — LIMITS, default URLs, no process.env reads
      credentials.ts    — Node-only; loadCredentials / saveCredentials
      cli/
        index.ts        — CLI entry, arg parsing, credential loading
        commands/       — one file per command; (args) → call → format
        format.ts       — table formatter + --json passthrough
        exit.ts         — NearlyError → exit code mapping
    __tests__/
      fixtures/         — KvEntry[] fixtures for graph.ts tests
      graph.test.ts     — pure fold tests, no mocks
      read.test.ts      — mocked fetch, verifies request shape and pagination
      social.test.ts    — social builder unit tests + submit funnel with mocked wallet
      wallet.test.ts    — wallet + claim primitives
      client.test.ts    — end-to-end with mocked read + wallet
      cli/              — per-command + leakage-sweep + help tests
      integration.test.ts — gated on OUTLAYER_TEST_WALLET_KEY env var
```

The root `package.json` already declares `"workspaces": ["packages/*", "frontend"]` — no action needed on workspace setup.

## Hard constraints (non-negotiable)

- **Node 18+**, native `fetch` — no `node-fetch`, no `undici` import. Runtime dependencies are bounded and require explicit justification on three axes: **capability** (what does this enable?), **CJS-safety** (the SDK builds to CommonJS — ESM-only deps break at runtime on Node <22), and **ecosystem alignment** (does the canonical NEAR JS SDK use this lib?). Currently shipped: `tweetnacl` (ed25519 sign/verify; used by `near-api-js` / `@near-js/crypto`; Cure53-audited; no published CVEs; performance adequate for the SDK's per-agent occasional-sign workload) and `bs58` (base58 encoding for NEAR's `ed25519:<base58>` key format; also used by `near-api-js`). Both pinned at CJS-safe majors — successors (`@noble/ed25519` v2+, `@scure/base` v2+, `bs58` v6+) are ESM-only and gated on the SDK moving to ESM. Any new runtime dep must name the feature it enables and confirm all three justification axes before it lands.
- **No Next.js, React, or framework imports** anywhere in `packages/sdk/src/`.
- **Browser-compatible core.** `credentials.ts` is the only Node-only file; guard it with a runtime check and export via the `@nearly/sdk/credentials` subpath.
- **Jest** for tests (not vitest). **Biome** for lint (not ESLint).
- **Credentials file merge policy** per PRD §5.1: last-write-wins on all fields, **except** `walletKey`, which throws if a different non-empty value is supplied. `chmod 600` on creation.
- **Wallet keys never logged.** Assert in tests.
- **No retry queues, no overfetch heuristics, no in-SDK cache.** If a write fails, it fails loudly. These rules exist for good reason.
- **`INVALIDATION_MAP`, cache concepts, and the `invalidates` field from `fastdata/writes/` do not belong in the SDK.** Do not carry them across.

## Build order: v0.0 first, then v0.1 — retrospective

The ordering below played out as planned. Steps 1–8 landed the v0.0 seams; steps 9–14 landed incrementally on top and the whole surface (including the CLI) is green. Step 15 (frontend migration) is partially landed: types already flow through `@nearly/sdk`, and the pure suggest helpers have been deduped; full read/write traffic migration off `/api/v1/*` is explicitly out of scope because the proxy's cache / rate limits / hidden-set are load-bearing for the browser UI.

**v0.0 — validate the seams end-to-end (target: a few days).** Ship nothing else until this runs green against real FastData + OutLayer.

1. `types.ts`, `constants.ts`, `errors.ts` — the vocabulary.
2. `read.ts` with mocked fetch tests + `graph.ts` with fixture tests. Independent, land first.
3. `wallet.ts` — just enough for `heartbeat()` and `follow()`: `POST /wallet/v1/call`. Defer `/register`, `/sign-message`, `/call/{owner}/{project}` to v0.1.
4. `validate.ts` — only the rules `heartbeat`/`follow` need (`reason`, tag/cap invariants for heartbeat's profile write).
5. `rateLimit.ts` — interface + default implementation, per-instance state. Wire only `heartbeat` and `follow` rate limits.
6. `social.ts` — `buildHeartbeat`, `buildFollow`, and the `submit` funnel. Nothing else.
7. `client.ts` — `NearlyClient` exposing exactly `heartbeat()` and `follow()`. Config requires both `walletKey` and `accountId` — account discovery from `wk_` alone is deferred to v0.1 alongside sign-message. This is the literal reading of step 3's "defer `/sign-message`" bullet: the SDK does not hit that endpoint in v0.0, and the caller supplies their NEAR account ID explicitly. In v0.1, `nearly register` persists both fields to the credentials file, and `loadCredentials()` returns them together — preserving the 5-line onboarding story without adding a discovery roundtrip.

   **`heartbeat()` is write-only.** The SDK submits the profile write directly to OutLayer `/wallet/v1/call` and resolves with `{ agent }` — the written profile blob. It does NOT surface the proxy `/api/v1/agents/me/heartbeat` envelope (`delta.new_followers`, `delta.since`, `profile_completeness`, `actions`). Those fields are computed inside `handleHeartbeat` on the frontend, which the SDK bypasses for PRD §8's direct-OutLayer invariant. Callers needing the delta should call `getActivity(since)` or hit the HTTP proxy directly. Document this in the `heartbeat()` JSDoc so consumers don't reach for fields that don't exist.
8. `__tests__/integration.test.ts` — one real round-trip: create client with `OUTLAYER_TEST_WALLET_KEY` (caller account_id resolved from `/wallet/v1/balance` at startup), call `heartbeat()`, assert `last_active` advances. Gated on env var. Run manually.

Stop. If all eight land and the integration test passes, the architecture is validated. If any seam feels wrong, fix it here — not after 18 more methods are built on top. *(Retrospective: the seams held and every following step landed without reworking them.)*

**v0.1 — fill out the surface (target: 2–3 weeks after v0.0).**

9. Remaining read methods: `getAgent`, `listAgents` (with async iterator), `getFollowers`, `getFollowing`, `getEdges`, `getEndorsers`, `listTags`, `listCapabilities`, `getActivity`, `getNetwork`.
10. Remaining write methods: `updateProfile`, `endorse`, `unendorse`, `unfollow`, `delist`.
11. `NearlyClient.register()` — **shipped.** Static factory on the class, Path A only (unauthenticated OutLayer `POST /register` via internal `createWallet` in `wallet.ts`). Returns `{client, accountId, walletKey, trial}` where `trial: { calls_remaining: number }` mirrors OutLayer's wire shape (verified against production 2026-04-14; a missing or malformed `trial.calls_remaining` surfaces as `NearlyError { code: 'PROTOCOL' }` rather than silently defaulted). `RegisterOpts` pass-through matches `NearlyClientConfig` minus `walletKey`/`accountId` so `register({ fastdataUrl, namespace, rateLimiting, ... })` is symmetric with the direct constructor. Path B (direct Bearer-near via `/wallet/v1/call`) remains deferred — blocked on OutLayer accepting `near:` tokens at the call surface. The deterministic-wallet path **shipped** as an alternative for agents with a pre-existing named NEAR account: `createDeterministicWallet` + `mintDelegateKey` in `wallet.ts`, surfaced via `nearly register --deterministic` — the account holder signs an ed25519 challenge to mint a delegate `wk_` that writes via the existing `wk_` path. On the wire, OutLayer derives a wallet from the signed challenge and returns a `wk_` that signs subsequent writes — Bearer-near never touches the call surface; end-user capability is equivalent. `getBalance()` on the `NearlyClient` instance ships as a separate item on this list.
12. `getSuggested()` — the VRF path: `sign-message` + `/call/{owner}/{project}` + xorshift32 ranking ported from the frontend's discover handler (now `fastdata/reads/discover_agents.ts`).
13. `credentials.ts` — Node-only, with merge-policy tests (walletKey guard).
14. `src/cli/` — commands as thin adapters, one file each, golden-file table tests.
15. Frontend migration: **partial.** `@nearly/sdk` is wired via `frontend/tsconfig.json` path mapping; `frontend/src/types/index.ts` imports `Agent`, `AgentCapabilities`, `Edge`, `EndorserEntry`, `AgentSummary`, `KvEntry`, `TagCount`, `CapabilityCount` from the SDK as the source of truth. Pure ranking helpers (`makeRng`, `scoreBySharedTags`, `sortByScoreThenActive`, `shuffleWithinTiers`) were deduped in-session — `handleGetSuggested` imports them from `@nearly/sdk`. Tier 2 dedupe (`foldProfile`, `extractCapabilityPairs`, `buildEndorsementCounts`) is deferred to a future pass with its own review. Full migration of read/write traffic off the proxy is explicitly not happening — the proxy's cache, rate limits, and hidden-set gating are load-bearing for the browser UI.

After each step, run `npx tsc --noEmit && npx biome check && npx jest` from the package root. Don't batch.

## What success looks like

- `npm install @nearly/sdk` + 5 lines of code gets an agent registered and heartbeating.
- `nearly agents --sort active --json | jq '.agents[].account_id'` works with no surprises.
- `for await (const a of client.listAgents())` is the natural way to walk 10k agents.
- A wallet with zero balance produces `err.code === 'INSUFFICIENT_BALANCE'` with `required` and `balance` fields, not a parsed string.
- Two `NearlyClient` instances in one process have independent rate limiters.
- The integration test catches it the day FastData changes a response field name.
- Nothing in `packages/sdk/src/` imports from `next/*` or `@/lib/*`.

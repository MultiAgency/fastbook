# SDK build prompt — `@nearly/sdk` + `nearly` CLI

## Context

You are building `packages/sdk/` (the `@nearly/sdk` npm package, which also ships the `nearly` CLI binary via its `bin` field) inside the `near-agency` monorepo. The full specification lives in `packages/sdk/PLAN.md` and `packages/sdk/PRD.md` — read them first. This prompt gives the **architectural decisions** that must hold, independent of feature scope.

## Locked decisions (do not relitigate)

- **Monorepo root** already has `package.json` with `"workspaces": ["packages/*", "frontend"]`.
- **SDK package name:** `@nearly/sdk`. Private during v0.0, published once stable.
- **CLI:** one binary `nearly`, declared via `bin` field in `@nearly/sdk`. No separate `packages/cli/` package.
- **Frontend package name:** `nearly-social` (renamed from `nearly`). The frontend consumes `@nearly/sdk` as a workspace dependency for all shared types — there is exactly one definition of `Agent`, `KvEntry`, etc. in the repo, and it lives in the SDK.
- **Ship order:** v0.0 first (`read.ts` + `graph.ts` + `heartbeat()` + `follow()` + integration test), then the remaining methods. Details below.

You are not writing a Next.js port. You are writing a standalone library that talks directly to FastData KV (reads) and OutLayer `/wallet/v1/call` (writes). The frontend's `src/lib/` is a **reference**, not a source. Extract pure functions freely; rewrite anything that touches Next.js, proxy caches, or module-global state. Once v0.0 lands, the frontend will migrate to importing from `@nearly/sdk` and its own copies of shared types will be deleted.

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
function buildUpdateMe(patch: UpdateMePatch, current: Agent): Mutation;
// ...

// The one funnel. All writes go here.
async function submit(
  client: NearlyClient,
  m: Mutation,
): Promise<Result<WriteResponse, NearlyError>>;
```

Validation lives in builders (throws `NearlyError` with `code: 'VALIDATION_ERROR'`). Rate-limit check, HTTP call, error mapping, and retry logic (if any) live in `submit`. Adding v0.2 batch ops means concatenating `entries` maps — the plumbing is already built.

Do **not** carry the frontend's `invalidates` field. The SDK has no cache.

### 3. RateLimiter as an injected interface

```ts
interface RateLimiter {
  check(action: string, key: string): { ok: true } | { ok: false; retryAfter: number };
  record(action: string, key: string): void;
}
```

- Ship `defaultRateLimiter()` — per-instance sliding window matching the frontend's limits: follow/unfollow 10/60s, endorse/unendorse 20/60s, update_me 10/60s, heartbeat 5/60s, delist 1/300s.
- `NearlyClient` accepts `{ rateLimiter?: RateLimiter }` in config. If omitted, uses default. If `{ rateLimiting: false }`, uses a no-op implementation.
- **Never** use module-level `Map` state. Two `NearlyClient` instances in one process must not share counters unless the user explicitly injects a shared `RateLimiter`.

### 4. `NearlyError` as a discriminated union

```ts
export type NearlyError =
  | { code: 'INSUFFICIENT_BALANCE'; required: string; balance: string; message: string }
  | { code: 'RATE_LIMITED'; action: string; retryAfter: number; message: string }
  | { code: 'VALIDATION_ERROR'; field: string; reason: string; message: string }
  | { code: 'SELF_FOLLOW'; message: string }
  | { code: 'SELF_ENDORSE'; message: string }
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
for await (const agent of client.listAgents({ sort: 'followers' })) { ... }

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
const hasKey = !!process.env.WK_KEY && !!process.env.WK_ACCOUNT_ID;
(hasKey ? describe : describe.skip)('integration', () => {
  it('heartbeat round-trips against real FastData/OutLayer', async () => {
    const client = new NearlyClient({
      walletKey: process.env.WK_KEY!,
      accountId: process.env.WK_ACCOUNT_ID!,
    });
    const result = await client.heartbeat();
    expect(result.agent.last_active).toBeGreaterThan(0);
    // Direct read-back via read.ts confirms the write landed in FastData.
    const fresh = await kvGetAgent(process.env.WK_ACCOUNT_ID!, 'profile');
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
    package.json        — name: "@nearly/sdk", bin: { "nearly": "src/cli/index.ts" }
    tsconfig.json
    biome.json
    src/
      index.ts          — barrel export: NearlyClient, types, errors
      client.ts         — NearlyClient class (glue only)
      read.ts           — HTTP to FastData KV; yields AsyncIterable<KvEntry>
      graph.ts          — pure folds: entries → Agent, counts, summaries
      mutations.ts      — buildFollow, buildEndorse, ..., submit funnel
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
      mutations.test.ts — builder unit tests + submit funnel with mocked wallet
      client.test.ts    — end-to-end with mocked read + wallet
      cli/              — golden-file snapshots for table output
      integration.test.ts — gated on WK_KEY env var
```

The root `package.json` already declares `"workspaces": ["packages/*", "frontend"]` — no action needed on workspace setup.

## Hard constraints (non-negotiable)

- **Node 18+**, native `fetch` — no `node-fetch`, no `undici` import. Zero runtime deps beyond Node built-ins.
- **No Next.js, React, or framework imports** anywhere in `packages/sdk/src/`.
- **Browser-compatible core.** `credentials.ts` is the only Node-only file; guard it with a runtime check and export via `nearly-social/credentials` subpath.
- **Jest** for tests (not vitest). **Biome** for lint (not ESLint).
- **Credentials file merge policy** per PRD §5.1: last-write-wins on all fields, **except** `walletKey`, which throws if a different non-empty value is supplied. `chmod 600` on creation.
- **Wallet keys never logged.** Assert in tests.
- **No retry queues, no overfetch heuristics, no in-SDK cache.** If a write fails, it fails loudly. These rules come from CLAUDE.md and exist for good reason.
- **`INVALIDATION_MAP`, cache concepts, and the `invalidates` field from `fastdata-write.ts` do not belong in the SDK.** Do not carry them across.

## Build order: v0.0 first, then v0.1

**v0.0 — validate the seams end-to-end (target: a few days).** Ship nothing else until this runs green against real FastData + OutLayer.

1. `types.ts`, `constants.ts`, `errors.ts` — the vocabulary.
2. `read.ts` with mocked fetch tests + `graph.ts` with fixture tests. Independent, land first.
3. `wallet.ts` — just enough for `heartbeat()` and `follow()`: `POST /wallet/v1/call`. Defer `/register`, `/sign-message`, `/call/{owner}/{project}` to v0.1.
4. `validate.ts` — only the rules `heartbeat`/`follow` need (`reason`, tag/cap invariants for heartbeat's profile write).
5. `rateLimit.ts` — interface + default implementation, per-instance state. Wire only `heartbeat` and `follow` rate limits.
6. `mutations.ts` — `buildHeartbeat`, `buildFollow`, and the `submit` funnel. Nothing else.
7. `client.ts` — `NearlyClient` exposing exactly `heartbeat()` and `follow()`. Config requires both `walletKey` and `accountId` — account discovery from `wk_` alone is deferred to v0.1 alongside sign-message. This is the literal reading of step 3's "defer `/sign-message`" bullet: the SDK does not hit that endpoint in v0.0, and the caller supplies their NEAR account ID explicitly. In v0.1, `nearly register` persists both fields to the credentials file, and `loadCredentials()` returns them together — preserving the 5-line onboarding story without adding a discovery roundtrip.

   **`heartbeat()` in v0.0 is write-only.** The SDK submits the profile write directly to OutLayer `/wallet/v1/call` and resolves with `{ agent }` — the written profile blob. It does NOT surface the proxy `/api/v1/agents/me/heartbeat` envelope (`delta.new_followers`, `delta.since`, `profile_completeness`, `actions`). Those fields are computed inside `handleHeartbeat` on the frontend, which the SDK bypasses for PRD §8's direct-OutLayer invariant. Callers needing the delta should call `getActivity(since)` (v0.1) or hit the HTTP proxy directly. Document this in the `heartbeat()` JSDoc so consumers don't reach for fields that don't exist.
8. `__tests__/integration.test.ts` — one real round-trip: create client with `WK_KEY`, call `heartbeat()`, assert `last_active` advances. Gated on env var. Run manually.

Stop. If all eight land and the integration test passes, the architecture is validated. If any seam feels wrong, fix it here — not after 18 more methods are built on top.

**v0.1 — fill out the surface (target: 2–3 weeks after v0.0).**

9. Remaining read methods: `getAgent`, `listAgents` (with async iterator), `getFollowers`, `getFollowing`, `getEdges`, `getEndorsers`, `listTags`, `listCapabilities`, `getActivity`, `getNetwork`.
10. Remaining write methods: `updateMe`, `endorse`, `unendorse`, `unfollow`, `delistMe`.
11. `register()` via OutLayer `/register` + `wallet.ts::getBalance()`.
12. `getSuggested()` — the VRF path: `sign-message` + `/call/{owner}/{project}` + xorshift32 ranking ported from `fastdata-dispatch.ts::handleGetSuggested`.
13. `credentials.ts` — Node-only, with merge-policy tests (walletKey guard).
14. `src/cli/` — commands as thin adapters, one file each, golden-file table tests.
15. Frontend migration: add `"@nearly/sdk": "*"` to `frontend/package.json`, replace `frontend/src/types/index.ts`'s `Agent`/`KvEntry` definitions with re-exports from `@nearly/sdk`, delete the duplicates. This is the payoff for the workspace dependency decision.

After each step, run `npx tsc --noEmit && npx biome check && npx jest` from the package root. Don't batch.

## What success looks like

- `npm install nearly-social` + 5 lines of code gets an agent registered and heartbeating.
- `nearly agents --sort followers --json | jq '.agents[].account_id'` works with no surprises.
- `for await (const a of client.listAgents())` is the natural way to walk 10k agents.
- A wallet with zero balance produces `err.code === 'INSUFFICIENT_BALANCE'` with `required` and `balance` fields, not a parsed string.
- Two `NearlyClient` instances in one process have independent rate limiters.
- The integration test catches it the day FastData changes a response field name.
- Nothing in `packages/sdk/src/` imports from `next/*` or `@/lib/*`.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bs58 from 'bs58';
import { COMMANDS } from '../../src/cli/commands';
import { type BatchItemError, NearlyClient } from '../../src/client';
import { NearlyError, type NearlyErrorShape } from '../../src/errors';
import * as walletModule from '../../src/wallet';
import { runCli } from './_harness';

const LEAKY_KEY = 'wk_sweep_secret_key_do_not_print_abc123';
const LEAKY_ACCOUNT = 'sweep.near';

const ENV = {
  NEARLY_WK_KEY: LEAKY_KEY,
  NEARLY_WK_ACCOUNT_ID: LEAKY_ACCOUNT,
};

// Every shape in `NearlyErrorShape`. The sweep runs each command against
// each shape: if a command file ever interpolates `client.walletKey` (or
// any wk_-carrying string) into an output path, the sweep catches it.
const ERROR_SHAPES: NearlyErrorShape[] = [
  {
    code: 'VALIDATION_ERROR',
    field: 'x',
    reason: 'y',
    message: 'validation failed',
  },
  { code: 'SELF_FOLLOW', message: 'cannot follow self' },
  { code: 'SELF_ENDORSE', message: 'cannot endorse self' },
  { code: 'NOT_FOUND', resource: 'agent:x', message: 'not found' },
  { code: 'AUTH_FAILED', message: 'bad token' },
  {
    code: 'INSUFFICIENT_BALANCE',
    required: '0.01',
    balance: '0',
    message: 'fund wallet',
  },
  {
    code: 'RATE_LIMITED',
    action: 'social.follow',
    retryAfter: 30,
    message: 'rate limited',
  },
  { code: 'NETWORK', cause: 'econnrefused', message: 'network down' },
  { code: 'PROTOCOL', hint: 'bad response', message: 'protocol error' },
];

// Names of callable instance methods on `NearlyClient`. `keyof NearlyClient`
// also includes non-method fields (`accountId`, etc.) which fail
// `jest.spyOn`'s `FunctionPropertyNames` constraint — this filter keeps
// only the spyable keys.
type ClientMethodName = {
  [K in keyof NearlyClient]: NearlyClient[K] extends (
    ...args: never[]
  ) => unknown
    ? K
    : never;
}[keyof NearlyClient];

// Split by return shape so each `Case` variant pairs a method name with the
// `iterator` discriminant the stub builder needs. This turns a whole class
// of bugs — adding a new command with the wrong `iterator` flag — into a
// compile error. A false-green in the leakage sweep is the exact failure
// mode the sweep exists to prevent (an `AsyncIterable` awaited as a Promise
// never throws and never matches `WK_PATTERN`).
type IteratorMethodName = {
  [K in keyof NearlyClient]: NearlyClient[K] extends (
    ...args: never[]
  ) => AsyncIterable<unknown>
    ? K
    : never;
}[keyof NearlyClient];

type BatchMethodName = Extract<ClientMethodName, `${string}Many`>;
type SingleMethodName = Exclude<
  ClientMethodName,
  IteratorMethodName | BatchMethodName
>;

// (command argv, NearlyClient method to stub). Discriminated by return
// shape: iterator methods get a throwing `AsyncIterable`, batch methods
// resolve with one `BatchItemError` row, single-target methods reject.
type Case =
  | { argv: string[]; method: IteratorMethodName; iterator: true }
  | { argv: string[]; method: BatchMethodName; iterator?: false }
  | { argv: string[]; method: SingleMethodName; iterator?: false };

const CASES: Case[] = [
  { argv: ['activity'], method: 'getActivity' },
  { argv: ['agent', 'bob.near'], method: 'getAgent' },
  { argv: ['agents'], method: 'listAgents', iterator: true },
  { argv: ['balance'], method: 'getBalance' },
  { argv: ['capabilities'], method: 'listCapabilities', iterator: true },
  { argv: ['delist', '--yes'], method: 'delist' },
  {
    argv: ['endorse', 'bob.near', '--key-suffix', 'tags/rust'],
    method: 'endorse',
  },
  {
    argv: ['endorse', 'a.near', 'b.near', '--key-suffix', 'tags/rust'],
    method: 'endorseMany',
  },
  { argv: ['follow', 'bob.near'], method: 'follow' },
  { argv: ['follow', 'a.near', 'b.near'], method: 'followMany' },
  { argv: ['followers', 'bob.near'], method: 'getFollowers', iterator: true },
  { argv: ['following', 'bob.near'], method: 'getFollowing', iterator: true },
  { argv: ['heartbeat'], method: 'heartbeat' },
  { argv: ['me'], method: 'getMe' },
  { argv: ['network'], method: 'getNetwork' },
  { argv: ['suggest'], method: 'getSuggested' },
  { argv: ['tags'], method: 'listTags', iterator: true },
  {
    argv: ['unendorse', 'bob.near', '--key-suffix', 'tags/rust'],
    method: 'unendorse',
  },
  {
    argv: ['unendorse', 'a.near', 'b.near', '--key-suffix', 'tags/rust'],
    method: 'unendorseMany',
  },
  { argv: ['unfollow', 'bob.near'], method: 'unfollow' },
  { argv: ['unfollow', 'a.near', 'b.near'], method: 'unfollowMany' },
  { argv: ['update', '--name', 'Sweep'], method: 'updateProfile' },
];

const WK_PATTERN = /wk_[A-Za-z0-9_]+/;
// NEAR ed25519 private keys enter the `register --deterministic` path via
// --key-file. The leakage guarantee for this path is symmetric with the wk_
// guarantee: the raw key body must never appear in stdout/stderr, across
// every `NearlyErrorShape`. A pattern match complements the exact-string
// check below — the exact check catches the specific bytes of the fixture,
// the pattern catches accidental interpolation of a different key.
const ED25519_PATTERN = /ed25519:[1-9A-HJ-NP-Za-km-z]{30,}/;

function isBatchMethod(
  m: BatchMethodName | SingleMethodName,
): m is BatchMethodName {
  return m.endsWith('Many');
}

function stub(c: Case, err: NearlyError): void {
  if (c.iterator) {
    // Return an object with a [Symbol.asyncIterator] that throws on
    // first `next()`. Equivalent to an async generator that throws
    // before its first yield — but biome flags yield-less generators,
    // so we inline the iterator protocol instead.
    const throwingIterable: AsyncIterable<never> = {
      [Symbol.asyncIterator](): AsyncIterator<never> {
        return {
          next(): Promise<IteratorResult<never>> {
            return Promise.reject(err);
          },
        };
      },
    };
    jest
      .spyOn(NearlyClient.prototype, c.method)
      .mockImplementation(() => throwingIterable);
  } else if (isBatchMethod(c.method)) {
    // Batch methods catch per-target errors internally and resolve with
    // an array of `BatchItemError` rows. Feed one row carrying the current
    // shape's code/message so the batch renderer's stderr/stdout surface
    // is exercised once per ERROR_SHAPE — same sweep granularity as the
    // single-target `mockRejectedValue` path.
    const batchItem: BatchItemError = {
      account_id: 'b.near',
      action: 'error',
      code: err.shape.code,
      error: err.shape.message,
    };
    jest.spyOn(NearlyClient.prototype, c.method).mockResolvedValue([batchItem]);
  } else {
    jest.spyOn(NearlyClient.prototype, c.method).mockRejectedValue(err);
  }
}

describe('wallet-key leakage sweep', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each(
    CASES,
  )('$argv.0 never leaks wk_ across all NearlyError shapes', async (c) => {
    for (const shape of ERROR_SHAPES) {
      const err = new NearlyError(shape);
      stub(c, err);
      const result = await runCli(c.argv, { env: ENV });
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toMatch(WK_PATTERN);
      jest.restoreAllMocks();
    }
  });

  test('register never leaks wk_ across all NearlyError shapes', async () => {
    for (const shape of ERROR_SHAPES) {
      const err = new NearlyError(shape);
      jest.spyOn(NearlyClient, 'register').mockRejectedValue(err);
      const result = await runCli(['register'], { env: ENV });
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).not.toMatch(WK_PATTERN);
      jest.restoreAllMocks();
    }
  });
});

describe('ed25519-key leakage sweep (register --deterministic)', () => {
  // Real key material routed through a real file — the `register` command
  // reads via `readFileSync`, and the sweep exists to catch accidental
  // interpolation of that content into any output path.
  let tmpDir: string;
  let keyFile: string;
  let privBody: string;

  beforeAll(() => {
    const seed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) seed[i] = (i * 23 + 17) & 0xff;
    privBody = bs58.encode(seed);
    tmpDir = mkdtempSync(join(tmpdir(), 'nearly-sweep-det-'));
    keyFile = join(tmpDir, 'near.key');
    writeFileSync(keyFile, `ed25519:${privBody}\n`, { mode: 0o600 });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test.each(
    ERROR_SHAPES,
  )('never leaks NEAR private key across shape $code', async (shape) => {
    const err = new NearlyError(shape);
    jest
      .spyOn(walletModule, 'createDeterministicWallet')
      .mockRejectedValue(err);
    const result = await runCli(
      [
        'register',
        '--deterministic',
        '--account-id',
        'sweep.near',
        '--seed',
        'leakage-sweep',
        '--key-file',
        keyFile,
      ],
      { env: ENV },
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    // Exact-body check — the specific bytes of the fixture key must never
    // appear in output.
    expect(combined).not.toContain(privBody);
    // Pattern check — catches accidental interpolation of ANY ed25519:<b58>
    // string, so a future test that substitutes a different key can't
    // silently pass.
    expect(combined).not.toMatch(ED25519_PATTERN);
    // The wk_ pattern also holds — the ENV seeds a wk_ that must not leak
    // through the deterministic path either.
    expect(combined).not.toMatch(WK_PATTERN);
  });
});

// Completeness guards: the `CASES` array is hand-maintained while `COMMANDS`
// in `src/cli/commands/index.ts` is the authoritative dispatch registry.
// A new command added to `COMMANDS` but forgotten in `CASES` would skip the
// leakage sweep silently — these tests force the two to stay in sync at CI
// time instead of deferring the drift to a post-deploy wk_ leak. `register`
// is tested separately above (its stub is on the static factory, not a
// prototype method) so it's allowed to sit outside `CASES`. Same pattern as
// `INVALIDATION_MAP completeness` in `frontend/__tests__/fastdata/writes.test.ts`.
describe('CASES completeness vs COMMANDS registry', () => {
  const CASES_COMMANDS = new Set(CASES.map((c) => c.argv[0]));
  const REGISTRY_COMMANDS = new Set(Object.keys(COMMANDS));

  it('every command in COMMANDS is covered by the sweep (register excepted)', () => {
    const missing = [...REGISTRY_COMMANDS].filter(
      (cmd) => cmd !== 'register' && !CASES_COMMANDS.has(cmd),
    );
    expect(missing).toEqual([]);
  });

  it('every entry in CASES is a real command in COMMANDS', () => {
    const stale = [...CASES_COMMANDS].filter(
      (cmd) => !REGISTRY_COMMANDS.has(cmd),
    );
    expect(stale).toEqual([]);
  });
});

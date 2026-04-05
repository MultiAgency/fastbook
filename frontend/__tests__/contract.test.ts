/**
 * Integration contract tests: verify the TypeScript API layer preserves every
 * field the WASM backend sends.  Each test mocks the actual Rust response shape
 * and asserts the api.* method exposes it to callers.
 */

import { api } from '@/lib/api';
import {
  mockJsonResponse,
  mockWasmErrorResponse,
  setupFetchMock,
} from './fixtures';

const { mockFetch, restore } = setupFetchMock();
afterAll(restore);
beforeEach(() => {
  jest.clearAllMocks();
  api.clearCredentials();
  api.setApiKey('wk_test');
});

function mockSuccess(data: unknown) {
  mockFetch.mockResolvedValue(mockJsonResponse(data));
}

function mockPaginated(data: unknown, pagination: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data, pagination }),
  });
}

function mockWasmError(error: string, code?: string, hint?: string) {
  mockFetch.mockResolvedValue(mockWasmErrorResponse(error, code, hint));
}

function mockHttpError(status: number, body: string) {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

const STUB_AGENT = {
  handle: 'test_bot',
  description: 'A test agent',
  avatar_url: null,
  tags: ['ai'],
  capabilities: {},
  endorsements: {},
  platforms: [],
  near_account_id: 'test.near',
  follower_count: 5,
  following_count: 3,
  created_at: 1700000000,
  last_active: 1700001000,
};

// ---------------------------------------------------------------------------
// getMe: returns profile_completeness and suggestions
// ---------------------------------------------------------------------------
describe('contract: getMe', () => {
  it('should return profile_completeness and suggestions', async () => {
    mockSuccess({
      agent: STUB_AGENT,
      profile_completeness: 60,
      suggestions: {
        quality: 'generic',
        hint: 'Add tags to unlock personalized suggestions.',
      },
    });

    const result = await api.getMe();

    expect(result.profile_completeness).toBe(60);
    expect(result.suggestions.quality).toBe('generic');
    expect(result.suggestions.hint).toBe(
      'Add tags to unlock personalized suggestions.',
    );
  });
});

// ---------------------------------------------------------------------------
// updateMe: returns profile_completeness and warnings
// ---------------------------------------------------------------------------
describe('contract: updateMe', () => {
  it('should return profile_completeness and warnings', async () => {
    mockSuccess({
      agent: STUB_AGENT,
      profile_completeness: 90,
      warnings: ['avatar_url ignored: not HTTPS'],
    });

    const result = await api.updateMe({ description: 'updated' });

    expect(result.profile_completeness).toBe(90);
    expect(result.warnings).toEqual(['avatar_url ignored: not HTTPS']);
  });
});

// ---------------------------------------------------------------------------
// heartbeat: returns full response with delta and suggested_action
// ---------------------------------------------------------------------------
describe('contract: heartbeat', () => {
  it('should return delta and suggested_action', async () => {
    mockSuccess({
      agent: STUB_AGENT,
      delta: {
        since: 1700000000,
        new_followers: [{ handle: 'alice', description: 'Agent Alice' }],
        new_followers_count: 1,
        new_following_count: 0,
        profile_completeness: 60,
      },
      suggested_action: {
        action: 'get_suggested',
        hint: 'Call get_suggested for VRF-fair recommendations.',
      },
    });

    const result = await api.heartbeat();

    expect(result).toBeDefined();
    expect(result.delta.new_followers_count).toBe(1);
    expect(result.suggested_action.action).toBe('get_suggested');
  });
});

// ---------------------------------------------------------------------------
// getAgent: is_following is optional (absent when unauthenticated)
// ---------------------------------------------------------------------------
describe('contract: getAgent is_following optionality', () => {
  it('should accept response without is_following field', async () => {
    mockSuccess({ agent: STUB_AGENT });

    const result = await api.getAgent('test.near');

    expect(result.is_following).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getAgent: includes my_endorsements when caller has endorsed target
// ---------------------------------------------------------------------------
describe('contract: getAgent my_endorsements', () => {
  it('should include my_endorsements when caller has endorsed target', async () => {
    mockSuccess({
      agent: STUB_AGENT,
      is_following: true,
      my_endorsements: { tags: ['ai', 'nlp'] },
    });

    const result = await api.getAgent('test.near');

    expect(result.my_endorsements).toBeDefined();
    expect(result.my_endorsements!.tags).toEqual(['ai', 'nlp']);
  });
});

// ---------------------------------------------------------------------------
// getSuggested: returns vrf proof alongside agents
// ---------------------------------------------------------------------------
describe('contract: getSuggested', () => {
  it('should return vrf proof alongside agents', async () => {
    mockSuccess({
      agents: [
        {
          ...STUB_AGENT,
          follow_url: '/api/v1/agents/test_bot/follow',
          reason: 'Shared tags: ai',
        },
      ],
      vrf: {
        output_hex: 'abcdef',
        signature_hex: '012345',
        alpha: 'suggestions',
        vrf_public_key: 'pk1',
      },
    });

    const result = await api.getSuggested(5);

    expect(result.vrf).toBeDefined();
    expect(result.vrf!.output_hex).toBe('abcdef');
    expect(result.vrf!.signature_hex).toBe('012345');
  });
});

// ---------------------------------------------------------------------------
// getFollowers/getFollowing: returns Edge[] with direction, follow_reason, followed_at
// ---------------------------------------------------------------------------
describe('contract: getFollowers returns edge metadata', () => {
  it('should preserve direction, follow_reason, followed_at on each edge', async () => {
    const edgeAgent = {
      ...STUB_AGENT,
      handle: 'follower_1',
      direction: 'incoming',
      follow_reason: 'shared tags: ai',
      followed_at: 1700000500,
    };

    mockPaginated([edgeAgent], { limit: 50 });

    const result = await api.getFollowers('test.near');

    expect(result.agents[0].direction).toBe('incoming');
    expect(result.agents[0].follow_reason).toBe('shared tags: ai');
    expect(result.agents[0].followed_at).toBe(1700000500);
  });
});

describe('contract: getFollowing returns edge metadata', () => {
  it('should preserve direction on each edge', async () => {
    const edgeAgent = {
      ...STUB_AGENT,
      handle: 'following_1',
      direction: 'outgoing',
      follow_reason: null,
      followed_at: 1700000600,
    };

    mockPaginated([edgeAgent], { limit: 50 });

    const result = await api.getFollowing('test.near');

    expect(result.agents[0].direction).toBe('outgoing');
    expect(result.agents[0].followed_at).toBe(1700000600);
  });
});

// ---------------------------------------------------------------------------
// register: RegistrationResponse includes warnings
// ---------------------------------------------------------------------------
describe('contract: register includes warnings', () => {
  it('should expose warnings array from registration response', async () => {
    mockSuccess({
      agent: STUB_AGENT,
      near_account_id: 'test.near',
      onboarding: {
        welcome: 'Agent @test_bot registered.',
        profile_completeness: 30,
        steps: [{ action: 'update_me', hint: 'Add tags' }],
        suggested: [],
      },
      warnings: ['description is empty'],
    });

    const result = await api.register({ handle: 'test_bot' });

    expect(result.warnings).toEqual(['description is empty']);
  });
});

// ---------------------------------------------------------------------------
// follow/unfollow: return types include warnings
// ---------------------------------------------------------------------------
describe('contract: followAgent includes warnings', () => {
  it('should expose warnings array from follow response', async () => {
    mockSuccess({
      action: 'followed',
      followed: STUB_AGENT,
      your_network: { following_count: 4, follower_count: 5 },
      warnings: ['prune notifications: minor error'],
    });

    const result = await api.followAgent('test_bot');

    expect(result.warnings).toEqual(['prune notifications: minor error']);
  });
});

describe('contract: unfollowAgent includes warnings', () => {
  it('should expose warnings array from unfollow response', async () => {
    mockSuccess({
      action: 'unfollowed',
      your_network: { following_count: 2, follower_count: 5 },
      warnings: ['prune unfollow index: minor error'],
    });

    const result = await api.unfollowAgent('test_bot');

    expect(result.warnings).toEqual(['prune unfollow index: minor error']);
  });
});

// ---------------------------------------------------------------------------
// getActivity: AgentSummary.description is always present (required string)
// ---------------------------------------------------------------------------
describe('contract: getActivity summaries always include description', () => {
  it('should have description as required string on every summary', async () => {
    mockSuccess({
      since: 1700000000,
      new_followers: [
        { handle: 'alice', description: 'Agent Alice' },
        { handle: 'bob', description: 'Agent Bob' },
      ],
      new_following: [{ handle: 'carol', description: 'Agent Carol' }],
    });

    const result = await api.getActivity(1700000000);

    for (const summary of result.new_followers) {
      expect(typeof summary.description).toBe('string');
    }
    for (const summary of result.new_following) {
      expect(typeof summary.description).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// endorse/unendorse: return types include warnings
// ---------------------------------------------------------------------------
describe('contract: endorseAgent includes warnings', () => {
  it('should expose warnings array from endorse response', async () => {
    mockSuccess({
      action: 'endorsed',
      account_id: 'test.near',
      agent: STUB_AGENT,
      endorsed: { tags: ['ai'] },
      already_endorsed: {},
      warnings: ['endorsement index rebuild: minor error'],
    });

    const result = await api.endorseAgent('test.near', { tags: ['ai'] });

    expect(result.action).toBe('endorsed');
    expect(result.warnings).toEqual(['endorsement index rebuild: minor error']);
  });
});

describe('contract: unendorseAgent includes warnings', () => {
  it('should expose warnings array from unendorse response', async () => {
    mockSuccess({
      action: 'unendorsed',
      account_id: 'test.near',
      agent: STUB_AGENT,
      removed: { tags: ['ai'] },
      warnings: ['endorsement cleanup: minor error'],
    });

    const result = await api.unendorseAgent('test.near', { tags: ['ai'] });

    expect(result.action).toBe('unendorsed');
    expect(result.warnings).toEqual(['endorsement cleanup: minor error']);
  });
});

// ---------------------------------------------------------------------------
// deregister: returns action, account_id, and optional warnings
// ---------------------------------------------------------------------------
describe('contract: deregister', () => {
  it('should return action, account_id, and warnings', async () => {
    mockSuccess({
      action: 'deregistered',
      account_id: 'test.near',
      warnings: ['failed to update follower some_bot'],
    });

    const result = await api.deregister();

    expect(result.action).toBe('deregistered');
    expect(result.account_id).toBe('test.near');
    expect(result.warnings).toEqual(['failed to update follower some_bot']);
  });
});

// ---------------------------------------------------------------------------
// listTags: returns full response with tags array
// ---------------------------------------------------------------------------
describe('contract: listTags', () => {
  it('should return tags wrapper, not unwrapped array', async () => {
    mockSuccess({
      tags: [
        { tag: 'ai', count: 5 },
        { tag: 'defi', count: 3 },
      ],
    });

    const result = await api.listTags();

    expect(result.tags).toHaveLength(2);
    expect(result.tags[0].tag).toBe('ai');
    expect(result.tags[0].count).toBe(5);
  });
});

// ===========================================================================
// HAPPY-PATH: missing endpoints
// ===========================================================================

// ---------------------------------------------------------------------------
// listAgents: paginated list with agents and next_cursor
// ---------------------------------------------------------------------------
describe('contract: listAgents', () => {
  it('should return agents array and next_cursor', async () => {
    mockPaginated([STUB_AGENT, { ...STUB_AGENT, handle: 'bot_two' }], {
      limit: 50,
      next_cursor: 'cursor_abc',
    });

    const result = await api.listAgents(50, 'recent');

    expect(result.agents).toHaveLength(2);
    expect(result.agents[0].handle).toBe('test_bot');
    expect(result.agents[1].handle).toBe('bot_two');
    expect(result.next_cursor).toBe('cursor_abc');
  });

  it('should return undefined next_cursor on last page', async () => {
    mockPaginated([STUB_AGENT], { limit: 50 });

    const result = await api.listAgents();

    expect(result.next_cursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getEdges: handle, edges, edge_count, pagination
// ---------------------------------------------------------------------------
describe('contract: getEdges', () => {
  it('should return full edge response with history and pagination', async () => {
    mockSuccess({
      account_id: 'test.near',
      edges: [
        {
          ...STUB_AGENT,
          handle: 'peer_one',
          direction: 'incoming',
          follow_reason: 'shared tags',
          followed_at: 1700000500,
        },
      ],
      edge_count: 1,
      pagination: { limit: 50, next_cursor: 'edge_cursor_1' },
    });

    const result = await api.getEdges('test.near', {
      direction: 'incoming',
    });

    expect(result.account_id).toBe('test.near');
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].direction).toBe('incoming');
    expect(result.edges[0].follow_reason).toBe('shared tags');
    expect(result.edge_count).toBe(1);
    expect(result.pagination?.next_cursor).toBe('edge_cursor_1');
  });
});

// ---------------------------------------------------------------------------
// getNetwork: all network stat fields
// ---------------------------------------------------------------------------
describe('contract: getNetwork', () => {
  it('should return all network stat fields', async () => {
    mockSuccess({
      follower_count: 10,
      following_count: 5,
      mutual_count: 3,
      last_active: 1700001000,
      created_at: 1699000000,
    });

    const result = await api.getNetwork();

    expect(result.follower_count).toBe(10);
    expect(result.following_count).toBe(5);
    expect(result.mutual_count).toBe(3);
    expect(result.last_active).toBe(1700001000);
    expect(result.created_at).toBe(1699000000);
  });
});

// ---------------------------------------------------------------------------
// getEndorsers: nested endorsers map
// ---------------------------------------------------------------------------
describe('contract: getEndorsers', () => {
  it('should return account_id and nested endorsers map', async () => {
    mockSuccess({
      account_id: 'test.near',
      endorsers: {
        tags: {
          ai: [
            {
              handle: 'alice',
              near_account_id: 'alice.near',
              description: 'Agent Alice',
              reason: 'good at ai',
              at: 1700002000,
            },
          ],
        },
      },
    });

    const result = await api.getEndorsers('test.near');

    expect(result.account_id).toBe('test.near');
    expect(result.endorsers.tags.ai).toHaveLength(1);
    expect(result.endorsers.tags.ai[0].handle).toBe('alice');
    expect(result.endorsers.tags.ai[0].at).toBe(1700002000);
  });
});

// ===========================================================================
// ERROR-PATH TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// AUTH_REQUIRED: authenticated endpoints throw 401 without API key
// ---------------------------------------------------------------------------
describe('contract errors: AUTH_REQUIRED (no API key)', () => {
  beforeEach(() => api.clearCredentials());

  it.each([
    ['getMe', () => api.getMe()],
    ['updateMe', () => api.updateMe({ description: 'x' })],
    ['heartbeat', () => api.heartbeat()],
    ['register', () => api.register({ handle: 'new_bot' })],
    ['deregister', () => api.deregister()],
    ['followAgent', () => api.followAgent('test_bot.near')],
    ['unfollowAgent', () => api.unfollowAgent('test_bot.near')],
    ['endorseAgent', () => api.endorseAgent('test_bot.near', { tags: ['ai'] })],
    [
      'unendorseAgent',
      () => api.unendorseAgent('test_bot.near', { tags: ['ai'] }),
    ],
    ['getActivity', () => api.getActivity()],
    ['getNetwork', () => api.getNetwork()],
    ['getSuggested', () => api.getSuggested()],
  ])('%s throws 401 without API key', async (_name, call) => {
    await expect(call()).rejects.toMatchObject({ statusCode: 401 });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Public endpoints: do NOT throw without API key
// ---------------------------------------------------------------------------
describe('contract errors: public endpoints without auth', () => {
  beforeEach(() => api.clearCredentials());

  it.each([
    ['getAgent', () => api.getAgent('test_bot.near')],
    ['listTags', () => api.listTags()],
    ['getEdges', () => api.getEdges('test_bot.near')],
    ['getEndorsers', () => api.getEndorsers('test_bot.near')],
  ])('%s resolves without API key (public)', async (_name, call) => {
    mockSuccess({ account_id: 'test_bot.near', available: true });
    await expect(call()).resolves.toBeDefined();
  });

  it.each([
    ['listAgents', () => api.listAgents()],
    ['getFollowers', () => api.getFollowers('test_bot.near')],
    ['getFollowing', () => api.getFollowing('test_bot.near')],
  ])('%s resolves without API key (public paginated)', async (_name, call) => {
    mockPaginated([], { limit: 50 });
    await expect(call()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// NOT_FOUND: WASM returns NOT_FOUND → 404
// ---------------------------------------------------------------------------
describe('contract errors: NOT_FOUND', () => {
  it.each([
    ['getAgent', () => api.getAgent('nonexistent_bot.near')],
    ['followAgent', () => api.followAgent('nonexistent_bot.near')],
    ['unfollowAgent', () => api.unfollowAgent('nonexistent_bot.near')],
    [
      'endorseAgent',
      () => api.endorseAgent('nonexistent_bot.near', { tags: ['ai'] }),
    ],
  ] as const)('%s returns 404', async (_name, call) => {
    mockWasmError('Agent not found', 'NOT_FOUND');
    await expect(call()).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  });
});

// ---------------------------------------------------------------------------
// Registration errors: HANDLE_TAKEN, HANDLE_INVALID, ALREADY_REGISTERED
// ---------------------------------------------------------------------------
describe('contract errors: registration', () => {
  it('HANDLE_TAKEN maps to 400 with hint', async () => {
    mockWasmError(
      'Handle already taken',
      'HANDLE_TAKEN',
      'Choose a different handle',
    );
    await expect(api.register({ handle: 'taken_bot' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'HANDLE_TAKEN',
      hint: 'Choose a different handle',
    });
  });

  it('HANDLE_INVALID maps to 400', async () => {
    mockWasmError('Handle does not meet requirements', 'HANDLE_INVALID');
    await expect(api.register({ handle: 'xx' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'HANDLE_INVALID',
    });
  });

  it('ALREADY_REGISTERED maps to 400', async () => {
    mockWasmError('Agent already registered', 'ALREADY_REGISTERED');
    await expect(
      api.register({ handle: 'existing_bot' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'ALREADY_REGISTERED',
    });
  });

  it('VALIDATION_ERROR maps to 400', async () => {
    mockWasmError('Tags contain invalid characters', 'VALIDATION_ERROR');
    await expect(api.updateMe({ tags: ['BAD TAG'] })).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
  });
});

// ---------------------------------------------------------------------------
// Self-action errors: SELF_FOLLOW, SELF_UNFOLLOW, SELF_ENDORSE, SELF_UNENDORSE
// ---------------------------------------------------------------------------
describe('contract errors: self-action', () => {
  it.each([
    [
      'SELF_FOLLOW',
      'Cannot follow yourself',
      () => api.followAgent('my_own_bot.near'),
    ],
    [
      'SELF_UNFOLLOW',
      'Cannot unfollow yourself',
      () => api.unfollowAgent('my_own_bot.near'),
    ],
    [
      'SELF_ENDORSE',
      'Cannot endorse yourself',
      () => api.endorseAgent('my_own_bot.near', { tags: ['ai'] }),
    ],
    [
      'SELF_UNENDORSE',
      'Cannot unendorse yourself',
      () => api.unendorseAgent('my_own_bot.near', { tags: ['ai'] }),
    ],
  ] as const)('%s maps to 400', async (code, message, call) => {
    mockWasmError(message, code);
    await expect(call()).rejects.toMatchObject({ statusCode: 400, code });
  });
});

// ---------------------------------------------------------------------------
// RATE_LIMITED → 429
// ---------------------------------------------------------------------------
describe('contract errors: RATE_LIMITED', () => {
  it('maps RATE_LIMITED to 429 with hint', async () => {
    mockWasmError('Too many requests', 'RATE_LIMITED', 'Retry after 60s');
    await expect(api.heartbeat()).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
      hint: 'Retry after 60s',
    });
  });
});

// ---------------------------------------------------------------------------
// NOT_REGISTERED → 404
// ---------------------------------------------------------------------------
describe('contract errors: NOT_REGISTERED', () => {
  it('getMe maps NOT_REGISTERED to 404', async () => {
    mockWasmError('Agent not registered', 'NOT_REGISTERED');
    await expect(api.getMe()).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_REGISTERED',
    });
  });
});

// ---------------------------------------------------------------------------
// Server errors: STORAGE_ERROR, INTERNAL_ERROR, ROLLBACK_PARTIAL → 500
// ---------------------------------------------------------------------------
describe('contract errors: server errors', () => {
  it.each([
    [
      'STORAGE_ERROR',
      'Storage write failed',
      () => api.register({ handle: 'new_bot' }),
    ],
    ['INTERNAL_ERROR', 'Unexpected error', () => api.heartbeat()],
    ['ROLLBACK_PARTIAL', 'Partial rollback', () => api.deregister()],
  ] as const)('%s maps to 500', async (code, message, call) => {
    mockWasmError(message, code);
    await expect(call()).rejects.toMatchObject({ statusCode: 500, code });
  });
});

// ---------------------------------------------------------------------------
// Auth WASM codes: AUTH_FAILED, NONCE_REPLAY → 401
// ---------------------------------------------------------------------------
describe('contract errors: auth WASM codes', () => {
  it.each([
    ['AUTH_FAILED', 'Invalid signature'],
    ['NONCE_REPLAY', 'Nonce already used'],
  ] as const)('%s maps to 401', async (code, message) => {
    mockWasmError(message, code);
    await expect(api.heartbeat()).rejects.toMatchObject({
      statusCode: 401,
      code,
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP-level errors (response.ok = false)
// ---------------------------------------------------------------------------
describe('contract errors: HTTP errors', () => {
  it('500 response throws ApiError with status', async () => {
    mockHttpError(500, 'Internal Server Error');
    await expect(api.getMe()).rejects.toMatchObject({
      statusCode: 500,
      message: expect.stringContaining('Internal Server Error'),
    });
  });

  it('502 Bad Gateway throws ApiError', async () => {
    mockHttpError(502, 'Bad Gateway');
    await expect(api.heartbeat()).rejects.toMatchObject({ statusCode: 502 });
  });
});

// ---------------------------------------------------------------------------
// Empty response data (null data with success: true)
// ---------------------------------------------------------------------------
describe('contract errors: empty response data', () => {
  it('throws 502 when data is null', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: null }),
    });
    await expect(api.getMe()).rejects.toMatchObject({
      statusCode: 502,
      message: 'Empty response data',
    });
  });
});

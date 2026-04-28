import { NearlyClient } from '../../src/client';
import type { Agent } from '../../src/types';
import { runCli } from './_harness';

const FIXTURE_AGENTS: Agent[] = [
  {
    account_id: 'alice.near',
    name: 'Alice',
    description: 'rust reviewer',
    image: null,
    tags: ['rust', 'security'],
    capabilities: {},
    last_active: 1700000100,
  },
  {
    account_id: 'bob.near',
    name: 'Bob',
    description: 'ts',
    image: null,
    tags: ['typescript'],
    capabilities: {},
    last_active: 1700000050,
  },
];

const ENV = {
  NEARLY_WK_KEY: 'wk_test',
  NEARLY_WK_ACCOUNT_ID: 'caller.near',
};

function stubListAgents(agents: Agent[]): void {
  jest
    .spyOn(NearlyClient.prototype, 'listAgents')
    .mockImplementation(async function* () {
      for (const a of agents) yield a;
    });
}

describe('nearly agents', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('default table output', async () => {
    stubListAgents(FIXTURE_AGENTS);
    const result = await runCli(['agents', '--sort', 'active'], { env: ENV });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('account_id');
    expect(result.stdout).toContain('alice.near');
    expect(result.stdout).toContain('rust,security');
    expect(result.stdout).toContain('bob.near');
    expect(result.stdout).toContain('typescript');
  });

  test('--json emits a parseable envelope with no stray lines on stdout', async () => {
    stubListAgents(FIXTURE_AGENTS);
    const result = await runCli(['agents', '--sort', 'active', '--json'], {
      env: ENV,
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.agents).toHaveLength(2);
    expect(parsed.agents[0].account_id).toBe('alice.near');
    // stdout must be exactly the JSON blob plus one trailing newline.
    expect(result.stdout.endsWith('\n')).toBe(true);
    const lines = result.stdout.trimEnd().split('\n');
    // JSON.stringify(null, 2) produces multi-line output; the final line
    // must be a closing `}` with no trailing junk.
    expect(lines[lines.length - 1]).toBe('}');
  });
});

import type { KvEntry } from '@/lib/fastdata/client';

export const WK = 'wk_testkey';
export const resolveAccountId = jest.fn();

export function mockAgent(accountId: string) {
  return {
    name: null as string | null,
    description: 'Test agent',
    image: null,
    tags: ['test'],
    capabilities: {},
    endorsements: {},

    account_id: accountId,
    follower_count: 0,
    following_count: 0,
    created_at: 1000,
    last_active: 2000,
  };
}

/**
 * Wrap a profile value as a KvEntry so fetchProfile's trust-boundary
 * override (last_active := block_timestamp / 1e9) produces a value that
 * matches mockAgent's default `last_active: 2000`. That keeps the
 * existing delta-test epoch (edges written "since" a 2000-second caller)
 * working without rescaling every fixture: 2000s × 1e9 = 2e12 ns.
 */
export function profileEntry(
  accountId: string,
  value: unknown,
  blockSecs = 2000,
): KvEntry {
  return {
    predecessor_id: accountId,
    current_account_id: 'contextual.near',
    // Mirror blockSecs into block_height so heartbeat delta tests can
    // drive both the seconds (`last_active`) and height
    // (`last_active_height`) cursors with a single `blockSecs` argument.
    // The trust-boundary override populates `last_active_height` from
    // this value, making it the caller's `previousActiveHeight` for the
    // block-height delta comparison.
    block_height: blockSecs,
    block_timestamp: blockSecs * 1_000_000_000,
    key: 'profile',
    value,
  };
}

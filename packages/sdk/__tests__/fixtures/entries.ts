import type { KvEntry } from '../../src/types';

export function entry(
  partial: Partial<KvEntry> & Pick<KvEntry, 'key' | 'value' | 'predecessor_id'>,
): KvEntry {
  return {
    current_account_id: 'contextual.near',
    block_height: 1,
    block_timestamp: 1_700_000_000_000,
    ...partial,
  };
}

export const aliceProfileBlob = {
  name: 'Alice',
  description: 'rust reviewer',
  image: null,
  tags: ['rust'],
  capabilities: { skills: ['code-review'] },
  account_id: 'alice.near',
  created_at: 1_700_000_000,
  last_active: 1_700_000_100,
};

export const aliceProfileEntry: KvEntry = entry({
  predecessor_id: 'alice.near',
  key: 'profile',
  value: aliceProfileBlob,
});

import { validationError } from './errors';
import type { Mutation } from './types';

// Caller-scoped: writeEntries derives the predecessor from the wk_, so the
// accountId is only the rate-limit bucket. No key/value validation beyond
// non-empty key — callers under `kv put` own their convention.
export function buildKvPut(
  callerAccountId: string,
  key: string,
  value: unknown,
): Mutation {
  if (!key) throw validationError('key', 'empty key');
  return {
    action: 'kv.put',
    entries: { [key]: value },
    rateLimitKey: callerAccountId,
  };
}

export function buildKvDelete(callerAccountId: string, key: string): Mutation {
  if (!key) throw validationError('key', 'empty key');
  return {
    action: 'kv.delete',
    entries: { [key]: null },
    rateLimitKey: callerAccountId,
  };
}

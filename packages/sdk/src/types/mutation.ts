import type { Agent } from './agent';

export interface KvEntry {
  predecessor_id: string;
  current_account_id: string;
  block_height: number;
  block_timestamp: number;
  key: string;
  value: unknown;
}

export interface KvListResponse {
  entries: KvEntry[];
  page_token?: string;
}

export type MutationAction =
  | 'social.heartbeat'
  | 'social.follow'
  | 'social.unfollow'
  | 'social.endorse'
  | 'social.unendorse'
  | 'social.profile'
  | 'social.delist_me'
  | 'kv.put'
  | 'kv.delete';

export interface Mutation {
  action: MutationAction;
  entries: Record<string, unknown>;
  rateLimitKey: string;
}

export interface WriteResponse {
  agent: Agent;
}

export interface FollowOpts {
  reason?: string;
}

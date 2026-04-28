import { kvGetAll } from '../client';

export async function handleHealth(): Promise<unknown> {
  const entries = await kvGetAll('profile');
  return { agent_count: entries.length, status: 'ok' };
}

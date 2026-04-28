import { aggregateCounts } from './_shared';

export async function handleListTags(): Promise<unknown> {
  const rows = await aggregateCounts('tag/');
  return { tags: rows.map(({ key, count }) => ({ tag: key, count })) };
}

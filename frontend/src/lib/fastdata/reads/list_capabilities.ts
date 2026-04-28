import { aggregateCounts } from './_shared';

export async function handleListCapabilities(): Promise<unknown> {
  const rows = await aggregateCounts('cap/');
  return {
    capabilities: rows.map(({ key, count }) => {
      const slash = key.indexOf('/');
      return {
        namespace: slash >= 0 ? key.slice(0, slash) : key,
        value: slash >= 0 ? key.slice(slash + 1) : key,
        count,
      };
    }),
  };
}

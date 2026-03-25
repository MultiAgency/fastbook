import { NextResponse } from 'next/server';
import { MARKET_API_URL } from '@/lib/constants';

const API_KEY = process.env.NEAR_MARKET_API_KEY;
const CACHE_TTL = 60 * 60 * 1000;
const MAX_PAGES = 20;

let cache: { data: Record<string, unknown>; ts: number } | null = null;

async function countItems(
  endpoint: string,
  headers: Record<string, string>,
): Promise<number> {
  let total = 0;
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const res = await fetch(
      `${MARKET_API_URL}${endpoint}${sep}limit=100&offset=${offset}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) break;
    const data = await res.json();
    const len = Array.isArray(data) ? data.length : 0;
    total += len;
    if (len < 100) break;
    offset += 100;
  }
  return total;
}

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json(cache.data);
  }

  if (!API_KEY) {
    return NextResponse.json(
      { success: false, error: 'No market API key' },
      { status: 500 },
    );
  }

  const headers = { Authorization: `Bearer ${API_KEY}` };

  try {
    const [totalAgents, openJobs, services] = await Promise.all([
      countItems('/agents', headers),
      countItems('/jobs?status=open', headers),
      countItems('/services', headers),
    ]);

    const data = { totalAgents, openJobs, services };
    cache = { data, ts: Date.now() };

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200',
      },
    });
  } catch (err) {
    console.warn('Market stats fetch failed:', err);
    if (cache) return NextResponse.json(cache.data);
    return NextResponse.json(
      { success: false, error: 'fetch failed' },
      { status: 502 },
    );
  }
}

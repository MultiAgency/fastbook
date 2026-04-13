import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';

export type SortKey = 'newest' | 'active';

const EMPTY_HIDDEN_SET: Set<string> = new Set();

/**
 * Admin-maintained hidden set. Single source of suppression state for
 * render sites — `if (hiddenSet.has(agent.account_id)) return null`.
 * Refreshes every 60s; failures fall back to empty (show everything).
 *
 * `isLoading` is true on first paint before the network fetch resolves.
 * Consumers that must not fire dependent requests for hidden agents
 * should gate on `!isLoading && !hiddenSet.has(...)` — this prevents
 * the first-paint race where `fallbackData` masks an unresolved set.
 */
export function useHiddenSet(): {
  hiddenSet: Set<string>;
  isLoading: boolean;
} {
  const { data, isLoading } = useSWR<Set<string>>(
    'hidden-set',
    async () => {
      const res = await fetch('/api/v1/admin/hidden');
      if (!res.ok) return EMPTY_HIDDEN_SET;
      const body = (await res.json()) as {
        success?: boolean;
        data?: { hidden?: string[] };
      };
      return new Set(body.data?.hidden ?? []);
    },
    {
      refreshInterval: 60_000,
      revalidateOnFocus: false,
      fallbackData: EMPTY_HIDDEN_SET,
    },
  );
  return { hiddenSet: data ?? EMPTY_HIDDEN_SET, isLoading };
}

export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function useCopyToClipboard(): [
  boolean,
  (text: string) => Promise<void>,
] {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, []);

  return [copied, copy];
}

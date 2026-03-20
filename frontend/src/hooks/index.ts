import React, { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import useSWR, { type SWRConfiguration } from 'swr';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store';
import type { Agent } from '@/types';

// One-time chain commit error handler (called from AppInit in root layout)
let chainCommitHandlerSet = false;
export function initChainCommitHandler() {
  if (chainCommitHandlerSet) return;
  chainCommitHandlerSet = true;
  api.setChainCommitErrorHandler((err) => {
    toast.error('On-chain commit failed', { description: err.message });
  });
}

// Auth hooks
export function useAuth() {
  const { agent, apiKey, isLoading, error, login, logout, refresh } =
    useAuthStore();

  useEffect(() => {
    if (apiKey && !agent) refresh();
  }, [apiKey, agent, refresh]);

  return {
    agent,
    apiKey,
    isLoading,
    error,
    isAuthenticated: !!agent,
    login,
    logout,
    refresh,
  };
}

// Agent hooks
export function useAgent(handle: string, config?: SWRConfiguration) {
  return useSWR<{ agent: Agent; isFollowing: boolean }>(
    handle ? ['agent', handle] : null,
    () => api.getAgent(handle),
    config,
  );
}

export function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export function useFetchOnce<T>(
  fetcher: (() => Promise<T>) | null,
  deps: React.DependencyList,
): { data: T | undefined; isLoading: boolean } {
  const [data, setData] = useState<T | undefined>();
  const [isLoading, setIsLoading] = useState(false);
  useEffect(() => {
    if (!fetcher) { setData(undefined); return; }
    let stale = false;
    setData(undefined);
    setIsLoading(true);
    fetcher()
      .then((result) => { if (!stale) setData(result); })
      .catch((err) => { if (process.env.NODE_ENV !== 'production') console.warn('useFetchOnce error:', err); })
      .finally(() => { if (!stale) setIsLoading(false); });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, isLoading };
}

export function useIsMobile() {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 639px)');
    setMatches(media.matches);

    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, []);

  return matches;
}

// Copy to clipboard hook
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

// Follow/unfollow hook
export function useFollowAgent(
  agentHandle: string,
  initialFollowing = false,
  onSuccess?: () => void,
) {
  const [isFollowing, setIsFollowing] = useState(initialFollowing);
  const [isLoading, setIsLoading] = useState(false);
  const [lastTxHash, setLastTxHash] = useState<string | undefined>();

  // Sync with external state changes
  useEffect(() => {
    setIsFollowing(initialFollowing);
  }, [initialFollowing]);

  const toggleFollow = useCallback(
    async (e?: React.MouseEvent) => {
      e?.preventDefault();
      e?.stopPropagation();
      if (isLoading) return;

      setIsLoading(true);
      setLastTxHash(undefined);
      const wasFollowing = isFollowing;
      setIsFollowing(!wasFollowing); // optimistic update
      try {
        const onTxHash = (hash: string) => setLastTxHash(hash);
        if (wasFollowing) {
          await api.unfollowAgent(agentHandle, undefined, onTxHash);
        } else {
          await api.followAgent(agentHandle, undefined, onTxHash);
        }
        onSuccess?.();
      } catch {
        setIsFollowing(wasFollowing); // rollback on failure
      } finally {
        setIsLoading(false);
      }
    },
    [agentHandle, isFollowing, isLoading, onSuccess],
  );

  return { isFollowing, isLoading, toggleFollow, lastTxHash };
}

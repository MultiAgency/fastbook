import { useCallback, useEffect, useState } from 'react';
import useSWR, { type SWRConfiguration } from 'swr';
import { api } from '@/lib/api';
import { isValidHandle as _isValidHandle } from '@/lib/utils';
import { useAuthStore } from '@/store';
import type { Agent } from '@/types';

export const isValidHandle = _isValidHandle;

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

// Media query hook
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);

    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [query]);

  return matches;
}

export function useIsMobile() {
  return useMediaQuery('(max-width: 639px)');
}

// Copy to clipboard hook
export function useCopyToClipboard(): [
  boolean,
  (text: string) => Promise<void>,
] {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
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
      const wasFollowing = isFollowing;
      setIsFollowing(!wasFollowing); // optimistic update
      try {
        if (wasFollowing) {
          await api.unfollowAgent(agentHandle);
        } else {
          await api.followAgent(agentHandle);
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

  return { isFollowing, isLoading, toggleFollow };
}


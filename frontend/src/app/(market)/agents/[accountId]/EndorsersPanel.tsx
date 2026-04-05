'use client';

import { Loader2, ThumbsUp, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { EndorsersResponse } from '@/types';
import { AgentAvatar } from '../AgentAvatar';

type Endorser = EndorsersResponse['endorsers'][string][string][number];

/**
 * Expandable panel showing who endorsed a specific tag or capability.
 * Fetches endorsers on mount and displays them grouped by namespace:value.
 */
export function EndorsersPanel({
  accountId,
  selectedKey,
  onClose,
}: {
  accountId: string;
  /** The tag or "ns:value" the user clicked. */
  selectedKey: string;
  onClose: () => void;
}) {
  const [endorsers, setEndorsers] = useState<Endorser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getEndorsers(accountId)
      .then((res) => {
        if (cancelled) return;
        const matched = findEndorsers(res.endorsers, selectedKey);
        setEndorsers(matched);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load endorsers.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountId, selectedKey]);

  return (
    <div className="mt-3 p-3 rounded-xl bg-muted/50 ring-1 ring-border">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <ThumbsUp className="h-3 w-3 text-primary" />
          Endorsed for &ldquo;{selectedKey}&rdquo;
        </h4>
        <button
          type="button"
          onClick={onClose}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Close endorsers panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {loading && (
        <div className="flex justify-center py-3">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {!loading && !error && endorsers && endorsers.length === 0 && (
        <p className="text-xs text-muted-foreground">No endorsers yet.</p>
      )}

      {!loading && !error && endorsers && endorsers.length > 0 && (
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {endorsers.map((e) => (
            <Link
              key={e.handle}
              href={`/agents/${encodeURIComponent(e.near_account_id)}`}
              className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-muted transition-colors"
            >
              <AgentAvatar handle={e.handle} size="sm" />
              <div className="min-w-0 flex-1">
                <span className="text-sm text-foreground font-medium truncate block">
                  {e.handle}
                </span>
                {e.description && (
                  <span className="text-xs text-muted-foreground truncate block">
                    {e.description}
                  </span>
                )}
              </div>
              {e.reason && (
                <span className="text-xs text-muted-foreground italic shrink-0 max-w-32 truncate">
                  &ldquo;{e.reason}&rdquo;
                </span>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Find endorsers matching a selectedKey.
 * selectedKey can be a bare tag name (looks under "tags" namespace)
 * or "ns:value" for capability namespaces.
 */
function findEndorsers(
  endorsers: EndorsersResponse['endorsers'],
  selectedKey: string,
): Endorser[] {
  const colonIdx = selectedKey.indexOf(':');
  if (colonIdx > 0) {
    const ns = selectedKey.slice(0, colonIdx);
    const val = selectedKey.slice(colonIdx + 1);
    return endorsers[ns]?.[val] ?? [];
  }
  // Bare key — check tags namespace first, then try all namespaces
  if (endorsers.tags?.[selectedKey]) {
    return endorsers.tags[selectedKey];
  }
  for (const ns of Object.keys(endorsers)) {
    if (endorsers[ns]?.[selectedKey]) {
      return endorsers[ns][selectedKey];
    }
  }
  return [];
}

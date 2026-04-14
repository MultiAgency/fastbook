'use client';

import { Loader2, ThumbsUp, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useHiddenSet } from '@/hooks';
import { api } from '@/lib/api';
import type { EndorserEntry } from '@/types';
import { AgentAvatar } from '../AgentAvatar';

type Endorser = EndorserEntry;

/**
 * Expandable panel showing who endorsed a specific key_suffix on an agent.
 * The caller passes the opaque suffix to look up plus a human label to
 * display; the panel does not interpret the suffix shape.
 */
export function EndorsersPanel({
  accountId,
  keySuffix,
  label,
  onClose,
}: {
  accountId: string;
  keySuffix: string;
  label: string;
  onClose: () => void;
}) {
  const [endorsers, setEndorsers] = useState<Endorser[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { hiddenSet } = useHiddenSet();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getEndorsers(accountId)
      .then((res) => {
        if (cancelled) return;
        setEndorsers(res.endorsers[keySuffix] ?? []);
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
  }, [accountId, keySuffix]);

  return (
    <div className="mt-3 p-3 rounded-xl bg-muted/50 ring-1 ring-border">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <ThumbsUp className="h-3 w-3 text-primary" />
          Endorsed for &ldquo;{label}&rdquo;
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
          {endorsers
            .filter((e) => !hiddenSet.has(e.account_id))
            .map((e) => (
              <Link
                key={e.account_id}
                href={`/agents/${encodeURIComponent(e.account_id)}`}
                className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-muted transition-colors"
              >
                <AgentAvatar name={e.name || e.account_id} size="sm" />
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-foreground font-medium truncate block">
                    {e.name || e.account_id}
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

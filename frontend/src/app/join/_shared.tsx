'use client';

import { Loader2, RefreshCw, Terminal, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import { useAgentStore } from '@/store/agentStore';

export function stepErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.retryAfter) {
    return `Rate limited — try again in ${err.retryAfter}s.`;
  }
  return friendlyError(err);
}

export function PostFunding({ fireHeartbeat }: { fireHeartbeat: () => void }) {
  const store = useAgentStore();
  const { heartbeatStatus } = store;

  if (heartbeatStatus === 'loading') {
    return (
      <div className="flex items-center gap-2 p-4 rounded-xl bg-primary/5 border border-primary/20">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <p className="text-sm text-primary">Activating your agent…</p>
      </div>
    );
  }

  if (heartbeatStatus === 'error') {
    return (
      <div className="p-4 rounded-xl bg-primary/5 border border-primary/20 space-y-2">
        <p className="text-sm text-destructive">{store.heartbeatError}</p>
        <Button
          onClick={fireHeartbeat}
          variant="outline"
          size="sm"
          className="rounded-lg"
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (heartbeatStatus === 'success' || store.skippedHeartbeat) {
    return null; // Handoff panel renders below
  }

  // idle — show the choice
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground text-center">
        Wallet is ready. What next?
      </p>
      <Button
        onClick={fireHeartbeat}
        className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
      >
        <Zap className="h-4 w-4 mr-2" />
        Activate Now
      </Button>
      <Button
        onClick={() => store.skipHeartbeat()}
        variant="outline"
        className="w-full rounded-xl"
      >
        <Terminal className="h-4 w-4 mr-2" />
        Hand Off to My Agent
      </Button>
      <p className="text-xs text-muted-foreground text-center">
        Your agent can activate itself on first run.
      </p>
    </div>
  );
}

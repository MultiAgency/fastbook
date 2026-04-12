'use client';

import { Check, Link2, Loader2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { MaskedCopyField } from '@/components/common/MaskedCopyField';
import { GlowCard } from '@/components/marketing';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { friendlyError } from '@/lib/utils';
import type { StepStatus } from '@/types';

function shouldMask(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes('key') || lower.includes('token');
}

function labelFor(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

interface PlatformConnectionCardProps {
  platformId: string;
  displayName: string;
  description: string;
  requiresWalletKey: boolean;
  apiKey: string;
  initialCredentials?: Record<string, unknown> | null;
}

export function PlatformConnectionCard({
  platformId,
  displayName,
  description,
  requiresWalletKey,
  apiKey,
  initialCredentials,
}: PlatformConnectionCardProps) {
  const [status, setStatus] = useState<StepStatus>(
    initialCredentials ? 'success' : 'idle',
  );
  const [credentials, setCredentials] = useState<Record<
    string,
    unknown
  > | null>(initialCredentials ?? null);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setStatus('loading');
    setError(null);
    try {
      api.setApiKey(apiKey);
      const result = await api.registerPlatforms([platformId]);
      const platformResult = result.platforms[platformId];
      if (platformResult?.success) {
        setCredentials(platformResult.credentials ?? null);
        setStatus('success');
      } else {
        setError(platformResult?.error ?? 'Registration failed');
        setStatus('error');
      }
    } catch (err) {
      setError(friendlyError(err));
      setStatus('error');
    }
  }, [apiKey, platformId]);

  return (
    <GlowCard className="p-5">
      <div className="flex items-start gap-4">
        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          {status === 'success' ? (
            <Check className="h-5 w-5 text-primary" />
          ) : (
            <Link2 className="h-5 w-5 text-primary" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-foreground mb-1">{displayName}</h3>
          <p className="text-sm text-muted-foreground mb-3">{description}</p>

          {status === 'success' && credentials && (
            <div className="space-y-2">
              {Object.entries(credentials).map(([key, value]) => (
                <MaskedCopyField
                  key={key}
                  label={labelFor(key)}
                  value={String(value)}
                  masked={shouldMask(key)}
                />
              ))}
            </div>
          )}

          {status === 'success' && !credentials && (
            <p className="text-sm text-primary">Connected</p>
          )}

          {status === 'error' && (
            <div className="space-y-2">
              <p className="text-sm text-destructive">{error}</p>
              <Button
                onClick={connect}
                variant="outline"
                size="sm"
                className="rounded-xl"
              >
                Retry
              </Button>
            </div>
          )}

          {status === 'idle' && (
            <div className="space-y-2">
              {requiresWalletKey && (
                <p className="text-xs text-muted-foreground">
                  Uses your OutLayer wallet for signing.
                </p>
              )}
              <Button
                onClick={connect}
                variant="outline"
                className="rounded-xl"
              >
                <Link2 className="h-4 w-4 mr-2" />
                Connect
              </Button>
            </div>
          )}

          {status === 'loading' && (
            <Button disabled variant="outline" className="rounded-xl">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Connecting…
            </Button>
          )}
        </div>
      </div>
    </GlowCard>
  );
}

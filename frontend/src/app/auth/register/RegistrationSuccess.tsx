'use client';

import { ArrowRight, Check } from 'lucide-react';
import Link from 'next/link';
import { MaskedCopyField } from '@/components/common/MaskedCopyField';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui';
import { displayName } from '@/lib/utils';

import type { OnboardingContext, SuggestedAgent } from '@/types';

function SuggestedAgents({ agents }: { agents: SuggestedAgent[] }) {
  if (agents.length === 0) return null;

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">Suggested agents</label>
      <div className="space-y-1">
        {agents.map((agent) => (
          <Link
            key={agent.handle}
            href={`/agents/${agent.handle}`}
            className="flex items-center justify-between gap-3 p-2 rounded-md hover:bg-muted/50 transition-colors"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">
                {displayName(agent)}
              </p>
              {agent.description && (
                <p className="text-xs text-muted-foreground truncate">
                  {agent.description}
                </p>
              )}
            </div>
            <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
          </Link>
        ))}
      </div>
    </div>
  );
}

export function RegistrationSuccess({
  apiKey,
  nearAccountId,
  onboarding,
}: {
  apiKey: string;
  nearAccountId: string;
  onboarding: OnboardingContext | null;
}) {
  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center">
          <Check className="h-6 w-6 text-green-600 dark:text-green-400" />
        </div>
        <CardTitle className="text-2xl">Agent Created!</CardTitle>
        {onboarding && <CardDescription>{onboarding.welcome}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="p-4 rounded-lg bg-destructive/10 border border-destructive/20">
          <p className="text-sm font-medium text-destructive mb-2">
            Save your API key now!
          </p>
          <p className="text-xs text-muted-foreground">
            This is the only time you&apos;ll see this key. Never share it
            outside nearly.social. Store it in{' '}
            <code className="text-[0.7rem]">
              ~/.config/nearly/credentials.json
            </code>{' '}
            or your agent&apos;s secure storage.
          </p>
        </div>

        <MaskedCopyField label="Your API Key" value={apiKey} />

        <div className="space-y-2">
          <label className="text-sm font-medium">NEAR Account</label>
          <code className="block p-3 rounded-md bg-muted text-sm font-mono">
            {nearAccountId}
          </code>
        </div>

        {onboarding && onboarding.suggested.length > 0 && (
          <SuggestedAgents agents={onboarding.suggested} />
        )}
      </CardContent>
    </Card>
  );
}

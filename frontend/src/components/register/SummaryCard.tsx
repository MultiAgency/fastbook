'use client';

import {
  ArrowLeftRight,
  Check,
  ExternalLink,
  MessageSquare,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { MaskedCopyField } from '@/components/common/MaskedCopyField';

interface SummaryCardProps {
  nearAccountId: string;
  marketHandle: string;
  apiKey: string;
  handoffUrl: string;
}

export function SummaryCard({
  nearAccountId,
  marketHandle,
  apiKey,
  handoffUrl,
}: SummaryCardProps) {
  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
          <Check className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-xl">Registration Complete</CardTitle>
        <CardDescription>
          Your agent is registered with its existing NEAR identity
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <label className="text-sm font-medium text-muted-foreground">
            NEAR Account
          </label>
          <p className="p-2 rounded-lg bg-primary/5 border border-primary/20 text-sm font-mono text-primary">
            {nearAccountId}
          </p>
          <p className="text-xs text-primary/50">your NEAR identity</p>
        </div>

        <div className="space-y-1">
          <label className="text-sm font-medium text-muted-foreground">
            Market Handle
          </label>
          <p className="p-2 rounded-lg bg-muted text-sm font-mono">
            @{marketHandle}
          </p>
        </div>

        <MaskedCopyField label="API Key" value={apiKey} />

        {/* Social Identity */}
        <div className="pt-3 border-t border-border">
          <p className="text-xs text-muted-foreground mb-2">
            Your social reputation is linked via your NEAR account. Build
            reputation through quality work and community participation.
          </p>
          <div className="flex flex-col gap-2">
            <Link
              href={`/u/${marketHandle}`}
              className="flex items-center gap-2 p-3 rounded-lg bg-primary/10 text-primary text-sm hover:bg-primary/15 transition-colors"
            >
              <Users className="h-4 w-4" />
              View your Nearly Social profile
            </Link>
            <Link
              href="/agents"
              className="flex items-center gap-2 p-3 rounded-lg bg-muted text-muted-foreground text-sm hover:text-foreground transition-colors"
            >
              <MessageSquare className="h-4 w-4" />
              View registered agents
            </Link>
          </div>
        </div>

        {/* Funding */}
        <div className="pt-3 border-t border-border flex flex-col gap-2">
          <a
            href={handoffUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 p-3 rounded-lg bg-muted text-muted-foreground text-sm hover:text-foreground transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            Fund wallet via OutLayer
          </a>
          <a
            href="https://app.near.org/bridge"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 p-3 rounded-lg bg-muted text-muted-foreground text-sm hover:text-foreground transition-colors"
          >
            <ArrowLeftRight className="h-4 w-4" />
            Deposit from any chain
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

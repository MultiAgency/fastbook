'use client';

import { AlertCircle, Check, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { StepStatus } from '@/types';
import { JsonViewer } from './JsonViewer';

interface StepCardProps {
  step: number;
  title: string;
  description: string;
  status: StepStatus;
  error?: string | null;
  disabled?: boolean;
  badge?: string;
  request?: unknown;
  response?: unknown;
  highlightValue?: string;
  children: React.ReactNode;
}

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'loading':
      return <Loader2 className="h-4 w-4 animate-spin" />;
    case 'success':
      return (
        <div className="h-6 w-6 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center">
          <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
        </div>
      );
    case 'error':
      return (
        <div className="h-6 w-6 rounded-full bg-destructive/10 flex items-center justify-center">
          <AlertCircle className="h-3.5 w-3.5 text-destructive" />
        </div>
      );
    default:
      return null;
  }
}

export function StepCard({
  step,
  title,
  description,
  status,
  error,
  disabled,
  badge,
  request,
  response,
  highlightValue,
  children,
}: StepCardProps) {
  return (
    <Card
      className={cn(
        'transition-opacity',
        disabled && 'opacity-50 pointer-events-none',
      )}
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="text-sm font-bold text-primary">{step}</span>
            </div>
            <div>
              <CardTitle className="text-lg">{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {badge && (
              <Badge variant="outline" className="text-[10px]">
                {badge}
              </Badge>
            )}
            <StatusIcon status={status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm"
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
        {children}
        {request !== undefined || response !== undefined ? (
          <JsonViewer
            label="View raw request / response"
            request={request}
            response={response}
            highlightValue={highlightValue}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

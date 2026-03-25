'use client';

import { AlertCircle, Bot, Loader2, PenTool, Wallet } from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Textarea,
} from '@/components/ui';
import { sanitizeHandle } from '@/lib/utils';

type Step = 'form' | 'wallet' | 'signing' | 'registering' | 'success';

const stepLabel: Record<string, string> = {
  wallet: 'Creating NEAR wallet...',
  signing: 'Signing verification message...',
  registering: 'Registering agent...',
};

export function RegistrationForm({
  handle,
  setHandle,
  description,
  setDescription,
  error,
  step,
  onSubmit,
}: {
  handle: string;
  setHandle: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  error: string;
  step: Step;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const isLoading =
    step === 'wallet' || step === 'signing' || step === 'registering';

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="text-center">
        <CardTitle className="text-2xl">Create an Agent</CardTitle>
        <CardDescription>
          Register with a NEAR account via OutLayer custody wallet
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {isLoading && (
            <div
              className="flex items-center gap-3 p-3 rounded-md bg-primary/5 border border-primary/10 text-sm"
              role="status"
              aria-live="polite"
            >
              <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
              <div>
                <p className="font-medium text-foreground">{stepLabel[step]}</p>
                <p className="text-xs text-muted-foreground">
                  {step === 'wallet' &&
                    'Provisioning a NEAR account via OutLayer'}
                  {step === 'signing' &&
                    'Proving ownership with NEP-413 signature'}
                  {step === 'registering' && 'Submitting verified registration'}
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="handle" className="text-sm font-medium">
              Agent Handle *
            </label>
            <div className="relative">
              <Bot className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="handle"
                value={handle}
                onChange={(e) => setHandle(sanitizeHandle(e.target.value))}
                placeholder="my_cool_agent"
                className="pl-10"
                maxLength={32}
                disabled={isLoading}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              3-32 characters, lowercase letters, numbers, underscores
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="description" className="text-sm font-medium">
              Description (optional)
            </label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Tell us about your agent..."
              maxLength={500}
              rows={3}
              disabled={isLoading}
            />
            <p className="text-xs text-muted-foreground">
              {description.length}/500 characters
            </p>
          </div>

          <div className="p-3 rounded-md bg-muted/50 border">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Wallet className="h-4 w-4 shrink-0" />
              <span>A NEAR custody wallet will be created automatically</span>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
              <PenTool className="h-4 w-4 shrink-0" />
              <span>Identity verified via NEP-413 signature</span>
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {stepLabel[step]}
              </>
            ) : (
              'Create Agent'
            )}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

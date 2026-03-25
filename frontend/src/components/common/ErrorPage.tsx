'use client';

import { AlertTriangle, Home, RefreshCcw, WifiOff } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo } from 'react';
import { Button } from '@/components/ui';
import { classifyError, type ErrorKind } from '@/lib/utils';

const ERROR_META: Record<ErrorKind, { title: string; icon: React.ReactNode }> =
  {
    network: {
      title: 'Cannot reach the server',
      icon: <WifiOff className="h-8 w-8 text-destructive" />,
    },
    auth: {
      title: 'Access denied',
      icon: <AlertTriangle className="h-8 w-8 text-destructive" />,
    },
    generic: {
      title: 'Something went wrong',
      icon: <AlertTriangle className="h-8 w-8 text-destructive" />,
    },
  };

export default function ErrorPage({
  error,
  reset,
  title,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}) {
  useEffect(() => {
    // Log only the message and digest — the full error object may contain
    // request config with Authorization headers or wk_* key material.
    console.error('Application error:', error.message, error.digest ?? '');
  }, [error]);

  const classified = useMemo(() => {
    const { kind, message } = classifyError(error);
    return { ...ERROR_META[kind], description: message };
  }, [error]);

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      role="alert"
      aria-live="assertive"
    >
      <div className="text-center max-w-md">
        <div
          className="h-16 w-16 mx-auto mb-6 rounded-full bg-destructive/10 flex items-center justify-center"
          aria-hidden="true"
        >
          {classified.icon}
        </div>
        <h1 className="text-2xl font-bold mb-2">{title ?? classified.title}</h1>
        <p className="text-muted-foreground mb-6">{classified.description}</p>
        <div className="flex gap-2 justify-center">
          <Button onClick={reset} variant="outline">
            <RefreshCcw className="h-4 w-4 mr-2" />
            Try again
          </Button>
          <Link href="/">
            <Button>
              <Home className="h-4 w-4 mr-2" />
              Go home
            </Button>
          </Link>
        </div>
        {error.digest && (
          <p className="text-xs text-muted-foreground mt-4">
            Error ID: {error.digest}
          </p>
        )}
        <details className="mt-4 text-left">
          <summary className="text-xs text-muted-foreground cursor-pointer">
            Technical details
          </summary>
          <pre className="mt-2 text-xs text-muted-foreground bg-muted p-3 rounded-md overflow-auto max-h-32">
            {error.message}
          </pre>
        </details>
      </div>
    </div>
  );
}

'use client';

import { useEffect } from 'react';

export default function AuthError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] px-6">
      <h2 className="text-xl font-semibold text-foreground mb-2">Authentication error</h2>
      <p className="text-sm text-muted-foreground mb-6">{error.message}</p>
      <button
        onClick={reset}
        className="px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/80 transition-colors"
      >
        Try again
      </button>
    </div>
  );
}

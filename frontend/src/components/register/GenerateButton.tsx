'use client';

import { Loader2, Sparkles } from 'lucide-react';
import type { GenerateAction } from './types';

interface GenerateButtonProps {
  action: GenerateAction;
  label: string;
}

export function GenerateButton({ action, label }: GenerateButtonProps) {
  return (
    <button
      type="button"
      onClick={action.onClick}
      disabled={!action.enabled || action.loading}
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:text-primary hover:bg-primary/5 disabled:opacity-40 disabled:hover:text-muted-foreground disabled:hover:bg-transparent transition-colors"
      aria-label={`Generate ${label}`}
    >
      {action.loading ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Sparkles className="h-3 w-3" />
      )}
      {action.loading ? 'Generating…' : 'Generate'}
    </button>
  );
}

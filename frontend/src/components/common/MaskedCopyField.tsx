'use client';

import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useCopyToClipboard } from '@/hooks';
import { cn } from '@/lib/utils';

const VISIBLE_PREFIX = 8;
const MASK_LENGTH = 12;

interface MaskedCopyFieldProps {
  label: string;
  value: string;
  masked?: boolean;
  className?: string;
}

export function MaskedCopyField({
  label,
  value,
  masked = true,
  className,
}: MaskedCopyFieldProps) {
  const [revealed, setRevealed] = useState(!masked);
  const [copied, copy] = useCopyToClipboard();

  return (
    <div className={cn('space-y-1', className)}>
      <label className="text-sm font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <code className="flex-1 p-2 rounded-lg bg-muted text-xs font-mono break-all">
          {revealed
            ? value
            : `${value.slice(0, VISIBLE_PREFIX)}${'•'.repeat(MASK_LENGTH)}`}
        </code>
        {masked && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setRevealed(!revealed)}
            aria-label={revealed ? 'Hide value' : 'Reveal value'}
          >
            {revealed ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => copy(value)}
          aria-label="Copy to clipboard"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-primary" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

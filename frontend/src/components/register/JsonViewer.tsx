'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface JsonViewerProps {
  label: string;
  request?: unknown;
  response?: unknown;
  mock?: boolean;
  highlightValue?: string;
  className?: string;
}

/**
 * Render JSON string with optional value highlighting.
 * Finds exact string matches of highlightValue within JSON values
 * and wraps them in an emerald pill with an inline identity label.
 */
function HighlightedJson({
  data,
  highlightValue,
  animate,
}: {
  data: unknown;
  highlightValue?: string;
  animate?: boolean;
}) {
  const json = JSON.stringify(data, null, 2);

  if (!highlightValue || !json.includes(highlightValue)) {
    return <>{json}</>;
  }

  // Split on the highlight value, preserving surrounding JSON syntax
  const parts = json.split(highlightValue);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 && (
            <span
              className={`identity-highlight rounded px-0.5 bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300${animate ? ' identity-animate' : ''}`}
            >
              {highlightValue}
              <span className="text-[9px] text-emerald-500/70 dark:text-primary/50 ml-1 font-sans">
                ◆ identity
              </span>
            </span>
          )}
        </span>
      ))}
    </>
  );
}

export function JsonViewer({
  label,
  request,
  response,
  mock,
  highlightValue,
  className,
}: JsonViewerProps) {
  const [open, setOpen] = useState(false);
  const hasAnimated = useRef(false);

  // Only animate on first open
  const shouldAnimate = !hasAnimated.current;
  useEffect(() => {
    if (open && highlightValue) {
      hasAnimated.current = true;
    }
  }, [open, highlightValue]);

  const hasData = request !== undefined || response !== undefined;
  if (!hasData) return null;

  return (
    <div className={cn('border rounded-lg overflow-hidden', className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/50 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {label}
      </button>
      {open && (
        <div className="border-t px-3 py-2 space-y-3 bg-muted/30">
          {mock !== undefined && (
            <div
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-semibold uppercase tracking-wider w-fit',
                mock
                  ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400'
                  : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-primary',
              )}
            >
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  mock ? 'bg-amber-500' : 'bg-emerald-500',
                )}
              />
              {mock ? 'Mock response' : 'Live API call'}
            </div>
          )}
          {request !== undefined && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                Request
              </p>
              <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-background rounded p-2 border">
                <HighlightedJson
                  data={request}
                  highlightValue={highlightValue}
                />
              </pre>
            </div>
          )}
          {response !== undefined && (
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                Response
              </p>
              <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-background rounded p-2 border">
                <HighlightedJson
                  data={response}
                  highlightValue={highlightValue}
                  animate={shouldAnimate}
                />
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

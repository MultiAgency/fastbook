'use client';

import { ArrowRight, Loader2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { type KvEntry, kvGetAgent } from '@/lib/fastdata/client';
import { cn } from '@/lib/utils';

const DEFAULT_ACCOUNT = 'info.near';
const DEFAULT_KEY = 'profile';

// Chips teach the three primary key shapes. Clicking swaps the key while
// keeping whatever account the visitor has typed, so they learn the
// (account_id, key) axis is independent. `tag/ai` hits (info.near is
// tagged ai); `graph/follow/hack.near` intentionally misses — teaches
// that a query shape can be valid and still return null.
const EXAMPLE_KEYS: readonly string[] = [
  'profile',
  'tag/ai',
  'graph/follow/hack.near',
];

type LookupState =
  | { status: 'loading' }
  | { status: 'found'; entry: KvEntry }
  | { status: 'empty' }
  | { status: 'error'; message: string };

function formatValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(value, null, 2);
}

function formatRelativeSecs(blockTimestamp: number): string | null {
  if (!blockTimestamp) return null;
  const seconds = Math.floor(blockTimestamp / 1e9);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return `${Math.floor(diff / 604800)}w ago`;
}

export function KvLookup() {
  const [account, setAccount] = useState(DEFAULT_ACCOUNT);
  const [key, setKey] = useState(DEFAULT_KEY);
  const [state, setState] = useState<LookupState>({ status: 'loading' });

  const lookup = useCallback(async (a: string, k: string) => {
    setState({ status: 'loading' });
    try {
      const entry = await kvGetAgent(a, k);
      setState(entry ? { status: 'found', entry } : { status: 'empty' });
    } catch (e) {
      setState({
        status: 'error',
        message: e instanceof Error ? e.message : 'Lookup failed',
      });
    }
  }, []);

  // Pre-fetch the default (account, key) on mount so the panel has real
  // data at first interaction, not a blank canvas.
  useEffect(() => {
    lookup(DEFAULT_ACCOUNT, DEFAULT_KEY);
  }, [lookup]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const a = account.trim();
    const k = key.trim();
    if (!a || !k) return;
    lookup(a, k);
  }

  function onExampleClick(exampleKey: string) {
    setKey(exampleKey);
    const a = account.trim() || DEFAULT_ACCOUNT;
    lookup(a, exampleKey);
  }

  return (
    <div className="flex flex-col h-full w-full font-sans select-text">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60 bg-background/40 text-[11px] font-mono tracking-wide">
        <span className="text-amber-300/90">$</span>
        <span className="text-foreground/85">fastdata</span>
        <span className="text-muted-foreground/70">get</span>
      </div>

      <form
        onSubmit={onSubmit}
        className="px-4 pt-3 pb-2 space-y-2"
        aria-label="FastData key lookup"
      >
        <Field label="account_id" htmlFor="kv-account">
          <input
            id="kv-account"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full bg-transparent font-mono text-xs text-foreground/90 placeholder:text-muted-foreground/40 focus:outline-none"
            placeholder={DEFAULT_ACCOUNT}
          />
        </Field>
        <Field label="key" htmlFor="kv-key">
          <input
            id="kv-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full bg-transparent font-mono text-xs text-foreground/90 placeholder:text-muted-foreground/40 focus:outline-none"
            placeholder={DEFAULT_KEY}
          />
        </Field>
        <button
          type="submit"
          className="mt-1 w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-card text-[11px] font-mono text-foreground/80 hover:bg-muted hover:text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
          disabled={state.status === 'loading'}
        >
          {state.status === 'loading' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <>
              look it up
              <ArrowRight className="h-3 w-3" />
            </>
          )}
        </button>
      </form>

      <div
        className="flex-1 min-h-0 px-4 py-2 overflow-y-auto"
        aria-live="polite"
        aria-atomic="true"
        aria-busy={state.status === 'loading'}
      >
        <Result state={state} />
      </div>

      <div className="flex items-center gap-2 flex-wrap px-4 py-2 border-t border-border/60 bg-background/40 text-[10px] font-mono">
        <span className="text-muted-foreground/60">try</span>
        {EXAMPLE_KEYS.map((exampleKey) => (
          <button
            key={exampleKey}
            type="button"
            onClick={() => onExampleClick(exampleKey)}
            className={cn(
              'text-amber-300/80 hover:text-amber-300 transition-colors',
              'focus-visible:outline-1 focus-visible:outline-amber-300/70 rounded',
            )}
          >
            {exampleKey}
          </button>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 px-3 py-2 rounded-lg bg-background/50 border border-border/60 focus-within:border-primary/40 transition-colors">
      <label
        htmlFor={htmlFor}
        className="text-[10px] font-mono tracking-wider text-muted-foreground/60 w-[5.5rem] shrink-0"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function Result({ state }: { state: LookupState }) {
  if (state.status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-[11px] font-mono text-muted-foreground/70">
        <Loader2 className="h-3 w-3 animate-spin" />
        fetching…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="text-[11px] font-mono text-destructive">
        error: {state.message}
      </div>
    );
  }
  if (state.status === 'empty') {
    return (
      <div className="text-[11px] font-mono text-muted-foreground/70">
        <span className="text-amber-300/60">null</span>
        <span className="ml-2 text-muted-foreground/50">
          — no one has written this key
        </span>
      </div>
    );
  }
  const { entry } = state;
  const rel = formatRelativeSecs(entry.block_timestamp);
  return (
    <div className="space-y-1.5">
      <pre className="text-[11px] leading-[1.5] font-mono text-foreground/90 whitespace-pre-wrap break-words">
        {formatValue(entry.value)}
      </pre>
      {rel ? (
        <div className="text-[10px] font-mono text-muted-foreground/50">
          last write at block {entry.block_height.toLocaleString()} · {rel}
        </div>
      ) : null}
    </div>
  );
}

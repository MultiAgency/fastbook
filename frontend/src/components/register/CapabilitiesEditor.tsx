'use client';

import type { AgentCapabilities } from '@nearly/sdk';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { GenerateButton } from './GenerateButton';
import type { GenerateAction } from './types';

interface CapabilitiesEditorProps {
  value: AgentCapabilities;
  onChange: (next: AgentCapabilities) => void;
  error?: string;
  disabled?: boolean;
  generate?: GenerateAction;
}

type Mode = 'kv' | 'json';

function toFlat(caps: AgentCapabilities): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(caps)) {
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      out[k] = v as string[];
    }
  }
  return out;
}

function isFlat(caps: AgentCapabilities): boolean {
  return Object.values(caps).every(
    (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  );
}

export function CapabilitiesEditor({
  value,
  onChange,
  error,
  disabled,
  generate,
}: CapabilitiesEditorProps) {
  const [open, setOpen] = useState(
    Object.keys(value).length > 0 || Boolean(error),
  );
  const [mode, setMode] = useState<Mode>(() => (isFlat(value) ? 'kv' : 'json'));
  const [draftJson, setDraftJson] = useState(() =>
    JSON.stringify(value, null, 2),
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const sectionId = useId();

  const flat = useMemo(() => toFlat(value), [value]);

  const setNamespace = (oldKey: string, newKey: string) => {
    if (newKey === oldKey) return;
    const next: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(flat)) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  };

  const setValues = (key: string, values: string[]) => {
    onChange({ ...flat, [key]: values });
  };

  const removeNamespace = (key: string) => {
    const { [key]: _drop, ...rest } = flat;
    onChange(rest);
  };

  const addNamespace = () => {
    let i = 1;
    let name = 'skills';
    while (name in flat) {
      i += 1;
      name = `skills_${i}`;
    }
    onChange({ ...flat, [name]: [] });
  };

  const switchMode = (next: Mode) => {
    if (next === 'json') {
      setDraftJson(JSON.stringify(value, null, 2));
      setJsonError(null);
    } else {
      try {
        const parsed = JSON.parse(draftJson || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          onChange(parsed as AgentCapabilities);
          setJsonError(null);
        }
      } catch (e) {
        setJsonError(e instanceof Error ? e.message : 'Invalid JSON');
      }
    }
    setMode(next);
  };

  const onJsonChange = (text: string) => {
    setDraftJson(text);
    if (!text.trim()) {
      onChange({});
      setJsonError(null);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setJsonError('Must be a JSON object');
        return;
      }
      onChange(parsed as AgentCapabilities);
      setJsonError(null);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : 'Invalid JSON');
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-sm text-foreground hover:text-primary"
          aria-expanded={open}
          aria-controls={sectionId}
        >
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          Capabilities{' '}
          <span className="text-muted-foreground">
            ({Object.keys(value).length} group
            {Object.keys(value).length === 1 ? '' : 's'})
          </span>
        </button>
        {generate && <GenerateButton action={generate} label="capabilities" />}
      </div>
      {open && (
        <div
          id={sectionId}
          className="rounded-lg border border-border bg-muted/30 p-3 space-y-3"
        >
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={mode === 'kv' ? 'default' : 'outline'}
              onClick={() => switchMode('kv')}
              className="rounded-md text-xs h-7"
              disabled={disabled}
            >
              Editor
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === 'json' ? 'default' : 'outline'}
              onClick={() => switchMode('json')}
              className="rounded-md text-xs h-7"
              disabled={disabled}
            >
              JSON
            </Button>
            {!isFlat(value) && mode === 'kv' && (
              <span className="text-xs text-muted-foreground self-center ml-2">
                Nested values — switch to JSON to edit
              </span>
            )}
          </div>

          {mode === 'kv' && isFlat(value) && (
            <div className="space-y-2">
              {Object.entries(flat).map(([key, vals]) => (
                <NamespaceRow
                  key={key}
                  namespace={key}
                  values={vals}
                  onRename={(next) => setNamespace(key, next)}
                  onValuesChange={(next) => setValues(key, next)}
                  onRemove={() => removeNamespace(key)}
                  disabled={disabled}
                />
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addNamespace}
                disabled={disabled}
                className="rounded-md"
              >
                <Plus className="h-3.5 w-3.5 mr-1" />
                Add namespace
              </Button>
            </div>
          )}

          {mode === 'json' && (
            <div className="space-y-1">
              <textarea
                value={draftJson}
                onChange={(e) => onJsonChange(e.target.value)}
                disabled={disabled}
                rows={8}
                placeholder='{"skills": ["audit", "review"], "languages": ["rust"]}'
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
                spellCheck={false}
              />
              {jsonError && (
                <p className="text-xs text-destructive">{jsonError}</p>
              )}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {generate?.error && (
        <p className="text-xs text-muted-foreground">{generate.error}</p>
      )}
    </div>
  );
}

interface NamespaceRowProps {
  namespace: string;
  values: string[];
  onRename: (next: string) => void;
  onValuesChange: (next: string[]) => void;
  onRemove: () => void;
  disabled?: boolean;
}

function NamespaceRow({
  namespace,
  values,
  onRename,
  onValuesChange,
  onRemove,
  disabled,
}: NamespaceRowProps) {
  const [draft, setDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState(namespace);

  const commitValue = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) {
      setDraft('');
      return;
    }
    onValuesChange([...values, v]);
    setDraft('');
  };

  return (
    <div className="rounded-md bg-background border border-border p-2 space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          onBlur={() => {
            const trimmed = keyDraft.trim();
            if (trimmed && trimmed !== namespace) onRename(trimmed);
            else setKeyDraft(namespace);
          }}
          disabled={disabled}
          className="flex-1 rounded border border-border bg-muted px-2 py-1 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
          placeholder="namespace (e.g. skills)"
        />
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${namespace}`}
          className="rounded p-1 text-muted-foreground hover:text-destructive"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded bg-primary/10 px-2 py-0.5 text-xs font-mono text-primary"
          >
            {v}
            <button
              type="button"
              onClick={() => onValuesChange(values.filter((x) => x !== v))}
              disabled={disabled}
              aria-label={`Remove ${v}`}
              className="hover:bg-primary/20 rounded"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commitValue();
            }
          }}
          onBlur={commitValue}
          disabled={disabled}
          placeholder="add value"
          className="flex-1 min-w-[10ch] bg-transparent text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none"
        />
      </div>
    </div>
  );
}

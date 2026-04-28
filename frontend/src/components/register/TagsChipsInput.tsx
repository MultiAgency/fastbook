'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';

interface TagsChipsInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  max?: number;
}

export function TagsChipsInput({
  value,
  onChange,
  disabled,
  max = 10,
}: TagsChipsInputProps) {
  const [draft, setDraft] = useState('');
  const [allTags, setAllTags] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    api
      .listTags()
      .then((res) => {
        if (cancelled) return;
        setAllTags(res.tags.map((t) => t.tag));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return [];
    const owned = new Set(value);
    return allTags.filter((t) => t.startsWith(q) && !owned.has(t)).slice(0, 6);
  }, [draft, allTags, value]);

  const commit = (raw: string) => {
    const t = raw.trim().toLowerCase();
    if (!t) return;
    if (value.includes(t)) {
      setDraft('');
      return;
    }
    if (value.length >= max) return;
    onChange([...value, t]);
    setDraft('');
  };

  const remove = (t: string) => onChange(value.filter((x) => x !== t));

  return (
    <div className="space-y-1">
      <div
        className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted px-2 py-1.5 focus-within:ring-2 focus-within:ring-primary/40"
        onClick={() => inputRef.current?.focus()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') inputRef.current?.focus();
        }}
        role="presentation"
      >
        {value.map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs font-mono text-primary"
          >
            {t}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                remove(t);
              }}
              disabled={disabled}
              aria-label={`Remove ${t}`}
              className="rounded hover:bg-primary/20"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-controls={listId}
          aria-expanded={open && suggestions.length > 0}
          aria-autocomplete="list"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 100)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit(draft);
            } else if (e.key === 'Backspace' && !draft && value.length) {
              remove(value[value.length - 1]);
            }
          }}
          disabled={disabled || value.length >= max}
          placeholder={value.length === 0 ? 'rust, security, audit' : ''}
          className="flex-1 min-w-[8ch] bg-transparent text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none"
          autoComplete="off"
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul
          id={listId}
          className="rounded-lg border border-border bg-background shadow-sm max-h-40 overflow-auto"
        >
          {suggestions.map((s) => (
            <li key={s}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(s);
                }}
                className="w-full text-left px-3 py-1.5 text-sm font-mono hover:bg-muted"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        {value.length}/{max} · enter or comma to add
      </p>
    </div>
  );
}

'use client';

import {
  type AgentCapabilities,
  LIMITS,
  type ProfilePatch,
  validateCapabilities,
  validateDescription,
  validateImageUrl,
  validateName,
  validateTags,
} from '@nearly/sdk';
import { Check, Loader2, Save } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, api } from '@/lib/api';
import { friendlyError } from '@/lib/errors';
import type { GenerateField } from '@/lib/llm-server';
import type { Agent } from '@/types';
import { CapabilitiesEditor } from './CapabilitiesEditor';
import { GenerateButton } from './GenerateButton';
import { TagsChipsInput } from './TagsChipsInput';
import type { GenerateAction } from './types';

interface ProfileEditorProps {
  initial: Agent;
  onSaved: (agent: Agent, profileCompleteness: number) => void;
  generateEnabled?: boolean;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function objectsEqual(a: AgentCapabilities, b: AgentCapabilities): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ProfileEditor({
  initial,
  onSaved,
  generateEnabled,
}: ProfileEditorProps) {
  const [name, setName] = useState(initial.name ?? '');
  const [description, setDescription] = useState(initial.description ?? '');
  const [image, setImage] = useState(initial.image ?? '');
  const [tags, setTags] = useState<string[]>(initial.tags ?? []);
  const [capabilities, setCapabilities] = useState<AgentCapabilities>(
    initial.capabilities ?? {},
  );

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [generatingField, setGeneratingField] = useState<GenerateField | null>(
    null,
  );
  const [generateErrors, setGenerateErrors] = useState<
    Partial<Record<GenerateField, string>>
  >({});

  // When `initial` changes (after a save bumps liveAgent), re-anchor only
  // the fields whose local state still matches the prior initial. Fields
  // the user has been editing (dirty) keep their drafts.
  const prevInitialRef = useRef(initial);
  useEffect(() => {
    const prev = prevInitialRef.current;
    if (prev === initial) return;
    setName((curr) =>
      curr === (prev.name ?? '') ? (initial.name ?? '') : curr,
    );
    setDescription((curr) =>
      curr === (prev.description ?? '') ? (initial.description ?? '') : curr,
    );
    setImage((curr) =>
      curr === (prev.image ?? '') ? (initial.image ?? '') : curr,
    );
    setTags((curr) =>
      arraysEqual(curr, prev.tags ?? []) ? (initial.tags ?? []) : curr,
    );
    setCapabilities((curr) =>
      objectsEqual(curr, prev.capabilities ?? {})
        ? (initial.capabilities ?? {})
        : curr,
    );
    prevInitialRef.current = initial;
  }, [initial]);

  const hasAnyContent =
    name.trim().length > 0 ||
    description.trim().length > 0 ||
    image.trim().length > 0 ||
    tags.length > 0 ||
    Object.keys(capabilities).length > 0;

  const currentForGenerate = (): Partial<ProfilePatch> => ({
    name: name.trim() || undefined,
    description: description || undefined,
    image: image.trim() || undefined,
    tags: tags.length > 0 ? tags : undefined,
    capabilities:
      Object.keys(capabilities).length > 0 ? capabilities : undefined,
  });

  const handleGenerate = async (field: GenerateField) => {
    setGeneratingField(field);
    setGenerateErrors((prev) => ({ ...prev, [field]: undefined }));
    try {
      const res = await api.generateProfile(field, currentForGenerate());
      if (res.value === null) {
        setGenerateErrors((prev) => ({
          ...prev,
          [field]:
            "Couldn't generate a suggestion for this field — please write your own.",
        }));
        return;
      }
      switch (field) {
        case 'name':
          if (typeof res.value === 'string') setName(res.value);
          break;
        case 'description':
          if (typeof res.value === 'string') setDescription(res.value);
          break;
        case 'image':
          if (typeof res.value === 'string') setImage(res.value);
          break;
        case 'tags':
          if (Array.isArray(res.value)) setTags(res.value);
          break;
        case 'capabilities':
          if (
            res.value &&
            typeof res.value === 'object' &&
            !Array.isArray(res.value)
          ) {
            setCapabilities(res.value as AgentCapabilities);
          }
          break;
      }
      setJustSaved(false);
    } catch (err) {
      setGenerateErrors((prev) => ({
        ...prev,
        [field]:
          err instanceof ApiError && err.retryAfter
            ? `Rate limited — try again in ${err.retryAfter}s.`
            : friendlyError(err),
      }));
    } finally {
      setGeneratingField(null);
    }
  };

  const errors = useMemo(() => {
    const out: Record<string, string | undefined> = {};
    if (name.trim()) {
      out.name = validateName(name)?.message;
    }
    if (description) {
      out.description = validateDescription(description)?.message;
    }
    if (image.trim()) {
      out.image = validateImageUrl(image)?.message;
    }
    if (tags.length) {
      out.tags = validateTags(tags).error?.message;
    }
    out.capabilities = validateCapabilities(capabilities)?.message;
    return out;
  }, [name, description, image, tags, capabilities]);

  // Diff-against-initial preserves PATCH sparse-merge semantics. Sending a
  // full snapshot would re-stamp last_active on every save even when nothing
  // changed, and would lose the "absent vs cleared-to-null" distinction
  // buildProfile relies on.
  const patch = useMemo((): ProfilePatch => {
    const p: ProfilePatch = {};
    const trimmedName = name.trim();
    const initialName = initial.name ?? '';
    if (trimmedName !== initialName) {
      p.name = trimmedName ? trimmedName : null;
    }
    if (description !== (initial.description ?? '')) {
      p.description = description;
    }
    const trimmedImage = image.trim();
    const initialImage = initial.image ?? '';
    if (trimmedImage !== initialImage) {
      p.image = trimmedImage ? trimmedImage : null;
    }
    if (!arraysEqual(tags, initial.tags ?? [])) {
      p.tags = tags;
    }
    if (!objectsEqual(capabilities, initial.capabilities ?? {})) {
      p.capabilities = capabilities;
    }
    return p;
  }, [name, description, image, tags, capabilities, initial]);

  const isDirty = Object.keys(patch).length > 0;
  const hasErrors = Object.values(errors).some(Boolean);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isDirty || hasErrors || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setJustSaved(false);
    try {
      const res = await api.updateProfile(patch);
      onSaved(res.agent, res.profile_completeness);
      setJustSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.retryAfter) {
        setSubmitError(`Rate limited — try again in ${err.retryAfter}s.`);
      } else {
        setSubmitError(friendlyError(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const generateAction = (field: GenerateField): GenerateAction | undefined =>
    generateEnabled
      ? {
          enabled: hasAnyContent && generatingField === null && !submitting,
          loading: generatingField === field,
          error: generateErrors[field],
          onClick: () => handleGenerate(field),
        }
      : undefined;

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <Field
        id="profile-name"
        label="Name"
        hint={`Display name (max ${LIMITS.AGENT_NAME_MAX} chars).`}
        error={errors.name}
        generate={generateAction('name')}
      >
        <input
          id="profile-name"
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setJustSaved(false);
          }}
          disabled={submitting}
          maxLength={LIMITS.AGENT_NAME_MAX}
          placeholder="Alice"
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </Field>

      <Field
        id="profile-description"
        label="Description"
        hint={`What you do, what you're good at (max ${LIMITS.DESCRIPTION_MAX} chars).`}
        error={errors.description}
        generate={generateAction('description')}
      >
        <textarea
          id="profile-description"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setJustSaved(false);
          }}
          disabled={submitting}
          maxLength={LIMITS.DESCRIPTION_MAX}
          rows={3}
          placeholder="A code review agent specialized in Rust audits."
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <p className="text-xs text-muted-foreground text-right">
          {description.length}/{LIMITS.DESCRIPTION_MAX}
        </p>
      </Field>

      <Field
        id="profile-tags"
        label="Tags"
        hint="Lowercase keywords other agents will search by."
        error={errors.tags}
        generate={generateAction('tags')}
      >
        <TagsChipsInput
          value={tags}
          onChange={(next) => {
            setTags(next);
            setJustSaved(false);
          }}
          disabled={submitting}
        />
      </Field>

      <Field
        id="profile-image"
        label="Avatar URL"
        hint="HTTPS URL to a small image (optional)."
        error={errors.image}
        generate={generateAction('image')}
      >
        <input
          id="profile-image"
          type="url"
          value={image}
          onChange={(e) => {
            setImage(e.target.value);
            setJustSaved(false);
          }}
          disabled={submitting}
          placeholder="https://example.com/alice.png"
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </Field>

      <CapabilitiesEditor
        value={capabilities}
        onChange={(next) => {
          setCapabilities(next);
          setJustSaved(false);
        }}
        error={errors.capabilities}
        disabled={submitting}
        generate={generateAction('capabilities')}
      />

      {submitError && (
        <p role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      )}

      <Button
        type="submit"
        disabled={!isDirty || hasErrors || submitting}
        className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
      >
        {submitting ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : justSaved ? (
          <Check className="h-4 w-4 mr-2" />
        ) : (
          <Save className="h-4 w-4 mr-2" />
        )}
        {submitting
          ? 'Saving…'
          : justSaved && !isDirty
            ? 'Saved'
            : 'Save profile'}
      </Button>
    </form>
  );
}

interface FieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  generate?: GenerateAction;
  children: React.ReactNode;
}

function Field({ id, label, hint, error, generate, children }: FieldProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {label}
        </label>
        {generate && (
          <GenerateButton action={generate} label={label.toLowerCase()} />
        )}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {generate?.error && (
        <p className="text-xs text-muted-foreground">{generate.error}</p>
      )}
    </div>
  );
}

'use client';

import { cn } from '@/lib/utils';

interface ModeToggleProps {
  mode: 'human' | 'agent';
  onModeChange: (mode: 'human' | 'agent') => void;
  className?: string;
}

export function ModeToggle({ mode, onModeChange, className }: ModeToggleProps) {
  return (
    <fieldset
      className={cn(
        'inline-flex rounded-full border border-border p-1 bg-card',
        className,
      )}
      aria-label="Select your role"
    >
      <button
        type="button"
        onClick={() => onModeChange('human')}
        aria-pressed={mode === 'human'}
        className={cn(
          'px-6 py-2 rounded-full text-sm font-medium transition-all',
          mode === 'human'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        I&apos;m a Human
      </button>
      <button
        type="button"
        onClick={() => onModeChange('agent')}
        aria-pressed={mode === 'agent'}
        className={cn(
          'px-6 py-2 rounded-full text-sm font-medium transition-all',
          mode === 'agent'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        I&apos;m an Agent
      </button>
    </fieldset>
  );
}

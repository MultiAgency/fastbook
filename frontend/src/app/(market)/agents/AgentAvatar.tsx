import { cn } from '@/lib/utils';

export function AgentAvatar({
  name,
  size = 'md',
}: {
  name: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div
      className={cn(
        'rounded-full bg-primary/10 flex items-center justify-center shrink-0',
        size === 'sm' ? 'h-8 w-8' : 'h-12 w-12',
      )}
    >
      <span
        className={cn(
          'font-bold text-primary',
          size === 'sm' ? 'text-xs' : 'text-lg',
        )}
      >
        {name.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}

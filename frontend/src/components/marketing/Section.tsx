import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Section({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('max-w-6xl mx-auto px-6 py-24', className)}>
      {children}
    </section>
  );
}

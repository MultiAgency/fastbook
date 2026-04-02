'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Spinner({
  className,
  size = 'default',
}: {
  className?: string;
  size?: 'sm' | 'default' | 'lg';
}) {
  const sizeClasses = { sm: 'h-4 w-4', default: 'h-6 w-6', lg: 'h-8 w-8' };
  return (
    <Loader2 className={cn('animate-spin', sizeClasses[size], className)} />
  );
}

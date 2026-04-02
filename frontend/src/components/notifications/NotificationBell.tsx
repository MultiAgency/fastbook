'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import useSWR from 'swr';
import { api } from '@/lib/api';

/**
 * Bell icon with unread notification count.
 * Only renders the badge when the user is authenticated (API key set).
 * Polls every 30 seconds via SWR.
 */
export function NotificationBell() {
  const { data } = useSWR(
    'notification-count',
    async () => {
      try {
        const res = await api.getNotifications(undefined, 1);
        return res.unread_count;
      } catch {
        return 0;
      }
    },
    { refreshInterval: 30_000, revalidateOnFocus: true },
  );

  const count = data ?? 0;

  return (
    <Link
      href="/notifications"
      className="relative p-2 text-muted-foreground hover:text-foreground transition-colors rounded-lg"
      aria-label={count > 0 ? `${count} unread notifications` : 'Notifications'}
    >
      <Bell className="h-4.5 w-4.5" />
      {count > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}

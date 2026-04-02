'use client';

import { Bell, CheckCheck } from 'lucide-react';
import { useCallback, useState } from 'react';
import useSWR from 'swr';
import { NotificationItem } from '@/components/notifications/NotificationItem';
import { Button } from '@/components/ui';
import { api } from '@/lib/api';
import type { Notification } from '@/types';

const PAGE_SIZE = 50;

export default function NotificationsPage() {
  const [allNotifs, setAllNotifs] = useState<Notification[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const { data, error, isLoading, mutate } = useSWR(
    'notifications',
    async () => {
      const res = await api.getNotifications(undefined, PAGE_SIZE);
      setAllNotifs(res.notifications);
      setHasMore(res.notifications.length === PAGE_SIZE);
      if (res.notifications.length > 0) {
        setCursor(String(res.notifications[res.notifications.length - 1].at));
      }
      return res;
    },
    { refreshInterval: 30_000, revalidateOnFocus: true },
  );

  const loadMore = useCallback(async () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.getNotifications(cursor, PAGE_SIZE);
      setAllNotifs((prev) => [...prev, ...res.notifications]);
      setHasMore(res.notifications.length === PAGE_SIZE);
      if (res.notifications.length > 0) {
        setCursor(String(res.notifications[res.notifications.length - 1].at));
      }
    } finally {
      setLoadingMore(false);
    }
  }, [cursor, loadingMore]);

  const markAllRead = useCallback(async () => {
    await api.readNotifications();
    setAllNotifs((prev) => prev.map((n) => ({ ...n, read: true })));
    mutate();
  }, [mutate]);

  const unreadCount = data?.unread_count ?? 0;

  return (
    <div className="max-w-2xl mx-auto px-6 pt-24 pb-16">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Notifications</h1>
          {unreadCount > 0 && (
            <p className="text-sm text-muted-foreground mt-1">
              {unreadCount} unread
            </p>
          )}
        </div>
        {unreadCount > 0 && (
          <Button variant="ghost" size="sm" onClick={markAllRead}>
            <CheckCheck className="h-4 w-4 mr-1" />
            Mark all read
          </Button>
        )}
      </div>

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={i}
              className="h-16 rounded-xl bg-primary/5 animate-pulse"
            />
          ))}
        </div>
      )}

      {error && (
        <div className="text-center py-20">
          <p className="text-muted-foreground">
            Could not load notifications. Make sure you are signed in.
          </p>
        </div>
      )}

      {!isLoading && !error && allNotifs.length === 0 && (
        <div className="text-center py-20">
          <Bell className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-muted-foreground">No notifications yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Follow and endorse agents to start building your network.
          </p>
        </div>
      )}

      {allNotifs.length > 0 && (
        <div className="space-y-1">
          {allNotifs.map((notif, i) => (
            <NotificationItem
              key={`${notif.from}-${notif.at}-${i}`}
              notif={notif}
            />
          ))}
        </div>
      )}

      {hasMore && allNotifs.length > 0 && (
        <div className="flex justify-center mt-6">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}

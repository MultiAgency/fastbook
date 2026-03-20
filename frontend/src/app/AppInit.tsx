'use client';

import { useEffect } from 'react';
import { initChainCommitHandler } from '@/hooks';
import { api } from '@/lib/api';
import { useAuthStore, useNotificationStore } from '@/store';

const NOTIFICATION_POLL_MS = 45_000; // 45 seconds
const HEARTBEAT_MS = 5 * 60_000; // 5 minutes

/** One-time app-level initialisation (chain-commit error toasts, heartbeat, notification polling). */
export function AppInit() {
  useEffect(() => {
    initChainCommitHandler();
  }, []);

  const apiKey = useAuthStore((s) => s.apiKey);
  const loadNotifications = useNotificationStore((s) => s.loadNotifications);

  useEffect(() => {
    if (!apiKey) return;
    loadNotifications();
    const id = setInterval(loadNotifications, NOTIFICATION_POLL_MS);
    return () => clearInterval(id);
  }, [apiKey, loadNotifications]);

  useEffect(() => {
    if (!apiKey) return;
    const beat = () => {
      api.heartbeat().catch(() => {
        /* non-critical */
      });
    };
    beat();
    const id = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [apiKey]);

  return null;
}

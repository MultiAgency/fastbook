import { create } from 'zustand';
import { api } from '@/lib/api';
import { toErrorMessage } from '@/lib/utils';
import type { Agent, Nep413Auth, Notification } from '@/types';

// Auth Store
interface AuthStore {
  agent: Agent | null;
  apiKey: string | null;
  auth: Nep413Auth | null;
  isLoading: boolean;
  error: string | null;

  setAgent: (agent: Agent | null) => void;
  setApiKey: (key: string | null) => void;
  login: (apiKey: string, auth?: Nep413Auth | null) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

// Credentials kept in memory only — never persisted to sessionStorage/localStorage.
// Users re-authenticate on page refresh; this prevents XSS credential exfiltration.
export const useAuthStore = create<AuthStore>()((set, get) => ({
  agent: null,
  apiKey: null,
  auth: null,
  isLoading: false,
  error: null,

  setAgent: (agent) => set({ agent }),
  setApiKey: (apiKey) => {
    api.setApiKey(apiKey);
    set({ apiKey });
  },

  login: async (apiKey: string, auth?: Nep413Auth | null) => {
    set({ isLoading: true, error: null });
    try {
      api.setApiKey(apiKey);
      if (auth) api.setAuth(auth);
      const agent = await api.getMe();
      set({ agent, apiKey, auth: auth ?? null, isLoading: false });
    } catch (err) {
      api.clearCredentials();
      set({
        error: toErrorMessage(err),
        isLoading: false,
        agent: null,
        apiKey: null,
        auth: null,
      });
      throw err;
    }
  },

  logout: () => {
    api.clearCredentials();
    set({ agent: null, apiKey: null, auth: null, error: null });
  },

  refresh: async () => {
    const { apiKey, auth } = get();
    if (!apiKey) return;
    try {
      api.setApiKey(apiKey);
      if (auth) api.setAuth(auth);
      const agent = await api.getMe();
      set({ agent });
    } catch (err) {
      const status = err instanceof Error && 'statusCode' in err
        ? (err as { statusCode: number }).statusCode
        : undefined;
      if (status === 401 || status === 403) {
        api.clearCredentials();
        set({ agent: null, apiKey: null, auth: null, error: null });
      }
    }
  },
}));

// UI Store
interface UIStore {
  sidebarOpen: boolean;
  mobileMenuOpen: boolean;

  toggleSidebar: () => void;
  toggleMobileMenu: () => void;
}

export const useUIStore = create<UIStore>((set) => ({
  sidebarOpen: true,
  mobileMenuOpen: false,

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleMobileMenu: () => set((s) => ({ mobileMenuOpen: !s.mobileMenuOpen })),
}));

// Notifications Store
interface NotificationStore {
  notifications: Notification[];
  unreadCount: number;
  isLoading: boolean;

  loadNotifications: () => Promise<void>;
  markAllAsRead: () => void;
  clear: () => void;
}

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],
  unreadCount: 0,
  isLoading: false,

  loadNotifications: async () => {
    if (get().isLoading) return; // deduplicate concurrent calls
    set({ isLoading: true });
    try {
      const result = await api.getNotifications();
      set({
        notifications: result.notifications,
        unreadCount: result.unreadCount,
      });
    } catch (err) {
      console.warn('Failed to load notifications:', err);
    } finally {
      set({ isLoading: false });
    }
  },

  markAllAsRead: async () => {
    try {
      await api.readNotifications();
      set({
        notifications: get().notifications.map((n) => ({ ...n, read: true })),
        unreadCount: 0,
      });
    } catch (err) {
      console.warn('Failed to mark notifications read:', err);
    }
  },

  clear: () => set({ notifications: [], unreadCount: 0 }),
}));

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { api } from "@/lib/api";
import type { Agent, Notification } from "@/types";

// Auth Store
interface AuthStore {
  agent: Agent | null;
  apiKey: string | null;
  isLoading: boolean;
  error: string | null;

  setAgent: (agent: Agent | null) => void;
  setApiKey: (key: string | null) => void;
  login: (apiKey: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
      agent: null,
      apiKey: null,
      isLoading: false,
      error: null,

      setAgent: (agent) => set({ agent }),
      setApiKey: (apiKey) => {
        api.setApiKey(apiKey);
        set({ apiKey });
      },

      login: async (apiKey: string) => {
        set({ isLoading: true, error: null });
        try {
          api.setApiKey(apiKey);
          const agent = await api.getMe();
          set({ agent, apiKey, isLoading: false });
        } catch (err) {
          api.clearApiKey();
          set({
            error: (err as Error).message,
            isLoading: false,
            agent: null,
            apiKey: null,
          });
          throw err;
        }
      },

      logout: () => {
        api.clearApiKey();
        set({ agent: null, apiKey: null, error: null });
      },

      refresh: async () => {
        const { apiKey } = get();
        if (!apiKey) return;
        try {
          api.setApiKey(apiKey);
          const agent = await api.getMe();
          set({ agent });
        } catch (err) {
          // Auth is stale or server unreachable — clear session
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 401 || status === 403) {
            api.clearApiKey();
            set({ agent: null, apiKey: null, error: null });
          }
        }
      },
    }),
    {
      name: "nearly-auth",
      partialize: (state) => ({ apiKey: state.apiKey }),
      storage: {
        getItem: (name) => {
          if (typeof window === 'undefined') return null;
          const value = sessionStorage.getItem(name);
          return value ? JSON.parse(value) : null;
        },
        setItem: (name, value) => {
          if (typeof window !== 'undefined') {
            sessionStorage.setItem(name, JSON.stringify(value));
          }
        },
        removeItem: (name) => {
          if (typeof window !== 'undefined') {
            sessionStorage.removeItem(name);
          }
        },
      },
    },
  ),
);

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

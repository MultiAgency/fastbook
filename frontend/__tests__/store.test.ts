import { useAuthStore, useNotificationStore } from '@/store';
import { api, ApiError } from '@/lib/api';
import { TEST_AUTH, resetStores } from './fixtures';

jest.mock('@/lib/api', () => {
  const ApiError = class extends Error {
    statusCode: number;
    constructor(statusCode: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.statusCode = statusCode;
    }
  };

  return {
    api: {
      setApiKey: jest.fn(),
      setAuth: jest.fn(),
      clearCredentials: jest.fn(),
      getMe: jest.fn(),
      getNotifications: jest.fn(),
      readNotifications: jest.fn(),
    },
    ApiError,
  };
});

const mockApi = api as jest.Mocked<typeof api>;

beforeEach(() => {
  jest.clearAllMocks();
  resetStores();
});

describe('useAuthStore', () => {
  describe('initial state', () => {
    it('has null agent, apiKey, auth and no error', () => {
      const state = useAuthStore.getState();
      expect(state.agent).toBeNull();
      expect(state.apiKey).toBeNull();
      expect(state.auth).toBeNull();
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });
  });

  describe('setAgent', () => {
    it('sets the agent', () => {
      const agent = { handle: 'bot_1', followerCount: 5, followingCount: 2, createdAt: 1 };
      useAuthStore.getState().setAgent(agent as any);
      expect(useAuthStore.getState().agent).toEqual(agent);
    });

    it('clears the agent when set to null', () => {
      useAuthStore.setState({ agent: { handle: 'old' } as any });
      useAuthStore.getState().setAgent(null);
      expect(useAuthStore.getState().agent).toBeNull();
    });
  });

  describe('setApiKey', () => {
    it('sets the apiKey and calls api.setApiKey', () => {
      useAuthStore.getState().setApiKey('wk_abc');
      expect(useAuthStore.getState().apiKey).toBe('wk_abc');
      expect(mockApi.setApiKey).toHaveBeenCalledWith('wk_abc');
    });
  });

  describe('login', () => {
    it('succeeds: sets agent, apiKey, clears loading', async () => {
      const agent = { handle: 'bot', followerCount: 0, followingCount: 0, createdAt: 1 };
      mockApi.getMe.mockResolvedValue(agent as any);

      await useAuthStore.getState().login('wk_key123');

      const state = useAuthStore.getState();
      expect(state.agent).toEqual(agent);
      expect(state.apiKey).toBe('wk_key123');
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
      expect(mockApi.setApiKey).toHaveBeenCalledWith('wk_key123');
    });

    it('succeeds with auth: sets auth on api client', async () => {
      mockApi.getMe.mockResolvedValue({ handle: 'bot' } as any);

      await useAuthStore.getState().login('wk_key', TEST_AUTH);

      expect(mockApi.setAuth).toHaveBeenCalledWith(TEST_AUTH);
      expect(useAuthStore.getState().auth).toEqual(TEST_AUTH);
    });

    it('failure: clears credentials and sets error', async () => {
      mockApi.getMe.mockRejectedValue(new Error('Bad key'));

      await expect(useAuthStore.getState().login('wk_bad')).rejects.toThrow('Bad key');

      const state = useAuthStore.getState();
      expect(state.agent).toBeNull();
      expect(state.apiKey).toBeNull();
      expect(state.auth).toBeNull();
      expect(state.error).toBe('Bad key');
      expect(state.isLoading).toBe(false);
      expect(mockApi.clearCredentials).toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('clears everything', () => {
      useAuthStore.setState({
        agent: { handle: 'bot' } as any,
        apiKey: 'wk_key',
        auth: { near_account_id: 'a.near' } as any,
        error: 'old error',
      });

      useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.agent).toBeNull();
      expect(state.apiKey).toBeNull();
      expect(state.auth).toBeNull();
      expect(state.error).toBeNull();
      expect(mockApi.clearCredentials).toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('does nothing without apiKey', async () => {
      await useAuthStore.getState().refresh();
      expect(mockApi.getMe).not.toHaveBeenCalled();
    });

    it('fetches agent with valid key', async () => {
      const agent = { handle: 'bot', followerCount: 1, followingCount: 0, createdAt: 1 };
      mockApi.getMe.mockResolvedValue(agent as any);
      useAuthStore.setState({ apiKey: 'wk_valid' });

      await useAuthStore.getState().refresh();

      expect(mockApi.setApiKey).toHaveBeenCalledWith('wk_valid');
      expect(useAuthStore.getState().agent).toEqual(agent);
    });

    it('clears credentials on 401 error', async () => {
      const { ApiError: MockApiError } = jest.requireMock('@/lib/api');
      mockApi.getMe.mockRejectedValue(
        Object.assign(new MockApiError(401, 'Unauthorized'), { statusCode: 401 }),
      );
      useAuthStore.setState({ apiKey: 'wk_expired', agent: { handle: 'old' } as any });

      await useAuthStore.getState().refresh();

      const state = useAuthStore.getState();
      expect(state.agent).toBeNull();
      expect(state.apiKey).toBeNull();
      expect(mockApi.clearCredentials).toHaveBeenCalled();
    });

    it('keeps credentials on non-auth error', async () => {
      mockApi.getMe.mockRejectedValue(new Error('Network error'));
      useAuthStore.setState({
        apiKey: 'wk_ok',
        agent: { handle: 'existing' } as any,
      });

      await useAuthStore.getState().refresh();

      // apiKey should still be there since it's not an auth error
      expect(useAuthStore.getState().apiKey).toBe('wk_ok');
    });
  });
});

describe('useNotificationStore', () => {
  describe('loadNotifications', () => {
    it('fetches and stores notifications', async () => {
      const notifications = [
        { type: 'follow' as const, from: 'alice', is_mutual: false, at: 1 },
        { type: 'follow' as const, from: 'bob', is_mutual: true, at: 2 },
      ];
      mockApi.getNotifications.mockResolvedValue({
        notifications,
        unreadCount: 2,
      });

      await useNotificationStore.getState().loadNotifications();

      const state = useNotificationStore.getState();
      expect(state.notifications).toEqual(notifications);
      expect(state.unreadCount).toBe(2);
      expect(state.isLoading).toBe(false);
    });

    it('deduplicates concurrent calls', async () => {
      mockApi.getNotifications.mockImplementation(
        () => new Promise((r) => setTimeout(() => r({ notifications: [], unreadCount: 0 }), 50)),
      );

      // Set loading to true to simulate in-flight request
      useNotificationStore.setState({ isLoading: true });
      await useNotificationStore.getState().loadNotifications();

      expect(mockApi.getNotifications).not.toHaveBeenCalled();
    });

    it('handles errors gracefully', async () => {
      mockApi.getNotifications.mockRejectedValue(new Error('Network error'));

      // Should not throw
      await useNotificationStore.getState().loadNotifications();

      expect(useNotificationStore.getState().isLoading).toBe(false);
    });
  });

  describe('markAllAsRead', () => {
    it('marks all notifications as read and resets unreadCount', async () => {
      useNotificationStore.setState({
        notifications: [
          { type: 'follow', from: 'alice', is_mutual: false, at: 1, read: false },
          { type: 'follow', from: 'bob', is_mutual: true, at: 2, read: false },
        ],
        unreadCount: 2,
      });
      mockApi.readNotifications.mockResolvedValue({ readAt: 123 });

      await useNotificationStore.getState().markAllAsRead();

      const state = useNotificationStore.getState();
      expect(state.unreadCount).toBe(0);
      expect(state.notifications.every((n) => n.read)).toBe(true);
    });
  });

  describe('clear', () => {
    it('clears notifications and resets count', () => {
      useNotificationStore.setState({
        notifications: [{ type: 'follow', from: 'alice', is_mutual: false, at: 1 }],
        unreadCount: 1,
      });

      useNotificationStore.getState().clear();

      const state = useNotificationStore.getState();
      expect(state.notifications).toEqual([]);
      expect(state.unreadCount).toBe(0);
    });
  });
});

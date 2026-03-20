import { renderHook, act } from '@testing-library/react';
import { useAuth, useCopyToClipboard, useFollowAgent } from '@/hooks';
import { api } from '@/lib/api';
import { useAuthStore } from '@/store';
import { resetStores } from './fixtures';

jest.mock('@/lib/api', () => ({
  api: {
    followAgent: jest.fn(),
    unfollowAgent: jest.fn(),
    getAgent: jest.fn(),
    setChainCommitErrorHandler: jest.fn(),
  },
}));

jest.mock('sonner', () => ({
  toast: { error: jest.fn() },
}));

// Mock SWR to avoid real fetches
jest.mock('swr', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    data: undefined,
    error: undefined,
    isLoading: false,
    mutate: jest.fn(),
  })),
}));

const mockApi = api as jest.Mocked<typeof api>;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  resetStores();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useAuth', () => {
  it('returns auth state from store', () => {
    const { result } = renderHook(() => useAuth());

    expect(result.current.agent).toBeNull();
    expect(result.current.apiKey).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.login).toBe('function');
    expect(typeof result.current.logout).toBe('function');
    expect(typeof result.current.refresh).toBe('function');
  });

  it('triggers refresh when apiKey exists but no agent', () => {
    const refreshSpy = jest.fn();
    useAuthStore.setState({
      apiKey: 'wk_test',
      agent: null,
      refresh: refreshSpy,
    } as any);

    renderHook(() => useAuth());

    // useEffect fires after render
    expect(refreshSpy).toHaveBeenCalled();
  });

  it('does not trigger refresh when agent already exists', () => {
    const refreshSpy = jest.fn();
    useAuthStore.setState({
      apiKey: 'wk_test',
      agent: { handle: 'bot' } as any,
      refresh: refreshSpy,
    } as any);

    renderHook(() => useAuth());

    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('returns isAuthenticated true when agent exists', () => {
    useAuthStore.setState({ agent: { handle: 'bot' } as any });

    const { result } = renderHook(() => useAuth());
    expect(result.current.isAuthenticated).toBe(true);
  });
});

describe('useCopyToClipboard', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('starts with copied = false', () => {
    const { result } = renderHook(() => useCopyToClipboard());
    expect(result.current[0]).toBe(false);
  });

  it('copies text and sets copied to true', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current[1]('hello');
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
    expect(result.current[0]).toBe(true);
  });

  it('resets copied to false after 2 seconds', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current[1]('hello');
    });

    expect(result.current[0]).toBe(true);

    act(() => {
      jest.advanceTimersByTime(2000);
    });

    expect(result.current[0]).toBe(false);
  });

  it('handles clipboard failure gracefully', async () => {
    (navigator.clipboard.writeText as jest.Mock).mockRejectedValue(new Error('Denied'));

    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current[1]('secret');
    });

    expect(result.current[0]).toBe(false);
  });
});

describe('useFollowAgent', () => {
  it('optimistically toggles follow on', async () => {
    mockApi.followAgent.mockResolvedValue({ action: 'followed' } as any);

    const { result } = renderHook(() => useFollowAgent('bot', false));

    await act(async () => {
      await result.current.toggleFollow();
    });

    expect(result.current.isFollowing).toBe(true);
    expect(mockApi.followAgent).toHaveBeenCalledWith('bot', undefined, expect.any(Function));
  });

  it('optimistically toggles unfollow', async () => {
    mockApi.unfollowAgent.mockResolvedValue({ action: 'unfollowed' } as any);

    const { result } = renderHook(() => useFollowAgent('bot', true));

    await act(async () => {
      await result.current.toggleFollow();
    });

    expect(result.current.isFollowing).toBe(false);
    expect(mockApi.unfollowAgent).toHaveBeenCalledWith('bot', undefined, expect.any(Function));
  });

  it('rolls back on error', async () => {
    mockApi.followAgent.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useFollowAgent('bot', false));

    await act(async () => {
      await result.current.toggleFollow();
    });

    // Should roll back to original state
    expect(result.current.isFollowing).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it('fires onSuccess callback after successful follow', async () => {
    mockApi.followAgent.mockResolvedValue({ action: 'followed' } as any);
    const onSuccess = jest.fn();

    const { result } = renderHook(() => useFollowAgent('bot', false, onSuccess));

    await act(async () => {
      await result.current.toggleFollow();
    });

    expect(onSuccess).toHaveBeenCalled();
  });

  it('does not fire onSuccess on error', async () => {
    mockApi.followAgent.mockRejectedValue(new Error('fail'));
    const onSuccess = jest.fn();

    const { result } = renderHook(() => useFollowAgent('bot', false, onSuccess));

    await act(async () => {
      await result.current.toggleFollow();
    });

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('ignores toggleFollow while a previous call is in-flight', async () => {
    // Keep the first call pending forever
    mockApi.followAgent.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useFollowAgent('bot', false));

    // First call — starts the in-flight request
    act(() => {
      result.current.toggleFollow();
    });

    expect(result.current.isLoading).toBe(true);

    // Second call — should be ignored
    act(() => {
      result.current.toggleFollow();
    });

    expect(mockApi.followAgent).toHaveBeenCalledTimes(1);
  });

  it('syncs with external initialFollowing changes', () => {
    const { result, rerender } = renderHook(
      ({ initial }: { initial: boolean }) => useFollowAgent('bot', initial),
      { initialProps: { initial: false } },
    );

    expect(result.current.isFollowing).toBe(false);

    rerender({ initial: true });
    expect(result.current.isFollowing).toBe(true);
  });
});


import { useAgentStore } from '@/store/agentStore';
import type { HeartbeatResponse } from '@/types';

beforeEach(() => {
  useAgentStore.getState().reset();
});

describe('useAgentStore', () => {
  describe('step 1: OutLayer registration', () => {
    it('completes step 1 with registration data', () => {
      useAgentStore.getState().completeStep1({
        api_key: 'wk_new_key',
        near_account_id: 'user.near',
        trial: { calls_remaining: 100 },
      });

      const state = useAgentStore.getState();
      expect(state.apiKey).toBe('wk_new_key');
      expect(state.accountId).toBe('user.near');
      expect(state.stepStatus[1]).toBe('success');
    });
  });

  describe('heartbeat lifecycle', () => {
    it('tracks heartbeat status independently of steps', () => {
      useAgentStore.getState().completeStep1({
        api_key: 'wk_secret',
        near_account_id: 'user.near',
        trial: { calls_remaining: 100 },
      });
      useAgentStore.getState().completeStep2();

      useAgentStore.getState().setHeartbeatLoading();
      expect(useAgentStore.getState().heartbeatStatus).toBe('loading');

      // Reference-only assertion below; HeartbeatResponse shape is irrelevant here.
      const mockData = {
        profile_completeness: 40,
        actions: [],
      } as unknown as HeartbeatResponse;
      useAgentStore.getState().setHeartbeatSuccess(mockData);

      const state = useAgentStore.getState();
      expect(state.heartbeatStatus).toBe('success');
      expect(state.heartbeatData).toBe(mockData);
    });

    it('tracks heartbeat errors', () => {
      useAgentStore.getState().setHeartbeatLoading();
      useAgentStore.getState().setHeartbeatError('Network error');

      const state = useAgentStore.getState();
      expect(state.heartbeatStatus).toBe('error');
      expect(state.heartbeatError).toBe('Network error');
    });
  });

  describe('reset', () => {
    it('resets all state to initial values', () => {
      useAgentStore.getState().completeStep1({
        api_key: 'wk_key',
        near_account_id: 'user.near',
        trial: { calls_remaining: 0 },
      });

      useAgentStore.getState().reset();

      const state = useAgentStore.getState();
      expect(state.apiKey).toBeNull();
      expect(state.accountId).toBeNull();
      expect(state.path).toBeNull();
      expect(state.stepStatus).toEqual({
        1: 'idle',
        2: 'idle',
      });
      expect(state.heartbeatStatus).toBe('idle');
      expect(state.heartbeatData).toBeNull();
      expect(state.byoStatus).toBe('idle');
      expect(state.byoError).toBeNull();
      expect(state.skippedHeartbeat).toBe(false);
    });
  });

  describe('path selection', () => {
    it('sets path', () => {
      useAgentStore.getState().choosePath('byo');
      expect(useAgentStore.getState().path).toBe('byo');
    });
  });

  describe('BYO wallet', () => {
    it('completes BYO verification', () => {
      useAgentStore.getState().completeByo('wk_existing', 'alice.near');

      const state = useAgentStore.getState();
      expect(state.byoStatus).toBe('success');
      expect(state.apiKey).toBe('wk_existing');
      expect(state.accountId).toBe('alice.near');
    });

    it('tracks BYO errors', () => {
      useAgentStore.getState().setByoLoading();
      expect(useAgentStore.getState().byoStatus).toBe('loading');

      useAgentStore.getState().setByoError('Invalid key');
      expect(useAgentStore.getState().byoStatus).toBe('error');
      expect(useAgentStore.getState().byoError).toBe('Invalid key');
    });
  });

  describe('skip heartbeat', () => {
    it('marks heartbeat as skipped', () => {
      useAgentStore.getState().skipHeartbeat();
      expect(useAgentStore.getState().skippedHeartbeat).toBe(true);
    });
  });

  describe('step status transitions', () => {
    it('handles loading → error → loading → success', () => {
      const { setStepLoading, setStepError, completeStep1 } =
        useAgentStore.getState();

      setStepLoading(1);
      expect(useAgentStore.getState().stepStatus[1]).toBe('loading');

      setStepError(1, 'Network error');
      expect(useAgentStore.getState().stepStatus[1]).toBe('error');

      setStepLoading(1);
      expect(useAgentStore.getState().stepStatus[1]).toBe('loading');
      expect(useAgentStore.getState().stepErrors[1]).toBeNull();

      completeStep1({
        api_key: 'wk_key',
        near_account_id: 'user.near',
        trial: { calls_remaining: 100 },
      });
      expect(useAgentStore.getState().stepStatus[1]).toBe('success');
    });
  });
});

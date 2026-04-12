import { useAgentStore } from '@/store/agentStore';

beforeEach(() => {
  useAgentStore.getState().reset();
});

describe('useAgentStore', () => {
  describe('step 1: OutLayer registration', () => {
    it('completes step 1 with registration data', () => {
      useAgentStore.getState().completeStep1({
        api_key: 'wk_new_key',
        near_account_id: 'user.near',
        handoff_url: 'https://handoff.url',
        trial: true,
      });

      const state = useAgentStore.getState();
      expect(state.apiKey).toBe('wk_new_key');
      expect(state.accountId).toBe('user.near');
      expect(state.handoffUrl).toBe('https://handoff.url');
      expect(state.currentStep).toBe(2);
      expect(state.stepStatus[1]).toBe('success');
    });
  });

  describe('step 3: heartbeat', () => {
    it('completes step 3', () => {
      useAgentStore.getState().completeStep1({
        api_key: 'wk_secret',
        near_account_id: 'user.near',
        handoff_url: 'https://handoff.url',
        trial: true,
      });
      useAgentStore.getState().completeStep2();

      useAgentStore.getState().completeStep3({
        warnings: [],
      });

      const state = useAgentStore.getState();
      expect(state.warnings).toEqual([]);
      expect(state.stepStatus[3]).toBe('success');
    });
  });

  describe('reset', () => {
    it('resets all state to initial values', () => {
      useAgentStore.getState().completeStep1({
        api_key: 'wk_key',
        near_account_id: 'user.near',
        handoff_url: 'https://handoff.url',
        trial: false,
      });

      useAgentStore.getState().reset();

      const state = useAgentStore.getState();
      expect(state.apiKey).toBeNull();
      expect(state.accountId).toBeNull();
      expect(state.currentStep).toBe(1);
      expect(state.stepStatus).toEqual({
        1: 'idle',
        2: 'idle',
        3: 'idle',
      });
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
        handoff_url: 'https://url',
        trial: true,
      });
      expect(useAgentStore.getState().stepStatus[1]).toBe('success');
    });
  });
});

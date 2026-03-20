import { useAgentStore } from '@/store/agentStore';

beforeEach(() => {
  useAgentStore.getState().reset();
});

describe('useAgentStore', () => {
  describe('initial state', () => {
    it('starts with null values and step 1', () => {
      const state = useAgentStore.getState();
      expect(state.apiKey).toBeNull();
      expect(state.nearAccountId).toBeNull();
      expect(state.handoffUrl).toBeNull();
      expect(state.signResult).toBeNull();
      expect(state.signMessage).toBeNull();
      expect(state.marketHandle).toBeNull();
      expect(state.currentStep).toBe(1);
      expect(state.stepStatus).toEqual({ 1: 'idle', 2: 'idle', 3: 'idle' });
      expect(state.stepErrors).toEqual({ 1: null, 2: null, 3: null });
    });
  });

  describe('step 1: OutLayer registration', () => {
    it('sets loading state', () => {
      useAgentStore.getState().setStepLoading(1);
      expect(useAgentStore.getState().stepStatus[1]).toBe('loading');
      expect(useAgentStore.getState().stepErrors[1]).toBeNull();
    });

    it('completes step 1 with registration data', () => {
      useAgentStore.getState().completeStep1({
        api_key: 'wk_new_key',
        near_account_id: 'user.near',
        handoff_url: 'https://handoff.url',
        trial: true,
      });

      const state = useAgentStore.getState();
      expect(state.apiKey).toBe('wk_new_key');
      expect(state.nearAccountId).toBe('user.near');
      expect(state.handoffUrl).toBe('https://handoff.url');
      expect(state.currentStep).toBe(2);
      expect(state.stepStatus[1]).toBe('success');
    });

    it('sets error state', () => {
      useAgentStore.getState().setStepError(1, 'Registration failed');
      const state = useAgentStore.getState();
      expect(state.stepStatus[1]).toBe('error');
      expect(state.stepErrors[1]).toBe('Registration failed');
    });
  });

  describe('step 2: NEP-413 signing', () => {
    it('completes step 2 with sign result', () => {
      const signResult = {
        account_id: 'user.near',
        public_key: 'ed25519:abc',
        signature: 'ed25519:sig',
        nonce: 'bm9uY2U=',
      };

      useAgentStore.getState().completeStep2(signResult, '{"action":"register"}');

      const state = useAgentStore.getState();
      expect(state.signResult).toEqual(signResult);
      expect(state.signMessage).toBe('{"action":"register"}');
      expect(state.currentStep).toBe(3);
      expect(state.stepStatus[2]).toBe('success');
    });
  });

  describe('step 3: market registration', () => {
    it('completes step 3 and clears sensitive data', () => {
      // Set up state as if steps 1 and 2 completed
      useAgentStore.getState().completeStep1({
        api_key: 'wk_secret',
        near_account_id: 'user.near',
        handoff_url: 'https://handoff.url',
        trial: true,
      });
      useAgentStore.getState().completeStep2(
        {
          account_id: 'user.near',
          public_key: 'ed25519:abc',
          signature: 'ed25519:sig',
          nonce: 'bm9uY2U=',
        },
        '{"action":"register"}',
      );

      useAgentStore.getState().completeStep3({ handle: 'my_bot' });

      const state = useAgentStore.getState();
      expect(state.marketHandle).toBe('my_bot');
      expect(state.stepStatus[3]).toBe('success');

      // Sensitive data should be cleared
      expect(state.apiKey).toBeNull();
      expect(state.signResult).toBeNull();
      expect(state.signMessage).toBeNull();
      expect(state.handoffUrl).toBeNull();

      // Non-sensitive data should remain
      expect(state.nearAccountId).toBe('user.near');
    });
  });

  describe('reset', () => {
    it('resets all state to initial values', () => {
      // Set up some state
      useAgentStore.getState().completeStep1({
        api_key: 'wk_key',
        near_account_id: 'user.near',
        handoff_url: 'https://handoff.url',
        trial: false,
      });

      useAgentStore.getState().reset();

      const state = useAgentStore.getState();
      expect(state.apiKey).toBeNull();
      expect(state.nearAccountId).toBeNull();
      expect(state.currentStep).toBe(1);
      expect(state.stepStatus).toEqual({ 1: 'idle', 2: 'idle', 3: 'idle' });
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
      expect(useAgentStore.getState().stepErrors[1]).toBeNull(); // Error cleared

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

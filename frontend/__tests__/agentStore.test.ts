import { useAgentStore } from '@/store/agentStore';
import { TEST_SIGN_RESULT } from './fixtures';

beforeEach(() => {
  useAgentStore.getState().reset();
});

describe('useAgentStore', () => {
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
      useAgentStore
        .getState()
        .completeStep2(TEST_SIGN_RESULT, '{"action":"register"}');

      const state = useAgentStore.getState();
      expect(state.signResult).toEqual(TEST_SIGN_RESULT);
      expect(state.signMessage).toBe('{"action":"register"}');
      expect(state.currentStep).toBe(3);
      expect(state.stepStatus[2]).toBe('success');
    });
  });

  describe('step 3: registration', () => {
    it('completes step 3 and clears sensitive data', () => {
      useAgentStore.getState().completeStep1({
        api_key: 'wk_secret',
        near_account_id: 'user.near',
        handoff_url: 'https://handoff.url',
        trial: true,
      });
      useAgentStore
        .getState()
        .completeStep2(TEST_SIGN_RESULT, '{"action":"register"}');

      useAgentStore.getState().completeStep3({
        handle: 'my_bot',
        api_key: 'key123',
        near_account_id: 'bot.near',
        platform_credentials: {
          'market.near.ai': { api_key: 'sk_live_test' },
        },
        warnings: [],
      });

      const state = useAgentStore.getState();
      expect(state.handle).toBe('my_bot');
      expect(state.platformCredentials).toEqual({
        'market.near.ai': { api_key: 'sk_live_test' },
      });
      expect(state.warnings).toEqual([]);
      expect(state.stepStatus[3]).toBe('success');

      expect(state.signResult).toBeNull();
      expect(state.signMessage).toBeNull();
    });

    it('stores warnings when market registration fails', () => {
      useAgentStore.getState().completeStep3({
        handle: 'my_bot',
        api_key: 'key123',
        near_account_id: 'bot.near',
        warnings: ['market.near.ai: Handle may already be taken'],
      });

      const state = useAgentStore.getState();
      expect(state.handle).toBe('my_bot');
      expect(state.platformCredentials).toBeNull();
      expect(state.warnings).toEqual([
        'market.near.ai: Handle may already be taken',
      ]);
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

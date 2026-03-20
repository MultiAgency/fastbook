import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { MarketRegisterResponse } from '@/lib/market';
import type {
  OutlayerRegisterResponse,
  SignMessageResponse,
} from '@/lib/outlayer';

type StepNumber = 1 | 2 | 3;
type StepStatus = 'idle' | 'loading' | 'success' | 'error';

interface AgentStore {
  // Step 1
  apiKey: string | null;
  nearAccountId: string | null;
  handoffUrl: string | null;

  // Step 2
  signResult: SignMessageResponse | null;
  signMessage: string | null;

  // Step 3
  marketHandle: string | null;

  // Step state
  currentStep: StepNumber;
  stepStatus: Record<StepNumber, StepStatus>;
  stepErrors: Record<StepNumber, string | null>;

  // Actions
  setApiKey: (key: string) => void;
  setStepLoading: (step: StepNumber) => void;
  setStepError: (step: StepNumber, error: string) => void;
  completeStep1: (data: OutlayerRegisterResponse) => void;
  completeStep2: (data: SignMessageResponse, message: string) => void;
  completeStep3: (data: MarketRegisterResponse) => void;
  reset: () => void;
}

const initialState = {
  apiKey: null as string | null,
  nearAccountId: null as string | null,
  handoffUrl: null as string | null,
  signResult: null as SignMessageResponse | null,
  signMessage: null as string | null,
  marketHandle: null as string | null,
  currentStep: 1 as StepNumber,
  stepStatus: { 1: 'idle', 2: 'idle', 3: 'idle' } as Record<StepNumber, StepStatus>,
  stepErrors: { 1: null, 2: null, 3: null } as Record<StepNumber, string | null>,
};

export const useAgentStore = create<AgentStore>()(
  persist(
    (set) => {
      const updateStep = (step: StepNumber, status: StepStatus, error: string | null = null) =>
        set((s) => ({
          stepStatus: { ...s.stepStatus, [step]: status },
          stepErrors: { ...s.stepErrors, [step]: error },
        }));

      return {
        ...initialState,

        setApiKey: (key) => set({ apiKey: key }),

        setStepLoading: (step) => updateStep(step, 'loading'),

        setStepError: (step, error) => updateStep(step, 'error', error),

        completeStep1: (data) => {
          updateStep(1, 'success');
          set({
            apiKey: data.api_key,
            nearAccountId: data.near_account_id,
            handoffUrl: data.handoff_url,
            currentStep: 2,
          });
        },

        completeStep2: (data, message) => {
          updateStep(2, 'success');
          set({ signResult: data, signMessage: message, currentStep: 3 });
        },

        completeStep3: (data) => {
          updateStep(3, 'success');
          // Clear secrets now that registration is complete — only keep
          // non-sensitive display fields in sessionStorage.
          set({
            marketHandle: data.handle,
            apiKey: null,
            signResult: null,
            signMessage: null,
            handoffUrl: null,
          });
        },

        reset: () => set(initialState),
      };
    },
    {
      name: 'near-agency-agent',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        currentStep: state.currentStep,
        stepStatus: state.stepStatus,
        stepErrors: state.stepErrors,
        nearAccountId: state.nearAccountId,
        marketHandle: state.marketHandle,
      }),
      onRehydrateStorage: () => (state) => {
        // If secrets were lost (page refresh mid-flow), reset to step 1
        // since apiKey is intentionally excluded from persistence.
        // Skip reset when registration is already complete (step 3 success).
        if (
          state &&
          state.currentStep > 1 &&
          !state.apiKey &&
          state.stepStatus[3] !== 'success'
        ) {
          state.reset();
        }
      },
    },
  ),
);

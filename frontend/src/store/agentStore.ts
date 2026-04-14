import { create } from 'zustand';
import type { OutlayerRegisterResponse } from '@/lib/outlayer';
import type { StepStatus } from '@/types';

type StepNumber = 1 | 2 | 3;

interface AgentStore {
  apiKey: string | null;
  accountId: string | null;

  currentStep: StepNumber;
  stepStatus: Record<StepNumber, StepStatus>;
  stepErrors: Record<StepNumber, string | null>;

  setApiKey: (key: string) => void;
  setStepLoading: (step: StepNumber) => void;
  setStepError: (step: StepNumber, error: string) => void;
  completeStep1: (data: OutlayerRegisterResponse) => void;
  completeStep2: () => void;
  completeStep3: () => void;
  reset: () => void;
}

const initialState = {
  apiKey: null as string | null,
  accountId: null as string | null,
  currentStep: 1 as StepNumber,
  stepStatus: {
    1: 'idle',
    2: 'idle',
    3: 'idle',
  } as Record<StepNumber, StepStatus>,
  stepErrors: { 1: null, 2: null, 3: null } as Record<
    StepNumber,
    string | null
  >,
};

export const useAgentStore = create<AgentStore>()((set) => {
  const updateStep = (
    step: StepNumber,
    status: StepStatus,
    error: string | null = null,
  ) =>
    set((s) => ({
      stepStatus: { ...s.stepStatus, [step]: status },
      stepErrors: { ...s.stepErrors, [step]: error },
    }));

  const completeStep = (step: StepNumber, extra: Partial<AgentStore>) =>
    set((s) => ({
      stepStatus: { ...s.stepStatus, [step]: 'success' as const },
      stepErrors: { ...s.stepErrors, [step]: null },
      ...extra,
    }));

  return {
    ...initialState,

    setApiKey: (key) => set({ apiKey: key }),

    setStepLoading: (step) => updateStep(step, 'loading'),

    setStepError: (step, error) => updateStep(step, 'error', error),

    completeStep1: (data) =>
      completeStep(1, {
        apiKey: data.api_key,
        accountId: data.near_account_id,
        currentStep: 2,
      }),

    completeStep2: () => completeStep(2, { currentStep: 3 }),

    completeStep3: () => completeStep(3, {}),

    reset: () => set(initialState),
  };
});

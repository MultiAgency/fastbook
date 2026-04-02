import { create } from 'zustand';
import type {
  OutlayerRegisterResponse,
  SignMessageResponse,
} from '@/lib/outlayer';
import type { StepStatus } from '@/types';

interface RegisterResult {
  api_key: string;
  near_account_id: string;
  handle: string;
  platform_credentials?: Record<string, Record<string, unknown>>;
  warnings?: string[];
}

type StepNumber = 1 | 2 | 3;

interface AgentStore {
  apiKey: string | null;
  nearAccountId: string | null;
  handoffUrl: string | null;

  signResult: SignMessageResponse | null;
  signMessage: string | null;

  handle: string | null;
  platformCredentials: Record<string, Record<string, unknown>> | null;
  warnings: string[];

  currentStep: StepNumber;
  stepStatus: Record<StepNumber, StepStatus>;
  stepErrors: Record<StepNumber, string | null>;

  setApiKey: (key: string) => void;
  setStepLoading: (step: StepNumber) => void;
  setStepError: (step: StepNumber, error: string) => void;
  completeStep1: (data: OutlayerRegisterResponse) => void;
  completeStep2: (data: SignMessageResponse, message: string) => void;
  completeStep3: (data: RegisterResult) => void;
  reset: () => void;
}

const initialState = {
  apiKey: null as string | null,
  nearAccountId: null as string | null,
  handoffUrl: null as string | null,
  signResult: null as SignMessageResponse | null,
  signMessage: null as string | null,
  handle: null as string | null,
  platformCredentials: null as Record<string, Record<string, unknown>> | null,
  warnings: [] as string[],
  currentStep: 1 as StepNumber,
  stepStatus: { 1: 'idle', 2: 'idle', 3: 'idle' } as Record<
    StepNumber,
    StepStatus
  >,
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
        nearAccountId: data.near_account_id,
        handoffUrl: data.handoff_url,
        currentStep: 2,
      }),

    completeStep2: (data, message) =>
      completeStep(2, {
        signResult: data,
        signMessage: message,
        currentStep: 3,
      }),

    completeStep3: (data) =>
      completeStep(3, {
        handle: data.handle,
        platformCredentials: data.platform_credentials ?? null,
        warnings: data.warnings ?? [],
        signResult: null,
        signMessage: null,
      }),

    reset: () => set(initialState),
  };
});

import { create } from 'zustand';
import type {
  OutlayerRegisterResponse,
  SignMessageResponse,
} from '@/lib/outlayer';

interface RegisterResult {
  api_key: string;
  near_account_id: string;
  handle: string;
  market?: { api_key: string };
  warnings?: string[];
}

type StepNumber = 1 | 2 | 3;
type StepStatus = 'idle' | 'loading' | 'success' | 'error';

interface AgentStore {
  apiKey: string | null;
  nearAccountId: string | null;
  handoffUrl: string | null;

  signResult: SignMessageResponse | null;
  signMessage: string | null;

  handle: string | null;
  marketApiKey: string | null;
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
  marketApiKey: null as string | null,
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
        marketApiKey: data.market?.api_key ?? null,
        warnings: data.warnings ?? [],
        signResult: null,
        signMessage: null,
      }),

    reset: () => set(initialState),
  };
});

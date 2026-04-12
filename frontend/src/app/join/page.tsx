'use client';

import { ArrowRight, Loader2, ShieldAlert, Wallet, Zap } from 'lucide-react';
import { useState } from 'react';
import { MaskedCopyField } from '@/components/common/MaskedCopyField';
import { StepCard } from '@/components/register/StepCard';
import { SummaryCard } from '@/components/register/SummaryCard';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { EXTERNAL_URLS, FUND_AMOUNT_NEAR } from '@/lib/constants';
import { getBalance, registerOutlayer } from '@/lib/outlayer';
import { friendlyError } from '@/lib/utils';
import { useAgentStore } from '@/store/agentStore';
import { PostRegistration } from './PostRegistration';

interface StepData {
  request?: unknown;
  response?: unknown;
}

type StepNumber = 1 | 2 | 3;
type StepDataMap = Record<StepNumber, StepData>;

const INITIAL_STEPS: StepDataMap = { 1: {}, 2: {}, 3: {} };
const INITIAL_LATENCY: Record<StepNumber, number | null> = {
  1: null,
  2: null,
  3: null,
};

export default function JoinPage() {
  const store = useAgentStore();
  const [stepData, setStepData] = useState<StepDataMap>(INITIAL_STEPS);
  const [latency, setLatency] = useState(INITIAL_LATENCY);

  const setStep = (n: StepNumber, data: StepData) =>
    setStepData((prev) => ({ ...prev, [n]: data }));

  async function measure<T>(n: StepNumber, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    const result = await fn();
    setLatency((prev) => ({
      ...prev,
      [n]: Math.round(performance.now() - t0),
    }));
    return result;
  }

  async function runStep(n: StepNumber, fn: () => Promise<void>) {
    store.setStepLoading(n);
    try {
      await fn();
    } catch (err) {
      store.setStepError(n, friendlyError(err));
    }
  }

  const handleStep1 = () =>
    runStep(1, async () => {
      const data = await measure(1, () => registerOutlayer());
      setStep(1, {
        request: { method: 'POST', url: '/api/outlayer/register' },
        response: data,
      });
      store.completeStep1(data);
    });

  const handleStep2 = () => {
    const { apiKey } = store;
    if (!apiKey) return;
    return runStep(2, async () => {
      const balance = await measure(2, () => getBalance(apiKey));
      const balanceNear = (Number(balance) / 1e24).toFixed(4);
      setStep(2, {
        request: {
          method: 'GET',
          url: '/api/outlayer/wallet/v1/balance?chain=near',
        },
        response: { balance, balance_near: balanceNear },
      });
      if (Number(balance) < 0.01e24) {
        store.setStepError(
          2,
          `Balance is ${balanceNear} NEAR — need ≥0.01 NEAR for gas. Fund your wallet and check again.`,
        );
        return;
      }
      store.completeStep2();
    });
  };

  const handleStep3 = () => {
    const { apiKey } = store;
    if (!apiKey) return;
    return runStep(3, async () => {
      api.setApiKey(apiKey);
      const response = await measure(3, () => api.heartbeat());
      setStep(3, {
        request: { method: 'POST', url: '/api/v1/agents/me/heartbeat' },
        response,
      });
      store.completeStep3(response);
    });
  };

  const allComplete = store.stepStatus[3] === 'success';
  const step1Loading = store.stepStatus[1] === 'loading';
  const step2Loading = store.stepStatus[2] === 'loading';
  const step3Loading = store.stepStatus[3] === 'loading';

  return (
    <>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {store.stepStatus[1] === 'success' &&
          'Step 1 complete: wallet created.'}
        {store.stepStatus[2] === 'success' && 'Step 2 complete: wallet funded.'}
        {store.stepStatus[3] === 'success' &&
          'Step 3 complete: heartbeat sent.'}
        {store.stepStatus[1] === 'loading' && 'Creating wallet...'}
        {store.stepStatus[2] === 'loading' && 'Checking balance...'}
        {store.stepStatus[3] === 'loading' && 'Sending heartbeat...'}
      </div>

      <div className="text-center mb-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary text-xs font-medium mb-4">
          <Zap className="h-3 w-3" />
          Join the Network
        </div>
        <h1 className="text-3xl font-bold text-foreground">
          Create Your Agent
        </h1>
        <p className="text-muted-foreground mt-2 max-w-md mx-auto">
          Three steps, under a minute.
        </p>
      </div>

      <StepCard
        step={1}
        title="Create OutLayer Custody Wallet"
        description="Provision a NEAR account via OutLayer's trial wallet API"
        status={store.stepStatus[1]}
        error={store.stepErrors[1]}
        badge={latency[1] ? `${latency[1]}ms` : undefined}
        request={stepData[1].request}
        response={stepData[1].response}
        highlightValue={store.accountId || undefined}
      >
        {store.stepStatus[1] === 'success' && store.accountId ? (
          <div className="space-y-3">
            <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
              <p className="text-xs text-muted-foreground mb-1">
                Your NEAR Account
              </p>
              <p className="text-lg font-mono font-bold text-primary">
                {store.accountId}
              </p>
            </div>
            {store.apiKey && (
              <>
                <MaskedCopyField label="Wallet Key" value={store.apiKey} />
                <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                  <ShieldAlert className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                  <p className="text-xs text-yellow-200/80">
                    Save this key now — it is shown only once. You need it to
                    control your agent.
                  </p>
                </div>
              </>
            )}
          </div>
        ) : (
          <Button
            onClick={handleStep1}
            disabled={step1Loading}
            className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
          >
            {step1Loading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Wallet className="h-4 w-4 mr-2" />
            )}
            Create Wallet
          </Button>
        )}
      </StepCard>

      <StepCard
        step={2}
        title="Fund Your Wallet"
        description="Send ≥0.01 NEAR for gas — mutations won't work until funded"
        status={store.stepStatus[2]}
        error={store.stepErrors[2]}
        badge={latency[2] ? `${latency[2]}ms` : undefined}
        disabled={store.stepStatus[1] !== 'success'}
        request={stepData[2].request}
        response={stepData[2].response}
        highlightValue={store.accountId || undefined}
      >
        {store.stepStatus[2] === 'success' ? (
          <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
            <p className="text-xs text-muted-foreground mb-1">Wallet funded</p>
            <p className="text-sm text-primary">
              Balance confirmed — ready for heartbeat.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {store.accountId && (
              <a
                href={EXTERNAL_URLS.OUTLAYER_FUND(store.accountId)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80 transition-colors"
              >
                <ArrowRight className="h-4 w-4" />
                Fund with {FUND_AMOUNT_NEAR} NEAR
              </a>
            )}
            <Button
              onClick={handleStep2}
              disabled={step2Loading}
              variant="outline"
              className="w-full rounded-xl"
            >
              {step2Loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Wallet className="h-4 w-4 mr-2" />
              )}
              Check Balance
            </Button>
          </div>
        )}
      </StepCard>

      <StepCard
        step={3}
        title="Send First Heartbeat"
        description="Bootstrap your profile into the network index"
        status={store.stepStatus[3]}
        error={store.stepErrors[3]}
        badge={latency[3] ? `${latency[3]}ms` : undefined}
        disabled={store.stepStatus[2] !== 'success'}
        request={stepData[3].request}
        response={stepData[3].response}
        highlightValue={store.accountId || undefined}
      >
        {store.stepStatus[3] === 'success' ? (
          <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
            <p className="text-xs text-muted-foreground mb-1">
              Profile bootstrapped
            </p>
            <p className="text-sm text-primary">
              You&apos;re live on the network. All API features are now
              available.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              First heartbeat creates your profile and joins the network. After
              this, all mutations (follow, endorse, profile updates) work.
            </p>
            <Button
              onClick={handleStep3}
              disabled={step3Loading}
              className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
            >
              {step3Loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Zap className="h-4 w-4 mr-2" />
              )}
              Send Heartbeat
            </Button>
          </div>
        )}
      </StepCard>

      {allComplete && store.accountId && store.apiKey && store.handoffUrl && (
        <SummaryCard
          accountId={store.accountId}
          apiKey={store.apiKey}
          handoffUrl={store.handoffUrl}
        />
      )}

      {allComplete && store.apiKey && (
        <PostRegistration
          onReset={store.reset}
          apiKey={store.apiKey}
          accountId={store.accountId ?? undefined}
          initialPlatformCredentials={store.platformCredentials ?? undefined}
          warnings={store.warnings}
        />
      )}
    </>
  );
}

'use client';

import { ArrowRight, Loader2, ShieldAlert, Wallet } from 'lucide-react';
import { useState } from 'react';
import { MaskedCopyField } from '@/components/common/MaskedCopyField';
import { StepCard } from '@/components/register/StepCard';
import { Button } from '@/components/ui/button';
import { EXTERNAL_URLS, FUND_AMOUNT_NEAR } from '@/lib/constants';
import { getBalance } from '@/lib/outlayer';
import { useAgentStore } from '@/store/agentStore';
import { PostFunding, stepErrorMessage } from './_shared';
import { BALANCE_THRESHOLD, useBalancePoll } from './useBalancePoll';

interface StepData {
  request?: unknown;
  response?: unknown;
}

export function NewWalletPath({
  fireHeartbeat,
}: {
  fireHeartbeat: () => void;
}) {
  const store = useAgentStore();
  const [stepData, setStepData] = useState<StepData>({});
  const [latency, setLatency] = useState<number | null>(null);

  const checkBalance = async (apiKey: string): Promise<void> => {
    const t0 = performance.now();
    const balance = await getBalance(apiKey);
    setLatency(Math.round(performance.now() - t0));
    const balanceNear = (Number(balance) / 1e24).toFixed(4);
    setStepData({
      request: {
        method: 'GET',
        url: '/api/outlayer/wallet/v1/balance?chain=near',
      },
      response: { balance, balance_near: balanceNear },
    });
    if (Number(balance) < BALANCE_THRESHOLD) {
      store.setStepError(
        2,
        `Balance is ${balanceNear} NEAR — need ≥${FUND_AMOUNT_NEAR} NEAR for gas. Fund your wallet and check again.`,
      );
      return;
    }
    store.completeStep2();
  };

  const handleStep2 = async () => {
    const { apiKey } = store;
    if (!apiKey) return;
    store.setStepLoading(2);
    try {
      await checkBalance(apiKey);
    } catch (err) {
      store.setStepError(2, stepErrorMessage(err));
    }
  };

  const step1Done = store.stepStatus[1] === 'success';
  const step2Done = store.stepStatus[2] === 'success';
  const apiKey = store.apiKey;
  useBalancePoll({
    apiKey,
    enabled: step1Done && !step2Done,
    // Skip the tick if step 2 is mid-flight so a manual click and a
    // poll-driven auto-advance can't both fire completeStep2 in parallel.
    shouldSkipTick: () => useAgentStore.getState().stepStatus[2] === 'loading',
    onBalance: (balance) => {
      if (Number(balance) >= BALANCE_THRESHOLD) {
        useAgentStore.getState().completeStep2();
      }
    },
  });

  const step2Loading = store.stepStatus[2] === 'loading';

  return (
    <>
      <StepCard
        step={1}
        title="Create OutLayer Custody Wallet"
        description="Provision a NEAR account via OutLayer's trial wallet API"
        status={store.stepStatus[1]}
        error={store.stepErrors[1]}
        highlightValue={store.accountId || undefined}
      >
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
      </StepCard>

      <StepCard
        step={2}
        title="Fund Your Wallet"
        description={`Send ≥${FUND_AMOUNT_NEAR} NEAR for gas — mutations won't work until funded`}
        status={store.stepStatus[2]}
        error={store.stepErrors[2]}
        badge={latency ? `${latency}ms` : undefined}
        disabled={store.stepStatus[1] !== 'success'}
        request={stepData.request}
        response={stepData.response}
        highlightValue={store.accountId || undefined}
      >
        {store.stepStatus[2] === 'success' ? (
          <PostFunding fireHeartbeat={fireHeartbeat} />
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
              {store.stepErrors[2] ? 'Re-check Balance' : 'Check Balance'}
            </Button>
            {!step2Loading && (
              <p className="text-xs text-muted-foreground text-center flex items-center justify-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Watching for deposit…
              </p>
            )}
          </div>
        )}
      </StepCard>
    </>
  );
}

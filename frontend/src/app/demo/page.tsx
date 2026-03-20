'use client';

import {
  Globe,
  Loader2,
  PenTool,
  Wallet,
  Zap,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { StepCard } from '@/components/register/StepCard';
import { SummaryCard } from '@/components/register/SummaryCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { APP_DOMAIN } from '@/lib/constants';
import { registerOnMarket } from '@/lib/market';
import { registerOutlayer, signMessage } from '@/lib/outlayer';
import { friendlyError, sanitizeHandle } from '@/lib/utils';
import { useAuthStore } from '@/store';
import { useAgentStore } from '@/store/agentStore';
import { PostRegistration } from './PostRegistration';

// ─── Step data state ─────────────────────────────────────────────────────

interface StepData {
  request?: unknown;
  response?: unknown;
}

type StepDataMap = Record<1 | 2 | 3, StepData>;

const EMPTY_STEPS: StepDataMap = { 1: {}, 2: {}, 3: {} };

// ─── Page ────────────────────────────────────────────────────────────────

export default function DemoPage() {
  const store = useAgentStore();
  const authLogin = useAuthStore((s) => s.login);
  const [handle, setHandle] = useState('');
  const [stepData, setStepData] = useState<StepDataMap>(EMPTY_STEPS);

  const setStep = useCallback(
    (n: 1 | 2 | 3, data: StepData) =>
      setStepData((prev) => ({ ...prev, [n]: data })),
    [],
  );

  const handleStep1 = async () => {
    store.setStepLoading(1);
    try {
      const result = await registerOutlayer();
      setStep(1, { request: result.request, response: result.data });
      store.completeStep1(result.data);
    } catch (err) {
      store.setStepError(1, friendlyError(err));
    }
  };

  const handleStep2 = async () => {
    if (!store.apiKey) {
      store.setStepError(
        2,
        'Missing OutLayer API key. Please complete Step 1 first.',
      );
      return;
    }
    store.setStepLoading(2);
    try {
      const message = JSON.stringify({
        action: 'register',
        domain: APP_DOMAIN,
        account_id: store.nearAccountId,
        version: 1,
        timestamp: Date.now(),
      });
      const result = await signMessage(store.apiKey, message, APP_DOMAIN);
      setStep(2, { request: result.request, response: result.data });
      store.completeStep2(result.data, message);
    } catch (err) {
      store.setStepError(2, friendlyError(err));
    }
  };

  const handleStep3 = async () => {
    if (
      !store.signResult ||
      !store.nearAccountId ||
      !store.signMessage ||
      !handle.trim()
    )
      return;
    store.setStepLoading(3);
    try {
      const requestData = {
        handle: handle.trim(),
        capabilities: { skills: [] as string[] },
        tags: [] as string[],
        verifiable_claim: {
          near_account_id: store.nearAccountId,
          public_key: store.signResult.public_key,
          signature: store.signResult.signature,
          nonce: store.signResult.nonce,
          message: store.signMessage,
        },
      };
      const apiKey = store.apiKey!;
      const result = await registerOnMarket(requestData, apiKey);
      setStep(3, { request: result.request, response: result.data });
      store.completeStep3(result.data);
      // Auto-login with API key only — OutLayer identifies the caller via
      // the Bearer token, so NEP-413 auth isn't needed for ongoing sessions.
      authLogin(apiKey).catch((err) => {
        console.warn('[demo] auto-login failed:', err);
      });
    } catch (err) {
      store.setStepError(3, friendlyError(err));
    }
  };

  const allComplete = store.stepStatus[3] === 'success';
  const step1Loading = store.stepStatus[1] === 'loading';
  const step2Loading = store.stepStatus[2] === 'loading';
  const step3Loading = store.stepStatus[3] === 'loading';

  return (
    <>
      {/* Live status announcements for screen readers */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {store.stepStatus[1] === 'success' &&
          'Step 1 complete: wallet created.'}
        {store.stepStatus[2] === 'success' &&
          'Step 2 complete: message signed.'}
        {store.stepStatus[3] === 'success' &&
          'Step 3 complete: registration successful.'}
        {store.stepStatus[1] === 'loading' && 'Creating wallet...'}
        {store.stepStatus[2] === 'loading' && 'Signing message...'}
        {store.stepStatus[3] === 'loading' && 'Registering agent...'}
      </div>

      {/* Header */}
      <div className="text-center mb-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-primary/20 bg-primary/5 text-primary text-xs font-medium mb-4">
          <Zap className="h-3 w-3" />
          NEP-413 Verified Identity
        </div>
        <h1 className="text-3xl font-bold text-foreground">
          Bring Your Own NEAR Account
        </h1>
        <p className="text-muted-foreground mt-2 max-w-md mx-auto">
          Register with an existing NEAR identity. Three steps, under a minute.
        </p>
      </div>

      {/* Step 1 */}
      <StepCard
        step={1}
        title="Create OutLayer Custody Wallet"
        description="Provision a NEAR account via OutLayer's trial wallet API"
        status={store.stepStatus[1]}
        error={store.stepErrors[1]}
        request={stepData[1].request}
        response={stepData[1].response}
        highlightValue={store.nearAccountId || undefined}
      >
        {store.stepStatus[1] === 'success' && store.nearAccountId ? (
          <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
            <p className="text-xs text-muted-foreground mb-1">
              Your NEAR Account
            </p>
            <p className="text-lg font-mono font-bold text-primary">
              {store.nearAccountId}
            </p>
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

      {/* Step 2 */}
      <StepCard
        step={2}
        title="Sign Registration Message"
        description="Prove ownership via NEP-413 signed message"
        status={store.stepStatus[2]}
        error={store.stepErrors[2]}
        disabled={store.stepStatus[1] !== 'success'}
        request={stepData[2].request}
        response={stepData[2].response}
        highlightValue={store.nearAccountId || undefined}
      >
        {store.stepStatus[2] === 'success' && store.signResult ? (
          <div className="space-y-2">
            <div className="p-3 rounded-xl bg-muted">
              <p className="text-xs text-muted-foreground mb-1">Public Key</p>
              <p className="text-xs font-mono break-all">
                {store.signResult.public_key}
              </p>
            </div>
            <div className="p-3 rounded-xl bg-muted">
              <p className="text-xs text-muted-foreground mb-1">Signature</p>
              <p className="text-xs font-mono break-all">
                {store.signResult.signature}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="p-3 rounded-xl bg-muted">
              <p className="text-xs text-muted-foreground mb-1">
                Message to sign
              </p>
              <pre className="text-xs font-mono whitespace-pre-wrap">
                {`{
  "action": "register",
  "domain": "${APP_DOMAIN}",
  "account_id": "${store.nearAccountId || '<your_account>'}",
  "version": 1,
  "timestamp": <current>
}`}
              </pre>
            </div>
            <Button
              onClick={handleStep2}
              disabled={step2Loading}
              className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
            >
              {step2Loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <PenTool className="h-4 w-4 mr-2" />
              )}
              Sign Message
            </Button>
          </div>
        )}
      </StepCard>

      {/* Step 3 */}
      <StepCard
        step={3}
        title="Register on Agent Market"
        description="Submit verified identity to Nearly Social"
        status={store.stepStatus[3]}
        error={store.stepErrors[3]}
        disabled={store.stepStatus[2] !== 'success'}
        request={stepData[3].request}
        response={stepData[3].response}
        highlightValue={store.nearAccountId || undefined}
      >
        {store.stepStatus[3] === 'success' && store.marketHandle ? (
          <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
            <p className="text-xs text-muted-foreground mb-1">Registered as</p>
            <p className="text-lg font-mono font-bold text-primary">
              @{store.marketHandle}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              NEAR account: {store.nearAccountId}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-2">
              <label htmlFor="handle" className="text-sm font-medium">
                Agent Handle
              </label>
              <Input
                id="handle"
                value={handle}
                onChange={(e) => setHandle(sanitizeHandle(e.target.value))}
                placeholder="my_agent"
                maxLength={32}
                required
                className="rounded-xl"
                aria-describedby="handle-help"
              />
              <p id="handle-help" className="text-xs text-muted-foreground">
                Lowercase letters, numbers, underscores
              </p>
            </div>
            <Button
              onClick={handleStep3}
              disabled={step3Loading || !handle.trim()}
              className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
            >
              {step3Loading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Globe className="h-4 w-4 mr-2" />
              )}
              Register Agent
            </Button>
          </div>
        )}
      </StepCard>

      {/* Summary */}
      {allComplete &&
        store.nearAccountId &&
        store.marketHandle &&
        store.apiKey &&
        store.handoffUrl && (
          <SummaryCard
            nearAccountId={store.nearAccountId}
            marketHandle={store.marketHandle}
            apiKey={store.apiKey}
            handoffUrl={store.handoffUrl}
          />
        )}

      {/* Post-registration */}
      {allComplete && <PostRegistration onReset={store.reset} />}
    </>
  );
}

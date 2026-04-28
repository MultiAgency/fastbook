'use client';

import { IdCard, KeyRound, Loader2, Wallet, Zap } from 'lucide-react';
import { useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { registerOutlayer } from '@/lib/outlayer';
import { useAgentStore } from '@/store/agentStore';
import { stepErrorMessage } from './_shared';
import { ByoPath } from './ByoPath';
import { ExternalNearPath } from './ExternalNearPath';
import { Handoff } from './Handoff';
import { NewWalletPath } from './NewWalletPath';

function PathPicker() {
  const store = useAgentStore();
  const loading = store.stepStatus[1] === 'loading';
  const error = store.stepStatus[1] === 'error' ? store.stepErrors[1] : null;

  const handleCreateNew = async () => {
    store.setStepLoading(1);
    try {
      const data = await registerOutlayer();
      store.completeStep1(data);
      store.choosePath('new');
    } catch (err) {
      store.setStepError(1, stepErrorMessage(err));
    }
  };

  return (
    <div className="space-y-3">
      <Button
        onClick={handleCreateNew}
        disabled={loading}
        className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Wallet className="h-4 w-4 mr-2" />
        )}
        Create Agent Wallet
      </Button>
      <Button
        onClick={() => store.choosePath('byo')}
        disabled={loading}
        variant="outline"
        className="w-full rounded-xl"
      >
        <KeyRound className="h-4 w-4 mr-2" />I Have a Wallet Key
      </Button>
      <Button
        onClick={() => store.choosePath('external-near')}
        disabled={loading}
        variant="outline"
        className="w-full rounded-xl"
      >
        <IdCard className="h-4 w-4 mr-2" />I Have a NEAR Account
      </Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

export default function JoinPage() {
  const store = useAgentStore();

  const fireHeartbeat = useCallback(async () => {
    const { apiKey } = useAgentStore.getState();
    if (!apiKey) return;
    useAgentStore.getState().setHeartbeatLoading();
    try {
      api.setApiKey(apiKey);
      const response = await api.heartbeat();
      useAgentStore.getState().setHeartbeatSuccess(response);
    } catch (err) {
      useAgentStore.getState().setHeartbeatError(stepErrorMessage(err));
    }
  }, []);

  const done = store.heartbeatStatus === 'success' || store.skippedHeartbeat;

  return (
    <>
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {store.stepStatus[1] === 'success' &&
          'Step 1 complete: wallet created.'}
        {store.stepStatus[2] === 'success' && 'Step 2 complete: wallet funded.'}
        {store.byoStatus === 'success' && 'Wallet verified.'}
        {store.heartbeatStatus === 'loading' && 'Activating your agent...'}
        {store.heartbeatStatus === 'success' &&
          'Setup complete. Your agent is ready.'}
        {store.skippedHeartbeat && 'Setup complete. Hand off to your agent.'}
        {store.stepStatus[1] === 'loading' && 'Creating wallet...'}
        {store.stepStatus[2] === 'loading' && 'Checking balance...'}
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
          {store.path === null &&
            'New wallet, bring your own, or use a NEAR key.'}
          {store.path === 'new' && 'Two steps, under a minute.'}
          {store.path === 'byo' && 'Paste your wallet key to get started.'}
          {store.path === 'external-near' &&
            'Sign in-browser with your NEAR key to provision a derived wallet.'}
        </p>
      </div>

      {store.path === null && <PathPicker />}
      {store.path !== null &&
        !done &&
        store.heartbeatStatus !== 'loading' &&
        (store.path === 'byo' ||
          store.path === 'external-near' ||
          store.stepStatus[1] !== 'success') && (
          <button
            type="button"
            onClick={() => store.reset()}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            ← Back
          </button>
        )}
      {store.path === 'new' && <NewWalletPath fireHeartbeat={fireHeartbeat} />}
      {store.path === 'byo' && <ByoPath fireHeartbeat={fireHeartbeat} />}
      {store.path === 'external-near' && (
        <ExternalNearPath fireHeartbeat={fireHeartbeat} />
      )}

      {done && store.accountId && store.apiKey && (
        <Handoff
          onReset={() => store.reset()}
          apiKey={store.apiKey}
          accountId={store.accountId}
          handoffUrl={store.handoffUrl ?? undefined}
          agent={store.heartbeatData?.agent}
          profileCompleteness={store.heartbeatData?.profile_completeness}
          generateEnabled={store.heartbeatData?.features?.generate}
        />
      )}
    </>
  );
}

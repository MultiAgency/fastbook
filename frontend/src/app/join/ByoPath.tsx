'use client';

import {
  ArrowRight,
  KeyRound,
  Loader2,
  ShieldAlert,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { EXTERNAL_URLS, FUND_AMOUNT_NEAR } from '@/lib/constants';
import { friendlyError } from '@/lib/errors';
import {
  getBalance,
  InsufficientBalanceError,
  verifyWallet,
} from '@/lib/outlayer';
import { useAgentStore } from '@/store/agentStore';
import { PostFunding } from './_shared';
import { BALANCE_THRESHOLD, useBalancePoll } from './useBalancePoll';

export function ByoPath({ fireHeartbeat }: { fireHeartbeat: () => void }) {
  const store = useAgentStore();
  const [inputKey, setInputKey] = useState('');
  const [balance, setBalance] = useState<string | null>(null);
  const [recheckLoading, setRecheckLoading] = useState(false);
  const [recheckError, setRecheckError] = useState<string | null>(null);
  const [insufficientBalance, setInsufficientBalance] = useState(false);
  const lowBalance = balance !== null && Number(balance) < BALANCE_THRESHOLD;

  const handleVerify = async () => {
    const key = inputKey.trim();
    if (!key.startsWith('wk_')) {
      store.setByoError('Key must start with wk_');
      return;
    }
    setInsufficientBalance(false);
    store.setByoLoading();
    try {
      const { account_id, balance: bal } = await verifyWallet(key);
      setBalance(bal);
      store.completeByo(key, account_id);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        setInsufficientBalance(true);
        store.setByoError(err.message);
      } else {
        store.setByoError(friendlyError(err));
      }
    }
  };

  const handleRecheck = async () => {
    if (!store.apiKey) return;
    setRecheckLoading(true);
    setRecheckError(null);
    try {
      const bal = await getBalance(store.apiKey);
      setBalance(bal);
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        // Surface as zero balance — existing low-balance UI covers the state.
        setBalance('0');
      } else {
        setRecheckError(friendlyError(err));
      }
    } finally {
      setRecheckLoading(false);
    }
  };

  const byoDone = store.byoStatus === 'success';
  const apiKey = store.apiKey;
  useBalancePoll({
    apiKey,
    enabled: byoDone && lowBalance,
    onBalance: (bal) => {
      setBalance(bal);
      setRecheckError(null);
    },
  });

  if (store.byoStatus === 'success') {
    return (
      <div className="space-y-4">
        <div className="p-4 rounded-xl bg-primary/5 border border-primary/20">
          <p className="text-xs text-muted-foreground mb-1">Verified Account</p>
          <p className="text-lg font-mono font-bold text-primary">
            {store.accountId}
          </p>
        </div>
        {lowBalance ? (
          <>
            <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <ShieldAlert className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
              <p className="text-xs text-yellow-200/80">
                Balance is below {FUND_AMOUNT_NEAR} NEAR — mutations will fail
                until funded.
              </p>
            </div>
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
              onClick={handleRecheck}
              disabled={recheckLoading}
              variant="outline"
              className="w-full rounded-xl"
            >
              {recheckLoading ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Wallet className="h-4 w-4 mr-2" />
              )}
              Re-check Balance
            </Button>
            {recheckError && (
              <p className="text-xs text-destructive text-center">
                {recheckError}
              </p>
            )}
            {!recheckLoading && !recheckError && (
              <p className="text-xs text-muted-foreground text-center flex items-center justify-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Watching for deposit…
              </p>
            )}
          </>
        ) : (
          <PostFunding fireHeartbeat={fireHeartbeat} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor="byo-key"
          className="text-xs text-muted-foreground block mb-1"
        >
          Wallet Key
        </label>
        <input
          id="byo-key"
          type="password"
          value={inputKey}
          onChange={(e) => setInputKey(e.target.value)}
          placeholder="wk_..."
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
          autoComplete="off"
        />
      </div>
      {insufficientBalance ? (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
          <ShieldAlert className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
          <div className="text-xs text-yellow-200/80 space-y-2">
            <p>
              Your wallet is registered but doesn't have enough NEAR for the
              verification call. Fund it, then verify again.
            </p>
            <a
              href="https://outlayer.fastnear.com/wallet/manage"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 underline hover:no-underline"
            >
              Open OutLayer dashboard
              <ArrowRight className="h-3 w-3" />
            </a>
          </div>
        </div>
      ) : (
        store.byoError && (
          <p className="text-sm text-destructive">{store.byoError}</p>
        )
      )}
      <Button
        onClick={handleVerify}
        disabled={store.byoStatus === 'loading' || !inputKey.trim()}
        className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
      >
        {store.byoStatus === 'loading' ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <KeyRound className="h-4 w-4 mr-2" />
        )}
        Verify Wallet
      </Button>
    </div>
  );
}

'use client';

import { createDeterministicWallet, mintDelegateKey } from '@nearly/sdk';
import { ArrowRight, IdCard, Loader2, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { MaskedCopyField } from '@/components/common/MaskedCopyField';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { EXTERNAL_URLS, FUND_AMOUNT_NEAR } from '@/lib/constants';
import { friendlyError } from '@/lib/errors';
import { useAgentStore } from '@/store/agentStore';
import { PostFunding } from './_shared';

export function ExternalNearPath({
  fireHeartbeat,
}: {
  fireHeartbeat: () => void;
}) {
  const store = useAgentStore();
  const [accountId, setAccountId] = useState('');
  const [seed, setSeed] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [mintKey, setMintKey] = useState(true);

  const handleRegister = async () => {
    const trimmedAccount = accountId.trim();
    const trimmedSeed = seed.trim();
    const trimmedKey = privateKey.trim();
    if (!trimmedAccount) {
      store.setExternalNearError('Account ID is required.');
      return;
    }
    if (!trimmedSeed) {
      store.setExternalNearError('Seed is required.');
      return;
    }
    if (!trimmedKey.startsWith('ed25519:')) {
      store.setExternalNearError(
        'Private key must start with "ed25519:" followed by a base58 body.',
      );
      return;
    }
    store.setExternalNearLoading();
    try {
      // Same-origin proxy: OutLayer's CORS allowlist omits PUT, breaking the mintDelegateKey
      // preflight. Don't swap to OUTLAYER_API_URL without re-checking PUT is allowed.
      const browserOutlayerUrl = '/api/outlayer';
      const provisioned = await createDeterministicWallet({
        outlayerUrl: browserOutlayerUrl,
        accountId: trimmedAccount,
        seed: trimmedSeed,
        privateKey: trimmedKey,
      });
      let walletKey: string | null = null;
      if (mintKey) {
        try {
          const minted = await mintDelegateKey({
            outlayerUrl: browserOutlayerUrl,
            accountId: trimmedAccount,
            seed: trimmedSeed,
            privateKey: trimmedKey,
          });
          walletKey = minted.walletKey;
          api.setApiKey(walletKey);
        } catch (mintErr) {
          setPrivateKey('');
          store.setExternalNearError(
            `Wallet provisioned (${provisioned.nearAccountId}) but delegate-key minting failed: ${friendlyError(mintErr)}. Re-enter your NEAR key and retry — derivation is deterministic, same inputs yield the same wallet.`,
          );
          return;
        }
      }
      setPrivateKey('');
      store.completeExternalNear(
        provisioned.walletId,
        provisioned.nearAccountId,
        walletKey,
      );
    } catch (err) {
      setPrivateKey('');
      store.setExternalNearError(friendlyError(err));
    }
  };

  if (store.externalNearStatus === 'success') {
    const derivedAccount = store.accountId ?? '';
    const walletKey = store.apiKey;
    return (
      <div className="space-y-4">
        <div className="p-4 rounded-xl bg-primary/5 border border-primary/20 space-y-2">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Wallet ID</p>
            <p className="text-sm font-mono font-bold text-primary break-all">
              {store.externalNearWalletId}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">
              Derived NEAR Account
            </p>
            <p className="text-sm font-mono font-bold text-primary break-all">
              {derivedAccount}
            </p>
          </div>
        </div>
        {walletKey ? (
          <>
            <MaskedCopyField label="Delegate Wallet Key" value={walletKey} />
            <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <ShieldAlert className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
              <p className="text-xs text-yellow-200/80">
                Active for this session. Save it if you want durability — it is
                not stored in the browser. Re-derives from the same NEAR key +
                seed on a future visit.
              </p>
            </div>
          </>
        ) : (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
            <ShieldAlert className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
            <p className="text-xs text-yellow-200/80">
              Provisioning only. No <code>wk_</code> was issued — manage this
              wallet via OutLayer with your NEAR key. Heartbeat and social
              mutations through Nearly require a <code>wk_</code> key.
            </p>
          </div>
        )}
        {derivedAccount && (
          <a
            href={EXTERNAL_URLS.OUTLAYER_FUND(derivedAccount)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/80 transition-colors"
          >
            <ArrowRight className="h-4 w-4" />
            Fund with {FUND_AMOUNT_NEAR} NEAR
          </a>
        )}
        {walletKey && <PostFunding fireHeartbeat={fireHeartbeat} />}
      </div>
    );
  }

  const loading = store.externalNearStatus === 'loading';
  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor="ext-account-id"
          className="text-xs text-muted-foreground block mb-1"
        >
          NEAR Account ID
        </label>
        <input
          id="ext-account-id"
          type="text"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder="alice.near"
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
          autoComplete="off"
          disabled={loading}
        />
      </div>
      <div>
        <label
          htmlFor="ext-seed"
          className="text-xs text-muted-foreground block mb-1"
        >
          Seed
          <span className="text-muted-foreground/70 ml-1">
            (same inputs = same wallet)
          </span>
        </label>
        <input
          id="ext-seed"
          type="text"
          value={seed}
          onChange={(e) => setSeed(e.target.value)}
          placeholder="task-42"
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
          autoComplete="off"
          disabled={loading}
        />
      </div>
      <div>
        <label
          htmlFor="ext-private-key"
          className="text-xs text-muted-foreground block mb-1"
        >
          NEAR Private Key
          <span className="text-muted-foreground/70 ml-1">
            (signed in-browser, never sent to Nearly)
          </span>
        </label>
        <input
          id="ext-private-key"
          type="password"
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          placeholder="ed25519:..."
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/40"
          autoComplete="off"
          disabled={loading}
        />
      </div>
      <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={mintKey}
          onChange={(e) => setMintKey(e.target.checked)}
          disabled={loading}
          className="mt-0.5"
        />
        <span>
          Also mint a delegate <code>wk_</code> so I can use this wallet in
          Nearly this session. Uncheck to provision the wallet only and manage
          it externally.
        </span>
      </label>
      {store.externalNearError && (
        <p className="text-sm text-destructive">{store.externalNearError}</p>
      )}
      <Button
        onClick={handleRegister}
        disabled={
          loading || !accountId.trim() || !seed.trim() || !privateKey.trim()
        }
        className="w-full rounded-xl bg-primary text-primary-foreground hover:bg-primary/80"
      >
        {loading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <IdCard className="h-4 w-4 mr-2" />
        )}
        {mintKey ? 'Provision + Activate Wallet' : 'Provision Derived Wallet'}
      </Button>
    </div>
  );
}

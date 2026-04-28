import { useEffect, useRef } from 'react';
import { FUND_AMOUNT_NEAR } from '@/lib/constants';
import { getBalance } from '@/lib/outlayer';

export const BALANCE_THRESHOLD = Number(FUND_AMOUNT_NEAR) * 1e24;
const BALANCE_POLL_MS = 5_000;

// Polls OutLayer balance on a fixed cadence while `enabled` and `apiKey`
// hold. Callbacks are ref-captured so the interval doesn't reset on every
// parent render; only the primitive gates restart the timer.
export function useBalancePoll({
  apiKey,
  enabled,
  onBalance,
  shouldSkipTick,
}: {
  apiKey: string | null;
  enabled: boolean;
  onBalance: (balance: string) => void;
  shouldSkipTick?: () => boolean;
}) {
  const pollingRef = useRef(false);
  const onBalanceRef = useRef(onBalance);
  const shouldSkipTickRef = useRef(shouldSkipTick);
  onBalanceRef.current = onBalance;
  shouldSkipTickRef.current = shouldSkipTick;

  useEffect(() => {
    if (!apiKey || !enabled) return;

    const id = setInterval(async () => {
      if (pollingRef.current || shouldSkipTickRef.current?.()) return;
      pollingRef.current = true;
      try {
        const balance = await getBalance(apiKey);
        onBalanceRef.current(balance);
      } catch {
        // Swallow transient poll failures — the next tick retries.
      } finally {
        pollingRef.current = false;
      }
    }, BALANCE_POLL_MS);

    return () => clearInterval(id);
  }, [apiKey, enabled]);
}

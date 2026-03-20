'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { api } from '@/lib/api';
import { APP_DOMAIN } from '@/lib/constants';
import { registerOutlayer, signMessage } from '@/lib/outlayer';
import { friendlyError, isValidHandle } from '@/lib/utils';
import { useAuthStore } from '@/store';
import type { Nep413Auth, OnboardingContext } from '@/types';
import { RegistrationForm } from './RegistrationForm';
import { RegistrationSuccess } from './RegistrationSuccess';

export type Step = 'form' | 'wallet' | 'signing' | 'registering' | 'success';

export default function RegisterPage() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const [step, setStep] = useState<Step>('form');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [nearAccountId, setNearAccountId] = useState('');
  const [onboarding, setOnboarding] = useState<OnboardingContext | null>(null);
  const [registerTxHash, setRegisterTxHash] = useState<string | undefined>();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!handle.trim()) {
      setError('Please enter an agent handle');
      return;
    }

    if (!isValidHandle(handle)) {
      setError(
        'Handle must be 2-32 characters, letters, numbers, and underscores only',
      );
      return;
    }

    try {
      // Step 1: Create OutLayer custody wallet
      setStep('wallet');
      const walletResult = await registerOutlayer();
      const { api_key: outlayerKey, near_account_id } = walletResult.data;
      setNearAccountId(near_account_id);
      setApiKey(outlayerKey);

      // Step 2: Sign NEP-413 registration message
      setStep('signing');
      const message = JSON.stringify({
        action: 'register',
        domain: APP_DOMAIN,
        account_id: near_account_id,
        version: 1,
        timestamp: Date.now(),
      });
      const signResult = await signMessage(outlayerKey, message, APP_DOMAIN);

      const auth: Nep413Auth = {
        near_account_id,
        public_key: signResult.data.public_key,
        signature: signResult.data.signature,
        nonce: signResult.data.nonce,
        message,
      };

      // Step 3: Register on the market via WASM
      setStep('registering');
      api.setApiKey(outlayerKey);
      api.setAuth(auth);
      const response = await api.register(
        {
          handle,
          description: description || undefined,
          verifiable_claim: auth,
        },
        (txHash) => setRegisterTxHash(txHash),
      );

      if (response.onboarding) setOnboarding(response.onboarding);
      setStep('success');
    } catch (err) {
      setError(friendlyError(err));
      setStep('form');
    }
  };

  const handleLogin = useCallback(async () => {
    try {
      await login(apiKey, api.getAuth()!);
      router.push('/');
    } catch {
      // If auto-login fails, user can still copy the key and login manually
    }
  }, [apiKey, login, router]);

  if (step === 'success' && apiKey) {
    return (
      <RegistrationSuccess
        apiKey={apiKey}
        nearAccountId={nearAccountId}
        registerTxHash={registerTxHash}
        onboarding={onboarding}
        onLogin={handleLogin}
      />
    );
  }

  return (
    <RegistrationForm
      handle={handle}
      setHandle={setHandle}
      description={description}
      setDescription={setDescription}
      error={error}
      step={step}
      onSubmit={handleSubmit}
    />
  );
}

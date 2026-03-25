'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { APP_DOMAIN } from '@/lib/constants';
import { registerOutlayer, signMessage } from '@/lib/outlayer';
import { friendlyError, isValidHandle } from '@/lib/utils';
import type { Nep413Auth, OnboardingContext } from '@/types';
import { RegistrationForm } from './RegistrationForm';
import { RegistrationSuccess } from './RegistrationSuccess';

export type Step = 'form' | 'wallet' | 'signing' | 'registering' | 'success';

export default function RegisterPage() {
  const [step, setStep] = useState<Step>('form');
  const [handle, setHandle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [nearAccountId, setNearAccountId] = useState('');
  const [onboarding, setOnboarding] = useState<OnboardingContext | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!handle.trim()) {
      setError('Please enter an agent handle');
      return;
    }

    if (!isValidHandle(handle)) {
      setError(
        'Handle must be 3-32 characters: start with a letter, then letters, numbers, or underscores',
      );
      return;
    }

    try {
      setStep('wallet');
      const wallet = await registerOutlayer();
      const { api_key: outlayerKey, near_account_id } = wallet;
      setNearAccountId(near_account_id);
      setApiKey(outlayerKey);

      setStep('signing');
      const message = JSON.stringify({
        action: 'register',
        domain: APP_DOMAIN,
        account_id: near_account_id,
        version: 1,
        timestamp: Date.now(),
      });
      const signed = await signMessage(outlayerKey, message, APP_DOMAIN);

      const auth: Nep413Auth = {
        near_account_id,
        public_key: signed.public_key,
        signature: signed.signature,
        nonce: signed.nonce,
        message,
      };

      setStep('registering');
      api.setApiKey(outlayerKey);
      api.setAuth(auth);
      const response = await api.register({
        handle,
        description: description || undefined,
        verifiable_claim: auth,
      });

      if (response.onboarding) setOnboarding(response.onboarding);
      setStep('success');
    } catch (err) {
      api.clearCredentials();
      setError(friendlyError(err));
      setStep('form');
    }
  };

  if (step === 'success' && apiKey) {
    return (
      <RegistrationSuccess
        apiKey={apiKey}
        nearAccountId={nearAccountId}
        onboarding={onboarding}
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

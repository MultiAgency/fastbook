import { useAuthStore, useNotificationStore } from '@/store';

/** NEP-413 auth object for agency.near — reuse across tests that need auth. */
export const TEST_AUTH = {
  near_account_id: 'agency.near',
  public_key: 'ed25519:abc',
  signature: 'ed25519:sig',
  nonce: 'bm9uY2U=',
  message: 'hello',
} as const;

/** Reset auth and notification stores to initial state. */
export function resetStores() {
  useAuthStore.setState({
    agent: null,
    apiKey: null,
    auth: null,
    isLoading: false,
    error: null,
  });
  useNotificationStore.setState({
    notifications: [],
    unreadCount: 0,
    isLoading: false,
  });
}

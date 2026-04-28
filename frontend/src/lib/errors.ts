import { toErrorMessage } from './utils';

export type ErrorKind = 'network' | 'auth' | 'generic';

export interface ClassifiedError {
  kind: ErrorKind;
  message: string;
}

const ERROR_PATTERNS: readonly [RegExp, string, ErrorKind][] = [
  // Specific upstream/status-code patterns before generic network patterns
  // so "upstream timeout" gets the server-specific message, not the generic one.
  [
    /upstream.*timeout|504/i,
    'The server took too long to respond. Please try again.',
    'network',
  ],
  [
    /upstream.*unreachable|502/i,
    'Could not reach the backend. Please try again.',
    'network',
  ],
  [
    /503|service unavailable|not configured/i,
    'The service is temporarily unavailable. Please try again later.',
    'network',
  ],
  [/\babort|\btimeout/i, 'Request timed out. Please try again.', 'network'],
  [
    /failed to fetch|networkerror|econnrefused|net::err_/i,
    'Could not reach the server. Make sure the backend is running.',
    'network',
  ],
  [
    /\brpc\b|network\s*error|\bfetch\b/i,
    'Could not reach the NEAR network. Please try again.',
    'network',
  ],
  [
    /already taken|conflict/i,
    'This account is already registered. Try a different one.',
    'generic',
  ],
  [/reserved/i, 'This name is reserved. Choose a different one.', 'generic'],
  [
    /already registered/i,
    'This NEAR account is already registered.',
    'generic',
  ],
  [/Agent not found/i, 'Agent not found.', 'generic'],
  [
    /No agent registered/i,
    'You need to register before performing this action.',
    'auth',
  ],
  [/Cannot follow yourself/i, 'You cannot follow yourself.', 'generic'],
  [/Cannot unfollow yourself/i, 'You cannot unfollow yourself.', 'generic'],
  [
    /Cannot endorse yourself|Cannot unendorse yourself/i,
    'You cannot endorse yourself.',
    'generic',
  ],
  [
    /nonce has already been used/i,
    'This signature has already been used. Please sign again.',
    'auth',
  ],
  [
    /expired|timestamp/i,
    'Your signature has expired. Please sign again.',
    'auth',
  ],
  [
    /Auth failed|Authentication required|unauthorized|\b401\b/i,
    'Authentication failed. Please restart the flow.',
    'auth',
  ],
  [/\b403\b|forbidden/i, 'Access denied.', 'auth'],
  [
    /rate.?limit|429|too many/i,
    'Too many requests. Please wait a moment.',
    'generic',
  ],
  [
    /WASM execution failed|decode.*output/i,
    'Backend execution error. Please try again.',
    'generic',
  ],
  [
    /402|quota|insufficient.*funds?|payment/i,
    'Insufficient credits. Please check your account balance.',
    'generic',
  ],
  [
    /VALIDATION_ERROR|validation failed/i,
    'Invalid input. Please check your data and try again.',
    'generic',
  ],
  [
    /STORAGE_ERROR/i,
    'A storage error occurred. Please try again shortly.',
    'generic',
  ],
  [
    /INTERNAL_ERROR/i,
    'An internal error occurred. Please try again.',
    'generic',
  ],
];

export function classifyError(err: unknown): ClassifiedError {
  // Check ApiError.code first — resilient to backend message text changes
  const code =
    err != null && typeof err === 'object' && 'code' in err
      ? (err as { code?: string }).code
      : undefined;
  const msg = code ? `${code} ${toErrorMessage(err)}` : toErrorMessage(err);
  for (const [pattern, message, kind] of ERROR_PATTERNS) {
    if (pattern.test(msg)) return { kind, message };
  }
  return {
    kind: 'generic',
    message: 'Something went wrong. Please try again.',
  };
}

export function friendlyError(err: unknown): string {
  return classifyError(err).message;
}

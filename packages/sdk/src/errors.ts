export type NearlyErrorCode =
  | 'INSUFFICIENT_BALANCE'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'SELF_FOLLOW'
  | 'SELF_ENDORSE'
  | 'NOT_FOUND'
  | 'AUTH_FAILED'
  | 'NETWORK'
  | 'PROTOCOL';

interface InsufficientBalanceError {
  code: 'INSUFFICIENT_BALANCE';
  required: string;
  balance: string;
  message: string;
}
interface RateLimitedError {
  code: 'RATE_LIMITED';
  action: string;
  retryAfter: number;
  message: string;
}
interface ValidationErrorShape {
  code: 'VALIDATION_ERROR';
  field: string;
  reason: string;
  message: string;
}
interface SelfFollowError {
  code: 'SELF_FOLLOW';
  message: string;
}
interface SelfEndorseError {
  code: 'SELF_ENDORSE';
  message: string;
}
interface NotFoundError {
  code: 'NOT_FOUND';
  resource: string;
  message: string;
}
interface AuthError {
  code: 'AUTH_FAILED';
  message: string;
}
interface NetworkError {
  code: 'NETWORK';
  cause: unknown;
  message: string;
}
interface ProtocolError {
  code: 'PROTOCOL';
  hint: string;
  message: string;
}

export type NearlyErrorShape =
  | InsufficientBalanceError
  | RateLimitedError
  | ValidationErrorShape
  | SelfFollowError
  | SelfEndorseError
  | NotFoundError
  | AuthError
  | NetworkError
  | ProtocolError;

export class NearlyError extends Error {
  readonly shape: NearlyErrorShape;

  constructor(shape: NearlyErrorShape) {
    super(shape.message);
    this.name = 'NearlyError';
    this.shape = shape;
  }

  get code(): NearlyErrorCode {
    return this.shape.code;
  }
}

export function validationError(field: string, reason: string): NearlyError {
  return new NearlyError({
    code: 'VALIDATION_ERROR',
    field,
    reason,
    message: `Validation failed for ${field}: ${reason}`,
  });
}

export function networkError(cause: unknown): NearlyError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new NearlyError({
    code: 'NETWORK',
    cause,
    message: `Network error: ${detail}`,
  });
}

export function protocolError(hint: string): NearlyError {
  return new NearlyError({
    code: 'PROTOCOL',
    hint,
    message: `Protocol error: ${hint}`,
  });
}

export function rateLimitedError(
  action: string,
  retryAfter: number,
): NearlyError {
  return new NearlyError({
    code: 'RATE_LIMITED',
    action,
    retryAfter,
    message: `Rate limit exceeded for ${action}. Retry after ${retryAfter}s.`,
  });
}

export function insufficientBalanceError(
  required: string,
  balance: string,
): NearlyError {
  return new NearlyError({
    code: 'INSUFFICIENT_BALANCE',
    required,
    balance,
    message: `Insufficient balance: required ≥${required} NEAR, current balance ${balance}. Fund your custody wallet and retry.`,
  });
}

export function authError(message: string): NearlyError {
  return new NearlyError({ code: 'AUTH_FAILED', message });
}

export function notFoundError(resource: string): NearlyError {
  return new NearlyError({
    code: 'NOT_FOUND',
    resource,
    message: `Not found: ${resource}`,
  });
}

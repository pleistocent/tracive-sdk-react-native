export type TraciveErrorKind =
  | 'notImplemented'
  | 'invalidRequest'
  | 'unsupportedInputType'
  | 'unsupportedCreditSource'
  | 'invalidToken'
  | 'expiredToken'
  | 'grantRevoked'
  | 'invalidApiKey'
  | 'insufficientCredits'
  | 'missingScope'
  | 'detailNotPermitted'
  | 'credentialMismatch'
  | 'partnerSuspended'
  | 'idempotencyConflict'
  | 'rateLimited'
  | 'network'
  | 'server'
  | 'unknown'
  | 'cacheMiss'
  | 'stateMismatch'
  | 'invalidQuery'
  | 'configuration';

export type InsufficientCreditsKind =
  'insufficient_user_credits' | 'insufficient_credits' | 'insufficient_partner_balance';

export interface TraciveErrorInfo {
  readonly code?: string;
  readonly message?: string;
  /** Quote this in a support ticket: it identifies the exact check on the server. */
  readonly checkId?: string;
}

export interface TraciveErrorOptions {
  readonly kind: TraciveErrorKind;
  readonly message?: string;
  readonly status?: number | undefined;
  readonly info?: TraciveErrorInfo | undefined;
  readonly retryAfterSeconds?: number | undefined;
  readonly which?: InsufficientCreditsKind | undefined;
  readonly cause?: unknown;
}

/**
 * `isTransient` answers "could this succeed on a later attempt?". It is NOT permission to retry:
 * a check without an idempotency key is never retried no matter what this says, because the SDK
 * cannot tell whether the first attempt was already charged.
 */
function computeIsTransient(kind: TraciveErrorKind, status: number | undefined): boolean {
  if (kind === 'network' || kind === 'rateLimited') return true;
  if (kind === 'server') return true;
  return status !== undefined && status >= 500;
}

export class TraciveError extends Error {
  override readonly name = 'TraciveError' as const;
  readonly kind: TraciveErrorKind;
  readonly status?: number | undefined;
  readonly info?: TraciveErrorInfo | undefined;
  /** Populated when `kind === 'rateLimited'`. */
  readonly retryAfterSeconds?: number | undefined;
  /** Populated when `kind === 'insufficientCredits'`. */
  readonly which?: InsufficientCreditsKind | undefined;
  /** Populated when `kind === 'network'`. Declared, not overridden: ES2020 `Error` has no cause. */
  readonly cause?: unknown;
  readonly isTransient: boolean;

  constructor(options: TraciveErrorOptions) {
    super(options.message ?? options.info?.message ?? options.kind);
    Object.setPrototypeOf(this, TraciveError.prototype);
    this.kind = options.kind;
    this.status = options.status;
    this.info = options.info;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.which = options.which;
    this.cause = options.cause;
    this.isTransient = computeIsTransient(options.kind, options.status);
  }

  /** The raw `code` the server sent, carried through even when it was not recognised. */
  get serverCode(): string | undefined {
    return this.info?.code;
  }
}

export function isTraciveError(value: unknown): value is TraciveError {
  return value instanceof TraciveError;
}

const KIND_BY_CODE: Readonly<Record<string, TraciveErrorKind>> = {
  not_implemented: 'notImplemented',
  invalid_request: 'invalidRequest',
  unsupported_input_type: 'unsupportedInputType',
  unsupported_credit_source: 'unsupportedCreditSource',
  invalid_token: 'invalidToken',
  expired_token: 'expiredToken',
  grant_revoked: 'grantRevoked',
  invalid_api_key: 'invalidApiKey',
  insufficient_user_credits: 'insufficientCredits',
  insufficient_credits: 'insufficientCredits',
  insufficient_partner_balance: 'insufficientCredits',
  missing_scope: 'missingScope',
  detail_not_permitted: 'detailNotPermitted',
  credential_mismatch: 'credentialMismatch',
  partner_suspended: 'partnerSuspended',
  idempotency_conflict: 'idempotencyConflict',
  rate_limited: 'rateLimited',
};

const INSUFFICIENT_CREDITS_KINDS: readonly InsufficientCreditsKind[] = [
  'insufficient_user_credits',
  'insufficient_credits',
  'insufficient_partner_balance',
];

function insufficientCreditsKind(code: string | undefined): InsufficientCreditsKind | undefined {
  return INSUFFICIENT_CREDITS_KINDS.find((candidate) => candidate === code);
}

/**
 * Maps a `(status, code)` pair onto a kind. An unrecognised code never crashes and is never
 * dropped: the raw value stays reachable through {@link TraciveError.serverCode} so a partner can
 * see what a newer server sent without waiting for an SDK release.
 */
export function traciveErrorFrom(input: {
  status: number;
  code?: string | undefined;
  message?: string | undefined;
  checkId?: string | undefined;
  retryAfterSeconds?: number | undefined;
}): TraciveError {
  const { status, code } = input;
  const mapped = code === undefined ? undefined : KIND_BY_CODE[code];

  let kind: TraciveErrorKind;
  if (mapped !== undefined) {
    kind = mapped;
  } else if (status === 429) {
    kind = 'rateLimited';
  } else if (status >= 500) {
    kind = 'server';
  } else {
    kind = 'unknown';
  }

  const info: TraciveErrorInfo = {
    ...(code !== undefined ? { code } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.checkId !== undefined ? { checkId: input.checkId } : {}),
  };

  return new TraciveError({
    kind,
    status,
    info,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: input.retryAfterSeconds }
      : {}),
    ...(kind === 'insufficientCredits' ? { which: insufficientCreditsKind(code) } : {}),
  });
}

/**
 * `Retry-After` accepts either a delay in seconds or an HTTP-date. A date in the past clamps to
 * zero rather than producing a negative sleep; anything unparseable is `undefined`, which leaves
 * the computed backoff in charge.
 */
export function parseRetryAfterSeconds(
  headerValue: string | undefined,
  nowMs: number,
): number | undefined {
  if (headerValue === undefined) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed === '') return undefined;

  if (/^[0-9]+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, (parsed - nowMs) / 1000);
}

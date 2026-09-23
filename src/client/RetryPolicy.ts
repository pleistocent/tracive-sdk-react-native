export interface RetryPolicy {
  /** `1` disables retrying entirely. */
  readonly maxAttempts: number;
  readonly initialBackoffSeconds: number;
  readonly multiplier: number;
  readonly maxBackoffSeconds: number;
  /** Clamped to 0..1. Without it a fleet of apps that all saw the same 503 retries in lockstep. */
  readonly jitter: number;
  readonly respectsRetryAfter: boolean;
}

/**
 * The defaults, and why each number is the number.
 *
 * They are the same in every Tracive SDK, which is the point of writing the reasoning down here:
 * the values drifted apart once already because nothing recorded what any of them was for, and a
 * number with no stated reason is one the next person is free to round off.
 *
 * - **`maxAttempts: 3`** — the first send plus two retries. A transient 5xx nearly always
 *   clears inside a couple of seconds; a third consecutive failure is a signal rather than noise,
 *   and further attempts only add load to a server that is already struggling. It is deliberately
 *   small because on a check every attempt is a potential charge, which is also why the budget can
 *   only be spent when the caller supplied an idempotency key.
 * - **`multiplier: 2`** — plain exponential backoff. Smaller barely spaces the attempts out at
 *   all; larger overshoots the window in which a transient fault actually clears, so the retry
 *   arrives well after the server recovered.
 * - **`initialBackoffSeconds: 0.5`** — long enough that the second attempt is not the first one
 *   repeated straight back into the same momentary fault: a load-balancer failover, a cold
 *   instance, a rate-limit bucket that refills on a sub-second tick. Short enough that a user
 *   watching a spinner does not experience it as a stall.
 * - **`jitter: 0.2`** — ±20%, applied symmetrically so the mean schedule is unchanged. Without it
 *   every app that saw the same 503 retries in lockstep and rebuilds the spike that caused it.
 *   Twenty per cent smears a fleet across the interval while keeping the delay predictable enough
 *   for someone reading a log to recognise the schedule.
 * - **`maxBackoffSeconds: 8`** — the ceiling. At these defaults it never binds, because the last
 *   retry waits one second; it exists for a caller who raises `maxAttempts`, and caps the wait at
 *   something a user will still sit through. A `Retry-After` on a 5xx overrides it outright,
 *   including upwards — see `backoffSecondsFor`.
 *
 * A 429 is never retried at all, whatever these numbers say. Its `Retry-After` can point at the
 * next UTC midnight, so the client surfaces `rateLimited` with `retryAfterSeconds` instead of
 * sleeping on it.
 */
const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialBackoffSeconds: 0.5,
  multiplier: 2,
  maxBackoffSeconds: 8,
  jitter: 0.2,
  respectsRetryAfter: true,
};

const DISABLED_RETRY: RetryPolicy = { ...DEFAULT_RETRY, maxAttempts: 1 };

function create(overrides?: Partial<RetryPolicy>): RetryPolicy {
  if (overrides === undefined) return DEFAULT_RETRY;
  const merged: Record<string, unknown> = { ...DEFAULT_RETRY };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  const policy = merged as unknown as RetryPolicy;
  return { ...policy, jitter: Math.min(1, Math.max(0, policy.jitter)) };
}

export const RetryPolicy: {
  readonly default: RetryPolicy;
  readonly disabled: RetryPolicy;
  create(overrides?: Partial<RetryPolicy>): RetryPolicy;
} = {
  default: DEFAULT_RETRY,
  disabled: DISABLED_RETRY,
  create,
};

/**
 * The delay before attempt number `attempt` (1-based, so attempt 2 is the first retry).
 *
 * `retryAfterSeconds` wins outright when the policy respects it, **including when it is longer
 * than `maxBackoffSeconds`** — a server asking for 60 seconds means 60 seconds, and clamping it
 * down would send the stampede straight back. Only a 5xx reaches this: a 429 is never retried.
 *
 * `randomFraction` is injected rather than read from `Math.random` so the schedule is testable.
 * Jitter is a scheduling nicety, never a security primitive, so a non-CSPRNG source is correct
 * here — see `src/crypto/random.ts` for the source that must never be `Math.random`.
 */
export function backoffSecondsFor(
  policy: RetryPolicy,
  attempt: number,
  retryAfterSeconds: number | undefined,
  randomFraction: number,
): number {
  if (policy.respectsRetryAfter && retryAfterSeconds !== undefined) {
    return Math.max(0, retryAfterSeconds);
  }
  const exponent = Math.max(0, attempt - 2);
  const raw = policy.initialBackoffSeconds * Math.pow(policy.multiplier, exponent);
  const capped = Math.min(policy.maxBackoffSeconds, raw);
  const jitter = Math.min(1, Math.max(0, policy.jitter));
  if (jitter === 0) return capped;
  // Symmetric jitter around the computed delay, never negative.
  const spread = capped * jitter;
  return Math.max(0, capped - spread + randomFraction * spread * 2);
}

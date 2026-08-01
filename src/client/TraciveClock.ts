import { TraciveError } from '../model/TraciveError';

/**
 * Time is a port so that TTLs, backoff schedules and pending-authorization ages are all testable
 * without waiting. The same clock measures a cache entry's freshness and stamps `fetchedAt`, so
 * the two can never disagree.
 */
export interface TraciveClock {
  nowMs(): number;
  /**
   * Waits `seconds`, or rejects as soon as `signal` aborts — whichever happens first.
   *
   * The signal is not decoration. `Retry-After` is honoured verbatim, including values far
   * larger than `maxBackoffSeconds`, so without a cancellation path a server asking for an hour
   * would hold the caller for an hour with no way out. An implementation that ignores the
   * parameter still satisfies this interface; the client re-checks the signal itself for exactly
   * that reason.
   */
  sleep(seconds: number, signal?: AbortSignal): Promise<void>;
}

/** The one error every abort path in this SDK produces, so a caller has a single shape to catch. */
export function abortedRequestError(): TraciveError {
  // `network`, not a kind of its own: from a caller's point of view the work stopped and nothing
  // was learned, which is exactly what `FetchHttpTransport` already reports for an aborted fetch.
  return new TraciveError({ kind: 'network', message: 'The request was aborted.' });
}

/**
 * `setTimeout` coerces its delay to a 32-bit signed integer, so anything over ~24.85 days fires
 * on the next tick instead — the exact opposite of what a long `Retry-After` asked for, and a hot
 * retry loop against a server that just asked for a long break. Long waits are therefore served
 * as a chain of slices no larger than this.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

export const systemClock: TraciveClock = {
  nowMs(): number {
    return Date.now();
  },
  sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(abortedRequestError());
    return new Promise((resolve, reject) => {
      let remainingMs = Math.max(0, seconds) * 1000;
      let timer: ReturnType<typeof setTimeout>;

      // Named rather than inline so it can be removed on the happy path: a long-lived signal
      // that accumulated one listener per retry would be a leak of its own.
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortedRequestError());
      };

      const arm = (): void => {
        const slice = Math.min(remainingMs, MAX_TIMEOUT_MS);
        remainingMs -= slice;
        timer = setTimeout(() => {
          if (remainingMs > 0) {
            arm();
            return;
          }
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, slice);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      arm();
    });
  },
};

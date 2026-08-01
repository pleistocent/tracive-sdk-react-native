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

export const systemClock: TraciveClock = {
  nowMs(): number {
    return Date.now();
  },
  sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(abortedRequestError());
    return new Promise((resolve, reject) => {
      // Named rather than inline so it can be removed on the happy path: a long-lived signal
      // that accumulated one listener per retry would be a leak of its own.
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortedRequestError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, seconds) * 1000);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  },
};

/**
 * Time is a port so that TTLs, backoff schedules and pending-authorization ages are all testable
 * without waiting. The same clock measures a cache entry's freshness and stamps `fetchedAt`, so
 * the two can never disagree.
 */
export interface TraciveClock {
  nowMs(): number;
  sleep(seconds: number): Promise<void>;
}

export const systemClock: TraciveClock = {
  nowMs(): number {
    return Date.now();
  },
  sleep(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, seconds) * 1000);
    });
  },
};

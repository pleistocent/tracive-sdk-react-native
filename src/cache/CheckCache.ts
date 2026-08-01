import { systemClock, type TraciveClock } from '../client/TraciveClock';
import { CachePolicy } from '../model/CachePolicy';
import { toCacheableCopy, type CheckResult } from '../model/CheckResult';
import type { CheckCacheError } from './CheckCacheError';
import type { CheckCacheKey } from './CheckCacheKey';

/**
 * A cache hit costs zero credits and every uncached repeat is a charge, so this is a billing
 * surface before it is a performance one.
 *
 * `read` returns `undefined` for a miss and throws only for a genuine storage fault. The
 * distinction matters: a miss means "ask the server", a fault means "the disk is broken", and
 * answering "no reports found" when the truth is the second would be a fabricated clean verdict.
 */
export interface CheckCache {
  readonly policy: CachePolicy;
  /**
   * The last storage fault, so that a cache which quietly stopped working shows up in the
   * partner's telemetry instead of silently billing them for every repeat check.
   */
  readonly lastStoreError: CheckCacheError | undefined;
  read(key: CheckCacheKey): Promise<CheckResult | undefined>;
  write(result: CheckResult, key: CheckCacheKey): Promise<void>;
  remove(key: CheckCacheKey): Promise<void>;
  clear(): Promise<void>;
  prune(): Promise<number>;
  count(): Promise<number>;
}

/** Caches nothing and reports nothing. Every read is a miss and every write is a no-op. */
export class NoOpCheckCache implements CheckCache {
  readonly policy: CachePolicy;
  #lastStoreError: CheckCacheError | undefined;

  constructor(policy?: CachePolicy, lastStoreError?: CheckCacheError) {
    this.policy = policy ?? CachePolicy.disabled;
    this.#lastStoreError = lastStoreError;
  }

  get lastStoreError(): CheckCacheError | undefined {
    return this.#lastStoreError;
  }

  read(_key: CheckCacheKey): Promise<CheckResult | undefined> {
    return Promise.resolve(undefined);
  }

  write(_result: CheckResult, _key: CheckCacheKey): Promise<void> {
    return Promise.resolve();
  }

  remove(_key: CheckCacheKey): Promise<void> {
    return Promise.resolve();
  }

  clear(): Promise<void> {
    return Promise.resolve();
  }

  prune(): Promise<number> {
    return Promise.resolve(0);
  }

  count(): Promise<number> {
    return Promise.resolve(0);
  }
}

interface MemoryEntry {
  readonly result: CheckResult;
  readonly expiresAtMs: number;
  readonly storedAtMs: number;
}

/**
 * The default wiring: repeat checks within a session are free with zero native code.
 *
 * It is deliberately not the recommended end state. Installing a persistent adapter is the first
 * post-install step in the README, stated in money terms, because a process restart throwing away
 * a 30-day HIGH-tier verdict is a bill, not a cache miss.
 *
 * Entries are held in a `Map` rather than a plain object. A folded key or a cache-key hex used as
 * an object property would collide with `__proto__`, `constructor` and `toString`; the record-key
 * guard already rejects `__proto__`, and this is free defence in depth.
 */
export class InMemoryCheckCache implements CheckCache {
  readonly policy: CachePolicy;
  readonly #clock: TraciveClock;
  readonly #entries = new Map<string, MemoryEntry>();
  #sequence = 0;

  constructor(options?: { policy?: CachePolicy; clock?: TraciveClock }) {
    this.policy = options?.policy ?? CachePolicy.default;
    this.#clock = options?.clock ?? systemClock;
  }

  /** An in-memory map has no storage layer, so it has no storage faults to report. */
  get lastStoreError(): CheckCacheError | undefined {
    return undefined;
  }

  read(key: CheckCacheKey): Promise<CheckResult | undefined> {
    if (!this.policy.enabled) return Promise.resolve(undefined);
    const entry = this.#entries.get(key.hex);
    if (entry === undefined) return Promise.resolve(undefined);
    if (this.#clock.nowMs() >= entry.expiresAtMs) {
      this.#entries.delete(key.hex);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.result);
  }

  write(result: CheckResult, key: CheckCacheKey): Promise<void> {
    if (!this.policy.enabled) return Promise.resolve();
    const ttlSeconds = CachePolicy.effectiveTtlSeconds(this.policy, result);
    if (ttlSeconds <= 0) {
      // Deleted rather than skipped, for the reason spelled out in `PersistentCheckCache.write`:
      // a zero TTL is the server retracting an answer, so leaving the previous entry in place
      // would keep serving the verdict it just withdrew.
      this.#entries.delete(key.hex);
      return Promise.resolve();
    }
    const cacheable = toCacheableCopy(result);
    this.#entries.set(key.hex, {
      result: cacheable,
      expiresAtMs: cacheable.fetchedAt.getTime() + ttlSeconds * 1000,
      storedAtMs: this.#sequence++,
    });
    void this.#evictOverflow();
    return Promise.resolve();
  }

  remove(key: CheckCacheKey): Promise<void> {
    this.#entries.delete(key.hex);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#entries.clear();
    return Promise.resolve();
  }

  prune(): Promise<number> {
    const now = this.#clock.nowMs();
    let removed = 0;
    for (const [hex, entry] of this.#entries) {
      if (now >= entry.expiresAtMs) {
        this.#entries.delete(hex);
        removed++;
      }
    }
    return Promise.resolve(removed + this.#evictOverflow());
  }

  count(): Promise<number> {
    return Promise.resolve(this.#entries.size);
  }

  #evictOverflow(): number {
    const max = this.policy.maxEntries;
    if (max === undefined || this.#entries.size <= max) return 0;
    const ordered = [...this.#entries.entries()].sort((a, b) => a[1].storedAtMs - b[1].storedAtMs);
    const excess = this.#entries.size - max;
    for (let i = 0; i < excess; i++) {
      const victim = ordered[i];
      if (victim !== undefined) this.#entries.delete(victim[0]);
    }
    return excess;
  }
}

import { systemClock, type TraciveClock } from '../client/TraciveClock';
import { CachePolicy } from '../model/CachePolicy';
import { toCacheableCopy, toTransactionRecordCopy, type CheckResult } from '../model/CheckResult';
import type { CheckCacheError } from './CheckCacheError';
import { transactionRowKey, type CheckCacheKey } from './CheckCacheKey';

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
  /**
   * Files `result` as the answer that was shown for `transactionId`.
   *
   * This is what a transaction-detail screen reads back weeks later — "checked before you sent it,
   * no reports found" — and it exists because `read` cannot answer that question. `read` is keyed on
   * the identifier and holds whatever the LATEST check said; a transaction detail has to show what
   * the user was shown AT THE TIME THEY DECIDED, and those two diverge the moment the same account
   * is checked again.
   *
   * Three differences from `write`, all following from that:
   * - It is a SNAPSHOT, not a pointer. Each call stores its own copy, so a later check of the same
   *   account cannot rewrite what an earlier transaction says. Recording one answer against two
   *   transactions — a user who transfers to the same account twice — is two calls with two ids and
   *   one billed check.
   * - It OUTLIVES the cache entry. The lifetime is `policy.transactionCheckRetentionSeconds`, not a
   *   tier TTL, and `cacheTtlSeconds` is not applied: that field retracts a verdict, and a record of
   *   the past cannot be retracted.
   * - `origin` and `fetchedAt` are stored as given, so a record marked `'CACHE'` is the honest
   *   statement that this transfer spent no credit.
   *
   * Call it AFTER the transaction exists. In a transfer flow the check happens on the confirmation
   * screen and the reference number is minted after the PIN, so there is no id to pass when the
   * check is made — which is why this is a separate call rather than an argument to `checkScammer`.
   *
   * @throws CheckCacheError `invalidTransactionId` when the id is blank.
   */
  writeTransactionCheck(result: CheckResult, transactionId: string): Promise<void>;
  /**
   * The answer recorded for `transactionId`, or `undefined` when there is none.
   *
   * `undefined` covers a transaction that was never recorded, one past its retention, and a row that
   * would not decrypt. A UI must read it as "no check is on file" and show nothing, never as "no
   * reports were found": the second is a clean bill of health for a transfer nobody checked.
   *
   * @throws CheckCacheError `invalidTransactionId` when the id is blank.
   */
  readTransactionCheck(transactionId: string): Promise<CheckResult | undefined>;
  /**
   * Drops one transaction record. Leaves the cache entry it was copied from, and every other
   * transaction's record, alone.
   *
   * @throws CheckCacheError `invalidTransactionId` when the id is blank.
   */
  removeTransactionCheck(transactionId: string): Promise<void>;
  /** Empties the cache, transaction records included. This is what sign-out calls. */
  clear(): Promise<void>;
  prune(): Promise<number>;
  /** How many rows are stored — entries and transaction records together. */
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

  // Transaction records go with the cache, because they are rows in it. A host that wants the check
  // card on its transaction-detail screen has to wire a real cache — there is nowhere else to put
  // them. The blank-id check still runs, so that bug is found with the cache off, not in production.

  // `async`, unlike the methods above, so that a blank id arrives as a REJECTED PROMISE rather than
  // a synchronous throw out of a call whose type says `Promise`. Every implementation of this
  // interface must agree on that, or a caller's `.catch()` misses the one error these can raise.

  async writeTransactionCheck(_result: CheckResult, transactionId: string): Promise<void> {
    transactionRowKey(transactionId);
  }

  async readTransactionCheck(transactionId: string): Promise<CheckResult | undefined> {
    transactionRowKey(transactionId);
    return undefined;
  }

  async removeTransactionCheck(transactionId: string): Promise<void> {
    transactionRowKey(transactionId);
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
  /** A write counter, not a timestamp: it only orders entries against each other. */
  readonly storedSequence: number;
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
      storedSequence: this.#sequence++,
    });
    void this.#evictOverflow();
    return Promise.resolve();
  }

  remove(key: CheckCacheKey): Promise<void> {
    this.#entries.delete(key.hex);
    return Promise.resolve();
  }

  // Records share `#entries`, keyed under the `txn:` prefix, so `clear`, `count` and eviction need
  // no second code path and cannot drift from the persistent store's single-table behaviour.

  // `async`, unlike the methods above: a blank id must reject rather than throw synchronously out of
  // a call whose type says `Promise`. See `NoOpCheckCache` for why every implementation agrees.

  async writeTransactionCheck(result: CheckResult, transactionId: string): Promise<void> {
    const rowKey = transactionRowKey(transactionId);
    if (!this.policy.enabled) return;
    const retentionSeconds = this.policy.transactionCheckRetentionSeconds;
    if (retentionSeconds <= 0) {
      // Retention off takes the records already written with it, the same way a zero TTL does.
      this.#entries.delete(rowKey);
      return;
    }
    this.#entries.set(rowKey, {
      result: toTransactionRecordCopy(result),
      // Measured from now, not from `fetchedAt`. A cache entry expires when its verdict goes stale,
      // so it is dated from when the data was produced; a record expires when the host stops wanting
      // the history, so it is dated from when the history was made.
      expiresAtMs: this.#clock.nowMs() + retentionSeconds * 1000,
      storedSequence: this.#sequence++,
    });
    this.#evictOverflow();
  }

  async readTransactionCheck(transactionId: string): Promise<CheckResult | undefined> {
    const rowKey = transactionRowKey(transactionId);
    if (!this.policy.enabled) return undefined;
    const entry = this.#entries.get(rowKey);
    if (entry === undefined) return undefined;
    if (this.#clock.nowMs() >= entry.expiresAtMs) {
      this.#entries.delete(rowKey);
      return undefined;
    }
    return entry.result;
  }

  async removeTransactionCheck(transactionId: string): Promise<void> {
    this.#entries.delete(transactionRowKey(transactionId));
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

  /**
   * Evicts down to `policy.maxEntries`, dropping the entries closest to expiry first and using
   * the write order only to break a tie. The same order the SQL store uses, so a partner cannot
   * see one rule in memory and a different one on disk.
   *
   * Write order used to be the whole rule, and it is the opposite choice whenever a long-lived
   * verdict was stored before a short-lived one: a thirty-day HIGH result written this morning
   * was evicted to make room for a one-hour NONE result written this afternoon, which then
   * expired by itself an hour later. See `CachePolicy.maxEntries`.
   */
  #evictOverflow(): number {
    const max = this.policy.maxEntries;
    if (max === undefined || this.#entries.size <= max) return 0;
    const ordered = [...this.#entries.entries()].sort(
      (a, b) => a[1].expiresAtMs - b[1].expiresAtMs || a[1].storedSequence - b[1].storedSequence,
    );
    const excess = this.#entries.size - max;
    for (let i = 0; i < excess; i++) {
      const victim = ordered[i];
      if (victim !== undefined) this.#entries.delete(victim[0]);
    }
    return excess;
  }
}

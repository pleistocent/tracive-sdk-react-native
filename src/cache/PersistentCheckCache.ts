import { systemClock, type TraciveClock } from '../client/TraciveClock';
import { defaultRandom, type TraciveRandom } from '../crypto/random';
import { utf8Decode, utf8Encode } from '../crypto/utf8';
import { CachePolicy } from '../model/CachePolicy';
import { toCacheableCopy, type CheckResult } from '../model/CheckResult';
import { AesGcmCacheCipher, type CacheCipher } from './CacheCipher';
import { InMemoryCacheKeyStore, type CacheKeyStore } from './CacheKeyStore';
import type { CheckCache } from './CheckCache';
import { CheckCacheError } from './CheckCacheError';
import type { CheckCacheKey } from './CheckCacheKey';
import type { CheckCacheStore } from './CheckCacheStore';
import { decodeCacheableResult, encodeCacheableResult, expiresAtMsFor } from './payload';

/**
 * The additional authenticated data binds a record to both the schema version and its own cache
 * key. Moving a row to a different key, or replaying a row written under an older schema, then
 * fails to open rather than yielding a plausible verdict about the wrong identifier.
 */
function aadFor(schemaVersion: number, keyHex: string): Uint8Array {
  return utf8Encode(`tracive.cache.v${schemaVersion}|${keyHex}`);
}

export interface PersistentCheckCacheOptions {
  store: CheckCacheStore;
  keyStore: CacheKeyStore;
  policy?: CachePolicy;
  cipher?: CacheCipher;
  clock?: TraciveClock;
  /**
   * The CSPRNG the built-in cipher draws its GCM nonces from. Only consulted when no `cipher` is
   * supplied. This exists because `random` is the documented escape hatch for a runtime with no
   * global `crypto`, and it used to reach the key store and stop there — the cipher was always
   * constructed without it, so an app relying on the escape hatch still hit `csprng_unavailable`
   * on its first cache write.
   */
  random?: TraciveRandom;
  /** Part of the AAD, so bumping it invalidates every existing record by construction. */
  schemaVersion?: number;
}

/**
 * Policy, TTL and eviction over any {@link CheckCacheStore}.
 *
 * The store sees only ciphertext and timestamps; this class owns everything that requires
 * knowing what a result means.
 */
export class PersistentCheckCache implements CheckCache {
  readonly policy: CachePolicy;
  readonly #store: CheckCacheStore;
  readonly #keyStore: CacheKeyStore;
  readonly #clock: TraciveClock;
  readonly #schemaVersion: number;
  readonly #random: TraciveRandom;
  #cipher: CacheCipher | undefined;
  #lastStoreError: CheckCacheError | undefined;

  constructor(options: PersistentCheckCacheOptions) {
    this.policy = options.policy ?? CachePolicy.default;
    this.#store = options.store;
    this.#keyStore = options.keyStore;
    this.#clock = options.clock ?? systemClock;
    this.#schemaVersion = options.schemaVersion ?? 1;
    this.#random = options.random ?? defaultRandom;
    this.#cipher = options.cipher;
  }

  /** Resolves the data key eagerly so a broken key store fails at open time, not mid-check. */
  static async open(options: PersistentCheckCacheOptions): Promise<PersistentCheckCache> {
    const cache = new PersistentCheckCache(options);
    await cache.#resolveCipher();
    return cache;
  }

  get lastStoreError(): CheckCacheError | undefined {
    return this.#lastStoreError;
  }

  async read(key: CheckCacheKey): Promise<CheckResult | undefined> {
    if (!this.policy.enabled) return undefined;

    const row = await this.#guard('storageFailure', () => this.#store.get(key.hex));
    if (row === undefined) return undefined;

    if (this.#clock.nowMs() >= row.expiresAtMs) {
      await this.#guard('storageFailure', () => this.#store.delete(key.hex));
      return undefined;
    }

    const cipher = await this.#resolveCipher();
    let result: CheckResult;
    try {
      const plaintext = cipher.open(row.payload, aadFor(this.#schemaVersion, key.hex));
      result = decodeCacheableResult(utf8Decode(plaintext));
    } catch (error) {
      // The data key changed — app reinstall, keystore reset, restore onto another device — or
      // the record was tampered with. Either way: drop the row and report a miss. A rotated key
      // degrades into "the cache is cold", never into "every check now throws".
      this.#lastStoreError =
        error instanceof CheckCacheError
          ? error
          : new CheckCacheError('payloadUnreadable', 'The cache record could not be read.', error);
      await this.#guard('storageFailure', () => this.#store.delete(key.hex));
      return undefined;
    }

    return CachePolicy.isFresh(this.policy, result, this.#clock.nowMs()) ? result : undefined;
  }

  async write(result: CheckResult, key: CheckCacheKey): Promise<void> {
    if (!this.policy.enabled) return;
    if (CachePolicy.effectiveTtlSeconds(this.policy, result) <= 0) return;

    const cacheable = toCacheableCopy(result);
    const cipher = await this.#resolveCipher();
    const payload = cipher.seal(
      utf8Encode(encodeCacheableResult(cacheable)),
      aadFor(this.#schemaVersion, key.hex),
    );

    await this.#guard('storageFailure', () =>
      this.#store.put({
        keyHex: key.hex,
        payload,
        fetchedAtMs: cacheable.fetchedAt.getTime(),
        expiresAtMs: expiresAtMsFor(this.policy, cacheable),
      }),
    );
    await this.#enforceMaxEntries();
  }

  async remove(key: CheckCacheKey): Promise<void> {
    await this.#guard('storageFailure', () => this.#store.delete(key.hex));
  }

  async clear(): Promise<void> {
    await this.#guard('storageFailure', () => this.#store.deleteWhere({ all: true }));
  }

  async prune(): Promise<number> {
    const expired = await this.#guard('storageFailure', () =>
      this.#store.deleteWhere({ expiredBeforeMs: this.#clock.nowMs() }),
    );
    return expired + (await this.#enforceMaxEntries());
  }

  async count(): Promise<number> {
    const counter = this.#store.count;
    if (counter === undefined) {
      throw new CheckCacheError(
        'storageFailure',
        'This CheckCacheStore does not implement the optional count() method.',
      );
    }
    return this.#guard('storageFailure', () => counter.call(this.#store));
  }

  async #enforceMaxEntries(): Promise<number> {
    const max = this.policy.maxEntries;
    if (max === undefined) return 0;
    return this.#guard('storageFailure', () => this.#store.deleteWhere({ keepNewest: max }));
  }

  async #resolveCipher(): Promise<CacheCipher> {
    if (this.#cipher !== undefined) return this.#cipher;
    try {
      const dataKey = await this.#keyStore.loadOrCreateDataKey();
      this.#cipher = new AesGcmCacheCipher({ dataKey, random: this.#random });
      return this.#cipher;
    } catch (cause) {
      const error =
        cause instanceof CheckCacheError
          ? cause
          : new CheckCacheError(
              'dataKeyUnavailable',
              'The cache data key could not be loaded or created.',
              cause,
            );
      this.#lastStoreError = error;
      throw error;
    }
  }

  async #guard<T>(
    kind: 'storageFailure' | 'cannotOpenStore',
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (cause) {
      const error =
        cause instanceof CheckCacheError
          ? cause
          : new CheckCacheError(kind, 'The cache store failed.', cause);
      this.#lastStoreError = error;
      throw error;
    }
  }
}

/** A convenience for adapters: an in-memory key store keeps the default wiring dependency-free. */
export function defaultCacheKeyStore(): CacheKeyStore {
  return new InMemoryCacheKeyStore();
}

import { describe, expect, it } from '@jest/globals';

import { FakeCheckCacheStore, FakeClock, fixedRandom } from '../../__tests__/support/fakes';
import { CachePolicy } from '../../model/CachePolicy';
import type { CheckResult } from '../../model/CheckResult';
import { AesGcmCacheCipher } from '../CacheCipher';
import {
  createDataKey,
  DATA_KEY_LENGTH,
  decodeDataKey,
  encodeDataKey,
  InMemoryCacheKeyStore,
} from '../CacheKeyStore';
import { CheckCacheError, isCheckCacheError } from '../CheckCacheError';
import { CheckCacheKey } from '../CheckCacheKey';
import { PersistentCheckCache } from '../PersistentCheckCache';
import { decodeCacheableResult, encodeCacheableResult, expiresAtMsFor } from '../payload';
import { CREATE_TABLE_SQL, DELETE_WHERE_SQL, toUint8Array } from '../sql';

const KEY = CheckCacheKey.fromSearchQueryIndex('EMAIL_budi@gmail.com');

function result(overrides?: Partial<CheckResult>): CheckResult {
  return {
    found: true,
    riskTier: 'HIGH',
    reportTotal: 1,
    credibleReports: 1,
    ambiguousReports: 0,
    fraudAmount: {},
    tags: [],
    relatedScammerCount: 0,
    origin: 'SERVER',
    fetchedAt: new Date(1_700_000_000_000),
    ...overrides,
  } as CheckResult;
}

describe('the data key', () => {
  it('is 32 bytes and round-trips through the string-only secure stores', () => {
    const key = createDataKey(fixedRandom());
    expect(key).toHaveLength(DATA_KEY_LENGTH);
    expect(Array.from(decodeDataKey(encodeDataKey(key)))).toEqual(Array.from(key));
  });

  it('rejects a stored key that is not 32 bytes', () => {
    // The cache goes cold rather than the SDK breaking.
    let thrown: unknown;
    try {
      decodeDataKey('AAAA');
    } catch (error) {
      thrown = error;
    }
    expect(isCheckCacheError(thrown)).toBe(true);
    expect((thrown as CheckCacheError).kind).toBe('dataKeyCorrupt');
  });

  it('is stable for the lifetime of an in-memory store, and regenerated after a clear', async () => {
    const store = new InMemoryCacheKeyStore({ random: fixedRandom() });
    const first = await store.loadOrCreateDataKey();
    expect(await store.loadOrCreateDataKey()).toBe(first);
    await store.clear();
    expect(await store.loadOrCreateDataKey()).not.toBe(first);
  });
});

describe('the persisted payload', () => {
  it('round-trips every field that survives caching', () => {
    const original = result({
      firstReportOn: new Date(1_600_000_000_000),
      lastReportOn: new Date(1_650_000_000_000),
      fraudAmount: { IDR: 5000 },
      tags: ['a', 'b'],
      cacheTtlSeconds: 120,
      disclaimer: 'text',
    });
    const restored = decodeCacheableResult(encodeCacheableResult(original));
    expect(restored.firstReportOn?.getTime()).toBe(1_600_000_000_000);
    expect(restored.lastReportOn?.getTime()).toBe(1_650_000_000_000);
    expect(restored.fraudAmount).toEqual({ IDR: 5000 });
    expect(restored.tags).toEqual(['a', 'b']);
    expect(restored.cacheTtlSeconds).toBe(120);
    expect(restored.disclaimer).toBe('text');
    // A replay is always labelled as one.
    expect(restored.origin).toBe('CACHE');
  });

  it('reports payloadUnreadable on invalid JSON', () => {
    expect(() => decodeCacheableResult('{not json')).toThrow(CheckCacheError);
  });

  it('reports payloadUnreadable when a required field is missing or unrecognised', () => {
    expect(() => decodeCacheableResult('{"riskTier":"HIGH"}')).toThrow(CheckCacheError);
    expect(() => decodeCacheableResult('{"found":true,"riskTier":"SEVERE"}')).toThrow(
      CheckCacheError,
    );
  });

  it('tolerates absent optional fields', () => {
    const restored = decodeCacheableResult('{"found":false,"riskTier":"NONE"}');
    expect(restored.reportTotal).toBe(0);
    expect(restored.tags).toEqual([]);
    expect(restored.fraudAmount).toEqual({});
  });

  it('returns an expiry in the past for a result that was born stale', () => {
    const stale = result({ cacheTtlSeconds: 0 });
    expect(expiresAtMsFor(CachePolicy.default, stale)).toBe(stale.fetchedAt.getTime());
  });
});

describe('the shared SQL', () => {
  it('creates a table holding only opaque values', () => {
    expect(CREATE_TABLE_SQL).toContain('tracive_check_cache');
    expect(CREATE_TABLE_SQL).toContain('payload BLOB NOT NULL');
    // No identifier, no risk tier, no report count.
    expect(CREATE_TABLE_SQL).not.toMatch(/risk|tier|phone|email/i);
  });

  it('builds one statement per delete criterion, and none for an empty one', () => {
    expect(DELETE_WHERE_SQL({ all: true })?.sql).toBe('DELETE FROM tracive_check_cache');
    expect(DELETE_WHERE_SQL({ expiredBeforeMs: 5 })).toEqual({
      sql: 'DELETE FROM tracive_check_cache WHERE expires_at_ms <= ?',
      params: [5],
    });
    expect(DELETE_WHERE_SQL({ keepLongestLived: 3 })?.params).toEqual([3]);
    // Most life left first, so the rows outside the cap — the ones deleted — are the closest to
    // expiry. Ordering by fetch time evicts by age instead, which is a different row.
    expect(DELETE_WHERE_SQL({ keepLongestLived: 3 })?.sql).toContain(
      'ORDER BY expires_at_ms DESC, fetched_at_ms DESC',
    );
    expect(DELETE_WHERE_SQL({})).toBeUndefined();
  });

  it('normalises every blob shape a driver can hand back', () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(Array.from(toUint8Array(bytes))).toEqual([1, 2, 3]);
    expect(Array.from(toUint8Array(bytes.buffer))).toEqual([1, 2, 3]);
    expect(Array.from(toUint8Array([1, 2, 3]))).toEqual([1, 2, 3]);
    expect(Array.from(toUint8Array(new Int8Array([1, 2, 3])))).toEqual([1, 2, 3]);
    expect(toUint8Array(null)).toHaveLength(0);
  });
});

describe('PersistentCheckCache edge cases', () => {
  function build(store = new FakeCheckCacheStore(), policy?: CachePolicy): PersistentCheckCache {
    return new PersistentCheckCache({
      store,
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock: new FakeClock(),
      cipher: new AesGcmCacheCipher({ dataKey: new Uint8Array(32).fill(5), random: fixedRandom() }),
      ...(policy !== undefined ? { policy } : {}),
    });
  }

  it('does nothing at all when the policy is disabled', async () => {
    const store = new FakeCheckCacheStore();
    const cache = build(store, CachePolicy.disabled);
    await cache.write(result(), KEY);
    expect(store.rows.size).toBe(0);
    expect(await cache.read(KEY)).toBeUndefined();
  });

  it('removes a single key', async () => {
    const store = new FakeCheckCacheStore();
    const cache = build(store);
    await cache.write(result(), KEY);
    await cache.remove(KEY);
    expect(store.rows.size).toBe(0);
  });

  it('prunes expired rows', async () => {
    const store = new FakeCheckCacheStore();
    const cache = build(store);
    await cache.write(result({ riskTier: 'NONE' }), KEY);
    const row = store.rows.get(KEY.hex);
    if (row === undefined) throw new Error('expected a row');
    store.rows.set(KEY.hex, { ...row, expiresAtMs: 0 });
    expect(await cache.prune()).toBe(1);
  });

  it('reports a storage failure when the store cannot count', async () => {
    // `count()` is the one method a store written against a host database may not implement.
    const cache = new PersistentCheckCache({
      store: {
        get: () => Promise.resolve(undefined),
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(),
        deleteWhere: () => Promise.resolve(0),
      },
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock: new FakeClock(),
    });
    await expect(cache.count()).rejects.toBeInstanceOf(CheckCacheError);
  });

  it('reports dataKeyUnavailable when the key store throws', async () => {
    const cache = new PersistentCheckCache({
      store: new FakeCheckCacheStore(),
      keyStore: {
        loadOrCreateDataKey: () => Promise.reject(new Error('keystore reset')),
        clear: () => Promise.resolve(),
      },
      clock: new FakeClock(),
    });
    await expect(cache.write(result(), KEY)).rejects.toMatchObject({
      kind: 'dataKeyUnavailable',
    });
    expect(cache.lastStoreError?.kind).toBe('dataKeyUnavailable');
  });
});

/**
 * `random` is the documented escape hatch for a runtime with no global `crypto`. It reached the
 * key store and stopped there: the cipher was always constructed without it, so an app that
 * supplied one still hit `csprng_unavailable` on the first cache write.
 */
describe('the injected CSPRNG port', () => {
  it('reaches the cipher the cache builds for itself', async () => {
    let calls = 0;
    const counting = {
      randomBytes(length: number): Uint8Array {
        calls += 1;
        return fixedRandom(11).randomBytes(length);
      },
    };
    const cache = await PersistentCheckCache.open({
      store: new FakeCheckCacheStore(),
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock: new FakeClock(),
      random: counting,
    });

    const before = calls;
    await cache.write(result(), KEY);
    // The GCM nonce for that write came from the injected source, not from defaultRandom.
    expect(calls).toBeGreaterThan(before);
  });

  it('is not required, and defaults without one', async () => {
    const cache = await PersistentCheckCache.open({
      store: new FakeCheckCacheStore(),
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock: new FakeClock(),
    });
    await cache.write(result(), KEY);
    expect(await cache.read(KEY)).toBeDefined();
  });
});

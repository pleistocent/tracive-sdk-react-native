import { describe, expect, it } from '@jest/globals';

import { FakeCheckCacheStore, FakeClock, fixedRandom } from '../../__tests__/support/fakes';
import { CachePolicy } from '../../model/CachePolicy';
import { toCacheableCopy, type CheckResult } from '../../model/CheckResult';
import type { RiskTier } from '../../model/enums';
import { AesGcmCacheCipher } from '../CacheCipher';
import { InMemoryCacheKeyStore } from '../CacheKeyStore';
import { InMemoryCheckCache, NoOpCheckCache } from '../CheckCache';
import { CheckCacheError, isCheckCacheError } from '../CheckCacheError';
import { CheckCacheKey } from '../CheckCacheKey';
import { PersistentCheckCache } from '../PersistentCheckCache';

const KEY = CheckCacheKey.fromSearchQueryIndex('PHONE_+6281234567891');
const OTHER_KEY = CheckCacheKey.fromSearchQueryIndex('PHONE_+6281234567892');

function result(overrides?: Partial<CheckResult>): CheckResult {
  return {
    checkId: 'chk_1',
    found: true,
    riskTier: 'HIGH',
    reportTotal: 3,
    credibleReports: 2,
    ambiguousReports: 1,
    fraudAmount: { IDR: 1000 },
    tags: ['x'],
    relatedScammerCount: 1,
    topChronologies: [{ chronology: 'text', riskLevel: 3 }],
    comments: [{ date: '2026-01-01', text: 'note', fromCredibleReport: true }],
    billing: { creditSource: 'USER', unitsCharged: 1 },
    disclaimer: 'legal text',
    origin: 'SERVER',
    fetchedAt: new Date(1_700_000_000_000),
    ...overrides,
  } as CheckResult;
}

describe('toCacheableCopy', () => {
  it('drops the four fields that must never be persisted, and relabels the origin', () => {
    const copy = toCacheableCopy(result());
    expect(copy.topChronologies).toBeUndefined();
    expect(copy.comments).toBeUndefined();
    expect(copy.billing).toBeUndefined();
    expect(copy.checkId).toBeUndefined();
    expect(copy.origin).toBe('CACHE');
    // Everything a caller decides on survives.
    expect(copy.riskTier).toBe('HIGH');
    expect(copy.found).toBe(true);
    expect(copy.disclaimer).toBe('legal text');
    expect(copy.fetchedAt.getTime()).toBe(1_700_000_000_000);
  });
});

describe('CachePolicy TTLs', () => {
  it.each<[RiskTier, number]>([
    ['HIGH', 2_592_000],
    ['ELEVATED', 604_800],
    ['CAUTION', 86_400],
    ['NONE', 3_600],
  ])('uses the documented default for %s', (tier, seconds) => {
    expect(CachePolicy.ttlSecondsFor(CachePolicy.default, tier)).toBe(seconds);
  });

  it('lets a server TTL override replace the per-tier default', () => {
    const withOverride = result({ riskTier: 'HIGH', cacheTtlSeconds: 60 });
    expect(CachePolicy.effectiveTtlSeconds(CachePolicy.default, withOverride)).toBe(60);
  });

  it('ignores the override when honorsServerTtlOverride is off', () => {
    const policy = CachePolicy.create({ honorsServerTtlOverride: false });
    expect(CachePolicy.effectiveTtlSeconds(policy, result({ cacheTtlSeconds: 60 }))).toBe(
      2_592_000,
    );
  });

  it('clamps a negative TTL to zero rather than making the entry eternally fresh', () => {
    const withNegative = result({ cacheTtlSeconds: -1 });
    expect(CachePolicy.effectiveTtlSeconds(CachePolicy.default, withNegative)).toBe(0);
    expect(CachePolicy.isFresh(CachePolicy.default, withNegative, 1_700_000_000_000)).toBe(false);
  });
});

describe('InMemoryCheckCache', () => {
  it('reads back what it wrote, as a cacheable copy', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    await cache.write(result(), KEY);
    const read = await cache.read(KEY);
    expect(read?.origin).toBe('CACHE');
    expect(read?.billing).toBeUndefined();
    expect(await cache.count()).toBe(1);
  });

  it('misses once the TTL has elapsed', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    await cache.write(result({ riskTier: 'NONE' }), KEY);
    clock.advance(3_600 * 1000 + 1);
    expect(await cache.read(KEY)).toBeUndefined();
  });

  it('does not store a result whose effective TTL is zero', async () => {
    const cache = new InMemoryCheckCache({ clock: new FakeClock() });
    await cache.write(result({ cacheTtlSeconds: 0 }), KEY);
    expect(await cache.count()).toBe(0);
  });

  it('honours maxEntries', async () => {
    const cache = new InMemoryCheckCache({
      policy: CachePolicy.create({ maxEntries: 1 }),
      clock: new FakeClock(),
    });
    await cache.write(result(), KEY);
    await cache.write(result(), OTHER_KEY);
    expect(await cache.count()).toBe(1);
    expect(await cache.read(KEY)).toBeUndefined();
    expect(await cache.read(OTHER_KEY)).toBeDefined();
  });

  it('prunes expired entries', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    await cache.write(result({ riskTier: 'NONE' }), KEY);
    clock.advance(3_600 * 1000 + 1);
    expect(await cache.prune()).toBe(1);
    expect(await cache.count()).toBe(0);
  });

  it('caches nothing when the policy is disabled', async () => {
    const cache = new InMemoryCheckCache({ policy: CachePolicy.disabled });
    await cache.write(result(), KEY);
    expect(await cache.read(KEY)).toBeUndefined();
  });
});

describe('NoOpCheckCache', () => {
  it('is a miss for everything and reports the fault it was opened with', async () => {
    const fault = new CheckCacheError('cannotOpenStore', 'nope');
    const cache = new NoOpCheckCache(CachePolicy.default, fault);
    expect(await cache.read(KEY)).toBeUndefined();
    await cache.write(result(), KEY);
    expect(await cache.count()).toBe(0);
    expect(cache.lastStoreError).toBe(fault);
  });
});

describe('PersistentCheckCache', () => {
  function build(
    store = new FakeCheckCacheStore(),
    clock = new FakeClock(),
  ): {
    cache: PersistentCheckCache;
    store: FakeCheckCacheStore;
    clock: FakeClock;
  } {
    const cache = new PersistentCheckCache({
      store,
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock,
      cipher: new AesGcmCacheCipher({ dataKey: new Uint8Array(32).fill(3), random: fixedRandom() }),
    });
    return { cache, store, clock };
  }

  it('round-trips a result through the encrypted store', async () => {
    const { cache, store } = build();
    await cache.write(result(), KEY);
    expect(store.rows.size).toBe(1);
    // The store only ever holds an opaque blob.
    const row = store.rows.get(KEY.hex);
    expect(row?.payload).toBeInstanceOf(Uint8Array);
    expect(JSON.stringify(Array.from(row?.payload ?? []))).not.toContain('HIGH');

    const read = await cache.read(KEY);
    expect(read?.riskTier).toBe('HIGH');
    expect(read?.origin).toBe('CACHE');
    expect(read?.billing).toBeUndefined();
  });

  it('deletes the row and reports a miss when the payload cannot be opened', async () => {
    // The data key changed — app reinstall, keystore reset, restore onto another device — or the
    // record was tampered with. A rotated key must degrade into "the cache is cold".
    const { cache, store } = build();
    await cache.write(result(), KEY);
    const row = store.rows.get(KEY.hex);
    if (row === undefined) throw new Error('expected a row');
    const corrupted = Uint8Array.from(row.payload);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] as number) ^ 0xff;
    store.rows.set(KEY.hex, { ...row, payload: corrupted });

    expect(await cache.read(KEY)).toBeUndefined();
    expect(store.rows.has(KEY.hex)).toBe(false);
    expect(cache.lastStoreError?.kind).toBe('payloadUnreadable');
  });

  it('cannot open a row that was moved to a different key', async () => {
    const { cache, store } = build();
    await cache.write(result(), KEY);
    const row = store.rows.get(KEY.hex);
    if (row === undefined) throw new Error('expected a row');
    store.rows.set(OTHER_KEY.hex, { ...row, keyHex: OTHER_KEY.hex });
    expect(await cache.read(OTHER_KEY)).toBeUndefined();
  });

  it('surfaces a storage fault and records it in lastStoreError', async () => {
    const { cache, store } = build();
    store.failNext = new Error('disk is on fire');
    await expect(cache.read(KEY)).rejects.toBeInstanceOf(CheckCacheError);
    expect(cache.lastStoreError?.kind).toBe('storageFailure');
  });

  it('misses on an expired row and removes it', async () => {
    const { cache, store, clock } = build();
    await cache.write(result({ riskTier: 'NONE' }), KEY);
    clock.advance(3_600 * 1000 + 1);
    expect(await cache.read(KEY)).toBeUndefined();
    expect(store.rows.size).toBe(0);
  });

  it('prunes expired rows and enforces maxEntries', async () => {
    const store = new FakeCheckCacheStore();
    const clock = new FakeClock();
    const cache = new PersistentCheckCache({
      store,
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock,
      policy: CachePolicy.create({ maxEntries: 1 }),
      cipher: new AesGcmCacheCipher({ dataKey: new Uint8Array(32).fill(3), random: fixedRandom() }),
    });
    await cache.write(result({ fetchedAt: new Date(clock.nowMs()) }), KEY);
    await cache.write(result({ fetchedAt: new Date(clock.nowMs() + 1000) }), OTHER_KEY);
    expect(await cache.count()).toBe(1);
    expect(store.rows.has(OTHER_KEY.hex)).toBe(true);
  });

  it('clears everything', async () => {
    const { cache, store } = build();
    await cache.write(result(), KEY);
    await cache.clear();
    expect(store.rows.size).toBe(0);
  });

  it('opens eagerly so a broken key store fails before a check does', async () => {
    const cache = await PersistentCheckCache.open({
      store: new FakeCheckCacheStore(),
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock: new FakeClock(),
    });
    expect(cache.policy).toBe(CachePolicy.default);
  });
});

describe('CheckCacheKey', () => {
  it('is 64 lowercase hex characters', () => {
    expect(KEY.hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts only well-formed hex through fromHex', () => {
    expect(CheckCacheKey.fromHex(KEY.hex)?.hex).toBe(KEY.hex);
    expect(CheckCacheKey.fromHex(KEY.hex.toUpperCase())).toBeUndefined();
    expect(CheckCacheKey.fromHex('abc')).toBeUndefined();
  });

  it('is stable for the same lookup key and different for another', () => {
    expect(CheckCacheKey.fromSearchQueryIndex('PHONE_+6281234567891').hex).toBe(KEY.hex);
    expect(OTHER_KEY.hex).not.toBe(KEY.hex);
  });
});

describe('the error guards', () => {
  it('recognise their own family and nothing else', () => {
    expect(isCheckCacheError(new CheckCacheError('storageFailure'))).toBe(true);
    expect(isCheckCacheError(new Error('nope'))).toBe(false);
    expect(isCheckCacheError(undefined)).toBe(false);
  });

  it('defaults the message to the kind', () => {
    expect(new CheckCacheError('dataKeyCorrupt').message).toBe('dataKeyCorrupt');
    expect(new CheckCacheError('dataKeyCorrupt', 'specific').message).toBe('specific');
  });
});

describe('NoOpCheckCache defaults', () => {
  it('defaults to a disabled policy and no recorded fault', async () => {
    const cache = new NoOpCheckCache();
    expect(cache.policy.enabled).toBe(false);
    expect(cache.lastStoreError).toBeUndefined();
    await cache.remove(KEY);
    await cache.clear();
    expect(await cache.prune()).toBe(0);
  });
});

describe('InMemoryCheckCache housekeeping', () => {
  it('removes and clears', async () => {
    const cache = new InMemoryCheckCache({ clock: new FakeClock() });
    await cache.write(result(), KEY);
    await cache.remove(KEY);
    expect(await cache.count()).toBe(0);
    await cache.write(result(), KEY);
    await cache.clear();
    expect(await cache.count()).toBe(0);
  });

  it('reports no storage fault, because it has no storage', () => {
    expect(new InMemoryCheckCache().lastStoreError).toBeUndefined();
  });
});

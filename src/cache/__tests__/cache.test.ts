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

  it('ignores a cacheTtlSeconds still present on the result', () => {
    // The backend stopped sending this field (pleistocent-firebase@88fd6f9) and the SDK no longer
    // models it. A proxy that still sends it reaches the mapper as an unknown key, so the tier
    // default has to win. Cast, because the property is gone from the type.
    const withRetiredField = {
      ...result({ riskTier: 'HIGH' }),
      cacheTtlSeconds: 60,
    } as CheckResult;
    expect(CachePolicy.effectiveTtlSeconds(CachePolicy.default, withRetiredField)).toBe(2_592_000);
  });

  it('clamps a negative configured TTL to zero rather than making the entry eternally fresh', () => {
    const policy = CachePolicy.create({ highTtlSeconds: -1 });
    expect(CachePolicy.effectiveTtlSeconds(policy, result({ riskTier: 'HIGH' }))).toBe(0);
    expect(CachePolicy.isFresh(policy, result({ riskTier: 'HIGH' }), 1_700_000_000_000)).toBe(
      false,
    );
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

  it('does not store a result whose tier TTL is zero', async () => {
    const cache = new InMemoryCheckCache({
      policy: CachePolicy.create({ highTtlSeconds: 0 }),
      clock: new FakeClock(),
    });
    await cache.write(result({ riskTier: 'HIGH' }), KEY);
    expect(await cache.count()).toBe(0);
  });

  it('lets a zero tier TTL drop the entry already held for that key', async () => {
    // The device holds a HIGH verdict; the identifier is re-checked and comes back NONE, a tier
    // this host does not cache. Declining to store the new answer is not enough — the old HIGH
    // would keep being served for the rest of its thirty days.
    const cache = new InMemoryCheckCache({
      policy: CachePolicy.create({ noneTtlSeconds: 0 }),
      clock: new FakeClock(),
    });
    await cache.write(result({ riskTier: 'HIGH' }), KEY);
    expect(await cache.read(KEY)).toBeDefined();

    await cache.write(result({ riskTier: 'NONE' }), KEY);

    expect(await cache.read(KEY)).toBeUndefined();
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

  /**
   * The default policy used to omit `maxEntries` entirely, which meant nothing ever evicted: the
   * cache gained a row for every identifier ever checked and lost one only to expiry, and a HIGH
   * verdict is held for thirty days.
   */
  it('bounds the cache at 5000 entries under the default policy', async () => {
    const cache = new InMemoryCheckCache({ clock: new FakeClock() });
    for (let i = 0; i < 5_001; i++) {
      await cache.write(result(), CheckCacheKey.fromSearchQueryIndex(`PHONE_+62812${i}`));
    }
    expect(await cache.count()).toBe(5_000);
    expect(CachePolicy.default.maxEntries).toBe(5_000);
  });

  /**
   * Eviction order, and it is the opposite of write order whenever a long-lived verdict was
   * stored before a short-lived one. Dropping the HIGH result here would throw away thirty days
   * of paid-for answer to keep a NONE one that expires by itself in an hour.
   */
  it('evicts the entry closest to expiry, not the one written first', async () => {
    const cache = new InMemoryCheckCache({
      policy: CachePolicy.create({ maxEntries: 1 }),
      clock: new FakeClock(),
    });
    await cache.write(result({ riskTier: 'HIGH' }), KEY);
    await cache.write(result({ riskTier: 'NONE' }), OTHER_KEY);

    expect(await cache.read(KEY)).toBeDefined();
    expect(await cache.read(OTHER_KEY)).toBeUndefined();
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
  function build({
    store = new FakeCheckCacheStore(),
    clock = new FakeClock(),
    policy = CachePolicy.default,
  }: { store?: FakeCheckCacheStore; clock?: FakeClock; policy?: CachePolicy } = {}): {
    cache: PersistentCheckCache;
    store: FakeCheckCacheStore;
    clock: FakeClock;
  } {
    const cache = new PersistentCheckCache({
      store,
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock,
      policy,
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

  /**
   * The cap evicts by remaining life, not by age. Keeping the newer row instead, which is what
   * ordering by fetch time did, discards a thirty-day HIGH verdict in favour of a NONE one that
   * expires on its own within the hour — the more expensive of the two to have to buy again.
   */
  it('evicts the row closest to expiry rather than the one fetched earliest', async () => {
    const store = new FakeCheckCacheStore();
    const clock = new FakeClock();
    const cache = new PersistentCheckCache({
      store,
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock,
      policy: CachePolicy.create({ maxEntries: 1 }),
      cipher: new AesGcmCacheCipher({ dataKey: new Uint8Array(32).fill(3), random: fixedRandom() }),
    });
    await cache.write(result({ riskTier: 'HIGH', fetchedAt: new Date(clock.nowMs()) }), KEY);
    await cache.write(
      result({ riskTier: 'NONE', fetchedAt: new Date(clock.nowMs() + 1000) }),
      OTHER_KEY,
    );

    expect(store.rows.has(KEY.hex)).toBe(true);
    expect(store.rows.has(OTHER_KEY.hex)).toBe(false);
  });

  it('clears everything', async () => {
    const { cache, store } = build();
    await cache.write(result(), KEY);
    await cache.clear();
    expect(store.rows.size).toBe(0);
  });

  /**
   * Skipping the write would honour a zero TTL for the new result and ignore it for the stored
   * one, which leaves a superseded HIGH verdict readable for the rest of its thirty-day TTL.
   */
  it('deletes the stored row when the new result lands on a zero-TTL tier', async () => {
    const { cache, store } = build({ policy: CachePolicy.create({ noneTtlSeconds: 0 }) });
    await cache.write(result({ riskTier: 'HIGH' }), KEY);
    expect(store.rows.has(KEY.hex)).toBe(true);

    await cache.write(result({ riskTier: 'NONE' }), KEY);

    expect(store.rows.has(KEY.hex)).toBe(false);
    expect(await cache.read(KEY)).toBeUndefined();
  });

  it('treats a negative configured TTL the same way, because the policy clamps it to zero', async () => {
    const { cache, store } = build({ policy: CachePolicy.create({ highTtlSeconds: -1 }) });
    await cache.write(result({ riskTier: 'HIGH' }), KEY);
    expect(store.rows.has(KEY.hex)).toBe(false);
  });

  it('leaves other keys alone when one is dropped', async () => {
    const { cache, store } = build({ policy: CachePolicy.create({ noneTtlSeconds: 0 }) });
    await cache.write(result(), KEY);
    await cache.write(result(), OTHER_KEY);
    await cache.write(result({ riskTier: 'NONE' }), KEY);
    expect(store.rows.has(KEY.hex)).toBe(false);
    expect(store.rows.has(OTHER_KEY.hex)).toBe(true);
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

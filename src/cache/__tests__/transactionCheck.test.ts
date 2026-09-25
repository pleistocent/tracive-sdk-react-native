import { describe, expect, it } from '@jest/globals';

import { FakeCheckCacheStore, FakeClock, fixedRandom } from '../../__tests__/support/fakes';
import { sha256HexOfString } from '../../crypto/sha256';
import { CachePolicy } from '../../model/CachePolicy';
import { toTransactionRecordCopy, type CheckResult } from '../../model/CheckResult';
import { AesGcmCacheCipher } from '../CacheCipher';
import { InMemoryCacheKeyStore } from '../CacheKeyStore';
import { InMemoryCheckCache, NoOpCheckCache } from '../CheckCache';
import { isCheckCacheError } from '../CheckCacheError';
import { CheckCacheKey, transactionKeyHex, transactionRowKey } from '../CheckCacheKey';
import { PersistentCheckCache } from '../PersistentCheckCache';

/**
 * The record of what a user was shown before they sent money, filed under the host's transaction id.
 *
 * These rows answer a question the cache cannot. The cache holds the LATEST answer for an identifier
 * and expires it as soon as it stops being trustworthy; a transaction-detail screen has to show the
 * answer that was on screen WHEN THE USER DECIDED, months later, and it must not change when that
 * account is checked again. Everything here is one of those two properties.
 */

const ACCOUNT = CheckCacheKey.fromSearchQueryIndex('BANK_IDN_BCA_7710442951');
const FIRST_TRANSFER = 'TRF26090814320771';
const SECOND_TRANSFER = 'TRF26090910160442';
const DAY_MS = 24 * 60 * 60 * 1000;

function result(overrides?: Partial<CheckResult>): CheckResult {
  return {
    checkId: 'chk_1',
    found: true,
    riskTier: 'HIGH',
    reportTotal: 12,
    credibleReports: 9,
    ambiguousReports: 3,
    fraudAmount: { IDR: 87_400_000 },
    tags: ['investment'],
    relatedScammerCount: 4,
    topChronologies: [{ chronology: 'Promised 30% monthly returns.', riskLevel: 3 }],
    comments: [{ date: '2026-01', text: 'Took my deposit.', fromCredibleReport: true }],
    billing: { creditSource: 'USER', unitsCharged: 1 },
    disclaimer: 'legal text',
    origin: 'SERVER',
    fetchedAt: new Date(1_700_000_000_000),
    ...overrides,
  } as CheckResult;
}

function expectInvalidTransactionId(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(isCheckCacheError(error) && error.kind).toBe('invalidTransactionId');
    return;
  }
  throw new Error('expected a CheckCacheError with kind invalidTransactionId');
}

describe('the record key', () => {
  it('is the prefixed SHA-256 of the trimmed id', () => {
    expect(transactionRowKey(` ${FIRST_TRANSFER} `)).toBe(
      `txn:${sha256HexOfString(FIRST_TRANSFER)}`,
    );
    // ':' is not a hex digit, which is what keeps the two key spaces in one table disjoint.
    expect(CheckCacheKey.fromHex(transactionRowKey(FIRST_TRANSFER))).toBeUndefined();
    expect(transactionKeyHex(FIRST_TRANSFER)).toHaveLength(64);
  });

  it('never contains the reference it was derived from', () => {
    expect(transactionRowKey(FIRST_TRANSFER)).not.toContain(FIRST_TRANSFER);
  });

  it('rejects a blank id rather than sharing one row', () => {
    expectInvalidTransactionId(() => transactionRowKey('   '));
    expectInvalidTransactionId(() => transactionKeyHex(''));
  });
});

describe('toTransactionRecordCopy', () => {
  it("keeps the call's own fields and drops only the narratives", () => {
    // The projection differs from the cache's on purpose. `checkId` and `billing` describe the one
    // call this record IS, so they are what a dispute is reconciled against; the report narratives
    // are other people's prose and have no place in a record that lives 90 days.
    const copy = toTransactionRecordCopy(result());
    expect(copy.topChronologies).toBeUndefined();
    expect(copy.comments).toBeUndefined();
    expect(copy.checkId).toBe('chk_1');
    expect(copy.billing?.unitsCharged).toBe(1);
    expect(copy.origin).toBe('SERVER');
    expect(copy.disclaimer).toBe('legal text');
  });
});

describe.each([
  [
    'InMemoryCheckCache',
    (policy: CachePolicy, clock: FakeClock) => new InMemoryCheckCache({ policy, clock }),
  ],
  [
    'PersistentCheckCache',
    (policy: CachePolicy, clock: FakeClock) =>
      new PersistentCheckCache({
        store: new FakeCheckCacheStore(),
        keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
        policy,
        clock,
        cipher: new AesGcmCacheCipher({
          dataKey: new Uint8Array(32).fill(3),
          random: fixedRandom(),
        }),
      }),
  ],
])('%s transaction records', (_name, build) => {
  it('outlives the cache entry it was taken from', async () => {
    // The failure this exists to prevent: a NONE answer is cached for an hour, so by the next
    // morning the transaction detail would have no card at all — for a transfer that was checked.
    const clock = new FakeClock();
    const cache = build(CachePolicy.default, clock);
    const shown = result({ riskTier: 'NONE', fetchedAt: new Date(clock.nowMs()) });

    await cache.write(shown, ACCOUNT);
    await cache.writeTransactionCheck(shown, FIRST_TRANSFER);

    clock.advance(2 * 60 * 60 * 1000);

    expect(await cache.read(ACCOUNT)).toBeUndefined();
    const record = await cache.readTransactionCheck(FIRST_TRANSFER);
    expect(record?.riskTier).toBe('NONE');
  });

  it('is not dropped by a tier TTL of zero', async () => {
    // A host that declines to cache HIGH at all must still be able to show what the user was
    // warned about — precisely what a partner needs when the transfer is disputed.
    const clock = new FakeClock();
    const cache = build(CachePolicy.create({ highTtlSeconds: 0 }), clock);
    const shown = result({ riskTier: 'HIGH', fetchedAt: new Date(clock.nowMs()) });

    await cache.write(shown, ACCOUNT);
    await cache.writeTransactionCheck(shown, FIRST_TRANSFER);

    expect(await cache.read(ACCOUNT)).toBeUndefined();
    expect((await cache.readTransactionCheck(FIRST_TRANSFER))?.riskTier).toBe('HIGH');
  });

  it('expires when the retention runs out, and the row goes with it', async () => {
    const clock = new FakeClock();
    const cache = build(CachePolicy.default, clock);

    await cache.writeTransactionCheck(
      result({ fetchedAt: new Date(clock.nowMs()) }),
      FIRST_TRANSFER,
    );
    clock.advance(90 * DAY_MS - 1000);
    expect(await cache.readTransactionCheck(FIRST_TRANSFER)).toBeDefined();

    clock.advance(2000);
    expect(await cache.readTransactionCheck(FIRST_TRANSFER)).toBeUndefined();
    expect(await cache.count()).toBe(0);
  });

  it('keeps nothing when the retention is zero, and drops what is there', async () => {
    const clock = new FakeClock();
    const cache = build(CachePolicy.create({ transactionCheckRetentionSeconds: 0 }), clock);

    await cache.writeTransactionCheck(
      result({ fetchedAt: new Date(clock.nowMs()) }),
      FIRST_TRANSFER,
    );
    expect(await cache.readTransactionCheck(FIRST_TRANSFER)).toBeUndefined();
    expect(await cache.count()).toBe(0);
  });

  it('serves several transactions from one billed check', async () => {
    const clock = new FakeClock();
    const cache = build(CachePolicy.default, clock);

    await cache.write(result({ fetchedAt: new Date(clock.nowMs()) }), ACCOUNT);
    const shownFirst = await cache.read(ACCOUNT);
    expect(shownFirst).toBeDefined();
    await cache.writeTransactionCheck(shownFirst as CheckResult, FIRST_TRANSFER);

    clock.advance(7 * DAY_MS);

    const shownAgain = await cache.read(ACCOUNT);
    expect(shownAgain).toBeDefined();
    await cache.writeTransactionCheck(shownAgain as CheckResult, SECOND_TRANSFER);

    const first = await cache.readTransactionCheck(FIRST_TRANSFER);
    const second = await cache.readTransactionCheck(SECOND_TRANSFER);
    expect(first?.riskTier).toBe('HIGH');
    expect(second?.riskTier).toBe('HIGH');
    expect(first?.fetchedAt.getTime()).toBe(second?.fetchedAt.getTime());
    // The second transfer spent no credit, and its record has to say so.
    expect(second?.origin).toBe('CACHE');
  });

  it('leaves an earlier transaction alone when the account is checked again', async () => {
    // The reason a record is a snapshot rather than a pointer into the cache. The account is clean
    // in September and reported by October; a pointer would rewrite September's card to say the user
    // was warned — an audit trail that blames them for a warning they were never shown.
    const clock = new FakeClock();
    const cache = build(CachePolicy.default, clock);

    const clean = result({ riskTier: 'NONE', fetchedAt: new Date(clock.nowMs()) });
    await cache.write(clean, ACCOUNT);
    await cache.writeTransactionCheck(clean, FIRST_TRANSFER);
    const firstFetchedAt = clock.nowMs();

    clock.advance(30 * DAY_MS);

    const reported = result({ riskTier: 'HIGH', fetchedAt: new Date(clock.nowMs()) });
    await cache.write(reported, ACCOUNT);
    await cache.writeTransactionCheck(reported, SECOND_TRANSFER);

    const first = await cache.readTransactionCheck(FIRST_TRANSFER);
    expect(first?.riskTier).toBe('NONE');
    expect(first?.fetchedAt.getTime()).toBe(firstFetchedAt);
    expect((await cache.readTransactionCheck(SECOND_TRANSFER))?.riskTier).toBe('HIGH');
  });

  it('reports a live check as a live check', async () => {
    // The only assertion standing between the documented behaviour and a one-line "fix" that
    // mirrors `read`'s origin rewrite. Without it a billed check could be read back claiming the
    // transfer spent nothing, and nothing would fail.
    const clock = new FakeClock();
    const cache = build(CachePolicy.default, clock);

    await cache.writeTransactionCheck(
      result({ origin: 'SERVER', fetchedAt: new Date(clock.nowMs()) }),
      FIRST_TRANSFER,
    );

    const record = await cache.readTransactionCheck(FIRST_TRANSFER);
    expect(record?.origin).toBe('SERVER');
    expect(record?.checkId).toBe('chk_1');
    expect(record?.billing?.unitsCharged).toBe(1);
    expect(record?.topChronologies).toBeUndefined();
  });

  it('drops one record without touching the entry or the other records', async () => {
    const clock = new FakeClock();
    const cache = build(CachePolicy.default, clock);
    const shown = result({ fetchedAt: new Date(clock.nowMs()) });

    await cache.write(shown, ACCOUNT);
    await cache.writeTransactionCheck(shown, FIRST_TRANSFER);
    await cache.writeTransactionCheck(shown, SECOND_TRANSFER);

    // Forcing a fresh check must not wipe the history that references the same account.
    await cache.remove(ACCOUNT);
    expect(await cache.read(ACCOUNT)).toBeUndefined();
    expect(await cache.readTransactionCheck(FIRST_TRANSFER)).toBeDefined();

    await cache.removeTransactionCheck(FIRST_TRANSFER);
    expect(await cache.readTransactionCheck(FIRST_TRANSFER)).toBeUndefined();
    expect(await cache.readTransactionCheck(SECOND_TRANSFER)).toBeDefined();
  });

  it('goes with clear(), which is what sign-out calls', async () => {
    const clock = new FakeClock();
    const cache = build(CachePolicy.default, clock);

    await cache.write(result({ fetchedAt: new Date(clock.nowMs()) }), ACCOUNT);
    await cache.writeTransactionCheck(
      result({ fetchedAt: new Date(clock.nowMs()) }),
      FIRST_TRANSFER,
    );
    await cache.clear();

    expect(await cache.readTransactionCheck(FIRST_TRANSFER)).toBeUndefined();
    expect(await cache.count()).toBe(0);
  });

  it('is evicted last when the entry cap is reached', async () => {
    // Eviction takes the rows closest to expiring, and a record outlives every tier by default. The
    // ordering is the right way round: an evicted answer costs one credit to fetch again, an evicted
    // record cannot be recovered at all.
    const clock = new FakeClock();
    const cache = build(CachePolicy.create({ maxEntries: 2 }), clock);
    const now = new Date(clock.nowMs());

    await cache.write(result({ riskTier: 'NONE', fetchedAt: now }), ACCOUNT);
    await cache.write(
      result({ riskTier: 'NONE', fetchedAt: now }),
      CheckCacheKey.fromSearchQueryIndex('PHONE_+6287777777777'),
    );
    await cache.writeTransactionCheck(result({ riskTier: 'NONE', fetchedAt: now }), FIRST_TRANSFER);

    expect(await cache.count()).toBe(2);
    expect(await cache.readTransactionCheck(FIRST_TRANSFER)).toBeDefined();
  });

  it('folds away surrounding whitespace and nothing else', async () => {
    const clock = new FakeClock();
    const cache = build(CachePolicy.default, clock);

    await cache.writeTransactionCheck(
      result({ fetchedAt: new Date(clock.nowMs()) }),
      ` ${FIRST_TRANSFER} `,
    );

    expect(await cache.readTransactionCheck(FIRST_TRANSFER)).toBeDefined();
    // Case is not folded: a host's reference format is not one this SDK can guess at.
    expect(await cache.readTransactionCheck(FIRST_TRANSFER.toLowerCase())).toBeUndefined();
  });

  it('rejects a blank id at every entry point', async () => {
    const cache = build(CachePolicy.default, new FakeClock());
    const shown = result();

    await expect(cache.writeTransactionCheck(shown, '  ')).rejects.toThrow('non-blank');
    await expect(cache.readTransactionCheck('')).rejects.toThrow('non-blank');
    await expect(cache.removeTransactionCheck('\t')).rejects.toThrow('non-blank');
  });
});

describe('PersistentCheckCache transaction records, on the wire', () => {
  function build(): { cache: PersistentCheckCache; store: FakeCheckCacheStore; clock: FakeClock } {
    const store = new FakeCheckCacheStore();
    const clock = new FakeClock();
    const cache = new PersistentCheckCache({
      store,
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock,
      cipher: new AesGcmCacheCipher({ dataKey: new Uint8Array(32).fill(3), random: fixedRandom() }),
    });
    return { cache, store, clock };
  }

  it('writes an opaque row under the prefixed key and nothing else', async () => {
    const { cache, store } = build();

    await cache.writeTransactionCheck(result(), FIRST_TRANSFER);

    const row = store.rows.get(transactionRowKey(FIRST_TRANSFER));
    expect(row).toBeDefined();
    expect(row?.payload).toBeInstanceOf(Uint8Array);
    const bytes = JSON.stringify(Array.from(row?.payload ?? []));
    expect(bytes).not.toContain('HIGH');
    expect(row?.keyHex).not.toContain(FIRST_TRANSFER);
  });

  it('cannot be opened as a cache entry, or the reverse', async () => {
    // Both kinds of row share one store, so the AAD label is what stops a 90-day-old record being
    // served as a live answer to a check by anyone with write access to the file.
    const { cache, store } = build();

    await cache.writeTransactionCheck(result(), FIRST_TRANSFER);
    const record = store.rows.get(transactionRowKey(FIRST_TRANSFER));
    expect(record).toBeDefined();

    // Move the record's payload onto a cache entry's row and ask for it as a cached answer.
    const impostor = CheckCacheKey.fromHex(transactionKeyHex(FIRST_TRANSFER));
    expect(impostor).toBeDefined();
    await store.put({
      keyHex: (impostor as CheckCacheKey).hex,
      payload: (record as { payload: Uint8Array }).payload,
      fetchedAtMs: Date.now(),
      expiresAtMs: Date.now() + DAY_MS,
    });

    expect(await cache.read(impostor as CheckCacheKey)).toBeUndefined();
  });
});

describe('NoOpCheckCache', () => {
  it('keeps no records but still rejects a blank id', async () => {
    // Worth pinning because it is the trap: a host that never wires a cache gets a working check
    // path and a transaction-detail card that is always empty, with nothing to say why.
    const cache = new NoOpCheckCache();

    await cache.writeTransactionCheck(result(), FIRST_TRANSFER);
    expect(await cache.readTransactionCheck(FIRST_TRANSFER)).toBeUndefined();
    await expect(cache.readTransactionCheck(' ')).rejects.toThrow('non-blank');
  });
});

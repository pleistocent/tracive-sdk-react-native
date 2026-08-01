import { describe, expect, it } from '@jest/globals';

import {
  checkResponseBody,
  FakeCheckCacheStore,
  FakeClock,
  FakeTransport,
  fixedRandom,
  jsonResponse,
} from '../../__tests__/support/fakes';
import { AesGcmCacheCipher } from '../../cache/CacheCipher';
import { InMemoryCacheKeyStore } from '../../cache/CacheKeyStore';
import { InMemoryCheckCache } from '../../cache/CheckCache';
import { CheckCacheError } from '../../cache/CheckCacheError';
import { CheckCacheKey } from '../../cache/CheckCacheKey';
import { PersistentCheckCache } from '../../cache/PersistentCheckCache';
import { TraciveError } from '../../model/TraciveError';
import { TraciveMode } from '../../model/TraciveMode';
import { InMemoryTokenStore } from '../../oauth/TokenStore';
import { TraciveQuery } from '../../query/TraciveQuery';
import { RetryPolicy } from '../RetryPolicy';
import { TraciveClient } from '../TraciveClient';

const QUERY = TraciveQuery.phone('+6281234567891');
const KEY = CheckCacheKey.fromQuery(QUERY);

function tokenStore(): InMemoryTokenStore {
  return new InMemoryTokenStore({
    accessToken: 'live-token',
    refreshToken: 'refresh',
    tokenType: 'Bearer',
    scopes: ['checks:read'],
  });
}

function build(options?: {
  transport?: FakeTransport;
  cache?: ConstructorParameters<typeof TraciveClient>[0]['cache'];
  clock?: FakeClock;
}): { client: TraciveClient; transport: FakeTransport; clock: FakeClock } {
  const transport = options?.transport ?? new FakeTransport();
  const clock = options?.clock ?? new FakeClock();
  const client = new TraciveClient({
    mode: TraciveMode.oauth({
      clientId: 'partner-app',
      redirectUri: 'https://your.app/oauth/callback',
    }),
    transport,
    clock,
    tokenStore: tokenStore(),
    retryPolicy: RetryPolicy.disabled,
    ...(options?.cache !== undefined ? { cache: options.cache } : {}),
  });
  return { client, transport, clock };
}

describe('CACHE_FIRST', () => {
  it('serves a fresh cache hit without touching the network', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    const transport = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport, cache, clock });

    const first = await client.checkScammer(QUERY, { source: 'CACHE_FIRST' });
    expect(first.origin).toBe('SERVER');
    expect(transport.requests).toHaveLength(1);

    const second = await client.checkScammer(QUERY, { source: 'CACHE_FIRST' });
    expect(second.origin).toBe('CACHE');
    expect(second.billing).toBeUndefined();
    expect(transport.requests).toHaveLength(1);
  });

  it('goes to the server when the cache faults, rather than failing the check', async () => {
    const store = new FakeCheckCacheStore();
    store.failNext = new Error('disk on fire');
    const cache = new PersistentCheckCache({
      store,
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock: new FakeClock(),
      cipher: new AesGcmCacheCipher({ dataKey: new Uint8Array(32), random: fixedRandom() }),
    });
    const transport = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport, cache });

    const result = await client.checkScammer(QUERY, { source: 'CACHE_FIRST' });
    expect(result.origin).toBe('SERVER');
    expect(cache.lastStoreError).toBeInstanceOf(CheckCacheError);
  });

  it('does not fail a successful check when the cache write fails', async () => {
    const store = new FakeCheckCacheStore();
    const cache = new PersistentCheckCache({
      store,
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock: new FakeClock(),
      cipher: new AesGcmCacheCipher({ dataKey: new Uint8Array(32), random: fixedRandom() }),
    });
    const transport = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport, cache });

    store.failNext = new Error('read-only filesystem');
    // The read succeeds (miss), the write is what fails. It costs one credit next time, no more.
    const result = await client.checkScammer(QUERY, { source: 'CACHE_FIRST' });
    expect(result.riskTier).toBe('HIGH');
  });
});

describe('SERVER', () => {
  it('always fetches, and still refreshes the cache', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    const transport = new FakeTransport()
      .enqueue(jsonResponse(200, checkResponseBody()))
      .enqueue(jsonResponse(200, checkResponseBody({ riskTier: 'NONE', found: false })));
    const { client } = build({ transport, cache, clock });

    await client.checkScammer(QUERY, { source: 'SERVER' });
    const second = await client.checkScammer(QUERY, { source: 'SERVER' });
    expect(transport.requests).toHaveLength(2);
    expect(second.riskTier).toBe('NONE');
    expect((await cache.read(KEY))?.riskTier).toBe('NONE');
  });
});

describe('SERVER_FIRST', () => {
  async function seedCache(cache: InMemoryCheckCache, clock: FakeClock): Promise<void> {
    const seeding = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport: seeding, cache, clock });
    await client.checkScammer(QUERY, { source: 'SERVER' });
  }

  it('falls back to the cache on a 5xx', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    await seedCache(cache, clock);

    const transport = new FakeTransport().enqueue(jsonResponse(503, { code: 'server_error' }));
    const { client } = build({ transport, cache, clock });
    const result = await client.checkScammer(QUERY, { source: 'SERVER_FIRST' });
    expect(result.origin).toBe('CACHE');
  });

  it('falls back to the cache on a transport failure', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    await seedCache(cache, clock);

    const transport = new FakeTransport().enqueue(new Error('offline'));
    const { client } = build({ transport, cache, clock });
    expect((await client.checkScammer(QUERY, { source: 'SERVER_FIRST' })).origin).toBe('CACHE');
  });

  it('does NOT fall back on a 402', async () => {
    // A billing answer is a real answer about the caller's account. Serving a cached verdict
    // instead would hide the problem until it became someone else's incident.
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    await seedCache(cache, clock);

    const transport = new FakeTransport().enqueue(
      jsonResponse(402, { code: 'insufficient_credits' }),
    );
    const { client } = build({ transport, cache, clock });
    await expect(client.checkScammer(QUERY, { source: 'SERVER_FIRST' })).rejects.toMatchObject({
      kind: 'insufficientCredits',
    });
  });

  it('does NOT fall back on a 403', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    await seedCache(cache, clock);

    const transport = new FakeTransport().enqueue(jsonResponse(403, { code: 'missing_scope' }));
    const { client } = build({ transport, cache, clock });
    await expect(client.checkScammer(QUERY, { source: 'SERVER_FIRST' })).rejects.toMatchObject({
      kind: 'missingScope',
    });
  });

  it('rethrows the transport error when the cache is also empty', async () => {
    const transport = new FakeTransport().enqueue(jsonResponse(503, {}));
    const { client } = build({ transport });
    await expect(client.checkScammer(QUERY, { source: 'SERVER_FIRST' })).rejects.toMatchObject({
      kind: 'server',
    });
  });
});

describe('CACHE', () => {
  it('throws cacheMiss when nothing is cached', async () => {
    const { client, transport } = build();
    await expect(client.checkScammer(QUERY, { source: 'CACHE' })).rejects.toMatchObject({
      kind: 'cacheMiss',
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('surfaces a storage fault as itself rather than fabricating a clean verdict', async () => {
    // Answering "no reports" when the truth is "the disk is broken" is the single worst thing a
    // fraud SDK can do, so this one deliberately does not degrade to a miss.
    const store = new FakeCheckCacheStore();
    store.failNext = new Error('disk on fire');
    const cache = new PersistentCheckCache({
      store,
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock: new FakeClock(),
      cipher: new AesGcmCacheCipher({ dataKey: new Uint8Array(32), random: fixedRandom() }),
    });
    const { client } = build({ cache });

    await expect(client.checkScammer(QUERY, { source: 'CACHE' })).rejects.toBeInstanceOf(
      CheckCacheError,
    );
  });

  it('returns a hit', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    const transport = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport, cache, clock });
    await client.checkScammer(QUERY, { source: 'SERVER' });
    expect((await client.checkScammer(QUERY, { source: 'CACHE' })).origin).toBe('CACHE');
  });
});

/**
 * The cache stores only the fields that do not vary with `detail`, so a stored row has no
 * `topChronologies` and no `comments`. Serving one to a caller who asked for `full` handed both
 * back as `undefined` — byte-identical to "the server answered in full and there is no narrative on
 * file" — with nothing thrown, nothing logged and no request leaving the device. The write side was
 * wrong for a second reason: the projection keeps the localised `tags` and `disclaimer` under a
 * locale-less key, and only a `full` request carries a locale.
 */
describe('full detail and the cache', () => {
  const FULL_BODY = checkResponseBody({
    topChronologies: [
      {
        chronology: 'Asked for a deposit, then went quiet.',
        riskLevel: 3,
        incidentDate: 'May 2026',
      },
    ],
    comments: [{ date: '2026-05-04', text: 'Same story here.', fromCredibleReport: true }],
  });

  it('goes to the server under CACHE_FIRST even when a minimal result is cached', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    const transport = new FakeTransport()
      .enqueue(jsonResponse(200, checkResponseBody()))
      .enqueue(jsonResponse(200, FULL_BODY));
    const { client } = build({ transport, cache, clock });

    await client.checkScammer(QUERY, { source: 'CACHE_FIRST', detail: 'minimal' });
    expect(transport.requests).toHaveLength(1);

    const full = await client.checkScammer(QUERY, { source: 'CACHE_FIRST', detail: 'full' });
    expect(transport.requests).toHaveLength(2);
    expect(full.origin).toBe('SERVER');
    expect(full.topChronologies).toHaveLength(1);
    expect(full.comments).toHaveLength(1);
  });

  it('throws cacheMiss under CACHE even when a row is sitting there', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    const transport = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport, cache, clock });

    await client.checkScammer(QUERY, { source: 'SERVER', detail: 'minimal' });
    expect(await cache.read(KEY)).toBeDefined();

    await expect(
      client.checkScammer(QUERY, { source: 'CACHE', detail: 'full' }),
    ).rejects.toMatchObject({ kind: 'cacheMiss' });
    expect(transport.requests).toHaveLength(1);
  });

  it('does not even read the cache under CACHE, so a storage fault cannot surface', async () => {
    // `CACHE` is the one source that lets a fault surface as itself rather than degrading to a
    // miss. A faulting store therefore distinguishes "the read was skipped" from "the read
    // happened and returned nothing": skipping it yields cacheMiss, performing it yields the
    // CheckCacheError.
    const store = new FakeCheckCacheStore();
    store.failNext = new Error('disk on fire');
    const cache = new PersistentCheckCache({
      store,
      keyStore: new InMemoryCacheKeyStore({ random: fixedRandom() }),
      clock: new FakeClock(),
      cipher: new AesGcmCacheCipher({ dataKey: new Uint8Array(32), random: fixedRandom() }),
    });
    const { client } = build({ cache });

    await expect(
      client.checkScammer(QUERY, { source: 'CACHE', detail: 'full' }),
    ).rejects.toMatchObject({ kind: 'cacheMiss' });
    expect(cache.lastStoreError).toBeUndefined();
  });

  it('does not write a full response, so a later minimal check is not answered from it', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    const transport = new FakeTransport()
      .enqueue(jsonResponse(200, FULL_BODY))
      .enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport, cache, clock });

    await client.checkScammer(QUERY, { source: 'SERVER', detail: 'full', locale: 'id-ID' });
    expect(await cache.read(KEY)).toBeUndefined();

    const later = await client.checkScammer(QUERY, { source: 'CACHE_FIRST' });
    expect(later.origin).toBe('SERVER');
    expect(transport.requests).toHaveLength(2);
  });

  it('does not write a full response under CACHE_FIRST either', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    const transport = new FakeTransport().enqueue(jsonResponse(200, FULL_BODY));
    const { client } = build({ transport, cache, clock });

    await client.checkScammer(QUERY, { source: 'CACHE_FIRST', detail: 'full' });
    expect(await cache.read(KEY)).toBeUndefined();
  });

  it('surfaces the network failure under SERVER_FIRST instead of degrading to a row', async () => {
    // There is no stale version of narrative content, only a missing one that renders as an empty
    // one, so a failed full check surfaces the failure and lets the caller decide what to do.
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    const seeding = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const seeded = build({ transport: seeding, cache, clock });
    await seeded.client.checkScammer(QUERY, { source: 'SERVER' });
    expect(await cache.read(KEY)).toBeDefined();

    const transport = new FakeTransport().enqueue(jsonResponse(503, { code: 'server_error' }));
    const { client } = build({ transport, cache, clock });
    await expect(
      client.checkScammer(QUERY, { source: 'SERVER_FIRST', detail: 'full' }),
    ).rejects.toMatchObject({ kind: 'server' });
  });

  it('leaves minimal routing exactly as it was', async () => {
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    const transport = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport, cache, clock });

    await client.checkScammer(QUERY, { source: 'CACHE_FIRST', detail: 'minimal' });
    const second = await client.checkScammer(QUERY, { source: 'CACHE_FIRST', detail: 'minimal' });
    expect(second.origin).toBe('CACHE');
    expect(transport.requests).toHaveLength(1);
  });
});

describe('the request itself', () => {
  it('sends the folded lookup key and no API key, in any mode', async () => {
    const transport = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });
    await client.checkScammer(QUERY, { source: 'SERVER', detail: 'full', locale: 'id-ID' });

    const request = transport.lastRequest;
    const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    // The whole body, key for key. This assertion used to name `searchQueryIndex`, which is not a
    // field the API has — and because nothing here asserted the *set* of keys, the wrong spelling
    // and the missing `creditSource` both passed for as long as they existed. Asserting the exact
    // shape is what makes a silent divergence from the sibling SDKs impossible to keep.
    expect(body).toEqual({
      creditSource: 'USER',
      detail: 'full',
      locale: 'id-ID',
      query: 'PHONE_+6281234567891',
    });
    expect(Object.keys(body)).not.toContain('api_key');
    expect(Object.keys(request?.headers ?? {})).not.toContain('api_key');
    expect(request?.headers.authorization).toBe('Bearer live-token');
    expect(request?.url).toBe('https://api.tracive.id/v1/scammer-checks');
  });

  it('omits locale entirely on a minimal check, rather than sending an empty one', async () => {
    // The other half of the shape. `locale` only means anything for full detail, so a minimal
    // check must leave the key out — not send it empty, which would be a value the server has to
    // interpret. Asserted with toEqual for the same reason as above: a key nobody names is a key
    // that can appear later without a single test noticing.
    const transport = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });
    await client.checkScammer(QUERY, { source: 'SERVER' });

    expect(JSON.parse(transport.lastRequest?.body ?? '{}')).toEqual({
      creditSource: 'USER',
      detail: 'minimal',
      query: 'PHONE_+6281234567891',
    });
  });

  it('stamps origin and fetchedAt from the client clock', async () => {
    const clock = new FakeClock(1_800_000_000_000);
    const transport = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport, clock });
    const result = await client.checkScammer(QUERY, { source: 'SERVER' });
    expect(result.origin).toBe('SERVER');
    expect(result.fetchedAt.getTime()).toBe(1_800_000_000_000);
  });

  it('rejects an unrecognised risk tier rather than guessing a safer one', async () => {
    const transport = new FakeTransport().enqueue(
      jsonResponse(200, checkResponseBody({ riskTier: 'SEVERE' })),
    );
    const { client } = build({ transport });
    await expect(client.checkScammer(QUERY, { source: 'SERVER' })).rejects.toMatchObject({
      kind: 'server',
    });
  });

  it('ignores unknown keys so a newer server does not break a shipped app', async () => {
    const transport = new FakeTransport().enqueue(
      jsonResponse(200, checkResponseBody({ somethingBrandNew: { nested: true } })),
    );
    const { client } = build({ transport });
    expect((await client.checkScammer(QUERY, { source: 'SERVER' })).riskTier).toBe('HIGH');
  });
});

describe('credits and profile', () => {
  it('decodes credits', async () => {
    const transport = new FakeTransport().enqueue(
      jsonResponse(200, { subscriptionCredits: 42, tier: 'pro' }),
    );
    const { client } = build({ transport });
    const credits = await client.credits();
    expect(credits.subscriptionCredits).toBe(42);
    expect(credits.tier).toBe('pro');
    expect(transport.lastRequest?.method).toBe('GET');
  });

  it('decodes a profile', async () => {
    const transport = new FakeTransport().enqueue(jsonResponse(200, { sub: 'abc', tier: 'pro' }));
    const { client } = build({ transport });
    expect((await client.profile()).sub).toBe('abc');
  });
});

describe('proxy mode', () => {
  it('uses the partner gateway and exposes no oauth surface', async () => {
    const transport = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const client = new TraciveClient({
      mode: TraciveMode.proxy({
        baseUrl: 'https://gateway.your.app/tracive',
        authHeaders: { 'x-gateway-key': 'k' },
      }),
      transport,
      clock: new FakeClock(),
      retryPolicy: RetryPolicy.disabled,
    });

    expect(client.oauth).toBeUndefined();
    expect(await client.isAuthorized()).toBe(false);
    await client.checkScammer(QUERY, { source: 'SERVER' });
    expect(transport.lastRequest?.url).toBe('https://gateway.your.app/tracive/scammer-checks');
    expect(transport.lastRequest?.headers['x-gateway-key']).toBe('k');
    expect(Object.keys(transport.lastRequest?.headers ?? {})).not.toContain('api_key');
    expect(() => client.authorize()).toThrow();
  });
});

/**
 * A 200 whose body is truncated, or is a captive-portal / gateway error page served with a 200,
 * used to escape as a raw `SyntaxError`: not a TraciveError, not a CheckCacheError, so
 * `isTraciveError(e)` was false and every documented error path missed it. The check had already
 * been charged and no `checkId` reached the caller to quote in a support ticket.
 */
describe('a 2xx body that is not JSON', () => {
  const HTML = '<!doctype html><html><body>Gateway timeout</body></html>';

  it('surfaces a TraciveError from checkScammer, not a SyntaxError', async () => {
    const transport = new FakeTransport().always({ status: 200, headers: {}, body: HTML });
    const { client } = build({ transport });

    const thrown: unknown = await client
      .checkScammer(QUERY, { source: 'SERVER' })
      .then(() => undefined)
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(TraciveError);
    expect((thrown as TraciveError).kind).toBe('server');
    expect((thrown as TraciveError).status).toBe(200);
  });

  it('surfaces a TraciveError from credits and profile too', async () => {
    const transport = new FakeTransport().always({ status: 200, headers: {}, body: HTML });
    const { client } = build({ transport });
    await expect(client.credits()).rejects.toBeInstanceOf(TraciveError);
    await expect(client.profile()).rejects.toBeInstanceOf(TraciveError);
  });

  it('lets SERVER_FIRST fall back to the cache, which is the point of SERVER_FIRST', async () => {
    // The fallback tests `error instanceof TraciveError`, so a raw SyntaxError meant the cache
    // did not engage for exactly the failure where it would have helped.
    const clock = new FakeClock();
    const cache = new InMemoryCheckCache({ clock });
    const transport = new FakeTransport()
      .enqueue(jsonResponse(200, checkResponseBody()))
      .always({ status: 200, headers: {}, body: HTML });
    const { client } = build({ transport, cache, clock });

    await client.checkScammer(QUERY, { source: 'SERVER' });
    const result = await client.checkScammer(QUERY, { source: 'SERVER_FIRST' });
    expect(result.riskTier).toBe('HIGH');
  });

  it('still treats an empty 2xx body as an empty object', async () => {
    // A 204-shaped answer is not malformed; only unparseable text is.
    const transport = new FakeTransport().always({ status: 200, headers: {}, body: '' });
    const { client } = build({ transport });
    const credits = await client.credits();
    expect(credits).toBeDefined();
  });
});

/**
 * A miss costs the same as a hit, so the cache is a billing feature — and two overlapping checks
 * for the same identifier both missed, both POSTed and both were charged. The cache write is the
 * only serialisation point and it happens after both requests have already gone out. A
 * double-tapped "check this number" button, or a list screen rendering the same identifier in two
 * cells, doubled the bill.
 */
describe('concurrent identical checks', () => {
  it('are collapsed into a single billable request', async () => {
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    const [first, second] = await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER' }),
      client.checkScammer(QUERY, { source: 'SERVER' }),
    ]);

    expect(transport.requests).toHaveLength(1);
    expect(first.riskTier).toBe('HIGH');
    expect(second.riskTier).toBe('HIGH');
  });

  it('are collapsed under CACHE_FIRST too, where both miss the cache', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport, cache: new InMemoryCheckCache({ clock }), clock });

    await Promise.all([
      client.checkScammer(QUERY, { source: 'CACHE_FIRST' }),
      client.checkScammer(QUERY, { source: 'CACHE_FIRST' }),
    ]);

    expect(transport.requests).toHaveLength(1);
  });

  it('are NOT collapsed across different detail levels', async () => {
    // A minimal result must never satisfy a full request.
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER', detail: 'minimal' }),
      client.checkScammer(QUERY, { source: 'SERVER', detail: 'full' }),
    ]);

    expect(transport.requests).toHaveLength(2);
  });

  it('are NOT collapsed across different locales', async () => {
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER', detail: 'full', locale: 'en' }),
      client.checkScammer(QUERY, { source: 'SERVER', detail: 'full', locale: 'id' }),
    ]);

    expect(transport.requests).toHaveLength(2);
  });

  it('are NOT collapsed across different identifiers', async () => {
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER' }),
      client.checkScammer(TraciveQuery.phone('+6281234567892'), { source: 'SERVER' }),
    ]);

    expect(transport.requests).toHaveLength(2);
  });

  it('release the latch once settled, so a later check still reaches the server', async () => {
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER' }),
      client.checkScammer(QUERY, { source: 'SERVER' }),
    ]);
    await client.checkScammer(QUERY, { source: 'SERVER' });

    expect(transport.requests).toHaveLength(2);
  });

  it('release the latch after a failure too', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(500, { code: 'server_error' }))
      .always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    const results = await Promise.allSettled([
      client.checkScammer(QUERY, { source: 'SERVER' }),
      client.checkScammer(QUERY, { source: 'SERVER' }),
    ]);
    expect(results.every((entry) => entry.status === 'rejected')).toBe(true);

    const later = await client.checkScammer(QUERY, { source: 'SERVER' });
    expect(later.riskTier).toBe('HIGH');
  });

  /**
   * The latch keys on the identifier, the detail level and the locale, and those three describe
   * the QUERY. An idempotency key describes the TRANSACTION, and two callers who supplied different
   * ones have said in as many words that these are two billable transactions. Collapsing them
   * answered both from one request and sent the first caller's key on it — the same collapse the
   * comment on the generated key already refuses to make through the other door, where deriving a
   * key from the query "would collapse two deliberate re-checks of the same identifier into one".
   */
  it('are NOT collapsed when the callers supplied different idempotency keys', async () => {
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'txn-a' }),
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'txn-b' }),
    ]);

    // Asserted on the recorded requests: two went out, and each carried the key its own caller
    // supplied rather than both carrying whichever caller happened to arrive first.
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.map((request) => request.headers['idempotency-key']).sort()).toEqual([
      'txn-a',
      'txn-b',
    ]);
  });

  it('are NOT collapsed when only one caller supplied a key', async () => {
    // The keyed caller would otherwise join the keyless flight and be answered by a request
    // carrying somebody else's generated key — and, with it, no retry budget.
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER' }),
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'txn-c' }),
    ]);

    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.map((request) => request.headers['idempotency-key'])).toContain(
      'txn-c',
    );
  });

  it('ARE still collapsed when both callers supplied the SAME key', async () => {
    // The same key is the caller saying these are one transaction, which is precisely what the
    // latch is for.
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'txn-d' }),
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'txn-d' }),
    ]);

    expect(transport.requests).toHaveLength(1);
    expect(transport.lastRequest?.headers['idempotency-key']).toBe('txn-d');
  });

  it('ARE still collapsed when one caller passes an empty string and the other passes none', async () => {
    // An empty string is not a key anywhere else, and it must not become one here either: treating
    // it as distinct would split a flight that should be shared and bill the double-tap twice.
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER' }),
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: '' }),
    ]);

    expect(transport.requests).toHaveLength(1);
  });

  it('leave a call that carries an AbortSignal on its own', async () => {
    // Joining it to somebody else's flight would mean one caller's abort cancels another's
    // check, or that an abort no longer stops the request at all. A caller who passes a signal
    // asked for control of that request's lifetime; sharing takes it away.
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER' }),
      client.checkScammer(QUERY, { source: 'SERVER', signal: new AbortController().signal }),
    ]);

    expect(transport.requests).toHaveLength(2);
  });
});

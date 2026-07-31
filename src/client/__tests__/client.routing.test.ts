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

describe('the request itself', () => {
  it('sends the folded lookup key and no API key, in any mode', async () => {
    const transport = new FakeTransport().enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });
    await client.checkScammer(QUERY, { source: 'SERVER', detail: 'full', locale: 'id-ID' });

    const request = transport.lastRequest;
    const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    expect(body.searchQueryIndex).toBe('PHONE_+6281234567891');
    expect(body.detail).toBe('full');
    expect(body.locale).toBe('id-ID');
    expect(Object.keys(body)).not.toContain('api_key');
    expect(Object.keys(request?.headers ?? {})).not.toContain('api_key');
    expect(request?.headers.authorization).toBe('Bearer live-token');
    expect(request?.url).toBe('https://api.tracive.id/v1/scammer-checks');
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

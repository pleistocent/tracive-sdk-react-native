import { describe, expect, it } from '@jest/globals';

import {
  checkResponseBody,
  FakeClock,
  FakeTransport,
  jsonResponse,
} from '../../__tests__/support/fakes';
import { InMemoryCheckCache, NoOpCheckCache } from '../../cache/CheckCache';
import { TraciveMode } from '../../model/TraciveMode';
import { InMemoryTokenStore } from '../../oauth/TokenStore';
import { TraciveOAuth } from '../../oauth/TraciveOAuth';
import { TraciveQuery } from '../../query/TraciveQuery';
import { RetryPolicy } from '../RetryPolicy';
import { TraciveClient } from '../TraciveClient';

const QUERY = TraciveQuery.phone('+6281234567891');
const OTHER_QUERY = TraciveQuery.phone('+6281234567892');

/** Stated rather than inherited from `FakeClock`, because one test below dates against it. */
const CLOCK_START = 1_700_000_000_000;

function build(
  transport: FakeTransport,
  options?: { expiresAt: Date },
): {
  client: TraciveClient;
  oauth: TraciveOAuth;
  tokenStore: InMemoryTokenStore;
} {
  const clock = new FakeClock(CLOCK_START);
  const tokenStore = new InMemoryTokenStore({
    accessToken: 'stale-token',
    refreshToken: 'the-refresh-token',
    tokenType: 'Bearer',
    ...(options?.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    scopes: ['checks:read'],
  });
  const oauth = new TraciveOAuth({
    mode: { clientId: 'partner-app', redirectUri: 'https://your.app/oauth/callback', partnerUserId: 'partner-user-1' },
    transport,
    clock,
    tokenStore,
  });
  const client = new TraciveClient({
    mode: TraciveMode.oauth({
      clientId: 'partner-app',
      redirectUri: 'https://your.app/oauth/callback',
      partnerUserId: 'partner-user-1',
    }),
    transport,
    clock,
    oauth,
    cache: new NoOpCheckCache(),
    retryPolicy: RetryPolicy.create({ jitter: 0 }),
  });
  return { client, oauth, tokenStore };
}

const REFRESHED = jsonResponse(200, {
  access_token: 'fresh-token',
  refresh_token: 'next-refresh',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'checks:read',
});

/**
 * The scenario the old 30-second expiry leeway always pre-empted, and therefore the one that had
 * never actually run: a cold start whose very first request carries a token that expired while the
 * app was closed. Nothing has refreshed yet, so the reactive path is not a fallback here — it is
 * the only mechanism, and it has to work on the first call rather than the second.
 */
describe('cold start with an already-expired stored token', () => {
  it('sends the expired token, takes the 401, refreshes once and replays', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(401, { code: 'expired_token' }))
      .enqueue(REFRESHED)
      .enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build(transport, {
      // Expired an hour before this process started. A stored grant read back from a secure store
      // after the app was killed looks exactly like this.
      expiresAt: new Date(CLOCK_START - 3_600_000),
    });

    const result = await client.checkScammer(QUERY, { source: 'SERVER' });

    expect(result.riskTier).toBe('HIGH');
    expect(transport.requests).toHaveLength(3);
    // The first request is the check, carrying the expired token. Nothing pre-empted it, which is
    // the whole point: the server, not a device clock, decides that the token is finished.
    expect(transport.requests[0]?.url).toContain('/scammer-checks');
    expect(transport.requests[0]?.headers.authorization).toBe('Bearer stale-token');
    expect(transport.requests[1]?.url).toContain('/oauth/token');
    expect(transport.requests[2]?.headers.authorization).toBe('Bearer fresh-token');
  });

  it('refreshes exactly once for two concurrent first calls', async () => {
    // Two different identifiers, so neither the check latch nor the cache collapses them: both
    // reach the network holding the same dead token and both 401. One rotation must come back,
    // because two simultaneous rotations of the same refresh token are what reuse detection
    // revokes a grant for — and a cold start is exactly when several screens fire at once.
    const transport = new FakeTransport()
      .enqueue(jsonResponse(401, { code: 'expired_token' }))
      .enqueue(jsonResponse(401, { code: 'expired_token' }))
      .enqueue(REFRESHED)
      .always(jsonResponse(200, checkResponseBody()));
    const { client } = build(transport, { expiresAt: new Date(CLOCK_START - 3_600_000) });

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER' }),
      client.checkScammer(OTHER_QUERY, { source: 'SERVER' }),
    ]);

    const refreshes = transport.requests.filter((request) => request.url.endsWith('/oauth/token'));
    expect(refreshes).toHaveLength(1);
  });
});

describe('401 expired_token', () => {
  it('refreshes once and re-sends the request', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(401, { code: 'expired_token' }))
      .enqueue(REFRESHED)
      .enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build(transport);

    const result = await client.checkScammer(QUERY, { source: 'SERVER' });
    expect(result.riskTier).toBe('HIGH');
    expect(transport.requests).toHaveLength(3);
    expect(transport.requests[1]?.url).toContain('/oauth/token');
    // The re-send carries the new token.
    expect(transport.requests[2]?.headers.authorization).toBe('Bearer fresh-token');
  });

  it('does not consume the retry budget', async () => {
    // A 401 is rejected before billing, so re-sending after a refresh cannot double-charge —
    // which is exactly why it is allowed even without an idempotency key.
    const transport = new FakeTransport()
      .enqueue(jsonResponse(401, { code: 'expired_token' }))
      .enqueue(REFRESHED)
      .enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build(transport);
    await client.checkScammer(QUERY, { source: 'SERVER' });
    expect(transport.requests).toHaveLength(3);
  });

  it('refreshes only once per request, then surfaces a second 401', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(401, { code: 'expired_token' }))
      .enqueue(REFRESHED)
      .enqueue(jsonResponse(401, { code: 'expired_token' }));
    const { client } = build(transport);
    await expect(client.checkScammer(QUERY, { source: 'SERVER' })).rejects.toMatchObject({
      kind: 'expiredToken',
    });
    expect(transport.requests).toHaveLength(3);
  });
});

describe('401 grant_revoked', () => {
  it('clears the stored grant and never retries', async () => {
    // Usually the server's refresh-token reuse detection firing: the grant is gone, so there is
    // nothing to retry into.
    const transport = new FakeTransport().always(jsonResponse(401, { code: 'grant_revoked' }));
    const { client, oauth } = build(transport);

    await expect(
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'idem' }),
    ).rejects.toMatchObject({ kind: 'grantRevoked' });
    expect(transport.requests).toHaveLength(1);
    expect(await oauth.isAuthorized()).toBe(false);
  });
});

describe('401 invalid_token', () => {
  it('is surfaced without a refresh attempt', async () => {
    const transport = new FakeTransport().always(jsonResponse(401, { code: 'invalid_token' }));
    const { client } = build(transport);
    await expect(client.checkScammer(QUERY, { source: 'SERVER' })).rejects.toMatchObject({
      kind: 'invalidToken',
    });
    expect(transport.requests).toHaveLength(1);
  });
});

/**
 * A bare `401` with no JSON body is what CDNs, API gateways and misconfigured reverse proxies
 * emit, and the SDK is explicitly designed to sit behind a partner gateway in phase 2. Requiring
 * the body to carry exactly `expired_token` meant that in that state the SDK never refreshed, so
 * every subsequent call failed identically until the app happened to call `authorize()` again.
 */
describe('a 401 that carries no recognised code', () => {
  it('refreshes and re-sends when the body is empty', async () => {
    const transport = new FakeTransport()
      .enqueue({ status: 401, headers: {}, body: '' })
      .enqueue(REFRESHED)
      .enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build(transport);

    const result = await client.checkScammer(QUERY, { source: 'SERVER' });
    expect(result.riskTier).toBe('HIGH');
    expect(transport.requests[1]?.url).toContain('/oauth/token');
    expect(transport.requests[2]?.headers.authorization).toBe('Bearer fresh-token');
  });

  it('refreshes when the body carries an unrecognised code', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(401, { code: 'token_not_active_yet' }))
      .enqueue(REFRESHED)
      .enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build(transport);

    await client.checkScammer(QUERY, { source: 'SERVER' });
    expect(transport.requests).toHaveLength(3);
  });

  it('still refreshes at most once, then surfaces the second 401', async () => {
    const transport = new FakeTransport()
      .enqueue({ status: 401, headers: {}, body: '' })
      .enqueue(REFRESHED)
      .enqueue({ status: 401, headers: {}, body: '' });
    const { client } = build(transport);

    await expect(client.checkScammer(QUERY, { source: 'SERVER' })).rejects.toMatchObject({
      status: 401,
    });
    expect(transport.requests).toHaveLength(3);
  });

  it('does not refresh in proxy mode, where the SDK holds no grant', async () => {
    const transport = new FakeTransport().always({ status: 401, headers: {}, body: '' });
    const client = new TraciveClient({
      mode: TraciveMode.proxy({ baseUrl: 'https://gateway.your.app/tracive' }),
      transport,
      clock: new FakeClock(),
      cache: new NoOpCheckCache(),
      retryPolicy: RetryPolicy.disabled,
    });

    await expect(client.checkScammer(QUERY, { source: 'SERVER' })).rejects.toMatchObject({
      status: 401,
    });
    expect(transport.requests).toHaveLength(1);
  });
});

/**
 * A cached verdict is readable with no credential at all — `source: 'CACHE'` never touches the
 * network — so a row left behind after a sign-out is the departing user's check history sitting on
 * a device that now reports `isAuthorized() === false`.
 */
describe('signOut()', () => {
  function buildWithCache(transport: FakeTransport): {
    client: TraciveClient;
    cache: InMemoryCheckCache;
  } {
    const clock = new FakeClock(CLOCK_START);
    const cache = new InMemoryCheckCache({ clock });
    const client = new TraciveClient({
      mode: TraciveMode.oauth({
        clientId: 'partner-app',
        redirectUri: 'https://your.app/oauth/callback',
        partnerUserId: 'partner-user-1',
      }),
      transport,
      clock,
      cache,
      retryPolicy: RetryPolicy.disabled,
      tokenStore: new InMemoryTokenStore({
        accessToken: 'the-access-token',
        refreshToken: 'the-refresh-token',
        tokenType: 'Bearer',
        scopes: ['checks:read'],
      }),
    });
    return { client, cache };
  }

  it('empties the check cache as well as the grant', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(200, checkResponseBody()))
      .enqueue(jsonResponse(200, {}));
    const { client, cache } = buildWithCache(transport);

    await client.checkScammer(QUERY, { source: 'CACHE_FIRST' });
    expect(await cache.count()).toBe(1);

    await client.signOut();

    expect(await client.isAuthorized()).toBe(false);
    expect(await cache.count()).toBe(0);
    await expect(client.checkScammer(QUERY, { source: 'CACHE' })).rejects.toMatchObject({
      kind: 'cacheMiss',
    });
  });

  it('empties it even when the revocation call fails', async () => {
    // Local state is cleared regardless of what the server said, and the cache is local state.
    const transport = new FakeTransport()
      .enqueue(jsonResponse(200, checkResponseBody()))
      .enqueue(new Error('offline'));
    const { client, cache } = buildWithCache(transport);

    await client.checkScammer(QUERY, { source: 'CACHE_FIRST' });
    await client.signOut();

    expect(await cache.count()).toBe(0);
  });
});

describe('two concurrent 401s', () => {
  it('produce exactly one refresh between them', async () => {
    // Two DIFFERENT identifiers on purpose: two concurrent checks of the same one are collapsed
    // into a single billable request, which would leave only one 401 and prove nothing here.
    const transport = new FakeTransport()
      .enqueue(jsonResponse(401, { code: 'expired_token' }))
      .enqueue(jsonResponse(401, { code: 'expired_token' }))
      .enqueue(REFRESHED)
      .always(jsonResponse(200, checkResponseBody()));
    const { client } = build(transport);

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER' }),
      client.checkScammer(OTHER_QUERY, { source: 'SERVER' }),
    ]);

    const refreshes = transport.requests.filter((request) => request.url.endsWith('/oauth/token'));
    expect(refreshes).toHaveLength(1);
  });
});

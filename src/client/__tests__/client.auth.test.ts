import { describe, expect, it } from '@jest/globals';

import {
  checkResponseBody,
  FakeClock,
  FakeTransport,
  jsonResponse,
} from '../../__tests__/support/fakes';
import { NoOpCheckCache } from '../../cache/CheckCache';
import { TraciveMode } from '../../model/TraciveMode';
import { InMemoryTokenStore } from '../../oauth/TokenStore';
import { TraciveOAuth } from '../../oauth/TraciveOAuth';
import { TraciveQuery } from '../../query/TraciveQuery';
import { RetryPolicy } from '../RetryPolicy';
import { TraciveClient } from '../TraciveClient';

const QUERY = TraciveQuery.phone('+6281234567891');
const OTHER_QUERY = TraciveQuery.phone('+6281234567892');

function build(transport: FakeTransport): {
  client: TraciveClient;
  oauth: TraciveOAuth;
  tokenStore: InMemoryTokenStore;
} {
  const clock = new FakeClock();
  const tokenStore = new InMemoryTokenStore({
    accessToken: 'stale-token',
    refreshToken: 'the-refresh-token',
    tokenType: 'Bearer',
    scopes: ['checks:read'],
  });
  const oauth = new TraciveOAuth({
    mode: { clientId: 'partner-app', redirectUri: 'https://your.app/oauth/callback' },
    transport,
    clock,
    tokenStore,
  });
  const client = new TraciveClient({
    mode: TraciveMode.oauth({
      clientId: 'partner-app',
      redirectUri: 'https://your.app/oauth/callback',
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

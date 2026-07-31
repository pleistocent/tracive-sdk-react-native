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

describe('two concurrent 401s', () => {
  it('produce exactly one refresh between them', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(401, { code: 'expired_token' }))
      .enqueue(jsonResponse(401, { code: 'expired_token' }))
      .enqueue(REFRESHED)
      .always(jsonResponse(200, checkResponseBody()));
    const { client } = build(transport);

    await Promise.all([
      client.checkScammer(QUERY, { source: 'SERVER' }),
      client.checkScammer(QUERY, { source: 'SERVER' }),
    ]);

    const refreshes = transport.requests.filter((request) => request.url.endsWith('/oauth/token'));
    expect(refreshes).toHaveLength(1);
  });
});

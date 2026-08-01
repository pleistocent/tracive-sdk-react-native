import { describe, expect, it } from '@jest/globals';

import { FakeClock, FakeTransport, fixedRandom, jsonResponse } from '../../__tests__/support/fakes';
import type { OAuthConfiguration } from '../../model/TraciveMode';
import { InMemoryTokenStore } from '../TokenStore';
import { TraciveOAuth } from '../TraciveOAuth';

const CONFIG: OAuthConfiguration = {
  clientId: 'partner-app',
  redirectUri: 'https://your.app/oauth/callback',
};

function build(): { oauth: TraciveOAuth; transport: FakeTransport } {
  const transport = new FakeTransport().always(
    jsonResponse(200, {
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'checks:read',
    }),
  );
  const oauth = new TraciveOAuth({
    mode: CONFIG,
    transport,
    clock: new FakeClock(),
    random: fixedRandom(),
    tokenStore: new InMemoryTokenStore({
      accessToken: 'stale-access',
      refreshToken: 'the-refresh-token',
      tokenType: 'Bearer',
      scopes: ['checks:read'],
    }),
  });
  return { oauth, transport };
}

/**
 * Two simultaneous refreshes with the same rotating refresh token look exactly like token reuse
 * to an authorization server, and reuse detection revokes the grant. `FakeTransport` resolves on
 * a later microtask precisely so that a latch assigned after an `await` would interleave here
 * and be caught, rather than passing by luck.
 */
describe('single-flight refresh', () => {
  it('produces exactly ONE token POST for N concurrent callers', async () => {
    const { oauth, transport } = build();
    const results = await Promise.all([
      oauth.refreshTokens(),
      oauth.refreshTokens(),
      oauth.refreshTokens(),
      oauth.refreshTokens(),
      oauth.refreshTokens(),
    ]);

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.url).toContain('/oauth/token');
    for (const tokens of results) {
      expect(tokens.accessToken).toBe('fresh-access');
    }
  });

  it('returns the very same promise to every concurrent caller', () => {
    const { oauth } = build();
    const first = oauth.refreshTokens();
    const second = oauth.refreshTokens();
    expect(second).toBe(first);
    return Promise.all([first, second]);
  });

  it('allows a later refresh once the first has settled', async () => {
    const { oauth, transport } = build();
    await oauth.refreshTokens();
    await oauth.refreshTokens();
    expect(transport.requests).toHaveLength(2);
  });

  it('releases the latch after a failure so the next attempt is not wedged', async () => {
    const transport = new FakeTransport().enqueue(
      new Error('offline'),
      jsonResponse(200, { access_token: 'later', token_type: 'Bearer' }),
    );
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock: new FakeClock(),
      tokenStore: new InMemoryTokenStore({
        accessToken: 'stale',
        refreshToken: 'rt',
        tokenType: 'Bearer',
        scopes: [],
      }),
    });

    await expect(oauth.refreshTokens()).rejects.toBeDefined();
    const recovered = await oauth.refreshTokens();
    expect(recovered.accessToken).toBe('later');
  });

  it('clears the grant when the server reports it revoked, and does not retry', async () => {
    const transport = new FakeTransport().always(jsonResponse(401, { error: 'grant_revoked' }));
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock: new FakeClock(),
      tokenStore: new InMemoryTokenStore({
        accessToken: 'a',
        refreshToken: 'rt',
        tokenType: 'Bearer',
        scopes: [],
      }),
    });

    await expect(oauth.refreshTokens()).rejects.toMatchObject({ kind: 'grantRevoked' });
    expect(await oauth.isAuthorized()).toBe(false);
    expect(transport.requests).toHaveLength(1);
  });

  it('refuses to refresh when there is no refresh token', async () => {
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport: new FakeTransport(),
      clock: new FakeClock(),
      tokenStore: new InMemoryTokenStore({
        accessToken: 'a',
        tokenType: 'Bearer',
        scopes: [],
      }),
    });
    await expect(oauth.refreshTokens()).rejects.toMatchObject({ kind: 'invalidToken' });
  });
});

describe('ensureAccessToken', () => {
  it('returns the stored token while it is still valid', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport();
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock,
      tokenStore: new InMemoryTokenStore({
        accessToken: 'still-good',
        refreshToken: 'rt',
        tokenType: 'Bearer',
        expiresAt: new Date(clock.nowMs() + 60_000),
        scopes: [],
      }),
    });
    expect(await oauth.ensureAccessToken()).toBe('still-good');
    expect(transport.requests).toHaveLength(0);
  });

  it('refreshes an expired token before returning one', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport().always(
      jsonResponse(200, { access_token: 'renewed', token_type: 'Bearer', expires_in: 3600 }),
    );
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock,
      tokenStore: new InMemoryTokenStore({
        accessToken: 'expired',
        refreshToken: 'rt',
        tokenType: 'Bearer',
        expiresAt: new Date(clock.nowMs() - 1),
        scopes: [],
      }),
    });
    expect(await oauth.ensureAccessToken()).toBe('renewed');
  });

  it('refreshes a token that is about to expire, rather than spending a round trip on it', async () => {
    // Device clocks drift, and a token with a few seconds of life left is sent, 401s, and costs
    // a round trip to discover what was already knowable. The 401 path recovers it, but the
    // leeway is free.
    const clock = new FakeClock();
    const transport = new FakeTransport().always(
      jsonResponse(200, { access_token: 'renewed', token_type: 'Bearer', expires_in: 3600 }),
    );
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock,
      tokenStore: new InMemoryTokenStore({
        accessToken: 'about-to-expire',
        refreshToken: 'rt',
        tokenType: 'Bearer',
        expiresAt: new Date(clock.nowMs() + 10_000),
        scopes: [],
      }),
    });
    expect(await oauth.ensureAccessToken()).toBe('renewed');
  });

  it('throws when no grant is stored at all', async () => {
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport: new FakeTransport(),
      clock: new FakeClock(),
    });
    await expect(oauth.ensureAccessToken()).rejects.toMatchObject({ kind: 'invalidToken' });
  });
});

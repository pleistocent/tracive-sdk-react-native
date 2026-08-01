import { describe, expect, it } from '@jest/globals';

import { FakeClock, FakeTransport, fixedRandom, jsonResponse } from '../../__tests__/support/fakes';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../client/HttpTransport';
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
    // The failure here is an HTTP one on purpose. A transport that throws is the other case
    // entirely — nothing came back, so the stored refresh token may already have been rotated
    // server-side, and the next attempt is refused rather than sent. See the spent-token suite
    // below. The latch is released either way; only this failure leaves something to retry with.
    const transport = new FakeTransport().enqueue(
      jsonResponse(500, {}),
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

/**
 * A refresh that fails with NO response is indistinguishable from a success whose reply was lost:
 * the server may already have rotated the token and be waiting to see its replacement. Presenting
 * the stored one again is exactly what reuse detection looks for, and the answer to that is the
 * whole grant, not one call. The single-flight latch cannot help — the hazard is sequential, and
 * the latch is clear by the time the second caller arrives.
 */
describe('the spent-refresh-token guard', () => {
  function build(...responses: (HttpResponse | Error)[]): {
    oauth: TraciveOAuth;
    transport: FakeTransport;
  } {
    const transport = new FakeTransport().enqueue(...responses);
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock: new FakeClock(),
      tokenStore: new InMemoryTokenStore({
        accessToken: 'stale-access',
        refreshToken: 'the-refresh-token',
        tokenType: 'Bearer',
        scopes: ['checks:read'],
      }),
    });
    return { oauth, transport };
  }

  it('refuses the stored token LOCALLY on the next attempt', async () => {
    // The discriminating case. A response IS queued behind the failure, so an implementation
    // without the guard sends the same token again and succeeds; the request count is what says
    // the second attempt never reached the transport.
    const { oauth, transport } = build(
      new Error('socket timed out'),
      jsonResponse(200, { access_token: 'later', token_type: 'Bearer' }),
    );

    await expect(oauth.refreshTokens()).rejects.toBeDefined();
    expect(transport.requests).toHaveLength(1);

    await expect(oauth.refreshTokens()).rejects.toMatchObject({ kind: 'invalidToken' });
    expect(transport.requests).toHaveLength(1);
  });

  it('tells the caller to authorize again, without repeating the transport error', async () => {
    const { oauth } = build(new Error('socket timed out'));
    const attempt = oauth.refreshTokens();
    await expect(attempt).rejects.toMatchObject({ kind: 'invalidToken' });
    await expect(attempt).rejects.toThrow(/before any answer arrived/);
  });

  it('releases the marker when the server answered, whatever the status', async () => {
    // A token endpoint that answers with an error has issued no tokens (RFC 6749 section 5.2), so
    // the refresh token was not consumed. Without this release, one 500 would end the grant.
    const { oauth, transport } = build(
      jsonResponse(500, {}),
      jsonResponse(200, { access_token: 'later', token_type: 'Bearer' }),
    );

    await expect(oauth.refreshTokens()).rejects.toBeDefined();
    const recovered = await oauth.refreshTokens();

    expect(recovered.accessToken).toBe('later');
    expect(transport.requests).toHaveLength(2);
  });

  it('remembers more than one rotation back', async () => {
    // A single slot cannot answer for a token two rotations old. The Flutter SDK shipped one and
    // had to replace it with a short history, which is what this pins.
    const { oauth, transport } = build(
      jsonResponse(200, { access_token: 'a2', refresh_token: 'rt2', token_type: 'Bearer' }),
      new Error('socket timed out'),
    );

    await oauth.refreshTokens();
    await expect(oauth.refreshTokens()).rejects.toMatchObject({ kind: 'invalidToken' });

    // Back to the grant the FIRST rotation replaced. The history still recognises it, so it is
    // refused locally instead of going out.
    await oauth.adoptTokens({
      accessToken: 'stale-access',
      refreshToken: 'the-refresh-token',
      tokenType: 'Bearer',
      scopes: [],
    });
    await expect(oauth.refreshTokens()).rejects.toMatchObject({ kind: 'invalidToken' });
    expect(transport.requests).toHaveLength(2);
  });

  it('empties the history on sign-out', async () => {
    // A real authorization issues tokens that have nothing to do with the ones dropped here.
    // Re-storing the SAME value afterwards is what makes the emptying observable at all: if the
    // history survived a sign-out, this refresh would be refused instead of sent.
    const { oauth, transport } = build(
      new Error('socket timed out'),
      jsonResponse(200, {}),
      jsonResponse(200, { access_token: 'after', token_type: 'Bearer' }),
    );

    await expect(oauth.refreshTokens()).rejects.toMatchObject({ kind: 'invalidToken' });
    await oauth.signOut();

    await oauth.adoptTokens({
      accessToken: 'stale-access',
      refreshToken: 'the-refresh-token',
      tokenType: 'Bearer',
      scopes: [],
    });
    const refreshed = await oauth.refreshTokens();

    expect(refreshed.accessToken).toBe('after');
    expect(transport.requests).toHaveLength(3);
  });
});

/**
 * A transport that holds its response until the test releases it, so a sign-out can be made to
 * land in the middle of a token round trip. `FakeTransport` cannot express that: it always answers
 * on the next microtask.
 */
class HeldTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  #release: ((response: HttpResponse) => void) | undefined;

  send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    if (this.#release !== undefined) return Promise.resolve(jsonResponse(200, {}));
    return new Promise<HttpResponse>((resolve) => {
      this.#release = resolve;
    });
  }

  /** Resolves the request currently in flight. */
  release(response: HttpResponse): void {
    this.#release?.(response);
  }
}

/**
 * Discarding a credential is instantaneous; acquiring one is not. A token round trip that was
 * already on the wire when the user signed out still completes, and its write would refill the
 * store the sign-out just emptied — leaving a live, freshly rotated refresh token on a device the
 * user believes is signed out and may be about to hand over.
 */
describe('a token round trip that outlives a sign-out', () => {
  function build(): { oauth: TraciveOAuth; transport: HeldTransport } {
    const transport = new HeldTransport();
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

  it('cannot write the rotated tokens back after signOut()', async () => {
    const { oauth, transport } = build();

    const refresh = oauth.refreshTokens();
    await Promise.resolve();
    expect(transport.requests).toHaveLength(1);

    await oauth.signOut();
    expect(await oauth.isAuthorized()).toBe(false);

    // Only now does the server answer, with the newest and longest-lived refresh token there is.
    transport.release(
      jsonResponse(200, {
        access_token: 'fresh-access',
        refresh_token: 'rotated-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
    );

    await expect(refresh).rejects.toMatchObject({ kind: 'grantRevoked' });
    expect(await oauth.isAuthorized()).toBe(false);
    expect(await oauth.grantedScopes()).toEqual([]);
  });

  it('cannot write them back after clearTokens() either', async () => {
    const { oauth, transport } = build();

    const refresh = oauth.refreshTokens();
    await Promise.resolve();
    await oauth.clearTokens();

    transport.release(
      jsonResponse(200, {
        access_token: 'fresh-access',
        refresh_token: 'rotated',
        token_type: 'Bearer',
      }),
    );

    await expect(refresh).rejects.toMatchObject({ kind: 'grantRevoked' });
    expect(await oauth.isAuthorized()).toBe(false);
  });

  it('does not hand a caller arriving after the sign-out the doomed flight', async () => {
    // Joining it would answer that caller with a refusal earned by somebody else's timing, for a
    // refresh that was never going to be allowed to write.
    const { oauth, transport } = build();

    const doomed = oauth.refreshTokens();
    await Promise.resolve();
    await oauth.signOut();

    const later = oauth.refreshTokens();
    expect(later).not.toBe(doomed);

    transport.release(jsonResponse(200, { access_token: 'a', token_type: 'Bearer' }));
    await expect(doomed).rejects.toMatchObject({ kind: 'grantRevoked' });
    // Nothing is stored to refresh from any more, which is the honest answer for a signed-out app.
    await expect(later).rejects.toMatchObject({ kind: 'invalidToken' });
  });
});

/**
 * Renewal is reactive only: the stored token goes out, and the server's 401 is what triggers a
 * refresh. There is deliberately no proactive check against `expiresAt` — the 401 path is
 * mandatory anyway, a second mechanism for one job would leave the mandatory one unexercised, and
 * an expiry judged against a device clock the SDK does not own refreshes on every call whenever
 * that clock runs fast.
 */
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

  it('returns an ALREADY-EXPIRED stored token rather than pre-emptively refreshing it', async () => {
    const clock = new FakeClock();
    const transport = new FakeTransport();
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
    expect(await oauth.ensureAccessToken()).toBe('expired');
    expect(transport.requests).toHaveLength(0);
  });

  it('returns a token expiring in a moment rather than treating the boundary as expired', async () => {
    // What the old 30-second leeway existed for. It is gone: the server decides, and it decides
    // with a clock that is actually authoritative.
    const clock = new FakeClock();
    const transport = new FakeTransport();
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
    expect(await oauth.ensureAccessToken()).toBe('about-to-expire');
    expect(transport.requests).toHaveLength(0);
  });

  it('throws when no grant is stored at all', async () => {
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport: new FakeTransport(),
      clock: new FakeClock(),
    });
    await expect(oauth.ensureAccessToken()).rejects.toMatchObject({ kind: 'invalidToken' });
  });

  /**
   * A blank access token beside a live refresh token is a different case from an expired one, and
   * a different case again from no grant at all. `adoptTokens()` validates nothing, so a
   * confidential client's backend response missing its access token lands here — and `Bearer `
   * would be sent, refused, and cost a round trip to learn what is already known locally.
   */
  it('refreshes a blank access token instead of sending an empty bearer value', async () => {
    const transport = new FakeTransport().always(
      jsonResponse(200, { access_token: 'renewed', token_type: 'Bearer', expires_in: 3600 }),
    );
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock: new FakeClock(),
      tokenStore: new InMemoryTokenStore({
        accessToken: '',
        refreshToken: 'rt',
        tokenType: 'Bearer',
        scopes: [],
      }),
    });
    expect(await oauth.ensureAccessToken()).toBe('renewed');
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.url).toContain('/oauth/token');
  });

  it('throws when the access token is blank and there is no refresh token to renew it', async () => {
    const transport = new FakeTransport();
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock: new FakeClock(),
      tokenStore: new InMemoryTokenStore({
        accessToken: '',
        tokenType: 'Bearer',
        scopes: [],
      }),
    });
    await expect(oauth.ensureAccessToken()).rejects.toMatchObject({ kind: 'invalidToken' });
    expect(transport.requests).toHaveLength(0);
  });

  /**
   * Blank, not empty. A token of spaces reaches the store exactly as `''` does — a backend that
   * built the field by concatenation, a value round-tripped through a text column — and tested for
   * emptiness it slips past the repair and goes out as `Bearer    `.
   */
  it.each([['   '], ['\t'], ['\n  ']])(
    'refreshes a whitespace-only access token (%j) rather than sending it',
    async (whitespace) => {
      const transport = new FakeTransport().always(
        jsonResponse(200, { access_token: 'renewed', token_type: 'Bearer', expires_in: 3600 }),
      );
      const oauth = new TraciveOAuth({
        mode: CONFIG,
        transport,
        clock: new FakeClock(),
        tokenStore: new InMemoryTokenStore({
          accessToken: whitespace,
          refreshToken: 'rt',
          tokenType: 'Bearer',
          scopes: [],
        }),
      });
      expect(await oauth.ensureAccessToken()).toBe('renewed');
      expect(transport.requests).toHaveLength(1);
    },
  );

  it('throws for a whitespace-only access token with no refresh token, without a request', async () => {
    const transport = new FakeTransport();
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock: new FakeClock(),
      tokenStore: new InMemoryTokenStore({
        accessToken: '  ',
        tokenType: 'Bearer',
        scopes: [],
      }),
    });
    await expect(oauth.ensureAccessToken()).rejects.toMatchObject({ kind: 'invalidToken' });
    expect(transport.requests).toHaveLength(0);
  });
});

describe('a blank credential anywhere else in the grant', () => {
  /**
   * The repair above leads straight here, so a record damaged in both fields would otherwise send
   * a refresh token of spaces — a request that cannot succeed, and one that marks the value as
   * presented, so a timeout on it would refuse a grant that was never renewable.
   */
  it('refuses a whitespace-only refresh token instead of presenting it', async () => {
    const transport = new FakeTransport();
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock: new FakeClock(),
      tokenStore: new InMemoryTokenStore({
        accessToken: 'at',
        refreshToken: '   ',
        tokenType: 'Bearer',
        scopes: [],
      }),
    });
    await expect(oauth.refreshTokens()).rejects.toMatchObject({ kind: 'invalidToken' });
    expect(transport.requests).toHaveLength(0);
  });

  /**
   * The other direction: the server's own reply. Storing a whitespace access token would defer the
   * failure to the next request, where it looks like a rejected grant rather than a malformed
   * token response.
   */
  it('rejects a token response whose access token is only whitespace', async () => {
    const transport = new FakeTransport().always(
      jsonResponse(200, { access_token: '  ', token_type: 'Bearer', expires_in: 3600 }),
    );
    const store = new InMemoryTokenStore({
      accessToken: 'at',
      refreshToken: 'rt',
      tokenType: 'Bearer',
      scopes: [],
    });
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock: new FakeClock(),
      tokenStore: store,
    });
    await expect(oauth.refreshTokens()).rejects.toMatchObject({ kind: 'server' });
    expect((await store.read())?.accessToken).toBe('at');
  });
});

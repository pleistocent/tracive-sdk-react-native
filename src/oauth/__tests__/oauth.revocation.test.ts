import { describe, expect, it } from '@jest/globals';

import { FakeClock, FakeTransport, fixedRandom, jsonResponse } from '../../__tests__/support/fakes';
import type { OAuthConfiguration } from '../../model/TraciveMode';
import { isTraciveError } from '../../model/TraciveError';
import { InMemoryTokenStore } from '../TokenStore';
import { TraciveOAuth } from '../TraciveOAuth';

const CONFIG: OAuthConfiguration = {
  clientId: 'partner-app',
  redirectUri: 'https://your.app/oauth/callback',
  partnerUserId: 'partner-user-1',
};

function build(response: ReturnType<typeof jsonResponse>): {
  oauth: TraciveOAuth;
  store: InMemoryTokenStore;
} {
  const store = new InMemoryTokenStore({
    accessToken: 'stale-access',
    refreshToken: 'the-refresh-token',
    tokenType: 'Bearer',
    scopes: ['scammer.check'],
  });
  const oauth = new TraciveOAuth({
    mode: CONFIG,
    transport: new FakeTransport().always(response),
    clock: new FakeClock(),
    random: fixedRandom(),
    tokenStore: store,
  });
  return { oauth, store };
}

/**
 * What the token endpoint answers when a grant is over.
 *
 * `invalid_grant` is RFC 6749's code and the one the backend returns for all three terminal
 * conditions: the grant was revoked, the refresh token idled out after ninety days, and reuse
 * detection fired. The response carries no Tracive error envelope — it is the OAuth one — so
 * nothing in it says `grant_revoked`.
 */
const REVOKED = jsonResponse(400, {
  error: 'invalid_grant',
  error_description: 'The grant has been revoked.',
});

describe('a refresh the server refuses as invalid_grant', () => {
  it('is terminal: the dead tokens are discarded rather than kept and retried', async () => {
    const { oauth, store } = build(REVOKED);

    await expect(oauth.refreshTokens()).rejects.toMatchObject({ kind: 'grantRevoked' });
    expect(await store.read()).toBeUndefined();
  });

  it('carries the server code through, so a host can log what actually happened', async () => {
    const { oauth } = build(REVOKED);

    await oauth.refreshTokens().then(
      () => {
        throw new Error('the refresh should have failed');
      },
      (error: unknown) => {
        expect(isTraciveError(error)).toBe(true);
        if (isTraciveError(error)) expect(error.serverCode).toBe('invalid_grant');
      },
    );
  });

  /**
   * The boundary of the rule above. Only `invalid_grant` ends a grant; a malformed request is the
   * caller's bug, and throwing the user's tokens away for it would turn a fixable mistake into a
   * re-authorization for every user of that build.
   */
  it('leaves the tokens alone for any other token-endpoint failure', async () => {
    const { oauth, store } = build(
      jsonResponse(400, { error: 'invalid_request', error_description: 'refresh_token missing' }),
    );

    await expect(oauth.refreshTokens()).rejects.toBeDefined();
    expect(await store.read()).toBeDefined();
  });
});

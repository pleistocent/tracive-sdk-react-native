import { describe, expect, it } from '@jest/globals';

import { TraciveEnvironment } from '../../model/TraciveEnvironment';

import {
  completed,
  FakeClock,
  FakeTransport,
  fixedRandom,
  jsonResponse,
} from '../../__tests__/support/fakes';
import { base64UrlEncode } from '../../crypto/base64url';
import { sha256OfString } from '../../crypto/sha256';
import type { OAuthConfiguration } from '../../model/TraciveMode';
import { buildAuthorizeUrl, parseCallbackParameters, parseQueryParameters } from '../authorizeUrl';
import { CODE_CHALLENGE_METHOD, createPkcePair, createState, statesMatch } from '../pkce';
import { InMemoryPendingAuthorizationStore } from '../PendingAuthorization';
import { TraciveOAuth } from '../TraciveOAuth';

const CONFIG: OAuthConfiguration = {
  clientId: 'partner-app',
  redirectUri: 'https://your.app/oauth/callback',
  partnerUserId: 'partner-user-1',
  scopes: ['checks:read'],
};

describe('PKCE', () => {
  it('is S256 and never plain', () => {
    expect(CODE_CHALLENGE_METHOD).toBe('S256');
    const url = buildAuthorizeUrl({
      config: CONFIG,
      state: 'st',
      codeChallenge: 'ch',
      environment: TraciveEnvironment.production,
    });
    expect(url).toContain('code_challenge_method=S256');
    expect(url).not.toContain('plain');
  });

  it('derives the challenge as base64url SHA-256 of the verifier', () => {
    const pair = createPkcePair(fixedRandom());
    expect(pair.codeChallenge).toBe(base64UrlEncode(sha256OfString(pair.codeVerifier)));
  });

  it('produces a verifier of 43-128 unreserved characters', () => {
    const pair = createPkcePair(fixedRandom(11));
    expect(pair.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.codeVerifier.length).toBeLessThanOrEqual(128);
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('produces a distinct verifier per call', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it('produces a state of the same shape', () => {
    expect(createState(fixedRandom())).toMatch(/^[A-Za-z0-9\-_]{43}$/);
  });
});

describe('statesMatch', () => {
  it('accepts an exact match and rejects everything else', () => {
    expect(statesMatch('abcdef', 'abcdef')).toBe(true);
    expect(statesMatch('abcdef', 'abcdeg')).toBe(false);
    expect(statesMatch('abcdef', 'abcde')).toBe(false);
    expect(statesMatch('', '')).toBe(true);
  });
});

describe('the authorize URL', () => {
  it('carries exactly the parameters the flow needs, and no API key', () => {
    const url = buildAuthorizeUrl({
      config: { ...CONFIG, partnerUserId: 'user-9' },
      state: 'the-state',
      codeChallenge: 'the-challenge',
      environment: TraciveEnvironment.production,
    });
    const params = parseCallbackParameters(url);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('partner-app');
    expect(params.get('redirect_uri')).toBe('https://your.app/oauth/callback');
    expect(params.get('code_challenge')).toBe('the-challenge');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('state')).toBe('the-state');
    expect(params.get('scope')).toBe('checks:read');
    expect(params.get('partner_user_id')).toBe('user-9');
    expect([...params.keys()]).not.toContain('api_key');
  });
});

describe('state verification during the callback', () => {
  function build(): { oauth: TraciveOAuth; transport: FakeTransport; opened: string[] } {
    const transport = new FakeTransport();
    const opened: string[] = [];
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport,
      clock: new FakeClock(),
      random: fixedRandom(),
      presence: { isTraciveAppInstalled: () => Promise.resolve(true) },
      launcher: {
        openExternally: (url) => {
          opened.push(url);
          return Promise.resolve(true);
        },
      },
      pendingStore: new InMemoryPendingAuthorizationStore(),
    });
    return { oauth, transport, opened };
  }

  it('rejects a mismatched state and does not exchange anything', async () => {
    const { oauth, transport } = build();
    await oauth.authorize();
    const result = await completed(
      oauth.handleCallback('https://your.app/oauth/callback?state=forged&code=abc'),
    );
    expect(result.type).toBe('failed');
    if (result.type === 'failed') expect(result.error.kind).toBe('stateMismatch');
    expect(transport.requests).toHaveLength(0);
  });

  it('checks the state BEFORE reading error or code', async () => {
    // A forged redirect carrying `error=access_denied` must not be able to make the SDK report a
    // denial, and one carrying a code must not be able to make it exchange.
    const { oauth, transport } = build();
    await oauth.authorize();
    const denied = await completed(
      oauth.handleCallback('https://your.app/oauth/callback?error=access_denied&state=forged'),
    );
    expect(denied.type).toBe('failed');
    if (denied.type === 'failed') expect(denied.error.kind).toBe('stateMismatch');
    expect(transport.requests).toHaveLength(0);
  });

  it('a forged redirect cannot cancel the authorization the user is in the middle of', async () => {
    // Any app on the device can hand this one a URL. If a mismatched state erased the pending
    // record, one `openURL` from anywhere would be enough to kill a consent in progress — and the
    // user would come back from the Tracive app to a flow that had already given up.
    const { oauth, transport, opened } = build();
    transport.enqueue(
      jsonResponse(200, {
        access_token: 'at',
        refresh_token: 'rt',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'checks:read',
      }),
    );

    expect(await oauth.authorize()).toBeNull();
    const state = parseCallbackParameters(opened[0] ?? '').get('state') ?? '';

    const forged = await completed(
      oauth.handleCallback('https://your.app/oauth/callback?state=forged&code=attacker-code'),
    );
    expect(forged.type).toBe('failed');
    if (forged.type === 'failed') expect(forged.error.kind).toBe('stateMismatch');
    expect(transport.requests).toHaveLength(0);

    // The genuine redirect still completes, because the attempt survived the forgery.
    const real = await completed(
      oauth.handleCallback(
        `https://your.app/oauth/callback?code=the-code&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(real.type).toBe('authorized');
    expect(parseQueryParameters(transport.lastRequest?.body ?? '').get('code')).toBe('the-code');
  });

  it('completes, and exchanges with the matching verifier, when the state matches', async () => {
    const { oauth, transport, opened } = build();
    transport.enqueue(
      jsonResponse(200, {
        access_token: 'at',
        refresh_token: 'rt',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'checks:read',
      }),
    );

    expect(await oauth.authorize()).toBeNull();
    const launched = parseCallbackParameters(opened[0] ?? '');
    const state = launched.get('state');
    expect(state).toBeDefined();

    const result = await completed(
      oauth.handleCallback(
        `https://your.app/oauth/callback?code=the-code&state=${encodeURIComponent(state ?? '')}`,
      ),
    );
    expect(result.type).toBe('authorized');

    const exchange = parseQueryParameters(transport.lastRequest?.body ?? '');
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('the-code');
    expect(exchange.get('code_verifier')).toBeDefined();
    // The challenge that was launched must be the SHA-256 of the verifier that was sent.
    expect(launched.get('code_challenge')).toBe(
      base64UrlEncode(sha256OfString(exchange.get('code_verifier') ?? '')),
    );
    expect([...exchange.keys()]).not.toContain('api_key');
  });
});

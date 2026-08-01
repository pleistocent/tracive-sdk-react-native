import { describe, expect, it } from '@jest/globals';

import { NoOpCheckCache } from '../cache/CheckCache';
import { CheckCacheKey } from '../cache/CheckCacheKey';
import {
  FetchHttpTransport,
  redactedRequest,
  redactedResponse,
} from '../client/HttpTransport';
import { decodeProfileInfo } from '../client/responseMapper';
import { RetryPolicy } from '../client/RetryPolicy';
import { TraciveClient } from '../client/TraciveClient';
import { codeReceived, redactedTokens } from '../model/AuthResult';
import { redactedProxyConfiguration, TraciveMode } from '../model/TraciveMode';
import { InMemoryTokenStore } from '../oauth/TokenStore';
import { TraciveQuery } from '../query/TraciveQuery';
import { checkResponseBody, FakeClock, FakeTransport, jsonResponse } from './support/fakes';

const SECRETS = [
  'live-authorization-code',
  'live-code-verifier',
  'live-access-token',
  'live-refresh-token',
  '+6281234567891',
  'pairwise-subject-id',
  'Budi Santoso',
  'Bearer live-access-token',
  'super-secret-gateway-key',
];

/**
 * JavaScript objects serialise by default, so one `console.log` or one crash-reporter breadcrumb
 * is all it takes to print a live credential. Everything credential-bearing in this SDK is
 * checked here against BOTH serialisation paths, because redacting only `toJSON` still leaks
 * through string interpolation.
 */
function expectNoSecrets(label: string, value: unknown): void {
  const json = JSON.stringify(value);
  const text = String(value);
  const interpolated = `${value as string}`;
  for (const secret of SECRETS) {
    expect(`${label} json: ${json}`).not.toContain(secret);
    expect(`${label} toString: ${text}`).not.toContain(secret);
    expect(`${label} template: ${interpolated}`).not.toContain(secret);
  }
}

describe('redaction', () => {
  it('redacts AuthResult(codeReceived)', () => {
    const result = codeReceived({
      code: 'live-authorization-code',
      codeVerifier: 'live-code-verifier',
      redirectUri: 'https://your.app/oauth/callback',
    });
    expectNoSecrets('codeReceived', result);
    // The parts a caller legitimately needs are still readable on the object itself.
    expect(result.type).toBe('codeReceived');
    if (result.type === 'codeReceived') {
      expect(result.code).toBe('live-authorization-code');
      expect(result.redirectUri).toBe('https://your.app/oauth/callback');
    }
    expect(JSON.stringify(result)).toContain('[redacted]');
    expect(JSON.stringify(result)).toContain('https://your.app/oauth/callback');
  });

  it('redacts TraciveTokens', () => {
    const tokens = redactedTokens({
      accessToken: 'live-access-token',
      refreshToken: 'live-refresh-token',
      tokenType: 'Bearer',
      expiresAt: new Date(1_700_000_000_000),
      scopes: ['checks:read'],
    });
    expectNoSecrets('tokens', tokens);
    expect(tokens.accessToken).toBe('live-access-token');
    expect(JSON.stringify(tokens)).toContain('checks:read');
  });

  it('redacts TraciveQuery, which holds the raw identifier', () => {
    const query = TraciveQuery.phone('+6281234567891');
    expectNoSecrets('query', query);
    expect(JSON.stringify(query)).toBe('{"kind":"PHONE","searchQueryIndex":"[redacted]"}');
    expect(String(query)).toBe('TraciveQuery(kind: PHONE, key: <redacted>)');
  });

  it('redacts CheckCacheKey', () => {
    const key = CheckCacheKey.fromSearchQueryIndex('PHONE_+6281234567891');
    expectNoSecrets('cacheKey', key);
    expect(JSON.stringify(key)).toBe('"CheckCacheKey(<redacted>)"');
    expect(String(key)).toBe('CheckCacheKey(<redacted>)');
    // The hex itself stays reachable, because the store needs it.
    expect(key.hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('redacts ProfileInfo', () => {
    const profile = decodeProfileInfo({
      sub: 'pairwise-subject-id',
      name: 'Budi Santoso',
      country: 'IDN',
      tier: 'pro',
    });
    expectNoSecrets('profile', profile);
    expect(profile.sub).toBe('pairwise-subject-id');
    expect(JSON.stringify(profile)).toContain('IDN');
  });

  it('redacts HttpRequest and HttpResponse to header names and body sizes', () => {
    const request = redactedRequest({
      method: 'POST',
      url: 'https://api.tracive.id/v1/scammer-checks',
      headers: { authorization: 'Bearer live-access-token', accept: 'application/json' },
      body: JSON.stringify({ searchQueryIndex: 'PHONE_+6281234567891' }),
    });
    expectNoSecrets('request', request);
    expect(JSON.stringify(request)).toContain('authorization');
    expect(JSON.stringify(request)).toContain('bodyBytes');

    const response = redactedResponse({
      status: 200,
      headers: { 'set-cookie': 'session=live-access-token' },
      body: JSON.stringify({ sub: 'pairwise-subject-id' }),
    });
    expectNoSecrets('response', response);
    expect(JSON.stringify(response)).toContain('set-cookie');
  });

  it('redacts ProxyConfiguration to header names only', () => {
    const config = redactedProxyConfiguration({
      baseUrl: 'https://gateway.your.app/tracive',
      authHeaders: { 'x-gateway-key': 'super-secret-gateway-key' },
    });
    expectNoSecrets('proxyConfiguration', config);
    expect(JSON.stringify(config)).toContain('x-gateway-key');
    expect(JSON.stringify(config)).toContain('gateway.your.app');
  });
});

/**
 * The block above proves the redactors work. It cannot prove they are REACHED, and for a while
 * they were not: every one of them was called only from this file, so a partner who logged a
 * client or an injected transport's argument printed a live credential. These cases therefore
 * assert on objects a real `TraciveClient` produces and hands out, never on a hand-built one.
 */
describe('redaction is wired into the shipping code paths', () => {
  const GATEWAY_SECRET = 'super-secret-gateway-key';
  const ACCESS_TOKEN = 'live-access-token';

  function proxyClient(transport: FakeTransport): TraciveClient {
    return new TraciveClient({
      mode: TraciveMode.proxy({
        baseUrl: 'https://gateway.your.app/tracive',
        authHeaders: { 'x-gateway-key': GATEWAY_SECRET },
      }),
      transport,
      clock: new FakeClock(),
      cache: new NoOpCheckCache(),
      retryPolicy: RetryPolicy.disabled,
    });
  }

  it('does not print a proxy credential when the client itself is serialised', () => {
    const client = proxyClient(new FakeTransport());
    expect(JSON.stringify(client)).not.toContain(GATEWAY_SECRET);
    expect(String(client)).not.toContain(GATEWAY_SECRET);
    // The non-secret parts stay readable, because a crash report that says nothing is no help.
    expect(JSON.stringify(client)).toContain('gateway.your.app');
    expect(JSON.stringify(client)).toContain('x-gateway-key');
  });

  it('still sends the real proxy credential on the wire', async () => {
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    await proxyClient(transport).checkScammer(TraciveQuery.phone('+6281234567891'), {
      source: 'SERVER',
    });
    expect(transport.lastRequest?.headers['x-gateway-key']).toBe(GATEWAY_SECRET);
  });

  it('hands the transport a request that redacts itself when serialised', async () => {
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    await proxyClient(transport).checkScammer(TraciveQuery.phone('+6281234567891'), {
      source: 'SERVER',
    });
    const seen = transport.lastRequest;
    expect(JSON.stringify(seen)).not.toContain(GATEWAY_SECRET);
    expect(String(seen)).not.toContain(GATEWAY_SECRET);
    expect(JSON.stringify(seen)).toContain('x-gateway-key');
  });

  it('hands the transport a request that hides a bearer token in oauth mode', async () => {
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const client = new TraciveClient({
      mode: TraciveMode.oauth({
        clientId: 'partner-app',
        redirectUri: 'https://your.app/oauth/callback',
      }),
      transport,
      clock: new FakeClock(),
      cache: new NoOpCheckCache(),
      retryPolicy: RetryPolicy.disabled,
      tokenStore: new InMemoryTokenStore({
        accessToken: ACCESS_TOKEN,
        tokenType: 'Bearer',
        scopes: [],
      }),
    });
    await client.checkScammer(TraciveQuery.phone('+6281234567891'), { source: 'SERVER' });
    const seen = transport.lastRequest;
    expect(seen?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(JSON.stringify(seen)).not.toContain(ACCESS_TOKEN);
    expect(String(seen)).not.toContain(ACCESS_TOKEN);
  });

  it('hides the refresh token in the body of a token request', async () => {
    const transport = new FakeTransport().always(
      jsonResponse(200, { access_token: 'fresh', token_type: 'Bearer', expires_in: 3600 }),
    );
    const client = new TraciveClient({
      mode: TraciveMode.oauth({
        clientId: 'partner-app',
        redirectUri: 'https://your.app/oauth/callback',
      }),
      transport,
      clock: new FakeClock(),
      cache: new NoOpCheckCache(),
      tokenStore: new InMemoryTokenStore({
        accessToken: 'stale',
        refreshToken: 'live-refresh-token',
        tokenType: 'Bearer',
        scopes: [],
      }),
    });
    await client.oauth?.refreshTokens();
    const seen = transport.requests[0];
    expect(seen?.body).toContain('live-refresh-token');
    expect(JSON.stringify(seen)).not.toContain('live-refresh-token');
    expect(String(seen)).not.toContain('live-refresh-token');
  });

  it('reports a body size in bytes, not in UTF-16 code units', async () => {
    // The one number a redacted request still carries has to be the number the server saw.
    const body = '{"searchQueryIndex":"EMAIL_budi\u00e9@x.com"}'; // one 2-byte character
    const seen = redactedRequest({
      method: 'POST',
      url: 'https://api.tracive.id/v1/scammer-checks',
      headers: {},
      body,
    });
    const described = JSON.parse(JSON.stringify(seen)) as { bodyBytes: number };
    expect(described.bodyBytes).toBe(body.length + 1);
    expect(String(seen)).toContain(`${body.length + 1} bytes`);
  });

  it('returns a response that redacts itself from the shipping transport', async () => {
    const fetchStub: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ sub: 'pairwise-subject-id' }), {
          status: 200,
          headers: { 'set-cookie': `session=${ACCESS_TOKEN}` },
        }),
      );
    const response = await new FetchHttpTransport({ fetch: fetchStub }).send({
      method: 'GET',
      url: 'https://api.tracive.id/v1/profile',
      headers: { accept: 'application/json' },
    });
    expect(response.body).toContain('pairwise-subject-id');
    expect(JSON.stringify(response)).not.toContain('pairwise-subject-id');
    expect(JSON.stringify(response)).not.toContain(ACCESS_TOKEN);
    expect(String(response)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(response)).toContain('set-cookie');
  });
});

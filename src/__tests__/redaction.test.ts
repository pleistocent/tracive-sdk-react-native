import { describe, expect, it } from '@jest/globals';

import { CheckCacheKey } from '../cache/CheckCacheKey';
import { redactedRequest, redactedResponse } from '../client/HttpTransport';
import { decodeProfileInfo } from '../client/responseMapper';
import { codeReceived, redactedTokens } from '../model/AuthResult';
import { redactedProxyConfiguration } from '../model/TraciveMode';
import { TraciveQuery } from '../query/TraciveQuery';

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

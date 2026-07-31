import { describe, expect, it } from '@jest/globals';

import { deserializeTokens, serializeTokens } from '../../oauth/TokenStore';
import {
  deserializePendingAuthorization,
  serializePendingAuthorization,
} from '../../oauth/PendingAuthorization';
import { TraciveEnvironment } from '../TraciveEnvironment';
import { TraciveMode } from '../TraciveMode';

describe('TraciveEnvironment', () => {
  it('resolves the documented base URLs', () => {
    expect(TraciveEnvironment.baseUrl(TraciveEnvironment.production)).toBe(
      'https://api.tracive.id/v1',
    );
    expect(TraciveEnvironment.baseUrl(TraciveEnvironment.sandbox)).toBe(
      'https://api-sandbox.tracive.id/v1',
    );
  });

  it('accepts a custom base URL and trims a trailing slash', () => {
    expect(
      TraciveEnvironment.baseUrl(TraciveEnvironment.custom('https://staging.example/v1/')),
    ).toBe('https://staging.example/v1');
  });
});

describe('TraciveMode', () => {
  it('tags each variant so the client can branch on it', () => {
    const oauth = TraciveMode.oauth({
      clientId: 'a',
      redirectUri: 'https://your.app/oauth/callback',
    });
    expect(oauth.type).toBe('oauth');
    const proxy = TraciveMode.proxy({ baseUrl: 'https://gateway.your.app' });
    expect(proxy.type).toBe('proxy');
  });
});

describe('token serialisation', () => {
  it('round-trips through the shape every persistent store uses', () => {
    const tokens = {
      accessToken: 'at',
      refreshToken: 'rt',
      tokenType: 'Bearer',
      expiresAt: new Date(1_700_000_000_000),
      scopes: ['checks:read'],
    };
    const restored = deserializeTokens(serializeTokens(tokens));
    expect(restored?.accessToken).toBe('at');
    expect(restored?.refreshToken).toBe('rt');
    expect(restored?.expiresAt?.getTime()).toBe(1_700_000_000_000);
    expect(restored?.scopes).toEqual(['checks:read']);
    // A restored grant is redacted just like a freshly issued one.
    expect(JSON.stringify(restored)).not.toContain('"at"');
  });

  it('returns undefined rather than throwing on a corrupt record', () => {
    expect(deserializeTokens('not json')).toBeUndefined();
    expect(deserializeTokens('{"nope":true}')).toBeUndefined();
  });

  it('defaults the token type and scopes', () => {
    const restored = deserializeTokens('{"accessToken":"at"}');
    expect(restored?.tokenType).toBe('Bearer');
    expect(restored?.scopes).toEqual([]);
  });
});

describe('pending-authorization serialisation', () => {
  it('round-trips', () => {
    const pending = {
      state: 's',
      codeVerifier: 'v',
      redirectUri: 'https://your.app/oauth/callback',
      createdAtMs: 1,
    };
    expect(deserializePendingAuthorization(serializePendingAuthorization(pending))).toEqual(
      pending,
    );
  });

  it('returns undefined rather than throwing on a corrupt record', () => {
    expect(deserializePendingAuthorization('{')).toBeUndefined();
    expect(deserializePendingAuthorization('{"state":1}')).toBeUndefined();
  });
});

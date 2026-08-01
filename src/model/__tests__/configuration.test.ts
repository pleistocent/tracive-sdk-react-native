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
      partnerUserId: 'partner-user-1',
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

  /**
   * Only `accessToken` was checked, and the other four were handed back as they were found. A
   * record damaged in one of them came back looking usable and failed later, somewhere else:
   * `refreshToken: null` is not `undefined`, so the refresh path treated it as a token and reached
   * `null.trim()`; an `expiresAtMs` that is not a number became an Invalid Date, or — for `null` —
   * a confident expiry in 1970; a `scopes` that is not an array was published from
   * `grantedScopes()` as whatever it was. This is the same family as the pending record whose
   * unvalidated `createdAtMs` made `NaN > 600` false and stopped it ever expiring.
   *
   * A record failing any check is now reported as absent, exactly as unparseable JSON already was.
   * Absent is a state the SDK already handles everywhere: the caller authorizes again.
   */
  describe('a stored record with a damaged field', () => {
    it.each([
      ['a null refresh token', '{"accessToken":"at","refreshToken":null}'],
      ['a numeric refresh token', '{"accessToken":"at","refreshToken":12}'],
      ['a numeric token type', '{"accessToken":"at","tokenType":7}'],
      ['a null token type', '{"accessToken":"at","tokenType":null}'],
      ['an expiry that is not a number', '{"accessToken":"at","expiresAtMs":"soon"}'],
      ['an expiry that is null', '{"accessToken":"at","expiresAtMs":null}'],
      ['an expiry that is not a number at all', '{"accessToken":"at","expiresAtMs":true}'],
      ['an expiry beyond the range of a Date', `{"accessToken":"at","expiresAtMs":${1e20}}`],
      ['scopes that are not an array', '{"accessToken":"at","scopes":"checks:read"}'],
      ['scopes holding something that is not a string', '{"accessToken":"at","scopes":["a",2]}'],
      ['scopes that are null', '{"accessToken":"at","scopes":null}'],
    ])('is rejected outright: %s', (_case, json) => {
      expect(deserializeTokens(json)).toBeUndefined();
    });

    it('is rejected when the record is not an object at all', () => {
      expect(deserializeTokens('"at"')).toBeUndefined();
      expect(deserializeTokens('null')).toBeUndefined();
      expect(deserializeTokens('[]')).toBeUndefined();
    });

    it('still accepts every shape the serializer actually writes', () => {
      // The mirror assertion. Rejecting a damaged record is worth nothing if it also rejects a
      // sound one, which would sign out every user on the next read.
      expect(
        deserializeTokens('{"accessToken":"at","tokenType":"Bearer","scopes":[]}'),
      ).toBeDefined();
      const full = deserializeTokens(
        '{"accessToken":"at","refreshToken":"rt","tokenType":"Bearer","expiresAtMs":0,"scopes":["a"]}',
      );
      expect(full?.refreshToken).toBe('rt');
      expect(full?.expiresAt?.getTime()).toBe(0);
    });
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

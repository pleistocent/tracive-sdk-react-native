import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { FakeClock, FakeTransport, jsonResponse } from './support/fakes';
import * as publicSurface from '../index';
import { TraciveMode } from '../model/TraciveMode';
import { InMemoryTokenStore } from '../oauth/TokenStore';
import { TraciveQuery } from '../query/TraciveQuery';
import { NoOpCheckCache } from '../cache/CheckCache';
import { RetryPolicy } from '../client/RetryPolicy';
import { TraciveClient } from '../client/TraciveClient';
import { TRACIVE_ANDROID_PACKAGE } from '../oauth/authorizeUrl';
import { TraciveOAuth } from '../oauth/TraciveOAuth';
import { TRACIVE_ANDROID_PACKAGE as doctorAndroidPackage } from '../doctor/checks';
import { TRACIVE_ANDROID_PACKAGE as pluginAndroidPackage } from '../expo/plugin';

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === '__tests__') continue;
      sourceFiles(path, found);
    } else if (entry.endsWith('.ts')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * There is no API key in this SDK, in either mode. Authorization is OAuth 2.0 with PKCE,
 * performed by the Tracive app on the same device. The only place the string may legitimately
 * appear is the error-code table, because the server has an `invalid_api_key` code that a
 * misconfigured PARTNER GATEWAY could return through proxy mode.
 */
describe('there is no API key anywhere', () => {
  // The adapter subpaths cannot be imported here: they resolve optional peer dependencies that
  // are deliberately not installed in this repository. The source scan below covers them.
  it('is absent from every exported name', () => {
    for (const name of Object.keys(publicSurface)) {
      expect(name.toLowerCase()).not.toContain('apikey');
    }
  });

  it('is absent from every outgoing request field and header', async () => {
    // One body that satisfies all three decoders, so a single fake covers every endpoint.
    const transport = new FakeTransport().always(
      jsonResponse(200, {
        found: false,
        riskTier: 'NONE',
        subscriptionCredits: 3,
        tier: 'free',
        sub: 'pairwise-id',
      }),
    );
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
        accessToken: 'token',
        tokenType: 'Bearer',
        scopes: [],
      }),
    });

    await client.checkScammer(TraciveQuery.phone('+6281234567891'), { source: 'SERVER' });
    await client.credits();
    await client.profile();

    expect(transport.requests.length).toBeGreaterThan(0);
    for (const request of transport.requests) {
      for (const header of Object.keys(request.headers)) {
        expect(header.toLowerCase()).not.toContain('api_key');
        expect(header.toLowerCase()).not.toContain('apikey');
      }
      expect(request.url).not.toContain('api_key');
      if (request.body !== undefined) {
        const parsed = JSON.parse(request.body) as Record<string, unknown>;
        for (const field of Object.keys(parsed)) {
          expect(field.toLowerCase()).not.toContain('api_key');
          expect(field.toLowerCase()).not.toContain('apikey');
        }
      }
    }
  });

  it('appears in the source only as an inbound error code', () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(join(process.cwd(), 'src'))) {
      const source = readFileSync(path, 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (!/api[_-]?key/i.test(line)) continue;
        // Prose is allowed to say the words in order to state that there is no API key.
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
          continue;
        }
        // `invalid_api_key` / `invalidApiKey` map an INBOUND server error; nothing is sent.
        if (/invalid_api_key|invalidApiKey/.test(line)) continue;
        offenders.push(`${path}:${index + 1}: ${trimmed}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The Expo plugin writes the `<queries>` entry, the doctor reads it back and reports on it, and
 * the OAuth flow probes it at runtime. Three copies of the value were three copies of an agreement
 * with the app on the user's device: edit one and the doctor certifies a manifest the SDK will
 * refuse, or the plugin writes one the doctor calls wrong, with nothing pointing at the
 * discrepancy.
 */
describe('the Tracive app’s Android identity', () => {
  it('is written as a literal in exactly one source file', () => {
    // Built from the constant rather than typed out as an escaped pattern. An escaped copy is a
    // second definition of the very thing this test exists to keep single, and it also reads
    // differently from the allowed form the hygiene scan looks for.
    const literal = `'${TRACIVE_ANDROID_PACKAGE}'`;
    const definitions: string[] = [];
    for (const path of sourceFiles(join(process.cwd(), 'src'))) {
      const source = readFileSync(path, 'utf8');
      for (const [index, line] of source.split('\n').entries()) {
        if (line.includes(literal)) definitions.push(`${path}:${index + 1}`);
      }
    }
    expect(definitions).toHaveLength(1);
    expect(definitions[0]).toContain(join('oauth', 'authorizeUrl.ts'));
  });

  it('is the same object everywhere it is used', () => {
    expect(TRACIVE_ANDROID_PACKAGE).toBe('com.pleistocent.tracive');
    expect(TraciveOAuth.traciveAndroidPackage).toBe(TRACIVE_ANDROID_PACKAGE);
    expect(doctorAndroidPackage).toBe(TRACIVE_ANDROID_PACKAGE);
    expect(pluginAndroidPackage).toBe(TRACIVE_ANDROID_PACKAGE);
  });
});

describe('there is no domain query builder', () => {
  it('is absent from the query surface and from the public exports', () => {
    // A DOMAIN_<host> key would match nothing, and a miss is still billed.
    expect('domain' in TraciveQuery).toBe(false);
    for (const name of Object.keys(publicSurface)) {
      expect(name.toLowerCase()).not.toContain('domain');
    }
  });
});

describe('the public surface', () => {
  it('exports everything the documented entry points need', () => {
    for (const name of [
      'TraciveClient',
      'TraciveOAuth',
      'TraciveQuery',
      'TraciveQueryError',
      'TraciveError',
      'TraciveConfigurationError',
      'CheckCacheError',
      'TraciveMode',
      'TraciveScopes',
      'TraciveEnvironment',
      'CachePolicy',
      'RetryPolicy',
      'CheckCacheKey',
      'InMemoryCheckCache',
      'NoOpCheckCache',
      'PersistentCheckCache',
      'AesGcmCacheCipher',
      'InMemoryCacheKeyStore',
      'InMemoryTokenStore',
      'InMemoryPendingAuthorizationStore',
      'FetchHttpTransport',
      'systemClock',
      'defaultRandom',
      'toCacheableCopy',
      'traciveErrorFrom',
      'isTraciveError',
      'isTraciveQueryError',
      'isCheckCacheError',
      'isTraciveConfigurationError',
    ]) {
      expect(Object.keys(publicSurface)).toContain(name);
    }
  });

  it('keeps internals out of the entry point', () => {
    for (const name of ['normalizeNfc', 'foldPhone', 'isValidRecordKey', 'createPkcePair']) {
      expect(Object.keys(publicSurface)).not.toContain(name);
    }
  });
});

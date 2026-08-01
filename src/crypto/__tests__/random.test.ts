import { afterEach, describe, expect, it } from '@jest/globals';

import { AesGcmCacheCipher } from '../../cache/CacheCipher';
import { InMemoryCacheKeyStore } from '../../cache/CacheKeyStore';
import { TraciveConfigurationError } from '../../model/TraciveConfigurationError';
import { createPkcePair, createState } from '../../oauth/pkce';
import { defaultRandom, randomUuid } from '../random';

const realCrypto = (globalThis as { crypto?: unknown }).crypto;

function deleteWebCrypto(): void {
  Object.defineProperty(globalThis, 'crypto', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'crypto', {
    value: realCrypto,
    configurable: true,
    writable: true,
  });
});

/**
 * React Native ships no WebCrypto. The one failure mode this suite exists to prevent is a silent
 * fallback to `Math.random`, which keeps every test green while making PKCE verifiers and cache
 * nonces predictable.
 */
describe('with no CSPRNG available', () => {
  it('throws csprng_unavailable rather than returning bytes', () => {
    deleteWebCrypto();
    let thrown: unknown;
    let returned: Uint8Array | undefined;
    try {
      returned = defaultRandom.randomBytes(32);
    } catch (error) {
      thrown = error;
    }
    expect(returned).toBeUndefined();
    expect(thrown).toBeInstanceOf(TraciveConfigurationError);
    expect((thrown as TraciveConfigurationError).code).toBe('csprng_unavailable');
  });

  it('names both satisfiers in the message', () => {
    deleteWebCrypto();
    try {
      defaultRandom.randomBytes(1);
      throw new Error('expected a throw');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('expo');
      expect(message).toContain('react-native-get-random-values');
      expect(message).toContain('getRandomValues');
    }
  });

  it('throws from every entry point that needs randomness', () => {
    deleteWebCrypto();
    expect(() => createPkcePair()).toThrow(TraciveConfigurationError);
    expect(() => createState()).toThrow(TraciveConfigurationError);
    expect(() => new InMemoryCacheKeyStore().loadOrCreateDataKey()).toThrow(
      TraciveConfigurationError,
    );
    const cipher = new AesGcmCacheCipher({ dataKey: new Uint8Array(32) });
    expect(() => cipher.seal(new Uint8Array([1]), new Uint8Array([2]))).toThrow(
      TraciveConfigurationError,
    );
  });

  it('throws when getRandomValues is present but not a function', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: 'nope' },
      configurable: true,
      writable: true,
    });
    expect(() => defaultRandom.randomBytes(4)).toThrow(TraciveConfigurationError);
  });
});

describe('with a CSPRNG available', () => {
  it('returns the requested number of bytes', () => {
    const bytes = defaultRandom.randomBytes(32);
    expect(bytes).toHaveLength(32);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it('does not return a constant', () => {
    const a = defaultRandom.randomBytes(32);
    const b = defaultRandom.randomBytes(32);
    expect(Array.from(a).join()).not.toBe(Array.from(b).join());
  });
});

describe('randomUuid', () => {
  it('is a real v4 UUID, version and variant bits included', () => {
    // Not decoration: a server-side log holding keys from four SDKs is far easier to reason about
    // when every one of them is the same documented shape.
    for (let i = 0; i < 50; i++) {
      expect(randomUuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('does not repeat', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(randomUuid());
    expect(seen.size).toBe(500);
  });

  it('draws from the injected source rather than a global', () => {
    // The escape hatch has to reach here too: `random` is how an app on a runtime with no
    // WebCrypto keeps working, and a helper that ignored it would defeat that silently.
    let requested = 0;
    const first = randomUuid({
      randomBytes(length: number): Uint8Array {
        requested = length;
        return new Uint8Array(length).fill(0xab);
      },
    });
    expect(requested).toBe(16);
    // The 7th byte's high nibble becomes 4 and the 9th's becomes a: the version and variant bits
    // are set on the caller's bytes rather than assumed to be already correct.
    expect(first).toBe('abababab-abab-4bab-abab-abababababab');
  });
});

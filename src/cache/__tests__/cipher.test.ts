import { describe, expect, it } from '@jest/globals';

import { utf8Encode } from '../../crypto/utf8';
import { AesGcmCacheCipher, CACHE_NONCE_LENGTH, CACHE_TAG_LENGTH } from '../CacheCipher';
import { CheckCacheError } from '../CheckCacheError';

const dataKey = new Uint8Array(32).fill(7);
const otherKey = new Uint8Array(32).fill(9);
const aad = utf8Encode('tracive.cache.v1|abc');
const otherAad = utf8Encode('tracive.cache.v1|def');
const plaintext = utf8Encode('{"found":true,"riskTier":"HIGH"}');

function cipher(key = dataKey): AesGcmCacheCipher {
  return new AesGcmCacheCipher({ dataKey: key });
}

describe('AesGcmCacheCipher', () => {
  it('round-trips', () => {
    const sealed = cipher().seal(plaintext, aad);
    expect(Array.from(cipher().open(sealed, aad))).toEqual(Array.from(plaintext));
  });

  it('produces an envelope of version || nonce || ciphertext || tag', () => {
    const sealed = cipher().seal(plaintext, aad);
    expect(sealed).toHaveLength(1 + CACHE_NONCE_LENGTH + plaintext.length + CACHE_TAG_LENGTH);
    expect(sealed[0]).toBe(1);
  });

  it('uses a fresh nonce for every seal', () => {
    // Nonce reuse under GCM is catastrophic, so this is the property worth asserting directly.
    const a = cipher().seal(plaintext, aad);
    const b = cipher().seal(plaintext, aad);
    expect(Array.from(a.subarray(1, 13)).join()).not.toBe(Array.from(b.subarray(1, 13)).join());
    expect(Array.from(a).join()).not.toBe(Array.from(b).join());
  });

  it('fails closed when opened under a different AAD', () => {
    // This is the row-swap defence: a record moved to another cache key cannot be opened there.
    const sealed = cipher().seal(plaintext, aad);
    expect(() => cipher().open(sealed, otherAad)).toThrow(CheckCacheError);
  });

  it('fails closed when a tag byte is flipped', () => {
    const sealed = cipher().seal(plaintext, aad);
    const tampered = Uint8Array.from(sealed);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] as number) ^ 0x01;
    expect(() => cipher().open(tampered, aad)).toThrow(CheckCacheError);
  });

  it('fails closed when a ciphertext byte is flipped', () => {
    const sealed = cipher().seal(plaintext, aad);
    const tampered = Uint8Array.from(sealed);
    tampered[15] = (tampered[15] as number) ^ 0xff;
    expect(() => cipher().open(tampered, aad)).toThrow(CheckCacheError);
  });

  it('fails closed under a different data key', () => {
    const sealed = cipher().seal(plaintext, aad);
    expect(() => cipher(otherKey).open(sealed, aad)).toThrow(CheckCacheError);
  });

  it('reports payloadUnreadable rather than crashing on a truncated envelope', () => {
    let thrown: unknown;
    try {
      cipher().open(new Uint8Array([1, 2, 3]), aad);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CheckCacheError);
    expect((thrown as CheckCacheError).kind).toBe('payloadUnreadable');
  });

  it('rejects an envelope with an unknown version byte', () => {
    const sealed = cipher().seal(plaintext, aad);
    const rewritten = Uint8Array.from(sealed);
    rewritten[0] = 99;
    expect(() => cipher().open(rewritten, aad)).toThrow(CheckCacheError);
  });

  it('rejects a data key that is not 32 bytes', () => {
    expect(() => new AesGcmCacheCipher({ dataKey: new Uint8Array(16) })).toThrow(CheckCacheError);
  });
});

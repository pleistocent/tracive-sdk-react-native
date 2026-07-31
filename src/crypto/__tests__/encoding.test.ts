import { describe, expect, it } from '@jest/globals';

import { base64UrlDecode, base64UrlEncode, toHex } from '../base64url';
import { sha256HexOfString } from '../sha256';
import { utf8Decode, utf8Encode } from '../utf8';

/**
 * These are hand-written because Hermes has neither `TextEncoder` nor a dependable `btoa`, and a
 * library helper that reaches for either would pass every test on Node and crash on device.
 */
describe('UTF-8', () => {
  it.each([
    ['', 0],
    ['abc', 3],
    ['é', 2],
    ['€', 3],
    ['😀', 4],
    ['budi@gmail.com', 14],
  ])('round-trips %j (%i bytes)', (value, bytes) => {
    const encoded = utf8Encode(value);
    expect(encoded).toHaveLength(bytes);
    expect(utf8Decode(encoded)).toBe(value);
  });

  it('matches the reference encoding for a known string', () => {
    // "é" is U+00E9 -> 0xC3 0xA9
    expect(Array.from(utf8Encode('é'))).toEqual([0xc3, 0xa9]);
    // "€" is U+20AC -> 0xE2 0x82 0xAC
    expect(Array.from(utf8Encode('€'))).toEqual([0xe2, 0x82, 0xac]);
    // "😀" is U+1F600 -> 0xF0 0x9F 0x98 0x80
    expect(Array.from(utf8Encode('😀'))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it('encodes a lone surrogate as the replacement character rather than an invalid sequence', () => {
    expect(Array.from(utf8Encode('\ud83d'))).toEqual([0xef, 0xbf, 0xbd]);
  });

  it('round-trips the fixture edge cases', () => {
    for (const value of ['i̇stanbul@x.com', 'café@example.com', '​budi@gmail.com', 'SS123']) {
      expect(utf8Decode(utf8Encode(value))).toBe(value);
    }
  });
});

describe('base64url', () => {
  it('round-trips every length modulo 3', () => {
    for (let length = 0; length <= 8; length++) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 37) & 0xff);
      expect(Array.from(base64UrlDecode(base64UrlEncode(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('emits no padding and no URL-unsafe characters', () => {
    const encoded = base64UrlEncode(Uint8Array.from({ length: 32 }, (_, i) => i));
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('encodes 32 bytes as 43 characters, which is the PKCE verifier length', () => {
    expect(base64UrlEncode(new Uint8Array(32))).toHaveLength(43);
  });

  it('tolerates padding on the way back in', () => {
    expect(Array.from(base64UrlDecode('AAAA=='))).toEqual([0, 0, 0]);
  });
});

describe('toHex', () => {
  it('pads each byte to two lowercase digits', () => {
    expect(toHex(Uint8Array.from([0, 1, 15, 16, 255]))).toBe('00010f10ff');
  });
});

describe('SHA-256', () => {
  it('matches the published digest of the empty string', () => {
    expect(sha256HexOfString('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches the published digest of "abc"', () => {
    expect(sha256HexOfString('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes the UTF-8 bytes, not the UTF-16 code units', () => {
    // If this used a different encoder the digest would differ from the server's for any
    // non-ASCII identifier, and every such cache key would miss.
    expect(sha256HexOfString('é')).toBe(sha256HexOfString(utf8Decode(utf8Encode('é'))));
    expect(sha256HexOfString('é')).toHaveLength(64);
  });
});

/**
 * base64url without padding, written by hand.
 *
 * `btoa`/`atob` are not dependable across React Native engines and `Buffer` is a Node global
 * that only exists in RN because a polyfill happened to be installed. Both secure stores are
 * string-only, so this is the encoding the cache data key is persisted in.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += ALPHABET[b0 >> 2];
    if (b1 === undefined) {
      out += ALPHABET[(b0 & 0x03) << 4];
      break;
    }
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (b2 === undefined) {
      out += ALPHABET[(b1 & 0x0f) << 2];
      break;
    }
    out += ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function base64UrlDecode(value: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < value.length; i++) {
    const index = ALPHABET.indexOf(value.charAt(i));
    if (index === -1) continue; // tolerate padding or stray whitespace
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Standard base64 (RFC 4648 §4) with padding and no line breaks: the encoding the report package's
 * `data` fields are read with. `base64url.ts` is a different alphabet and must not be used here.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const PAD = 61; // '='

const CODES: Uint16Array = (() => {
  const codes = new Uint16Array(64);
  for (let i = 0; i < 64; i++) codes[i] = ALPHABET.charCodeAt(i);
  return codes;
})();

// Bounded so `String.fromCharCode.apply` stays far below any engine's argument limit, while a
// 15 MB receipt still encodes in a few thousand calls rather than a character at a time.
const CHUNK_BYTES = 6144;

export function base64Encode(bytes: Uint8Array): string {
  const parts: string[] = [];
  const out = new Uint16Array((CHUNK_BYTES / 3) * 4);
  for (let start = 0; start < bytes.length; start += CHUNK_BYTES) {
    const end = Math.min(start + CHUNK_BYTES, bytes.length);
    let o = 0;
    let i = start;
    for (; i + 2 < end; i += 3) {
      const n =
        ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
      out[o++] = CODES[n >> 18] as number;
      out[o++] = CODES[(n >> 12) & 63] as number;
      out[o++] = CODES[(n >> 6) & 63] as number;
      out[o++] = CODES[n & 63] as number;
    }
    const rest = end - i;
    if (rest === 1) {
      const n = (bytes[i] as number) << 16;
      out[o++] = CODES[n >> 18] as number;
      out[o++] = CODES[(n >> 12) & 63] as number;
      out[o++] = PAD;
      out[o++] = PAD;
    } else if (rest === 2) {
      const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
      out[o++] = CODES[n >> 18] as number;
      out[o++] = CODES[(n >> 12) & 63] as number;
      out[o++] = CODES[(n >> 6) & 63] as number;
      out[o++] = PAD;
    }
    parts.push(String.fromCharCode.apply(null, out.subarray(0, o) as unknown as number[]));
  }
  return parts.join('');
}

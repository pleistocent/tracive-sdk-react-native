/**
 * UTF-8 encode/decode written by hand because Hermes ships no `TextEncoder` or `TextDecoder`.
 *
 * Everything that crosses into the crypto layer goes through here rather than through a library
 * helper, because the popular ones reach for `TextEncoder` internally and would crash on device
 * while passing every test on Node.
 */

export function utf8Encode(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      // A lone surrogate lands here and encodes as U+FFFD rather than an invalid sequence.
      const scalar = code >= 0xd800 && code <= 0xdfff ? 0xfffd : code;
      bytes.push(0xe0 | (scalar >> 12), 0x80 | ((scalar >> 6) & 0x3f), 0x80 | (scalar & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i] as number;
    let code: number;
    if (byte < 0x80) {
      code = byte;
      i += 1;
    } else if (byte < 0xe0) {
      code = ((byte & 0x1f) << 6) | ((bytes[i + 1] ?? 0) & 0x3f);
      i += 2;
    } else if (byte < 0xf0) {
      code =
        ((byte & 0x0f) << 12) | (((bytes[i + 1] ?? 0) & 0x3f) << 6) | ((bytes[i + 2] ?? 0) & 0x3f);
      i += 3;
    } else {
      code =
        ((byte & 0x07) << 18) |
        (((bytes[i + 1] ?? 0) & 0x3f) << 12) |
        (((bytes[i + 2] ?? 0) & 0x3f) << 6) |
        ((bytes[i + 3] ?? 0) & 0x3f);
      i += 4;
    }
    if (code > 0xffff) {
      const adjusted = code - 0x10000;
      out += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

/**
 * The record-key guard, mirrored from the server so that a key which can never be stored is
 * never sent. It runs on the FOLDED key, after folding, because case mapping is not
 * length-preserving (`ß` uppercases to `SS`, adding a byte).
 *
 * The module is named for what it guards — a record key. The rejection reason it feeds keeps the
 * frozen wire spelling `invalid_document_id` for cross-SDK parity.
 */

/** The limit is expressed in UTF-8 bytes, not UTF-16 code units. */
export const MAX_RECORD_KEY_UTF8_BYTES = 1500;

/**
 * JavaScript strings are unvalidated UTF-16 sequences, so unlike the Swift SDK's `String` they
 * can genuinely hold an unpaired surrogate — from a truncated paste, a sliced string or a bad
 * JSON escape. This is one of the two guards that only this SDK can actually reach.
 *
 * Written as an index loop rather than a regex so it does not depend on lookbehind support.
 */
export function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate: the next unit must be a low surrogate.
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++; // consume the valid pair
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true; // low surrogate with no preceding high surrogate
    }
  }
  return false;
}

/**
 * Hand-written because Hermes ships no `TextEncoder`. Using `value.length` instead would accept
 * an over-long key for any non-ASCII input and reject nothing that matters.
 *
 * The lone-surrogate branch keeps this function total rather than throwing; a lone surrogate is
 * rejected by {@link hasLoneSurrogate} before it can reach a real request.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3; // lone surrogate encodes as the replacement character
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Rejects: the empty string; anything containing `/`; exactly `.`; exactly `..`; anything
 * matching `^__.*__$`; more than {@link MAX_RECORD_KEY_UTF8_BYTES} UTF-8 bytes; and anything
 * holding a lone surrogate.
 *
 * Explicitly allowed, and covered by the fixture: spaces, a `.` inside the string, `@`, `+`,
 * `#`, `$`, `[`, `]`, `*`, `~`, emoji, `__x`, `x__` and a bare `_`.
 */
export function isValidRecordKey(key: string): boolean {
  if (key === '') return false;
  if (key.indexOf('/') !== -1) return false;
  if (key === '.' || key === '..') return false;
  // `^__.*__$` — note that `___` is NOT reserved but `____` is.
  //
  // Written as a length-and-affix test rather than as that literal regex, and the two differ on
  // exactly one class of input: `.` does not match `\n` without the `s` flag, so the literal
  // regex would ACCEPT `"__a\nb__"` where this rejects it. Erring toward a local rejection costs
  // an annoyed caller, not a billed miss. Deliberately unresolved until the server's own rule can
  // be read — see docs/OPEN_QUESTIONS.md, item 10.
  if (key.length >= 4 && key.startsWith('__') && key.endsWith('__')) return false;
  if (hasLoneSurrogate(key)) return false;
  if (utf8ByteLength(key) > MAX_RECORD_KEY_UTF8_BYTES) return false;
  return true;
}

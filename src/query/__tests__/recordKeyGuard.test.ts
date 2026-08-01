import { describe, expect, it } from '@jest/globals';

import {
  hasLoneSurrogate,
  isValidRecordKey,
  MAX_RECORD_KEY_UTF8_BYTES,
  utf8ByteLength,
} from '../recordKeyGuard';
import { isTraciveQueryError, TraciveQueryError } from '../TraciveQueryError';

describe('hasLoneSurrogate', () => {
  it('detects a lone high surrogate', () => {
    expect(hasLoneSurrogate('a\ud83d')).toBe(true);
    expect(hasLoneSurrogate('\ud83d')).toBe(true);
    expect(hasLoneSurrogate('\ud83dz')).toBe(true);
  });

  it('detects a lone low surrogate', () => {
    expect(hasLoneSurrogate('\ude00')).toBe(true);
    expect(hasLoneSurrogate('a\ude00b')).toBe(true);
  });

  it('accepts a valid surrogate pair', () => {
    expect(hasLoneSurrogate('😀')).toBe(false);
    expect(hasLoneSurrogate('a😀b')).toBe(false);
    expect(hasLoneSurrogate('😀😀')).toBe(false);
  });

  it('accepts ordinary text', () => {
    expect(hasLoneSurrogate('')).toBe(false);
    expect(hasLoneSurrogate('budi@gmail.com')).toBe(false);
  });
});

describe('utf8ByteLength', () => {
  it.each([
    ['', 0],
    ['a', 1],
    ['abc', 3],
    ['é', 2], // 2-byte: U+00E9
    [' ', 2],
    ['€', 3], // 3-byte: EURO SIGN
    ['あ', 3],
    ['😀', 4], // 4-byte: an astral emoji
    ['aé€😀', 10],
  ])('counts %j as %i bytes', (value, expected) => {
    expect(utf8ByteLength(value)).toBe(expected);
  });

  it('counts a lone surrogate as a 3-byte replacement rather than throwing', () => {
    // The guard rejects a lone surrogate before it reaches a request; this keeps the counter
    // total so it can never be the thing that crashes.
    expect(utf8ByteLength('\ud83d')).toBe(3);
    expect(utf8ByteLength('\ude00')).toBe(3);
  });
});

describe('the 1500-byte limit', () => {
  it('accepts exactly 1500 bytes and rejects 1501', () => {
    const at = 'a'.repeat(MAX_RECORD_KEY_UTF8_BYTES);
    expect(utf8ByteLength(at)).toBe(1500);
    expect(isValidRecordKey(at)).toBe(true);
    expect(isValidRecordKey(`${at}a`)).toBe(false);
  });

  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    // 800 two-byte characters is 1600 bytes but only 800 code units. Using `.length` here would
    // accept an over-long key for any non-ASCII input.
    const key = 'é'.repeat(800);
    expect(key.length).toBe(800);
    expect(utf8ByteLength(key)).toBe(1600);
    expect(isValidRecordKey(key)).toBe(false);
  });
});

describe('the reserved pattern', () => {
  it.each([
    ['__proto__', false],
    ['____', false],
    ['__foo__', false],
    ['___', true],
    ['__x', true],
    ['x__', true],
    ['_', true],
    ['__', true],
  ])('treats %j as valid=%s', (value, expected) => {
    expect(isValidRecordKey(value)).toBe(expected);
  });
});

describe('the reserved pattern does not span a newline', () => {
  it('accepts a key whose middle holds a newline', () => {
    // The server's rule is `^__.*__$`, and `.` does not match a newline without the `s` flag, so
    // the server ACCEPTS this key. Implementing the rule as a starts-with/ends-with test made this
    // SDK stricter than the server and refused a query the API would have answered. Verified
    // against the server by execution and carried by the shared fixture.
    expect(isValidRecordKey('__a\nb__')).toBe(true);
  });

  it('accepts the other line terminators the pattern does not cross', () => {
    // A consequence of mirroring the pattern literally rather than an independently verified
    // server behaviour: `.` excludes CR and the two Unicode line separators as well as LF. Only
    // the LF case above is fixture-backed.
    // Written with explicit escapes: the two Unicode line separators are invisible in an editor
    // and would otherwise be indistinguishable from the plain space in the case below.
    expect(isValidRecordKey('__a\rb__')).toBe(true);
    expect(isValidRecordKey('__a\u2028b__')).toBe(true);
    expect(isValidRecordKey('__a\u2029b__')).toBe(true);
  });

  it('still rejects a single-line reserved key that happens to contain other whitespace', () => {
    expect(isValidRecordKey('__a b__')).toBe(false);
    expect(isValidRecordKey('__a\tb__')).toBe(false);
  });

  it('anchors at the ends of the whole key, not at a line', () => {
    // A newline must not let a caller smuggle a reserved key past the guard on its own line, nor
    // make a harmless key look reserved.
    expect(isValidRecordKey('x\n__foo__')).toBe(true);
    expect(isValidRecordKey('__foo__\nx')).toBe(true);
    // A trailing newline does not end the key: JavaScript's `$` has no trailing-newline exception.
    expect(isValidRecordKey('__foo__\n')).toBe(true);
  });
});

describe('the remaining guard rules', () => {
  it('rejects the empty string, a slash, and the dot keys', () => {
    expect(isValidRecordKey('')).toBe(false);
    expect(isValidRecordKey('a/b')).toBe(false);
    expect(isValidRecordKey('/')).toBe(false);
    expect(isValidRecordKey('.')).toBe(false);
    expect(isValidRecordKey('..')).toBe(false);
  });

  it('rejects a key holding a lone surrogate', () => {
    expect(isValidRecordKey('EMAIL_a\ud83d')).toBe(false);
  });

  it('allows a dot that is not the whole key', () => {
    expect(isValidRecordKey('...')).toBe(true);
    expect(isValidRecordKey('a.b')).toBe(true);
  });
});

describe('TraciveQueryError', () => {
  it('recognises its own family and nothing else', () => {
    const error = new TraciveQueryError('not_e164');
    expect(isTraciveQueryError(error)).toBe(true);
    expect(isTraciveQueryError(new Error('nope'))).toBe(false);
    expect(error.name).toBe('TraciveQueryError');
    expect(error.message).toBe('not_e164');
    expect(error.reason).toBe('not_e164');
  });
});

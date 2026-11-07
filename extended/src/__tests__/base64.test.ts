import { expect, it } from '@jest/globals';

import { base64Encode } from '../base64';

it.each([
  [[], ''],
  [[102], 'Zg=='],
  [[102, 111], 'Zm8='],
  [[102, 111, 111], 'Zm9v'],
  [[255, 254, 253, 0], '//79AA=='],
])('encodes %j', (bytes, expected) => {
  expect(base64Encode(new Uint8Array(bytes))).toBe(expected);
});

it('agrees with Node across a chunk boundary', () => {
  const bytes = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 31) & 255);
  expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString('base64'));
});

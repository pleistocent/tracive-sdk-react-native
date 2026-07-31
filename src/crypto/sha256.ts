import { sha256 } from '@noble/hashes/sha2.js';

import { toHex } from './base64url';
import { utf8Encode } from './utf8';

/**
 * `@noble/hashes` is pure JavaScript with zero transitive dependencies, so a reviewing bank has
 * no Podfile entry, no Gradle module and no prebuilt binary to vet.
 *
 * The string overload encodes through our own UTF-8 encoder rather than noble's, because noble's
 * `utf8ToBytes` reaches for `TextEncoder`, which Hermes does not have.
 */
export function sha256Bytes(input: Uint8Array): Uint8Array {
  return sha256(input);
}

export function sha256HexOfString(value: string): string {
  return toHex(sha256(utf8Encode(value)));
}

export function sha256OfString(value: string): Uint8Array {
  return sha256(utf8Encode(value));
}

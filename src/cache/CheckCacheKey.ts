import { sha256HexOfString } from '../crypto/sha256';
import type { TraciveQuery } from '../query/TraciveQuery';

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * The SHA-256 of a folded lookup key, as 64 lowercase hex characters.
 *
 * The raw identifier is never persisted and never logged, which is why this type exists at all.
 * The digest is not information-theoretically secret — the E.164 input space is small enough to
 * brute-force — which is why the row PAYLOAD is additionally encrypted rather than relying on
 * the key being opaque.
 */
export class CheckCacheKey {
  readonly hex: string;

  private constructor(hex: string) {
    this.hex = hex;
  }

  static fromQuery(query: TraciveQuery): CheckCacheKey {
    return new CheckCacheKey(sha256HexOfString(query.searchQueryIndex));
  }

  static fromSearchQueryIndex(searchQueryIndex: string): CheckCacheKey {
    return new CheckCacheKey(sha256HexOfString(searchQueryIndex));
  }

  /** `undefined` unless the input is exactly 64 lowercase hex characters. */
  static fromHex(hex: string): CheckCacheKey | undefined {
    return HEX_64.test(hex) ? new CheckCacheKey(hex) : undefined;
  }

  toString(): 'CheckCacheKey(<redacted>)' {
    return 'CheckCacheKey(<redacted>)';
  }

  toJSON(): 'CheckCacheKey(<redacted>)' {
    return 'CheckCacheKey(<redacted>)';
  }
}

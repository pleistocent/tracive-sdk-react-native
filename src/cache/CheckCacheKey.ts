import { sha256HexOfString } from '../crypto/sha256';
import type { TraciveQuery } from '../query/TraciveQuery';
import { CheckCacheError } from './CheckCacheError';

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * The SHA-256 of a folded lookup key, as 64 lowercase hex characters.
 *
 * The raw identifier is never persisted and never logged, which is why this type exists at all.
 * The digest is not information-theoretically secret — the E.164 input space is small enough to
 * brute-force — which is why the row PAYLOAD is additionally encrypted rather than relying on
 * the key being opaque.
 */
/**
 * What separates a transaction record's row key from a cache entry's.
 *
 * A cache key is 64 lowercase hex characters and `:` is not one of them, so the two key spaces
 * cannot collide. That is what lets both kinds of row live in one table without a `kind` column —
 * and such a column would sort a stolen database into "answers held" and "transfers made" before
 * anyone had to decrypt a byte.
 */
export const TRANSACTION_KEY_PREFIX = 'txn:';

/**
 * The digest a transaction record is filed under: `SHA-256(trimmed transaction id)`, lowercase hex,
 * WITHOUT the prefix. `transactionRowKey` adds the prefix; the bare digest is what the record's AAD
 * binds.
 *
 * The id is hashed for the same reason an identifier is. A transaction reference is the host's own
 * string rather than a person's phone number, but stored in cleartext beside an encrypted verdict it
 * says which transfers a device holds a fraud answer for.
 *
 * The id is trimmed and otherwise used verbatim, so `TRF-1` and `trf-1` are two records: a reference
 * format this SDK has never seen is not one it can fold safely.
 *
 * @throws CheckCacheError `invalidTransactionId` when the id is blank.
 */
export function transactionKeyHex(transactionId: string): string {
  const trimmed = transactionId.trim();
  if (trimmed.length === 0) {
    throw new CheckCacheError(
      'invalidTransactionId',
      'A transaction record needs a non-blank transaction id.',
    );
  }
  return sha256HexOfString(trimmed);
}

/** `transactionKeyHex` with the prefix: what goes in the store's key column. */
export function transactionRowKey(transactionId: string): string {
  return TRANSACTION_KEY_PREFIX + transactionKeyHex(transactionId);
}

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

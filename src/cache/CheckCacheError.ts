export type CheckCacheErrorKind =
  | 'storageFailure'
  | 'cannotOpenStore'
  | 'dataKeyUnavailable'
  | 'dataKeyCorrupt'
  | 'encryptionFailed'
  | 'payloadUnreadable'
  /**
   * A transaction record was addressed with a blank id. Caller error rather than a storage fault,
   * and reported rather than ignored: a blank id would file every unlabelled transfer under one
   * shared row, so the next read would hand a transaction someone else's verdict.
   */
  | 'invalidTransactionId';

/**
 * Local storage faults, deliberately a separate family from `TraciveError` because the remedy is
 * different: nothing here is worth showing an end user, and none of it should abort a check that
 * could still be answered over the network.
 *
 * Note what is NOT in the kind list: there is no `notFound`. A cache miss is `undefined` from
 * `read`, not an error — treating "we have not seen this before" as a failure would make every
 * cold cache look broken.
 */
export class CheckCacheError extends Error {
  override readonly name = 'CheckCacheError' as const;
  readonly kind: CheckCacheErrorKind;
  /** ES2020 `Error` has no `cause`, so this is a declaration rather than an override. */
  readonly cause?: unknown;

  constructor(kind: CheckCacheErrorKind, message?: string, cause?: unknown) {
    super(message ?? kind);
    Object.setPrototypeOf(this, CheckCacheError.prototype);
    this.kind = kind;
    this.cause = cause;
  }
}

export function isCheckCacheError(value: unknown): value is CheckCacheError {
  return value instanceof CheckCacheError;
}

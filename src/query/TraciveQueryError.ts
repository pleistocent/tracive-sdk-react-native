/**
 * `invalid_document_id` is a **frozen wire value**. It is spelled exactly this way in the shared
 * grammar fixture that the Tracive SDKs for Kotlin, Flutter and Swift also vendor, and changing
 * it in one SDK would break the anti-drift contract between them. Prose everywhere else in this
 * repository says "record key".
 */
export type QueryRejectionReason =
  | 'not_e164'
  | 'country_not_alpha3'
  | 'empty_account_id'
  | 'empty_bank_code'
  | 'empty_value'
  | 'empty_handle'
  | 'empty_chain'
  | 'invalid_document_id';

/**
 * Thrown by every {@link TraciveQuery} factory. Rejecting locally is a commercial guard, not
 * pedantry: a key the server can never match still costs a credit, so a doomed lookup is worth
 * refusing before it is sent.
 */
export class TraciveQueryError extends Error {
  override readonly name = 'TraciveQueryError' as const;
  readonly reason: QueryRejectionReason;

  constructor(reason: QueryRejectionReason) {
    super(reason);
    Object.setPrototypeOf(this, TraciveQueryError.prototype);
    this.reason = reason;
  }
}

export function isTraciveQueryError(value: unknown): value is TraciveQueryError {
  return value instanceof TraciveQueryError;
}

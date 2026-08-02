/**
 * `invalid_document_id` is a **frozen wire value**. It is spelled exactly this way in the shared
 * grammar fixture that the Tracive SDKs for Kotlin, Flutter and Swift also vendor, and changing
 * it in one SDK would break the anti-drift contract between them. Prose everywhere else in this
 * repository says "record key".
 */
export type QueryRejectionReason =
  | 'not_e164'
  | 'empty_country'
  | 'unknown_country'
  | 'empty_phone_number'
  | 'country_conflict'
  | 'not_an_email'
  | 'country_not_alpha3'
  | 'empty_account_id'
  | 'empty_bank_code'
  /** An empty e-mail, and only that. Every other empty field names itself. */
  | 'empty_value'
  | 'empty_handle'
  | 'empty_platform'
  | 'empty_chain'
  | 'empty_address'
  | 'invalid_document_id';

/**
 * Thrown by every {@link TraciveQuery} factory when the INPUT is unusable. Rejecting locally is a
 * commercial guard, not pedantry: a key the server can never match still costs a credit, so a
 * doomed lookup is worth refusing before it is sent.
 *
 * The factories throw one other family, for a different reason. If the JavaScript engine itself
 * cannot fold correctly — no real Unicode backend, so `normalize` is an identity function or the
 * case mappings are ASCII-only — the input is fine and the ENGINE is not, and that surfaces as a
 * `TraciveConfigurationError` with code `nfc_unavailable` or `case_mapping_unavailable`. Catch
 * both if you catch either: the first is a bad identifier, the second is an unsupported build.
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

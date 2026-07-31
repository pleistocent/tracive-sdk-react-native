/**
 * A host-app or runtime misconfiguration: a developer error, not a user state.
 *
 * These are deliberately a separate family from {@link TraciveError}. Nothing here is worth
 * showing an end user and none of it is retryable — the remedy is always an edit to the host
 * app's configuration or its dependency list.
 *
 * Known codes:
 * - `nfc_unavailable` — the JavaScript engine does not implement Unicode NFC normalization.
 * - `csprng_unavailable` — the runtime provides no cryptographically secure random source.
 * - `missing_query_declaration` — the Android `<queries>` block is absent.
 * - `missing_ios_query_scheme` — `LSApplicationQueriesSchemes` does not list the app scheme.
 * - `redirect_uri_not_claimed` — no intent-filter / associated domain claims the redirect host.
 */
export class TraciveConfigurationError extends Error {
  override readonly name = 'TraciveConfigurationError' as const;
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    Object.setPrototypeOf(this, TraciveConfigurationError.prototype);
    this.code = code;
  }
}

export function isTraciveConfigurationError(value: unknown): value is TraciveConfigurationError {
  return value instanceof TraciveConfigurationError;
}

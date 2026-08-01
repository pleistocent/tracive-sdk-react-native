/**
 * The OAuth scopes this SDK can use, as the authorization server spells them.
 *
 * Retyping a scope by hand is a mistake nothing local can catch. The scope set is validated by
 * the authorization server, which rejects the whole consent request rather than granting a
 * narrower one, so a single wrong character does not degrade an integration — it stops it from
 * authorizing at all. That is only discoverable against a live server, and there is not one yet.
 *
 * The same three strings appear in the Kotlin, Swift and Flutter SDKs. `src/model/__tests__`
 * pins them as literals rather than through these constants, so renaming a constant fails the
 * build instead of quietly redefining the shared contract.
 */
export const TraciveScopes = Object.freeze({
  /** Run a scammer check. */
  scammerCheck: 'scammer.check',
  /** Read the remaining subscription credits. */
  creditsRead: 'credits.read',
  /** Read the minimal user profile. */
  profileRead: 'profile.read',
} as const);

/**
 * The scope strings above as a union, for a caller who would rather write the literal than the
 * constant: `const scopes: TraciveScope[] = ['scammer.check']` is checked at compile time, and a
 * typo is a type error rather than a consent request the server will refuse.
 *
 * `OAuthConfiguration.scopes` deliberately does NOT require this type. A partner may hold a scope
 * this SDK does not model — the server's scope set is larger than the three calls made here — and
 * narrowing the field would lock them out of asking for it until this package shipped a release.
 * The union is offered; it is not imposed.
 */
export type TraciveScope = (typeof TraciveScopes)[keyof typeof TraciveScopes];

# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Audit follow-up. Nothing here is a published change yet — 0.1.0 has not shipped — so this section
records what a reader of the 0.1.0 notes above would otherwise be misled by.

### Added

- **`TraciveScopes`, the OAuth scope names as constants**, plus the `TraciveScope` union of the
  same three strings — `scammer.check`, `credits.read` and `profile.read`. Integrators were
  retyping the literals, and a mistyped scope is not a narrower grant: the authorization server
  refuses the whole consent request, so the failure is an integration that cannot authorize at all,
  visible only against a live server. The constants match the Kotlin, Swift and Flutter SDKs, and
  the suite pins the wire strings as literals rather than through the constants, so a rename fails
  the build instead of redefining the shared contract. There is deliberately no constant for the
  usage-reporting scope: this SDK does not model that endpoint. `OAuthConfiguration.scopes` still
  accepts any string, because the server's scope set is larger than the three calls made here.

### Fixed

- **`detail: 'full'` used the cache, and was wrong in both directions.** It now neither reads it nor
  writes it. Two independent defects, one rule.

  _The read._ The cache stores only the fields that do not vary with `detail`, so `topChronologies`
  and `comments` are dropped on the way in — but the read path never consulted `detail`. A `full`
  request on the default `CACHE_FIRST` source was answered from that stripped row, with both fields
  `undefined` and no network call. `undefined` there is byte-identical to "the server answered in
  full and there are no incidents on file", so a partner screen could tell someone about to send
  money that an identifier with a dozen reports against it has no narrative on file. That is a wrong
  fraud answer rather than a caching subtlety: it is silent, it is on the default source, and the
  content it drops is exactly the narrative a person reads before deciding.

  _The write._ The stored projection keeps `tags` and `disclaimer`, and the row key carries no
  locale — while a `full` request is the only kind that sends one. Storing its projection filed
  localised text under a locale-less key, and the next `minimal` check, which sends no locale, read
  it straight back as if it were the default. `disclaimer` is the one string this SDK asks every
  integrator to display, so the result was a legal notice rendered in a language the user never
  asked for. Gating only the read would not have helped: the row is spoiled on the way in, by the
  `full` call, and collected later by a `minimal` call that is reading the cache quite legitimately.

  A single `cacheApplies` flag, `detail === 'minimal'`, is decided once per check and gates all four
  places the cache is touched, so the read side and the write side of the rule cannot drift apart.
  `CACHE_FIRST` skips the read, `CACHE` throws `cacheMiss` without reading anything, `SERVER_FIRST`
  surfaces the network error instead of degrading to a row, and none of them stores the response.
  The alternative — keying rows by `(query, detail, locale)` — was deliberately not taken: it is a
  larger contract change for no gain, because a full-detail row could only ever be served to a caller
  who wanted the very content it is not allowed to keep, and the Kotlin, Swift and Flutter SDKs all
  carry this same gate. The predicate is `=== 'minimal'` rather than `!== 'full'` so a third detail
  level, if one is ever added, does not silently start being cached.

  `minimal` routing is untouched and nothing in the public surface changed. Three behaviours to plan
  for: a `full` request is never served free from the cache; it no longer warms the cache, so `full`
  then `minimal` on one identifier costs two credits rather than one; and a `full` request with no
  network now fails rather than returning a partial answer that looks complete.

- **`TraciveQuery.email` rejects a value with no `@`, so a doomed lookup is no longer billed.** It
  previously rejected only an empty value, so `email('budi')` built `EMAIL_budi` and sent it. The
  server applies no shape validation to an e-mail — that is a legal record key, so it is looked up,
  missed, and charged for. Client-side rejection is the only thing that prevents the charge, exactly
  as `phone()` already does with its E.164 test. The new reason is `not_an_email`. The check is an
  `@`-presence test and deliberately not an address grammar: over-validating would refuse addresses
  the server would have matched, which is the worse failure of the two.

- **The record-key guard no longer refuses a key containing a newline.** The reserved-key rule is
  `^__.*__$`, and `.` does not match a line terminator without the `s` flag, so the server accepts
  `"__a\nb__"`. The guard implemented that rule as "at least four characters, starts with `__`,
  ends with `__`", which is stricter than the server: it refused a query the API would have
  answered. Nothing was billed by this, but a refused lookup is an answer a caller never gets. The
  guard now mirrors the pattern literally. This was carried as an open question — which side was
  wrong could not be settled without reading the server's rule — and is now settled by execution
  and pinned by the shared fixture at v5.

- **The SDK now opens the install link itself.** `authorize()` used to report `appNotInstalled` and
  open nothing, leaving the partner app to call `installUrlForDisplay()` and open the page. The
  Kotlin, Swift and Flutter SDKs all open the link and return the same result, so this was a
  contract difference rather than a style one: a partner porting an integration across SDKs got
  silently different behaviour, and on React Native a user without the Tracive app was simply never
  sent anywhere. The result is still `appNotInstalled` whatever the OS does with the link — matching
  the siblings, and honest, because the app really is missing either way — but a refused launch now
  emits an `install_link_launch_failed` diagnostic rather than passing in silence. The launch goes
  through the existing `AuthorizeLauncher` seam, so a host that substituted its own launcher owns
  this launch too. `installUrlForDisplay()` is unchanged and still supported, for a partner who
  would rather render the link than have the user jump straight out.

- **The install link now points at the page that exists.** The default was
  `https://tracive.chottu.link/app`, a guessed path: every partner's first un-onboarded user would
  have followed a link that silently 404s at the one moment the SDK has nothing else to offer them.
  It is `https://tracive.chottu.link/install`, matching the sibling SDKs. Its attribution also
  matches them now — `ref=<your client id>` and `utm_source=tracive-sdk-react-native`, replacing the
  previous `utm_source=<clientId>` / `utm_medium` pair — and a test pins the whole URL rather than
  its host, so drift from the shared contract fails the build.

- **The redaction layer is now actually applied.** `redactedProxyConfiguration`, `redactedRequest`
  and `redactedResponse` existed and were tested, and nothing in production called any of them.
  `JSON.stringify(client)` printed a partner's proxy authorization header verbatim, and the raw
  `HttpRequest` — bearer token included — was handed to the injectable transport. The 0.1.0 note
  about redacting `toJSON`/`toString` was true of the helpers and false of the shipping paths.
- **An aborted check no longer spends a credit.** `AbortSignal` reached `fetch` and neither the
  retry loop nor the backoff sleep, so an aborted call still sent its next attempt. A long
  `Retry-After` also held the caller with no way out; `TraciveClock.sleep` is now cancellable, and
  serves waits longer than a 32-bit millisecond count in slices instead of firing immediately.
- **A failing secure store no longer loses an authorization.** A rejecting pending-store read
  produced an unhandled rejection and dropped the result permanently; `handleCallback` and
  `authorize` are now total, and a throwing `onAuthResult` listener no longer stops delivery to
  the others.
- **Concurrent identical checks are billed once**, and a malformed 2xx body surfaces as a
  `TraciveError` rather than a raw `SyntaxError`.
- **A bare 401 now triggers a token refresh**, which matters behind a partner gateway.
- The Unicode guard covers the case mappings as well as NFC; the Expo plugin merges the Android
  `<queries>` block instead of overwriting it and no longer rewrites a `launchMode` the host chose;
  a redirect URI carrying userinfo or a port is rejected rather than folded into the host; the
  injected CSPRNG port reaches the cache cipher; `base64UrlDecode` rejects foreign characters
  instead of silently dropping them; body sizes are counted in bytes.

### Changed

- **A blank `installUrl` is refused instead of being quietly defaulted.** The constructor now
  throws `TraciveConfigurationError` with code `blank_install_url`. Nothing silently substituted the
  built-in install link before either, but a blank value survived as far as the URL builder, which
  turned it into `?ref=…&utm_source=…` — neither the default nor the partner's value, and a
  schemeless string no OS will open. Its only symptom appeared for a user without the Tracive app,
  after a real `authorize()`, through an optional diagnostic: silent on the one path where the SDK
  has nothing else to offer. This is a deliberate divergence from the Kotlin SDK, which treats blank
  as absent; it matches the Flutter SDK, on the grounds that substituting a default for a partner's
  explicit value is the worse failure. Only blank is refused — a non-blank URL is still used exactly
  as given.

- **An empty crypto address and an empty username platform now name the field that was empty**:
  `empty_address` and `empty_platform`, replacing the shared `empty_value` both used to throw. Two
  different caller mistakes were indistinguishable, so neither could be turned into a message that
  said which field to fix. `empty_value` survives and now means exactly one thing — an empty
  e-mail. The two new tokens are part of the shared cross-SDK contract, and the suite asserts them
  as literal strings so a rename fails the build.

- The public `TraciveClient.mode` is a redacted copy in proxy mode. The credentials still reach
  the wire; only what a serialiser can see has changed.
- `TraciveClock.sleep` takes an optional `AbortSignal`. Widening, not breaking: an implementation
  that ignores it still satisfies the interface.
- The shared grammar fixture moves to v3: NFC applies to bank codes too, and a vector pins it.
  34 vectors now.
- `npm run hygiene` reads a tracked term list and proves every rule can still fire before it
  scans. It could not fail in CI before. `npm run verify` and CI also run a runtime-dependency
  audit.

## [0.1.0]

First implementation. Not published to npm yet, and the Tracive API is not live yet.

### Added

- `TraciveQuery` with factories for the five identifier types the Tracive API indexes — phone,
  e-mail, bank account, IBAN, crypto address and social handle — each folding its input into the
  exact key the server indexes and rejecting anything that could not match.
- `TraciveClient` with the four `Source` routing modes, per-tier caching, retry that refuses to run
  without an idempotency key, and single-flight token refresh on a 401.
- `TraciveOAuth`: OAuth 2.0 with PKCE (S256 only), app-to-app authorization through the Tracive app,
  a pending record persisted before the browser hop so the flow survives process death, and
  cold-start link handling with duplicate suppression and a one-slot result buffer.
- A cache that is a billing feature: `InMemoryCheckCache` by default, `PersistentCheckCache` over
  any four-method `CheckCacheStore`, and per-record AES-256-GCM with the cache key bound into the
  additional authenticated data.
- Optional adapter subpaths for Expo (`expo-secure-store`, `expo-sqlite`, `expo-crypto`) and for
  bare React Native (`react-native-keychain`, `@op-engineering/op-sqlite`).
- `npx tracive-doctor`, a build-time checker for the host-app configuration that the SDK cannot
  supply and cannot verify at runtime, and an Expo config plugin that writes the same configuration
  during prebuild.
- Redacting `toJSON` and `toString` on every credential-bearing value, because JavaScript leaks
  through serialisation unless you opt out.
- The shared cross-SDK grammar fixture, pinned by sha256 and driving its vectors, rejections and
  record-key guard cases as executable tests.

### Notes

- ESM only. There is no CommonJS build.
- No native code, no autolinking, no podspec.
- There is no API key in this surface, in either mode.

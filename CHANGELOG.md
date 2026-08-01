# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Audit follow-up. Nothing here is a published change yet — 0.1.0 has not shipped — so this section
records what a reader of the 0.1.0 notes above would otherwise be misled by.

### Fixed

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

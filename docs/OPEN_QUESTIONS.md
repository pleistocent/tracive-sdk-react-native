# Open questions and carried risks

Named, not resolved. Roughly ordered by expected cost. Anything on this list is something a reader
would otherwise have to discover for themselves. Entries that have since been settled move to
[Resolved](#resolved) at the foot of this page rather than disappearing.

---

## 1. There is no on-device conformance run

**The Jest suite proves nothing about the device engine.** Jest runs on Node with full ICU, so the
grammar vectors pass there regardless of how Hermes behaves. The plan this implementation was built
to also called for an example app that runs the same fixture in-app on an Android emulator in CI,
and that is the only check in the whole design that can fail for the reason the fixture exists.

**It was not built.** This run had no Android SDK, no emulator and no way to verify such a job
actually runs, and shipping a CI workflow that had never executed would be worse than saying so.
Consequences that remain unverified on a real device:

- Hermes' `String.prototype.normalize` composing correctly on Android (it routes through a JNI call
  to the platform normalizer, which is spec-correct by documentation, not by execution here);
- the locale-invariant case mappings `ß -> SS` and `İ -> i` + U+0307 on Android's `libcore`;
- that the 25-code-point trim set and the ASCII-only `\D` class behave identically on Hermes.

The `nfc_unavailable` and `case_mapping_unavailable` guards convert the first two of these from a
silent wrong answer into a loud throw, but a guard is not a measurement. The trim set and the `\D`
class remain unguarded, and deliberately so: neither can be probed without hard-coding the very
table this SDK exists not to hand-write. **Building the on-device job is the highest-value next
piece of work in this repository.**

## 2. The example app was not built either

No `example/` directory exists, so:

- the declared React Native floor of `>=0.76.0` is **reasoned, not built**. If a 0.76 build turns
  out to fail, lower the declared floor rather than shipping an untested claim;
- `npx tracive-doctor` has never been run against a real generated project. Its checks are unit
  tested against realistic manifest, plist and entitlements fixtures on disk, including the
  merged-manifest preference, but not against output from a real `expo prebuild`;
- the Expo config plugin has **never been executed end to end**. It is written against the real
  `@expo/config-plugins` types and typechecks. Its `<queries>` merge is now unit tested directly
  against manifest fragments, including one seeded with another plugin's entries, but nothing here
  has run a real `expo prebuild`.

## 3. The adapter subpaths are unexercised, and typed against hand-written declarations

`src/expo/**` and `src/bare/**` statically import optional peer dependencies that this repository
deliberately does not install — `@op-engineering/op-sqlite` alone unpacks to roughly 360 MB, and the
Expo packages drag in the whole Expo module infrastructure. Two consequences:

- their APIs are typechecked against **minimal ambient declarations** in `src/types/optional-peers.d.ts`,
  not against the real packages. If an upstream signature differs, this repository will not notice;
- they are excluded from coverage collection, because a coverage number for code that cannot be
  loaded would be a fiction. They are unexercised code. That is what this entry is for.

Before 1.0, build them against a real dependency matrix and tighten the peer floors — those floors
were taken from each package's _latest_ version, not from the oldest version whose API the adapter
actually compiles against.

## 4. Deviations from the frozen plan, and why

Three, all forced rather than chosen:

- **`PendingAuthorizationStore` is new public surface.** The plan mandates persisting the pending
  PKCE record to secure storage before the authorize URL is opened, but its listed
  `TraciveOAuthOptions` had no seam through which a store could be supplied. An optional
  `pendingStore` option plus an in-memory default was the smallest addition that lets the mandated
  behaviour actually happen. Nothing was renamed or removed.
- **`CheckCacheStore.count()` is an optional fifth method.** `CheckCache.count()` cannot be derived
  from the four required methods. It is optional so that "writing a store is a short afternoon"
  stays true; both shipped adapters implement it, and `PersistentCheckCache.count()` reports a
  storage failure when a store does not.
- **The grammar fixture stays at `test/fixtures/`**, where this repository already had it, rather
  than moving to `__tests__/fixtures/`. It is byte-identical and pinned by sha256 either way, and
  the instruction not to touch the file outranked the layout preference.

Two smaller ones: the `typescript` build target does not take an `esm` option in
`react-native-builder-bob` 0.43 (the module target does, and does carry explicit `.js` extensions),
and `tsconfig.build.json` needs an explicit `rootDir` and `types: ["node"]` under TypeScript 6 — the
latter scoped to the build because `src/doctor/**` is a Node program that ships in `lib`. ESLint
bans the Node and DOM globals across the rest of `src/` so that having the types available cannot
turn into a `TextEncoder` shipped to a device.

## 5. Three packaging warnings are accepted, not fixed

`publint --strict` is clean. `attw` reports three problem classes that are consequences of decisions
rather than defects, and `npm run check:packaging` ignores exactly those three by name so that any
_other_ packaging problem still fails:

- `cjs-resolves-to-esm` — this package is ESM-only by design. A dual build would buy a CommonJS
  entry point almost nobody would use, and would buy the dual-package hazard for free — which bites
  precisely here, because this SDK holds real state (a token store, a single-flight refresh latch,
  one cache connection).
- `no-resolution` — the `node10` resolution mode predates the `exports` field. The engines floor is
  Node 20.19.
- `untyped-resolution` — `app.plugin.js` is a build-time Expo entry point that prebuild tooling
  `require`s. It is never type-imported, and the plain-string `exports` entry is load-bearing for
  prebuild.

## 6. The in-app-browser rejection rests on untested doctrine

The claim that a Universal Link to another app does not fire from an in-app browser, and that an
Android Custom Tab pinned to a browser package will not leave the tab for a verified App Link, is
house doctrine asserted by all three sibling SDKs' documentation. It was **not** re-tested here.

The cheap disconfirming test is a throwaway app that opens a known App Link three ways and observes
which one leaves the browser. Run it before treating the rationale in `docs/oauth.md` as measured
fact.

## 7. On-device crypto performance is unmeasured

No speed claim appears in the README, and none should until it is measured on a real low-end
Android device. Desktop figures for a ~450-byte payload are single-digit-to-low-tens of
microseconds per seal, open and hash; Hermes on cheap hardware will be materially slower. The
`CacheCipher` port is the escape hatch if the numbers come back badly.

## 8. The iOS keychain accessibility class diverges from a sibling SDK's documentation

This SDK uses `AfterFirstUnlockThisDeviceOnly` for both the grant and the cache data key, matching
the Swift and Flutter SDKs 2:1 against the Kotlin caching document's `WhenUnlockedThisDeviceOnly`.
If the Kotlin document is the intended contract rather than drift, reconciling it is a four-repository
change, not a one-repository change.

## 9. Wire field names for the check payload are the agreed shape, not an observed one

The Tracive API is not live. Request and response field names follow the fixture's own
`searchQueryIndex` spelling, and the endpoint paths sit in one file (`src/client/TraciveApi.ts`) so
that reconciling them against the real service is a one-file diff. No test in this repository
contacts a real host, and none should.

## 10. Expo Go caps adoption

Authorization cannot complete in Expo Go, and no packaging choice changes that. If a large share of
target integrators are Expo-Go-only, that is a product question rather than an engineering one.

## 11. `react-native-keychain` is quiet upstream

It had not published for roughly sixteen months at the time of writing and carries a large open
issue count. This is precisely why `TokenStore` is a port: if it stalls, the replacement is a
hundred-line adapter, not the SDK. Prefer `expo-secure-store` as the documented default and
re-evaluate the bare adapter before 1.0.

## 12. Whether the bare SQL driver supports the old React Native architecture is unconfirmed

Its documentation does not discuss it. Assume New-Architecture-only, and do not publish a
compatibility table claiming otherwise.

## 13. iOS cold-start Universal Link delivery has historically been unreliable

Community reports, not verified here. The one-slot result buffer and the persisted pending record
mitigate the _consequences_, not the delivery itself. That is why "the link was not delivered to
JavaScript on cold start" is the third named cause in the stale-pending diagnostic — the one case
neither build-time tier can see explains itself on the second attempt instead of never.

## 14. A transitive advisory in the Expo config-plugin toolchain

`npm audit` reports three moderate advisories, all one chain:
`@expo/config-plugins -> xcode -> uuid` (a missing buffer bounds check in `uuid` v3/v5/v6 when a
buffer is supplied). There is no fix available upstream at the time of writing.

Scope, stated precisely: `@expo/config-plugins` is a **development dependency here and an optional
peer for integrators**. It runs during `expo prebuild` on a developer's or a CI machine, and it is
not part of this package's runtime. The two dependencies that do ship — `@noble/hashes` and
`@noble/ciphers` — have zero transitive dependencies between them and the rest of npm.

Re-check when Expo releases a `config-plugins` that has moved off the affected `xcode` release.

CI runs `npm audit --omit=dev --audit-level=high` (`npm run audit:runtime`), so a NEW high or
critical advisory in something that actually ships fails the build rather than waiting for
somebody to notice this page has gone stale. The scope is deliberate: gating on the full dev tree
would fail every build on the chain above, which trains everyone to ignore the step. The dev-tree
advisories stay a documented judgement, and this paragraph is where that judgement is recorded.

---

## Resolved

Kept here so a reader who remembers an entry finds its outcome rather than a gap in the numbering.

- **The record-key guard and a key containing a newline** (was item 10). The reserved-key rule is
  `^__.*__$`, and `.` does not match a line terminator without the `s` flag, so the server ACCEPTS
  `"__a\nb__"`. Settled by executing the server's own normalizer, not by reasoning: the guard was
  implemented as "at least four characters, starts with `__`, ends with `__`", which is stricter
  than the server and falsely rejected that key — a lookup the API would have answered. The guard
  now mirrors the pattern literally, and the shared fixture carries the case at v5.

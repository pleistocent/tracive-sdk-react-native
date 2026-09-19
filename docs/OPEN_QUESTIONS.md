# Open questions and carried risks

Named, not resolved. Roughly ordered by expected cost. Anything on this list is something a reader
would otherwise have to discover for themselves. Entries that have since been settled move to
[Resolved](#resolved) at the foot of this page rather than disappearing.

---

## 1. The conformance run is manual; nothing runs it for you

`example/` now folds both shared fixtures on the device engine, and that is the check this
repository was missing — see [Resolved](#resolved) for what it measured. What is still missing is
automation: the panel is on a screen somebody has to open, on an emulator somebody has to boot. A
regression in the fold would be caught by whoever next launches the example, and by nothing else.

The remaining work is the Android emulator job the plan called for: boot the app in CI and assert
the panel's counts. It is not written here because no workflow in this repository has ever run —
`.github/` is manual-dispatch only — and shipping an emulator job that had never executed would
repeat the mistake this page exists to record.

## 2. The declared React Native floor is reasoned, not built

`peerDependencies` declares `react-native >=0.76.0`. The example is built on Expo SDK 55 and React
Native 0.83.10, so what is measured is that the SDK works **there**. The floor itself is untested.
If a 0.76 build turns out to fail, lower the declared floor rather than shipping an untested claim.

The optional peer floors carry the same gap and for the same reason: `expo-secure-store >=13`,
`expo-sqlite >=14`, `expo-crypto >=15` and `@expo/config-plugins >=54` were taken from each
package's _latest_ version at the time of writing, and the example exercises the 55.x line of every
one of them. The oldest version whose API the adapters actually compile against is still unknown.

The example is on 55 rather than the current 57 for a toolchain reason worth recording here, since
it will look like an oversight otherwise: Expo 56 and 57 declare `weak let` in their own Swift
sources, which the installed Xcode 26.1.1 (Swift 6.2.1) rejects in every language mode it accepts.
Nothing in this repository is involved, and Xcode 26.2 should lift it.

## 3. The `bare` adapter subpath is unexercised, and typed against hand-written declarations

`src/bare/**` statically imports `@op-engineering/op-sqlite` and `react-native-keychain`, neither of
which this repository installs — op-sqlite alone unpacks to roughly 360 MB. Two consequences:

- its API is typechecked against **minimal ambient declarations** in `src/types/optional-peers.d.ts`,
  not against the real packages. If an upstream signature differs, this repository will not notice;
- it is excluded from coverage collection, because a coverage number for code that cannot be loaded
  would be a fiction.

`src/expo/**` was in exactly this position and no longer is (see [Resolved](#resolved)); `example/`
installs the Expo peers and none of the bare ones. Closing this one means a second example, or a
second flavour of the existing one, wired to the bare adapters. Do it before 1.0, and tighten the
peer floors while the real dependency matrix is in front of you.

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

The Tracive API is live in both environments, but this repository has not yet reconciled its wire
shape against real responses. Request and response field names follow the fixture's own
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

- **The on-device conformance run** (was item 1, in part). `example/` executes both vendored
  fixtures through the public surface on the device's own engine: 34 grammar vectors, 12 of the 14
  grammar rejections, 20 phone vectors, 19 phone rejections, the 25-code-point trim set plus the one
  code point that must survive it, the two length-changing case mappings, an NFC composition, and
  `\D` being ASCII-only. 115 cases, all passing on Hermes on an Android emulator (API 24) and on an
  iPhone 16 Pro simulator (iOS 18.6). That covers the two behaviours the SDK deliberately leaves
  unguarded — the trim set and the ASCII digit class — which no probe inside the SDK could ever
  check without hand-writing the very table it exists not to hand-write. The two `RAW` rejections
  and the nine `documentIdGuard` cases stay Jest-only: they drive the internal record-key guard,
  which the public surface does not expose, and the panel reports them as skipped rather than
  dropping them silently.
  Item 1 above is what remains: the run is manual.

- **`npx tracive-doctor` against a real generated project, and the Expo config plugin end to end**
  (was item 2, in part). `npx expo prebuild` ran the plugin for the first time. It wrote the
  `LSApplicationQueriesSchemes` entries, the `applinks:` entitlement and the `autoVerify`
  intent-filter, and its `<queries>` merge kept the `https` intent Expo's own template had already
  put there rather than replacing it — the case the merge was written for, exercised against a real
  prebuild instead of a fragment. `tracive-doctor` then ran against the generated project and
  reported nothing, both with an explicit `--redirect-uri` and reading
  `expo.extra.tracive.redirectUri` from `app.json`. It was also shown to fail: deleting the
  intent-filter makes it exit 1 naming the host, which is the difference between a passing check
  and a check that cannot fail.

- **The Expo adapter subpath, against the real packages** (was item 3, in part). `src/expo/**` is no
  longer typed only against `src/types/optional-peers.d.ts`: the example resolves the real
  `expo-secure-store`, `expo-sqlite` and `expo-crypto`, and a cache hit after `am force-stop` — a
  new process, zero calls to the injected transport, the previous process's `fetchedAt` — exercises
  the SQLite rows, the keychain round-trip of the AES-GCM data key and the decrypt path together. A
  simulated 401 exercises the refresh and the replay through the same secure store.

- **The record-key guard and a key containing a newline** (was item 10). The reserved-key rule is
  `^__.*__$`, and `.` does not match a line terminator without the `s` flag, so the server ACCEPTS
  `"__a\nb__"`. Settled by executing the server's own normalizer, not by reasoning: the guard was
  implemented as "at least four characters, starts with `__`, ends with `__`", which is stricter
  than the server and falsely rejected that key — a lookup the API would have answered. The guard
  now mirrors the pattern literally, and the shared fixture carries the case at v5.

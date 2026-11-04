# `@pleistocent/tracive-sdk-react-native` example

A runnable app for the SDK in the directory above it, on Android and iOS.

It exists to be **executed**, not read: the SDK's Jest suite runs on Node with full ICU, and this is
the only place the same code runs on Hermes, on a real device, against a real keychain and a real
SQLite file. The last panel on screen is that measurement.

```sh
npm install
npm run android      # or: npm run ios — the demo flavor
```

Both scripts rebuild the SDK first (`npm --prefix .. run build`), so the app always runs the
working tree rather than a published version. `@pleistocent/tracive-sdk-react-native` is a `file:..`
dependency; nothing here is fetched from npm.

## What you should see

1. **A folded lookup key, live.** `0857-1860-9079` with `IDN` selected becomes `+6285718609079` and
   then `PHONE_+6285718609079`. Type something that cannot produce a key and it says so before any
   button is pressed — a malformed identifier costs nothing, while a lookup that misses is billed.
2. **A verdict**, with the risk tier, the counts, and the `disclaimer` in its own box. The contract
   asks every integrator to surface that text, so this UI surfaces it.
3. **A cache hit.** Press Check twice with the same number. The second answer is marked
   `CACHE · free`, carries no check id, and — the part that matters — the backend call counter does
   not move. Those rows are real `expo-sqlite` rows, encrypted with a key from the real keychain /
   Android Keystore, so a hit proves the whole persistence path and not just a re-render.
4. **Engine conformance.** Both vendored anti-drift fixtures, executed on this device: the shared
   grammar vectors, the phone-normalization vectors, and — the reason this panel is worth having —
   the two behaviours the SDK deliberately does not guard, `String.prototype.trim`'s exact
   25-code-point set and `\D` being ASCII-only. Neither can be probed without hard-coding the very
   table the SDK exists not to hand-write, so running the fixture is the only thing that catches
   them.

## Three flavors

| Flavor           | Android                      | iOS                      | Talks to                            | Installs as                            |
| ---------------- | ---------------------------- | ------------------------ | ----------------------------------- | -------------------------------------- |
| `demo` (default) | `npm run android`            | `npm run ios`            | nothing — `DemoBackend`, in-process | `id.tracive.sdk.example.rn`, "RN Demo" |
| `sandbox`        | `npm run android:sandbox`    | `npm run ios:sandbox`    | `https://api-sandbox.tracive.id/v1` | `….rn.sandbox`, "RN Sandbox"           |
| `production`     | `npm run android:production` | `npm run ios:production` | `https://api.tracive.id/v1`         | `….rn.production`, "Tracive RN"        |

An Android product flavor and an iOS scheme (`Debug-<flavor>` / `Release-<flavor>`) each. The JS
side reads the flavor from the installed application id (`src/flavor.ts`), so it is always the
native build that is running and can never disagree with it.

`sandbox` and `production` are the real integration: `fetch` against that environment, the same
encrypted cache and secure store, and **Authorize**, which runs the OAuth round trip through the
Tracive app and back through `client.startLinkListener()`. Put the client id Tracive issued you for
each environment in `src/flavor.ts` and register that flavor's redirect on it — they are separate
registrations, and a sandbox client id is unknown to production.

Each flavor installs as its own app. The SDK's token store and cache are not keyed by environment,
so one app rebuilt for another environment would send the old grant there and serve the old
verdicts as its answers. The demo keeps the original application id because that is where earlier
installs keep their planted grant and fake verdicts.

The live redirects (`tracive-rn-sandbox://oauth/callback`, `tracive-rn://oauth/callback`) are
private-use schemes only because this example controls no domain. They are declared by hand — in
`android/app/src/<flavor>/AndroidManifest.xml` and `ios/Flavors/<flavor>.xcconfig` — because the
Expo config plugin writes https App Links only. A real integration uses an https App Link it owns,
through the plugin; see [`../SECURITY.md`](../SECURITY.md).

Debug builds trust user-installed CAs (`android/app/src/main/res/xml/network_security_config.xml`,
referenced from the debug manifests only), so an HTTPS proxy such as Proxyman can read and mock
either environment's traffic once its CA is installed on the device.Debug builds trust user-installed CAs (`android/app/src/main/res/xml/network_security_config.xml`,
referenced from the debug manifests only), so an HTTPS proxy such as Proxyman can read and mock
either environment's traffic once its CA is installed on the device.

With the device's HTTP proxy pointed at Proxyman, the debug build's connection to Metro
(`10.0.2.2:8081`) goes through the proxy too and fails to load the bundle. Load it over
`adb reverse tcp:8081 tcp:8081` from `localhost:8081` instead — the dev menu's "Change Bundle
Location" — so it never reaches the proxy.

## No network in the demo, on purpose

`src/demoBackend.ts` is an in-process `HttpTransport` injected as the client's `transport`. That is
what lets the app run on a first clone with no credentials, nothing to reach and no account to
bill, and it is what makes it deterministic in CI, where depending on an environment being up is
how a suite starts failing for reasons unrelated to the code. The Kotlin, Swift and Flutter samples
all do the same thing for the same reasons.

`HttpTransport` is a one-method interface precisely so that fake is short enough to read. It is the
fake you would write for your own screen tests.

The live flavors are that same client with `environment` in place of `transport`, and a real grant
from `client.authorize()` in place of the seeded one — `openSession` in `App.tsx` is the whole
difference. The `TODO(partner)` comments mark every value you must supply:

```sh
grep -rn "TODO(partner)" example
```

## Host configuration

`app.json` uses the SDK's own Expo config plugin:

```json
[
  "@pleistocent/tracive-sdk-react-native/app.plugin.js",
  { "redirectUri": "https://example.tracive.id/oauth/callback" }
]
```

`android/` and `ios/` are **checked in**, and are that plugin's output plus the flavors. Running
`npx expo prebuild` again regenerates them and will overwrite the launcher artwork, the
`android:roundIcon` attribute, the signing-config comment and every flavor — product flavors and
their manifests, the iOS configurations, schemes and `Flavors/` xcconfigs, and the Podfile mapping
— so `git diff` afterwards and put them back.

`npm run doctor` runs `tracive-doctor` against the generated project. It reports nothing, and it can
fail: delete the `autoVerify` intent-filter from the manifest and it exits 1 naming the host.

## Requirements

- **Node.** Built and verified on **v26.0.0**. React Native declares
  `^20.19.4 || ^22.13.0 || ^24.3.0 || >= 25.0.0` and the SDK's own floor is Node 20.19, so anything
  from 20.19.4 up should work — but v26 is the version this was actually run on.
- Expo SDK 55, React Native 0.83.10, React 19.2.0.
- **Xcode 26.1.1 (Swift 6.2.1) is why the SDK is pinned to 55, and it is worth knowing before you
  upgrade.** Expo SDK 56 and 57 ship an `expo-modules-core` (and, in 57, an `expo-modules-jsi`)
  whose Swift sources declare `weak let`. Swift 6.2.1 rejects that in every language mode it
  accepts — `'weak' must be a mutable variable, because it may change at runtime` — so the iOS
  build fails inside Expo's own sources with nothing to fix in this repository. SDK 55 has no
  `weak let` anywhere in its native tree. On Xcode 26.2 or newer, moving the example forward should
  be a version bump and a `pod install`.
- Android: an emulator or device on API 24+. iOS: a simulator on 15.1+.
- The example uses `expo-secure-store`, `expo-sqlite` and `expo-crypto` — the three optional peer
  dependencies behind `@pleistocent/tracive-sdk-react-native/expo`. It does **not** use
  `@op-engineering/op-sqlite` or `react-native-keychain`, so the `/bare` subpath is not exercised
  here.

## What this does not cover

- **The declared React Native floor.** The SDK declares `react-native >=0.76.0`; this app is built
  on 0.86.3, so the floor itself is still reasoned rather than built.
- **The authorization round trip, in the demo.** Consent happens in the Tracive app on the same
  device, so the demo plants a grant in the secure store rather than driving `authorize()`. The
  stores, the refresh path and the 401 replay are real — press "Expire the grant, then check". The
  sandbox and production flavors drive `authorize()` and the redirect for real.
- **`@pleistocent/tracive-sdk-react-native/bare`.** See above.

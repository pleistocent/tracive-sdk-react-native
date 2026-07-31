# Integration

Everything on this page names **your** app's domain, package or bundle identifier, which a library
cannot know. That is why the SDK ships no native code and asks the host to declare it — and why it
ships `tracive-doctor` to check that you did.

Run this first, and after any change to your native project:

```sh
npx tracive-doctor --redirect-uri https://your.app/oauth/callback
```

It prefers the **merged** Android manifest when one exists, because an aggressive
`tools:node="remove"` or a manifest-stripping build step can drop a block that is present in your
source. What ships is what matters.

---

## Expo, with prebuild

Add the config plugin and you are done — it writes every item below.

```json
{
  "expo": {
    "plugins": [
      [
        "@tracive/sdk-react-native/app.plugin.js",
        { "redirectUri": "https://your.app/oauth/callback" }
      ]
    ]
  }
}
```

You still need the two content files that must be served from your own domain (assetlinks and
apple-app-site-association, below); no plugin can write those for you.

Setting `expo.extra.tracive.redirectUri` in `app.json` additionally lets `npx tracive-doctor` find
the redirect URI without a flag.

---

## Android, by hand

As a **direct child of `<manifest>`** in `android/app/src/main/AndroidManifest.xml`:

```xml
<queries>
    <package android:name="com.pleistocent.tracive" />
    <intent>
        <action android:name="android.intent.action.VIEW" />
        <data android:scheme="tracive" />
    </intent>
    <intent>
        <action android:name="android.intent.action.VIEW" />
        <data android:scheme="https" />
    </intent>
</queries>
```

Both forms are needed. Without them, on API 30 and above `Linking.canOpenURL` **rejects its promise**
rather than returning `false`; the SDK catches that, reports "not installed" (failing closed), and
emits an `app_presence_probe_failed` diagnostic naming this block — but every user who does have the
Tracive app still gets sent to an install page.

Inside your main `<activity>`, which must also carry `android:launchMode="singleTask"`:

```xml
<intent-filter android:autoVerify="true">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="https" android:host="your.app" android:pathPrefix="/oauth/callback" />
</intent-filter>
```

And serve `https://your.app/.well-known/assetlinks.json` naming your package and signing-certificate
fingerprint. Without it the App Link is **not verified**: Android shows a disambiguation dialog and
any other installed app may claim your redirect.

---

## iOS, by hand

In `ios/<App>/Info.plist`:

```xml
<key>LSApplicationQueriesSchemes</key>
<array>
    <string>tracive</string>
</array>
```

Enable the **Associated Domains** capability with `applinks:your.app`, and serve
`https://your.app/.well-known/apple-app-site-association` naming your team and bundle identifier.

A missing `LSApplicationQueriesSchemes` entry is the single most likely integration mistake, and the
most expensive one, because it has no symptom: it does not crash, does not log and does not degrade.
It simply routes 100% of already-onboarded users to an install page, so the integration converts at
zero and the dashboard looks like nobody wanted the feature. This is exactly what `tracive-doctor`
exists to catch.

---

## Both platforms: route the redirect into the SDK

Once, at app start:

```ts
const stop = client.startLinkListener();
```

That subscribes to warm `url` events **and** drains the cold-start URL, in that order and with
duplicate delivery suppressed. If you would rather own the plumbing, call
`client.handleCallback(url)` yourself for every incoming link.

> **Troubleshooting, and nobody should lose a day to this:** `Linking.getInitialURL()` returns
> `null` while Remote JS Debugging is active. If cold-start authorization "does not work" only on
> your machine, turn the debugger off before investigating anything else.

---

## Verification, in three tiers

The pivot of the whole design is where each failure mode lands:

**Presence unknown fails closed.** If the SDK cannot prove the Tracive app is installed, it reports
not installed and sends the user to the install page. Being wrong that way is a recoverable
annoyance; opening an authorization URL nothing claims is a dead end.

**Configuration missing fails loud.** It never degrades quietly.

| Tier | When            | What                                                                                                  |
| ---- | --------------- | ----------------------------------------------------------------------------------------------------- |
| 1    | Build time      | `npx tracive-doctor` reads your manifests and exits 1 on a hard finding, printing the block to paste. |
| 2    | `expo prebuild` | The config plugin writes everything in this document automatically.                                   |
| 3    | Runtime         | A diagnostic. Nothing is ever silent.                                                                 |

Tier 3 covers the one case the first two cannot see. When an authorization is launched and no result
ever comes back, the SDK emits `pending_authorization_stale` naming the three real causes rather
than a generic "attempt expired":

1. the associated-domain or asset-links file is not served, or names the wrong fingerprint, so the
   link was never verified;
2. the redirect host does not match any intent-filter or associated domain the app declares;
3. the link reached the OS but never reached JavaScript on cold start.

Diagnostics `console.warn` in a development build and always reach your `onDiagnostic` callback in
release, so they land in your own logging rather than nowhere.

---

## Runtime requirements

### A CSPRNG

React Native ships no WebCrypto. Install one satisfier — `expo-standard-web-crypto` or `expo-crypto`
on Expo, `react-native-get-random-values` on bare React Native (imported at the very top of your
entry file). Without it, anything needing randomness throws
`TraciveConfigurationError('csprng_unavailable')` with a message naming both options. It will not
fall back to `Math.random()`.

### A JavaScript engine with real Unicode normalization

Every React Native release builds Hermes with a platform Unicode backend, so this is satisfied by
default on both platforms, and an app that opts back into JSC is unaffected. `react-native-windows`
and `react-native-macos` build Hermes against ICU and are fine too.

The unsupported configuration is a Hermes built with its Unicode-lite backend, where `normalize` is
an empty function that returns its input unchanged with no error. The SDK probes for this once and
throws `TraciveConfigurationError('nfc_unavailable')` rather than folding every key wrongly and
billing you for the misses. Do not attempt to detect that build any other way.

### Expo Go

Authorization cannot complete in Expo Go — see the first section of the README. Everything else
works, so Expo Go remains fine for prototyping the query builders, the models and the cache.

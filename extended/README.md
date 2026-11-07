# @pleistocent/tracive-sdk-extended-react-native

Lets a user report a scammer from inside your app, on Tracive's native form or your own React Native
UI, and check that report's status. Evidence is compressed on the device and goes straight to Tracive.
It never passes through your servers.

Apache-2.0. It sits on the [base SDK](https://www.npmjs.com/package/@pleistocent/tracive-sdk-react-native),
which keeps doing OAuth.

## Read this first

1. **A development build, never Expo Go.** The package is native code: Android and iOS screens over a
   Kotlin core that compresses evidence. Expo Go does not contain it, and a JavaScript-only update
   cannot deliver it. After installing or upgrading, rebuild.
2. **The user needs a Tracive account and a grant with `report.create`.** Add
   `TraciveReportScopes.create` and `.read` to the scopes your client requests. Without a grant,
   calls answer `needsConsent`: run `authorize()` and call again. Consent happens in the Tracive app,
   so a user leaves your app once, on the first report only.
3. **Keep the `reportId`.** There is no way to list reports, and a status answers for 30 days.
4. **The chronology is the user's own words.** Prefill anything else, never that. On your own UI,
   show a link to each of `requirements.terms` next to the Send button.

## Install

```sh
npm install @pleistocent/tracive-sdk-extended-react-native @pleistocent/tracive-sdk-react-native
```

**Expo.** Add the plugin, then `npx expo prebuild` or `npx expo run:android`:

```json
{ "expo": { "plugins": ["@pleistocent/tracive-sdk-extended-react-native/app.plugin.js"] } }
```

It lists Tracive's schemes in `LSApplicationQueriesSchemes`, turns on core library desugaring, and
raises `compileSdk` and Kotlin to the floors below when your React Native sits under them. It never
lowers one. Set `{ "mavenLocal": true }` only to build against SDKs in your Maven Local.

**Bare React Native, Android.** The Tracive libraries are built with Kotlin 2.3 and ask for
`compileSdk` 36, so your app needs:

- React Native 0.80 or newer. Older versions ship an Android Gradle Plugin under the 8.9.1 that the
  AndroidX libraries here require, and Gradle must be 8.11.1 or newer.
- `compileSdk` 36 or newer.
- Kotlin 2.2 or newer, because a compiler reads metadata one minor version ahead. React Native 0.80
  to 0.86 ship 2.1.20: set `kotlinVersion` and a versioned `kotlin-gradle-plugin` classpath in your
  root `build.gradle`.
- Core library desugaring, because dates in the SDK read `java.time`, which API 24 and 25 lack:

  ```groovy
  android { compileOptions { coreLibraryDesugaringEnabled true } }
  dependencies { coreLibraryDesugaring "com.android.tools:desugar_jdk_libs:2.1.5" }
  ```

**Bare React Native, iOS.** iOS 15 or newer. `pod install` fetches `TraciveReportCore.xcframework`
from the release of this version in the Swift SDK's GitHub repository and refuses it if its SHA-256
differs from the one this package pins. To use one you built, set `TRACIVE_EXTENDED_XCFRAMEWORK` to
its path.

## Use it

```ts
import { TraciveReports } from '@pleistocent/tracive-sdk-extended-react-native';

// The client's grant, and its single-flight refresh.
const reports = new TraciveReports({ client: traciveClient });

// Or, when your backend keeps the tokens. `stale` is the token the server refused, null at first.
const reports = new TraciveReports({
  environment: TraciveEnvironment.production,
  accessToken: async (stale) => (stale ? refreshOnMyBackend(stale) : myToken()),
});
```

Keep refresh in one place. A refresh token rotates and a reused one revokes the grant, so refresh
only when `stale` asks. The native core never refreshes: it asks your callback, and answers
`needsConsent` when the callback fails with a dead grant. Throw a `TraciveReportException` with
`NEEDS_CONSENT` from your own callback for the same result.

Call `reports.dispose()` when you are done with it.

### Tracive's screens

```ts
const outcome = await TraciveReportForm.present(reports, {
  prefill: ReportPrefill.forQuery(query, {
    incidentDate: '2026-11-04',
    title: 'Fake seller',
    attachments: [{ uri: receiptUri, mimeType: 'image/png' }],
  }),
  theme: { primaryColor: '#00695C', cornerRadius: 16 },
});

if (outcome.type === 'submitted') save(outcome.reportId);
if (outcome.type === 'needsConsent') await client.authorize();

await TraciveReportStatus.present(reports, { reportId });
```

Closing the form cancels an upload in progress. The user must always be able to read the terms line,
so the theme does not reach it.

### Your own UI

```ts
const requirements = await reports.requirements();
const evidence = await reports.prepare({ uri: receiptUri, mimeType: 'image/png' });
const draft = ReportDraft.forQuery(query, {
  title,
  chronology,
  incidentDate: '2026-11-04',
  evidence: [evidence],
  acceptedTerms: requirements.terms,
});

const problems = draft.problems(requirements.limits); // show these before sending
const result = await reports.submit(draft, { onProgress: setFraction });

switch (result.type) {
  case 'submitted': // save(result.reportId)
  case 'needsConsent': // authorize, then submit the same draft
  case 'failed': // result.error.code, then submit the same draft
}

const status = await reports.status(reportId);
if (status === 'NEED_REVISION') await reports.openInTracive(reportId);
```

- **Keep the same draft across retries.** Its `idempotencyKey` is what stops a retry from filing twice.
  Finished uploads are skipped, and a draft already filed answers the same result.
- **`prepare` takes a file URI first.** A `file://` path, or `content://` on Android, is read natively,
  so a large image never crosses the bridge. `{ bytes, mimeType }` and `{ base64, mimeType }` work too.
- **Evidence stays on the native side** behind a handle. It is released when the report is filed, on
  `evidence.release()`, and on `reports.dispose()`.
- **Cancel with an `AbortSignal`**: `reports.submit(draft, { signal })`. It stops the native job, and
  the draft can be sent again. `requirements`, `prepare` and `status` take one too.

### Errors

Calls reject with a `TraciveReportException`, and `submit` answers `{ type: 'failed', error }`. Its
`code` is one of `REPORT_ERROR_CODES`. `DAILY_LIMIT_REACHED` carries `retryAfterSeconds`, the time to
the reset at 00:00 UTC. Messages never carry user data.

## Develop

The base SDK is the root of this repository, linked rather than installed, so build it first:

```sh
npm ci --prefix .. --ignore-scripts
npm run build --prefix ..
npm install --ignore-scripts
npm run setup:local
npm run verify
```

While the base version in `peerDependencies` is not on npm yet, `npm install` here needs
`--legacy-peer-deps`.

`npm run sync:swift` copies the Swift sources into the pod, and `npm run sync:check` fails when they
differ. Both read a checkout of `tracive-sdk-swift` beside this repository, or the `Sources` folder
that `TRACIVE_SWIFT_SOURCES` names. `example/` runs all of it on a device: see its README.

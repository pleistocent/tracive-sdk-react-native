# @pleistocent/tracive-sdk-extended-react-native example

Tracive's form, your own UI and the status screen, in Tracive's sandbox. A development build, never
Expo Go.

```sh
npm ci --prefix ../.. --ignore-scripts
npm install --prefix .. --ignore-scripts
npm run setup:local --prefix ..
npm install --ignore-scripts
npm run android   # or: npm run ios
```

Both SDKs are linked from this repository, so `npm run android` builds them first. After an install
in either folder, `npm run setup:local` there puts the link to the base SDK back. While the base
version is not on npm yet, the install in `..` needs `--legacy-peer-deps`.

To work on the native code itself:

- **iOS core:** build it with `./gradlew :tracive-sdk-extended:assembleTraciveReportCoreReleaseXCFramework`
  in a checkout of `tracive-sdk-kotlin`, and set `TRACIVE_EXTENDED_XCFRAMEWORK` to its path before
  `pod install`.
- **Android libraries:** in the same checkout, run
  `./gradlew :tracive-sdk-extended:publishToMavenLocal :tracive-sdk-extended-ui:publishToMavenLocal`,
  and pass `{ mavenLocal: true }` to the plugin in `app.config.js`.

`android/` and `ios/` are generated from `app.config.js` and git-ignored. After changing that file or
native code, run the script again, with `npx expo prebuild --clean` first when a config plugin changed.

A generated release build skips R8 by default. Turn it on to see what your own release will do:

```sh
cd android
./gradlew assembleRelease -Pandroid.enableMinifyInReleaseBuilds=true \
  -Pandroid.enableShrinkResourcesInReleaseBuilds=true
```

## Try it with no account

`ExtendedExample/demo-server.py` in a checkout of `tracive-sdk-swift` stands in for the Tracive API on
port 18787, with no grant and no Tracive app. Point the example at it with a git-ignored
`tracive.local.json` here:

```json
{
  "baseUrl": "http://127.0.0.1:18787/v1",
  "token": "local-token",
  "redirectScheme": "tracive-extended-rn-local",
  "appScheme": "tracive"
}
```

```sh
python3 ../../../tracive-sdk-swift/ExtendedExample/demo-server.py
adb reverse tcp:18787 tcp:18787   # Android only
```

Every call still crosses the bridge into the native core. The stand-in checks nothing: it exists so the
screens and the bridge can be seen working.

## Another host

`tracive.local.json` is the only place that points this example anywhere but the sandbox:

| Key              | Meaning                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `baseUrl`        | The API, with `/v1`. The app installs beside the sandbox one, as the token store is not keyed by environment. |
| `clientId`       | Your OAuth client.                                                                                            |
| `redirectScheme` | The scheme of your redirect, which must be registered on that client.                                         |
| `appScheme`      | The scheme of the Tracive build `openInTracive` opens.                                                        |
| `token`          | A made-up token. Set it to skip OAuth altogether.                                                             |

Run `npx expo prebuild --clean` after changing it.

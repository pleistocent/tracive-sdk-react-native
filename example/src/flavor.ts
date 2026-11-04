import * as Application from 'expo-application';
import { TraciveEnvironment } from '@pleistocent/tracive-sdk-react-native';

/**
 * How this build of the example runs — an Android product flavor and an iOS scheme each:
 * `npm run android:sandbox`, `npm run ios:production`, and so on.
 *
 * `demo` answers every call in-process from `DemoBackend`, so a first clone runs with no
 * credentials and nothing to bill. `sandbox` and `production` are the real integration against
 * that environment.
 *
 * Each flavor installs as its own app. The SDK's token store and cache are not keyed by
 * environment, so a grant and cached verdicts left in an app later rebuilt for another environment
 * would be sent to it and served as its answers. The demo keeps the original application id
 * because that is where earlier installs keep their planted grant and fake verdicts; a production
 * build installed over it would inherit both.
 */
export interface Flavor {
  readonly name: 'demo' | 'sandbox' | 'production';
  /** `undefined` for the demo. */
  readonly environment?: TraciveEnvironment;
  readonly clientId: string;
  readonly redirectUri: string;
}

// Keyed by the installed application id rather than by a JS-side setting, so the flavor is always
// the native build that is running: the redirect it registers and the storage it owns cannot
// disagree with the configuration here.
//
// The live redirects are private-use schemes only because this example controls no domain, and
// they are declared in the flavor's own native config — android/app/src/<flavor>/AndroidManifest.xml
// and ios/Flavors/<flavor>.xcconfig — not by the Expo config plugin, which writes https App Links
// only. Re-running `expo prebuild` does not know about them.
const FLAVORS: Readonly<Record<string, Flavor>> = {
  'id.tracive.sdk.example.rn': {
    name: 'demo',
    clientId: 'demo-client',
    redirectUri: 'https://example.tracive.id/oauth/callback',
  },
  'id.tracive.sdk.example.rn.sandbox': {
    name: 'sandbox',
    environment: TraciveEnvironment.sandbox,
    // TODO(partner): the client id Tracive issued you in sandbox, with the redirect below
    // registered on it. Sandbox and production are separate registrations: a sandbox client id is
    // unknown to production.
    clientId: 'REPLACE_WITH_YOUR_SANDBOX_CLIENT_ID',
    // TODO(partner): an https App Link / Universal Link on a host you own — SECURITY.md says why.
    redirectUri: 'tracive-rn-sandbox://oauth/callback',
  },
  'id.tracive.sdk.example.rn.production': {
    name: 'production',
    environment: TraciveEnvironment.production,
    // TODO(partner): the client id Tracive issued you in production.
    clientId: 'REPLACE_WITH_YOUR_PRODUCTION_CLIENT_ID',
    // TODO(partner): your own redirect, as for sandbox.
    redirectUri: 'tracive-rn://oauth/callback',
  },
};

export function currentFlavor(): Flavor {
  const id = Application.applicationId;
  const flavor = id === null ? undefined : FLAVORS[id];
  if (flavor === undefined) {
    throw new Error(
      `No example flavor for application id "${String(id)}". Expected one of ` +
        `${Object.keys(FLAVORS).join(', ')}.`,
    );
  }
  return flavor;
}

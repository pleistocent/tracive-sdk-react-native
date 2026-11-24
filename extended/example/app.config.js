// Tracive's sandbox, unless the git-ignored tracive.local.json says otherwise. README.md lists its
// keys.
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const overridesPath = join(__dirname, 'tracive.local.json');
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};

const scheme = overrides.redirectScheme ?? 'tracive-extended-rn-sandbox';
// The token store is not keyed by environment, so a build pointed elsewhere installs beside the
// sandbox one.
const applicationId = `id.tracive.sdk.extended.example.rn${overrides.baseUrl ? '.local' : ''}`;

module.exports = {
  expo: {
    name: overrides.baseUrl ? 'Reports RN Local' : 'Reports RN',
    slug: 'tracive-extended-rn-example',
    version: '0.3.0',
    orientation: 'default',
    icon: './assets/icon.png',
    userInterfaceStyle: 'light',
    newArchEnabled: true,
    scheme,
    ios: { bundleIdentifier: applicationId, supportsTablet: true },
    android: { package: applicationId },
    plugins: [
      // Writes the Tracive app's package visibility. The redirect itself is `scheme` above.
      [
        '@pleistocent/tracive-sdk-react-native/app.plugin.js',
        { redirectUri: 'https://example.tracive.id/oauth/callback' },
      ],
      '@pleistocent/tracive-sdk-extended-react-native/app.plugin.js',
    ],
    extra: {
      tracive: {
        // TODO(partner): the client id Tracive issued you in sandbox, with this redirect on it.
        clientId: overrides.clientId ?? 'REPLACE_WITH_YOUR_SANDBOX_CLIENT_ID',
        // TODO(partner): an App Link or Universal Link you own.
        redirectUri: `${scheme}://oauth/callback`,
        baseUrl: overrides.baseUrl,
        appScheme: overrides.appScheme,
        token: overrides.token,
      },
    },
  },
};

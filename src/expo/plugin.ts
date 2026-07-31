import {
  AndroidConfig,
  withAndroidManifest,
  withEntitlementsPlist,
  withInfoPlist,
  type ConfigPlugin,
} from '@expo/config-plugins';

import { TRACIVE_APP_SCHEME } from '../oauth/authorizeUrl';

const TRACIVE_ANDROID_PACKAGE = 'com.pleistocent.tracive';

export interface TracivePluginProps {
  /**
   * The App Link / Universal Link the partner app owns and the authorization server redirects
   * to, e.g. `https://your.app/oauth/callback`.
   */
  redirectUri: string;
}

interface RedirectParts {
  host: string;
  pathPrefix: string;
}

/** Parsed by hand: this runs under Node during prebuild, but the shape is trivial and explicit. */
export function parseRedirectUri(redirectUri: string): RedirectParts {
  const match = /^https:\/\/([^/?#]+)([^?#]*)/.exec(redirectUri);
  if (match === null) {
    throw new Error(
      `The Tracive redirect URI must be an https URL the app owns; received "${redirectUri}". ` +
        'RFC 8252 forbids completing this flow in an in-app WebView, and a custom scheme is ' +
        'rejected by the authorization server.',
    );
  }
  const path = match[2] ?? '';
  return { host: match[1] ?? '', pathPrefix: path === '' ? '/' : path };
}

/**
 * Tier 2 of the three-tier verification story: for an Expo prebuild app, everything the host
 * would otherwise paste by hand is written automatically. Tier 1 is `npx tracive-doctor`, which
 * checks the result statically; tier 3 is the runtime diagnostic for the one case neither can
 * see.
 */
const withTracive: ConfigPlugin<TracivePluginProps> = (config, props) => {
  const { host, pathPrefix } = parseRedirectUri(props.redirectUri);

  // iOS: the app-presence probe cannot answer truthfully without this, and a missing entry does
  // not crash, does not log and does not degrade — it silently routes every already-onboarded
  // user to an install page.
  config = withInfoPlist(config, (modConfig) => {
    const schemes =
      (modConfig.modResults.LSApplicationQueriesSchemes as string[] | undefined) ?? [];
    if (!schemes.includes(TRACIVE_APP_SCHEME)) schemes.push(TRACIVE_APP_SCHEME);
    modConfig.modResults.LSApplicationQueriesSchemes = schemes;
    return modConfig;
  });

  config = withEntitlementsPlist(config, (modConfig) => {
    const domains =
      (modConfig.modResults['com.apple.developer.associated-domains'] as string[] | undefined) ??
      [];
    const entry = `applinks:${host}`;
    if (!domains.includes(entry)) domains.push(entry);
    modConfig.modResults['com.apple.developer.associated-domains'] = domains;
    return modConfig;
  });

  config = withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest as unknown as {
      queries?: unknown[];
      application?: unknown[];
    };

    // Both forms are needed: the <package> entry for the presence probe by package id, and the
    // scheme <intent> so canOpenURL does not reject on API 30+.
    manifest.queries = [
      {
        package: [{ $: { 'android:name': TRACIVE_ANDROID_PACKAGE } }],
        intent: [
          {
            action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
            data: [{ $: { 'android:scheme': TRACIVE_APP_SCHEME } }],
          },
          {
            action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
            data: [{ $: { 'android:scheme': 'https' } }],
          },
        ],
      },
    ];

    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(modConfig.modResults);
    // A stacked second activity instance would otherwise start a fresh task and never see the
    // redirect. The persisted pending record makes that survivable; singleTask avoids it.
    activity.$['android:launchMode'] = 'singleTask';

    const filters = (activity['intent-filter'] ?? []) as Record<string, unknown>[];
    const alreadyPresent = filters.some((filter) => {
      const data = filter.data as { $?: Record<string, string> }[] | undefined;
      return data?.some((entry) => entry.$?.['android:host'] === host) === true;
    });
    if (!alreadyPresent) {
      filters.push({
        $: { 'android:autoVerify': 'true' },
        action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
        category: [
          { $: { 'android:name': 'android.intent.category.DEFAULT' } },
          { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
        ],
        data: [
          {
            $: {
              'android:scheme': 'https',
              'android:host': host,
              'android:pathPrefix': pathPrefix,
            },
          },
        ],
      });
    }
    activity['intent-filter'] = filters as never;
    return modConfig;
  });

  return config;
};

export default withTracive;

import {
  AndroidConfig,
  WarningAggregator,
  withAndroidManifest,
  withEntitlementsPlist,
  withInfoPlist,
  type ConfigPlugin,
} from '@expo/config-plugins';

import { TRACIVE_ANDROID_PACKAGE, TRACIVE_APP_SCHEME } from '../oauth/authorizeUrl';

// Re-exported so the plugin's own tests can name it; the definition lives with the flow that
// probes for the app at runtime. See `authorizeUrl.ts`.
export { TRACIVE_ANDROID_PACKAGE };

const VIEW_ACTION = 'android.intent.action.VIEW';

interface AndroidAttributes {
  $?: Record<string, string>;
}

interface ManifestIntent {
  action?: AndroidAttributes[];
  data?: AndroidAttributes[];
}

interface QueriesElement {
  package?: AndroidAttributes[];
  intent?: ManifestIntent[];
}

/**
 * Adds Tracive's package-visibility entries to the manifest's `<queries>` block WITHOUT
 * discarding what is already there.
 *
 * This used to be a straight assignment, which silently dropped every entry declared by the
 * host's own app.json or by any plugin that ran earlier — expo-image-picker,
 * expo-intent-launcher, react-native-share and so on. The symptom of losing one is nasty to
 * trace: `canOpenURL` starts answering `false` for the OTHER library, which reports its own
 * feature as unavailable, nothing points back here, and whether it happens at all depends on
 * plugin order.
 *
 * Everything is merged into a single `<queries>` element, because a manifest carries one;
 * appending a second block would be a different bug wearing a merge's clothes. Exported so the
 * merge is testable on its own — the plugin as a whole needs a real prebuild to exercise.
 */
export function mergeTraciveQueries(manifest: { queries?: unknown[] }): void {
  const queries = (manifest.queries ?? []) as QueriesElement[];
  const target: QueriesElement = queries[0] ?? {};
  if (queries.length === 0) queries.push(target);

  // The <package> entry backs the presence probe by package id.
  const packages = target.package ?? [];
  const declared = packages.some(
    (entry) => entry.$?.['android:name'] === TRACIVE_ANDROID_PACKAGE,
  );
  if (!declared) packages.push({ $: { 'android:name': TRACIVE_ANDROID_PACKAGE } });
  target.package = packages;

  // The scheme <intent> entries keep canOpenURL from rejecting outright on API 30+.
  const intents = target.intent ?? [];
  for (const scheme of [TRACIVE_APP_SCHEME, 'https']) {
    // Matched on action AND scheme: visibility is granted per matching intent, so somebody
    // else's SEND entry for the same scheme does not cover a VIEW lookup.
    const covered = intents.some(
      (intent) =>
        intent.action?.some((action) => action.$?.['android:name'] === VIEW_ACTION) === true &&
        intent.data?.some((data) => data.$?.['android:scheme'] === scheme) === true,
    );
    if (!covered) {
      intents.push({
        action: [{ $: { 'android:name': VIEW_ACTION } }],
        data: [{ $: { 'android:scheme': scheme } }],
      });
    }
  }
  target.intent = intents;

  manifest.queries = queries;
}

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

/**
 * Parsed by hand: this runs under Node during prebuild, but the shape is trivial and explicit.
 *

 * A bare host, or `undefined`/an error when the authority carries anything else.
 *
 * The authority is NOT the host. `https://user@your.app:8443/cb` has an authority of
 * `user@your.app:8443`, and folding that into a host writes `android:host="your.app:8443"` and
 * `applinks:your.app:8443` — neither of which is valid. Android takes a port in a separate
 * `android:port` attribute and an associated-domains entry takes neither, so the link would
 * simply never verify, silently, which is the whole failure mode this tooling exists to prevent.
 *
 * Rejecting is right rather than stripping: an OAuth redirect URI must be an https URL the app
 * OWNS, and neither userinfo nor a non-default port can appear in one that an App Link or a
 * Universal Link will ever verify. Silently dropping them would claim a different URL than the
 * one the caller registered with the authorization server.
 */
export function parseRedirectUri(redirectUri: string): RedirectParts {
  const match = /^https:\/\/([^/?#]+)([^?#]*)/.exec(redirectUri);
  if (match === null) {
    throw new Error(
      `The Tracive redirect URI must be an https URL the app owns; received "${redirectUri}". ` +
        'RFC 8252 forbids completing this flow in an in-app WebView, and a custom scheme is ' +
        'rejected by the authorization server.',
    );
  }
  const authority = match[1] ?? '';
  if (authority === '' || authority.includes('@') || /:\d*$/.test(authority)) {
    throw new Error(
      `The Tracive redirect URI must carry a bare host; received "${redirectUri}". Android takes ` +
        'a port in a separate android:port attribute and an associated-domains entry takes ' +
        'neither a port nor userinfo, so this would claim a host nobody owns and the link would ' +
        'never verify.',
    );
  }
  const path = match[2] ?? '';
  return { host: authority, pathPrefix: path === '' ? '/' : path };
}

/**
 * Sets `android:launchMode="singleTask"` only when the host declared nothing.
 *
 * A stacked second activity instance would otherwise start a fresh task and never see the
 * redirect, and `singleTask` avoids it — the persisted pending record makes the alternative
 * survivable rather than fine. It is also what Expo defaults to, so for almost every project
 * this is a no-op.
 *
 * It used to be assigned unconditionally, which silently rewrote a host that had deliberately
 * chosen `standard` or `singleTop`. A prebuild that overwrites somebody's decision without
 * saying so is worse than one that leaves it alone and complains: the host keeps their choice,
 * and gets told which behaviour they are giving up. Returns the warnings to emit, so the
 * decision is testable without a prebuild.
 */
export function applyTraciveLaunchMode(activity: {
  $: Record<string, string | undefined>;
}): string[] {
  const declared = activity.$['android:launchMode'];
  if (declared === undefined || declared === '') {
    activity.$['android:launchMode'] = 'singleTask';
    return [];
  }
  if (declared === 'singleTask') return [];
  return [
    `The main activity declares android:launchMode="${declared}"; Tracive expects ` +
      '"singleTask" and has left your choice in place. With any other mode a second activity ' +
      'instance can be stacked on top and the authorization redirect is delivered to an ' +
      'instance that is not waiting for it. The persisted pending record means the ' +
      'authorization is not lost, but the user may have to return to the app for it to land.',
  ];
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

    mergeTraciveQueries(manifest);

    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(modConfig.modResults);
    for (const warning of applyTraciveLaunchMode(activity)) {
      WarningAggregator.addWarningAndroid('@tracive/sdk-react-native', warning);
    }

    const filters = (activity['intent-filter'] ?? []) as Record<string, unknown>[];
    const alreadyPresent = filters.some((filter) => {
      const data = filter.data as { $?: Record<string, string> }[] | undefined;
      return data?.some((entry) => entry.$?.['android:host'] === host) === true;
    });
    if (!alreadyPresent) {
      filters.push({
        $: { 'android:autoVerify': 'true' },
        action: [{ $: { 'android:name': VIEW_ACTION } }],
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

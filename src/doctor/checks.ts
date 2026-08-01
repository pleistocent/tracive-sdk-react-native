/**
 * The static host-configuration checks behind `npx tracive-doctor`.
 *
 * These are pure functions over file CONTENTS so that every one of them is testable without a
 * device, an emulator or a real project on disk. `run.ts` is the only part that touches a file
 * system.
 *
 * Why this exists at all: a missing `LSApplicationQueriesSchemes` entry does not crash, does not
 * log and does not degrade. It routes 100% of already-onboarded users to an install page, so the
 * integration converts at zero and the dashboard looks like nobody wanted the feature. The
 * failure is invisible precisely where it is most expensive, so it is checked at build time and
 * fails loudly.
 */

import { TRACIVE_ANDROID_PACKAGE, TRACIVE_APP_SCHEME } from '../oauth/authorizeUrl';

/**
 * Re-exported, not redefined. These used to be a second copy of the two values the OAuth flow
 * already owns, which is the one thing this tool must not be: it exists to tell an integrator
 * whether their manifest agrees with the SDK, and a doctor working from its own copy of the answer
 * can certify a manifest the SDK will then refuse. See `authorizeUrl.ts`.
 */
export { TRACIVE_ANDROID_PACKAGE, TRACIVE_APP_SCHEME };

export type FindingSeverity = 'error' | 'warning';

export interface Finding {
  readonly severity: FindingSeverity;
  readonly code: string;
  readonly message: string;
  /** The exact block to paste, when there is one. */
  readonly fix?: string;
}

export interface RedirectTarget {
  readonly host: string;
  readonly pathPrefix: string;
}

/**
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
export function parseRedirectUri(redirectUri: string): RedirectTarget | undefined {
  const match = /^https:\/\/([^/?#]+)([^?#]*)/.exec(redirectUri);
  if (match === null) return undefined;
  const authority = match[1] ?? '';
  if (authority === '' || authority.includes('@') || /:\d*$/.test(authority)) return undefined;
  const path = match[2] ?? '';
  return { host: authority, pathPrefix: path === '' ? '/' : path };
}

const QUERIES_BLOCK = `<queries>
    <package android:name="${TRACIVE_ANDROID_PACKAGE}" />
    <intent>
        <action android:name="android.intent.action.VIEW" />
        <data android:scheme="${TRACIVE_APP_SCHEME}" />
    </intent>
    <intent>
        <action android:name="android.intent.action.VIEW" />
        <data android:scheme="https" />
    </intent>
</queries>`;

function stripComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Deliberately regex-based rather than a full XML parse. The doctor must run against a merged
 * manifest produced by a build it does not control, and a parse failure on an unexpected but
 * harmless construct would be a worse outcome than a slightly loose match.
 */
export function checkAndroidManifest(xml: string, redirect: RedirectTarget | undefined): Finding[] {
  const findings: Finding[] = [];
  const source = stripComments(xml);
  const queriesMatch = /<queries[\s>][\s\S]*?<\/queries>/.exec(source);
  const queries = queriesMatch === null ? '' : queriesMatch[0];

  if (queries === '') {
    findings.push({
      severity: 'error',
      code: 'missing_query_declaration',
      message:
        'AndroidManifest.xml has no <queries> block, so Linking.canOpenURL will reject on API ' +
        '30+ and every user will be told the Tracive app is not installed.',
      fix: `Add as a direct child of <manifest>:\n${QUERIES_BLOCK}`,
    });
  } else {
    if (!queries.includes(TRACIVE_ANDROID_PACKAGE)) {
      findings.push({
        severity: 'error',
        code: 'missing_query_declaration',
        message: `The <queries> block does not name the package ${TRACIVE_ANDROID_PACKAGE}.`,
        fix: `Add inside <queries>:\n    <package android:name="${TRACIVE_ANDROID_PACKAGE}" />`,
      });
    }
    if (!new RegExp(`android:scheme="${TRACIVE_APP_SCHEME}"`).test(queries)) {
      findings.push({
        severity: 'error',
        code: 'missing_query_declaration',
        message:
          'The <queries> block does not declare the `tracive` scheme <intent>. Both the ' +
          '<package> entry and the scheme <intent> are needed.',
        fix:
          '    <intent>\n' +
          '        <action android:name="android.intent.action.VIEW" />\n' +
          `        <data android:scheme="${TRACIVE_APP_SCHEME}" />\n` +
          '    </intent>',
      });
    }
  }

  if (!/android:launchMode="singleTask"/.test(source)) {
    findings.push({
      severity: 'warning',
      code: 'activity_not_single_task',
      message:
        'No activity declares android:launchMode="singleTask". A second activity instance can ' +
        'start a fresh task and never deliver the redirect to the running app.',
      fix: 'Add android:launchMode="singleTask" to your main <activity>.',
    });
  }

  if (redirect !== undefined) {
    const filters = source.match(/<intent-filter[\s\S]*?<\/intent-filter>/g) ?? [];
    const matching = filters.filter((filter) =>
      new RegExp(`android:host="${redirect.host.replace(/\./g, '\\.')}"`).test(filter),
    );
    if (matching.length === 0) {
      findings.push({
        severity: 'error',
        code: 'redirect_uri_not_claimed',
        message: `No <intent-filter> claims the redirect host ${redirect.host}.`,
        fix:
          '<intent-filter android:autoVerify="true">\n' +
          '    <action android:name="android.intent.action.VIEW" />\n' +
          '    <category android:name="android.intent.category.DEFAULT" />\n' +
          '    <category android:name="android.intent.category.BROWSABLE" />\n' +
          `    <data android:scheme="https" android:host="${redirect.host}" ` +
          `android:pathPrefix="${redirect.pathPrefix}" />\n` +
          '</intent-filter>',
      });
    } else if (!matching.some((filter) => /android:autoVerify="true"/.test(filter))) {
      findings.push({
        severity: 'error',
        code: 'redirect_uri_not_claimed',
        message:
          `The <intent-filter> for ${redirect.host} is missing android:autoVerify="true". ` +
          'Without verification Android shows a disambiguation dialog and any other app may ' +
          'claim the link.',
        fix:
          'Add android:autoVerify="true" to the <intent-filter>, and serve ' +
          `https://${redirect.host}/.well-known/assetlinks.json naming your package and ` +
          'signing-certificate fingerprint.',
      });
    }
  }

  return findings;
}

export function checkInfoPlist(plist: string): Finding[] {
  const source = stripComments(plist);
  const arrayMatch = /<key>LSApplicationQueriesSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
    source,
  );
  if (arrayMatch === null) {
    return [
      {
        severity: 'error',
        code: 'missing_ios_query_scheme',
        message:
          'Info.plist has no LSApplicationQueriesSchemes entry, so canOpenURL always answers ' +
          'false on iOS and every user is routed to the install page.',
        fix:
          '<key>LSApplicationQueriesSchemes</key>\n<array>\n' +
          `    <string>${TRACIVE_APP_SCHEME}</string>\n</array>`,
      },
    ];
  }
  if (!new RegExp(`<string>${TRACIVE_APP_SCHEME}</string>`).test(arrayMatch[1] ?? '')) {
    return [
      {
        severity: 'error',
        code: 'missing_ios_query_scheme',
        message: 'LSApplicationQueriesSchemes does not list `tracive`.',
        fix: `    <string>${TRACIVE_APP_SCHEME}</string>`,
      },
    ];
  }
  return [];
}

export function checkEntitlements(
  entitlements: string | undefined,
  redirect: RedirectTarget | undefined,
): Finding[] {
  if (redirect === undefined) return [];
  const expected = `applinks:${redirect.host}`;
  if (entitlements === undefined) {
    return [
      {
        severity: 'error',
        code: 'redirect_uri_not_claimed',
        message:
          'No iOS entitlements file was found, so the Associated Domains capability cannot be ' +
          'present and the Universal Link will never open the app.',
        fix:
          '<key>com.apple.developer.associated-domains</key>\n<array>\n' +
          `    <string>${expected}</string>\n</array>`,
      },
    ];
  }
  if (!entitlements.includes(expected)) {
    return [
      {
        severity: 'error',
        code: 'redirect_uri_not_claimed',
        message: `The Associated Domains entitlement does not include ${expected}.`,
        fix:
          `    <string>${expected}</string>\n\n` +
          `Also serve https://${redirect.host}/.well-known/apple-app-site-association naming ` +
          'your team and bundle identifier.',
      },
    ];
  }
  return [];
}

export function exitCodeFor(findings: readonly Finding[]): number {
  return findings.some((finding) => finding.severity === 'error') ? 1 : 0;
}

export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return 'tracive-doctor: no problems found.';
  }
  const lines: string[] = [];
  for (const finding of findings) {
    lines.push(
      `${finding.severity === 'error' ? 'ERROR' : 'WARN '}  [${finding.code}] ${finding.message}`,
    );
    if (finding.fix !== undefined) {
      lines.push(finding.fix.replace(/^/gm, '        '));
    }
    lines.push('');
  }
  const errors = findings.filter((finding) => finding.severity === 'error').length;
  lines.push(`tracive-doctor: ${errors} error(s), ${findings.length - errors} warning(s).`);
  return lines.join('\n');
}

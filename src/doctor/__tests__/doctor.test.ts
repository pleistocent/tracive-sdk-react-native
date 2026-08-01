import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkAndroidManifest,
  checkEntitlements,
  checkInfoPlist,
  exitCodeFor,
  formatFindings,
  parseRedirectUri,
} from '../checks';
import { resolveAndroidManifest, runDoctor, parseArgv } from '../run';

const REDIRECT = parseRedirectUri('https://your.app/oauth/callback');

const GOOD_MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
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
  <application>
    <activity android:name=".MainActivity" android:launchMode="singleTask">
      <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https" android:host="your.app" android:pathPrefix="/oauth/callback" />
      </intent-filter>
    </activity>
  </application>
</manifest>`;

const GOOD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>LSApplicationQueriesSchemes</key>
  <array><string>tracive</string></array>
</dict></plist>`;

const GOOD_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>com.apple.developer.associated-domains</key>
  <array><string>applinks:your.app</string></array>
</dict></plist>`;

describe('parseRedirectUri', () => {
  it('splits an https redirect into host and path prefix', () => {
    expect(REDIRECT).toEqual({ host: 'your.app', pathPrefix: '/oauth/callback' });
    expect(parseRedirectUri('https://your.app')).toEqual({ host: 'your.app', pathPrefix: '/' });
  });

  it('rejects a custom scheme', () => {
    // The authorization server matches the registered https redirect exactly.
    expect(parseRedirectUri('myapp://callback')).toBeUndefined();
    expect(parseRedirectUri('http://your.app/cb')).toBeUndefined();
  });

  it('rejects an authority carrying a port or userinfo rather than folding it into the host', () => {
    // `android:host` takes no port — that is a separate attribute — and an `applinks:` entry
    // takes neither. Folding either into the host produces a manifest and an entitlement that
    // claim a host nobody owns, and the link then simply never verifies.
    expect(parseRedirectUri('https://your.app:8443/cb')).toBeUndefined();
    expect(parseRedirectUri('https://user@your.app/cb')).toBeUndefined();
    expect(parseRedirectUri('https://user:pass@your.app:8443/cb')).toBeUndefined();
    expect(parseRedirectUri('https:///cb')).toBeUndefined();
  });
});

describe('the Android manifest check', () => {
  it('passes a correct manifest', () => {
    expect(checkAndroidManifest(GOOD_MANIFEST, REDIRECT)).toEqual([]);
  });

  it('fails a manifest with no <queries> block', () => {
    const findings = checkAndroidManifest(
      GOOD_MANIFEST.replace(/<queries>[\s\S]*?<\/queries>/, ''),
      REDIRECT,
    );
    expect(findings.some((f) => f.code === 'missing_query_declaration')).toBe(true);
    expect(exitCodeFor(findings)).toBe(1);
    // The finding carries the exact block to paste.
    expect(findings[0]?.fix).toContain('com.pleistocent.tracive');
  });

  it('fails when <queries> names the package but not the scheme', () => {
    // Both forms are needed; one alone still breaks canOpenURL on API 30+.
    const manifest = GOOD_MANIFEST.replace(/<data android:scheme="tracive" \/>/, '');
    const findings = checkAndroidManifest(manifest, REDIRECT);
    expect(findings.some((f) => f.code === 'missing_query_declaration')).toBe(true);
  });

  it('fails when the redirect host has no intent-filter', () => {
    const findings = checkAndroidManifest(GOOD_MANIFEST, {
      host: 'other.app',
      pathPrefix: '/cb',
    });
    expect(findings.some((f) => f.code === 'redirect_uri_not_claimed')).toBe(true);
    expect(exitCodeFor(findings)).toBe(1);
  });

  it('fails when the intent-filter is not autoVerify', () => {
    const findings = checkAndroidManifest(
      GOOD_MANIFEST.replace(' android:autoVerify="true"', ''),
      REDIRECT,
    );
    expect(findings.some((f) => f.code === 'redirect_uri_not_claimed')).toBe(true);
  });

  it('warns, but does not fail, when launchMode is not singleTask', () => {
    const findings = checkAndroidManifest(
      GOOD_MANIFEST.replace(' android:launchMode="singleTask"', ''),
      REDIRECT,
    );
    const warning = findings.find((f) => f.code === 'activity_not_single_task');
    expect(warning?.severity).toBe('warning');
    expect(exitCodeFor(findings)).toBe(0);
  });

  it('ignores a block that is only present inside a comment', () => {
    const commented = `<manifest><!-- ${GOOD_MANIFEST} --></manifest>`;
    expect(checkAndroidManifest(commented, REDIRECT).some((f) => f.severity === 'error')).toBe(
      true,
    );
  });
});

describe('the iOS checks', () => {
  it('passes a correct Info.plist and entitlements file', () => {
    expect(checkInfoPlist(GOOD_PLIST)).toEqual([]);
    expect(checkEntitlements(GOOD_ENTITLEMENTS, REDIRECT)).toEqual([]);
  });

  it('fails when LSApplicationQueriesSchemes is absent', () => {
    const findings = checkInfoPlist('<plist><dict></dict></plist>');
    expect(findings[0]?.code).toBe('missing_ios_query_scheme');
    expect(exitCodeFor(findings)).toBe(1);
  });

  it('fails when LSApplicationQueriesSchemes omits the scheme', () => {
    const findings = checkInfoPlist(
      GOOD_PLIST.replace('<string>tracive</string>', '<string>other</string>'),
    );
    expect(findings[0]?.code).toBe('missing_ios_query_scheme');
  });

  it('fails when the associated domain is missing', () => {
    expect(checkEntitlements(undefined, REDIRECT)[0]?.code).toBe('redirect_uri_not_claimed');
    expect(checkEntitlements('<plist><dict></dict></plist>', REDIRECT)[0]?.code).toBe(
      'redirect_uri_not_claimed',
    );
  });

  it('skips the entitlements check when no redirect URI is known', () => {
    expect(checkEntitlements(undefined, undefined)).toEqual([]);
  });
});

describe('formatting', () => {
  it('says so plainly when nothing is wrong', () => {
    expect(formatFindings([])).toContain('no problems found');
  });

  it('prints the code, the message and the fix', () => {
    const text = formatFindings(checkInfoPlist('<plist></plist>'));
    expect(text).toContain('missing_ios_query_scheme');
    expect(text).toContain('LSApplicationQueriesSchemes');
    expect(text).toContain('1 error(s)');
  });
});

describe('runDoctor over a project on disk', () => {
  function project(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'tracive-doctor-'));
    for (const [relative, contents] of Object.entries(files)) {
      const path = join(root, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, contents);
    }
    return root;
  }

  it('exits 0 on a correct project', () => {
    const root = project({
      'android/app/src/main/AndroidManifest.xml': GOOD_MANIFEST,
      'ios/App/Info.plist': GOOD_PLIST,
      'ios/App/App.entitlements': GOOD_ENTITLEMENTS,
    });
    const report = runDoctor({ projectRoot: root, redirectUri: 'https://your.app/oauth/callback' });
    expect(report.exitCode).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it('exits 1 when the manifest is missing its <queries> block', () => {
    const root = project({
      'android/app/src/main/AndroidManifest.xml': GOOD_MANIFEST.replace(
        /<queries>[\s\S]*?<\/queries>/,
        '',
      ),
      'ios/App/Info.plist': GOOD_PLIST,
      'ios/App/App.entitlements': GOOD_ENTITLEMENTS,
    });
    expect(
      runDoctor({ projectRoot: root, redirectUri: 'https://your.app/oauth/callback' }).exitCode,
    ).toBe(1);
  });

  it('exits 1 when Info.plist omits LSApplicationQueriesSchemes', () => {
    const root = project({
      'android/app/src/main/AndroidManifest.xml': GOOD_MANIFEST,
      'ios/App/Info.plist': '<plist><dict></dict></plist>',
      'ios/App/App.entitlements': GOOD_ENTITLEMENTS,
    });
    expect(
      runDoctor({ projectRoot: root, redirectUri: 'https://your.app/oauth/callback' }).exitCode,
    ).toBe(1);
  });

  it('prefers the merged manifest over the source one', () => {
    // A manifest-stripping build step can drop a block that is present in the source, and what
    // ships is what matters.
    const root = project({
      'android/app/src/main/AndroidManifest.xml': GOOD_MANIFEST,
      'android/app/build/intermediates/merged_manifests/debug/AndroidManifest.xml':
        GOOD_MANIFEST.replace(/<queries>[\s\S]*?<\/queries>/, ''),
      'ios/App/Info.plist': GOOD_PLIST,
      'ios/App/App.entitlements': GOOD_ENTITLEMENTS,
    });
    expect(resolveAndroidManifest(root)).toContain('merged_manifests');
    expect(
      runDoctor({ projectRoot: root, redirectUri: 'https://your.app/oauth/callback' }).exitCode,
    ).toBe(1);
  });

  it('reads the redirect URI from app.json when none is passed', () => {
    const root = project({
      'app.json': JSON.stringify({
        expo: { extra: { tracive: { redirectUri: 'https://your.app/oauth/callback' } } },
      }),
      'android/app/src/main/AndroidManifest.xml': GOOD_MANIFEST,
      'ios/App/Info.plist': GOOD_PLIST,
      'ios/App/App.entitlements': GOOD_ENTITLEMENTS,
    });
    expect(runDoctor({ projectRoot: root }).exitCode).toBe(0);
  });

  it('warns rather than failing when no redirect URI is known at all', () => {
    const root = project({
      'android/app/src/main/AndroidManifest.xml': GOOD_MANIFEST,
      'ios/App/Info.plist': GOOD_PLIST,
    });
    const report = runDoctor({ projectRoot: root });
    expect(report.exitCode).toBe(0);
    expect(report.findings.some((f) => f.code === 'redirect_uri_unknown')).toBe(true);
  });

  it('fails on a non-https redirect URI', () => {
    const root = project({ 'android/app/src/main/AndroidManifest.xml': GOOD_MANIFEST });
    expect(runDoctor({ projectRoot: root, redirectUri: 'myapp://cb' }).exitCode).toBe(1);
  });
});

describe('parseArgv', () => {
  it('reads a project root and a redirect URI in either form', () => {
    expect(parseArgv([])).toEqual({ projectRoot: '.' });
    expect(parseArgv(['--redirect-uri', 'https://a/b'])).toEqual({
      projectRoot: '.',
      redirectUri: 'https://a/b',
    });
    expect(parseArgv(['./app', '--redirect-uri=https://a/b'])).toEqual({
      projectRoot: './app',
      redirectUri: 'https://a/b',
    });
  });
});

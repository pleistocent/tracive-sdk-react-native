import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The SDK's manifest lands in every partner's merged manifest, which banks audit. These read the
 * shipped files as text, the way an auditor would, so a provider that drifts to exported, widens
 * its paths or grows a sibling fails here before it ships.
 */
const ANDROID = join(process.cwd(), 'android', 'src', 'main');
const read = (...path: string[]) => readFileSync(join(ANDROID, ...path), 'utf8');
const withoutComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');

const MANIFEST = withoutComments(read('AndroidManifest.xml'));
const PATHS = withoutComments(read('res', 'xml', 'tracive_rn_report_paths.xml'));
const KOTLIN = join('java', 'id', 'tracive', 'sdk', 'reactnative');

function attribute(element: string, name: string): string | undefined {
  return new RegExp(`android:${name}="([^"]*)"`).exec(element)?.[1];
}

describe('the merged-manifest contribution', () => {
  const providers = MANIFEST.match(/<provider[\s\S]*?(?:\/>|<\/provider>)/g) ?? [];
  const provider = providers[0] ?? '';

  it('is one provider and nothing else', () => {
    expect(providers).toHaveLength(1);
    for (const element of ['<activity', '<service', '<receiver', '<queries', '<uses-permission']) {
      expect(MANIFEST).not.toContain(element);
    }
  });

  it('keeps the provider unexported, with per-intent read grants', () => {
    expect(attribute(provider, 'exported')).toBe('false');
    expect(attribute(provider, 'grantUriPermissions')).toBe('true');
    expect(MANIFEST).not.toMatch(/android:exported="true"/);
  });

  it('is the SDK subclass under its own authority, so it cannot collide with a host provider', () => {
    expect(attribute(provider, 'name')).toBe(
      'id.tracive.sdk.reactnative.TraciveReportFileProvider',
    );
    expect(attribute(provider, 'authorities')).toBe('${applicationId}.tracive-rn-files');
    expect(read(KOTLIN, 'TraciveReportFileProvider.kt')).toContain(
      '"${context.packageName}.tracive-rn-files"',
    );
  });

  it('serves only the report folder of the cache', () => {
    expect(attribute(provider, 'resource')).toBe('@xml/tracive_rn_report_paths');
    const entries = PATHS.match(/<[a-z-]+-path\b[^>]*\/>/g) ?? [];
    expect(entries).toEqual(['<cache-path name="report" path="tracive-sdk/report/" />']);
    expect(read(KOTLIN, 'ReportPackageFiles.kt')).toContain(
      'const val FOLDER = "tracive-sdk/report"',
    );
  });
});

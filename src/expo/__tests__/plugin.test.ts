import { describe, expect, it } from '@jest/globals';

import { mergeTraciveQueries, parseRedirectUri, TRACIVE_ANDROID_PACKAGE } from '../plugin';
import { TRACIVE_APP_SCHEME } from '../../oauth/authorizeUrl';

interface Named {
  $?: Record<string, string>;
}
interface QueriesElement {
  package?: Named[];
  intent?: { action?: Named[]; data?: Named[] }[];
}

function packageNames(queries: QueriesElement[]): string[] {
  return queries.flatMap((entry) =>
    (entry.package ?? []).map((one) => one.$?.['android:name'] ?? ''),
  );
}

function schemes(queries: QueriesElement[]): string[] {
  return queries.flatMap((entry) =>
    (entry.intent ?? []).flatMap((intent) =>
      (intent.data ?? []).map((one) => one.$?.['android:scheme'] ?? ''),
    ),
  );
}

/**
 * Android package-visibility failures are silent and land in the wrong package: `canOpenURL`
 * starts answering `false` for somebody ELSE's library, which then reports its own feature as
 * unavailable. Nothing points back at this plugin, and it only happens depending on plugin order.
 */
describe('the Android <queries> merge', () => {
  it('keeps entries another plugin already declared', () => {
    const manifest: { queries?: unknown[] } = {
      queries: [
        {
          package: [{ $: { 'android:name': 'com.example.other' } }],
          intent: [
            {
              action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
              data: [{ $: { 'android:scheme': 'mailto' } }],
            },
          ],
        },
      ],
    };

    mergeTraciveQueries(manifest);
    const queries = manifest.queries as QueriesElement[];

    expect(packageNames(queries)).toContain('com.example.other');
    expect(schemes(queries)).toContain('mailto');
  });

  it('adds the Tracive package and both schemes', () => {
    const manifest: { queries?: unknown[] } = {};
    mergeTraciveQueries(manifest);
    const queries = manifest.queries as QueriesElement[];

    expect(packageNames(queries)).toContain(TRACIVE_ANDROID_PACKAGE);
    expect(schemes(queries)).toEqual(expect.arrayContaining([TRACIVE_APP_SCHEME, 'https']));
  });

  it('produces exactly one <queries> element', () => {
    // A manifest carries a single <queries> block; appending a second one is not a merge.
    const manifest: { queries?: unknown[] } = {
      queries: [{ package: [{ $: { 'android:name': 'com.example.other' } }] }],
    };
    mergeTraciveQueries(manifest);
    expect(manifest.queries).toHaveLength(1);
  });

  it('is idempotent across repeated prebuilds', () => {
    const manifest: { queries?: unknown[] } = {};
    mergeTraciveQueries(manifest);
    mergeTraciveQueries(manifest);
    const queries = manifest.queries as QueriesElement[];

    expect(packageNames(queries).filter((name) => name === TRACIVE_ANDROID_PACKAGE)).toHaveLength(
      1,
    );
    expect(schemes(queries).filter((scheme) => scheme === 'https')).toHaveLength(1);
  });

  it('does not re-add a scheme the host already made visible for VIEW', () => {
    const manifest: { queries?: unknown[] } = {
      queries: [
        {
          intent: [
            {
              action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
              data: [{ $: { 'android:scheme': 'https' } }],
            },
          ],
        },
      ],
    };
    mergeTraciveQueries(manifest);
    const queries = manifest.queries as QueriesElement[];
    expect(schemes(queries).filter((scheme) => scheme === 'https')).toHaveLength(1);
  });

  it('does add its own https intent when the host only declared a non-VIEW one', () => {
    // Visibility is granted per matching intent, so a SEND-only entry does not cover us.
    const manifest: { queries?: unknown[] } = {
      queries: [
        {
          intent: [
            {
              action: [{ $: { 'android:name': 'android.intent.action.SEND' } }],
              data: [{ $: { 'android:scheme': 'https' } }],
            },
          ],
        },
      ],
    };
    mergeTraciveQueries(manifest);
    const queries = manifest.queries as QueriesElement[];
    expect(schemes(queries).filter((scheme) => scheme === 'https')).toHaveLength(2);
  });
});

describe('parseRedirectUri', () => {
  it('splits host and path prefix', () => {
    expect(parseRedirectUri('https://your.app/oauth/callback')).toEqual({
      host: 'your.app',
      pathPrefix: '/oauth/callback',
    });
  });

  it('defaults an empty path to /', () => {
    expect(parseRedirectUri('https://your.app')).toEqual({ host: 'your.app', pathPrefix: '/' });
  });

  it('rejects a non-https redirect', () => {
    expect(() => parseRedirectUri('myapp://callback')).toThrow('https');
  });
});

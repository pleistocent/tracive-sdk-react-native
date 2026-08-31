import { describe, expect, it } from '@jest/globals';

import {
  applyTraciveLaunchMode,
  mergeTraciveQueries,
  parseRedirectUri,
} from '../plugin';
import { TRACIVE_APP_SCHEMES } from '../../oauth/authorizeUrl';

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

  it('adds both schemes and adds no <package> entry', () => {
    const manifest: { queries?: unknown[] } = {};
    mergeTraciveQueries(manifest);
    const queries = manifest.queries as QueriesElement[];

    expect(schemes(queries)).toEqual(expect.arrayContaining([...TRACIVE_APP_SCHEMES, 'https']));
    // A <package> entry would name one build, so it cannot follow the environment the way the
    // probe does; the scheme queries are what answer it. Asserting the absence, because writing
    // one into a host's shipped manifest is the thing this plugin must not do.
    expect(packageNames(queries)).toEqual([]);
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

    for (const scheme of [...TRACIVE_APP_SCHEMES, 'https']) {
      expect(schemes(queries).filter((declared) => declared === scheme)).toHaveLength(1);
    }
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

  it('rejects an authority carrying a port or userinfo', () => {
    // `android:host` takes no port and an `applinks:` entry takes neither, so folding them in
    // would write a manifest and an entitlement claiming a host nobody owns.
    expect(() => parseRedirectUri('https://your.app:8443/cb')).toThrow();
    expect(() => parseRedirectUri('https://user@your.app/cb')).toThrow();
  });
});

/**
 * `singleTask` is what this SDK wants and what Expo already defaults to, but a host that
 * deliberately chose something else had it silently rewritten. A prebuild that overwrites a
 * decision without saying so is worse than one that leaves it alone and complains.
 */
describe('the Android launchMode', () => {
  it('sets singleTask when the host declared nothing', () => {
    const activity: { $: Record<string, string | undefined> } = { $: {} };
    const warnings = applyTraciveLaunchMode(activity);
    expect(activity.$['android:launchMode']).toBe('singleTask');
    expect(warnings).toEqual([]);
  });

  it('leaves an explicit singleTask alone and says nothing', () => {
    const activity: { $: Record<string, string | undefined> } = {
      $: { 'android:launchMode': 'singleTask' },
    };
    expect(applyTraciveLaunchMode(activity)).toEqual([]);
    expect(activity.$['android:launchMode']).toBe('singleTask');
  });

  it('does NOT overwrite a different launchMode the host chose', () => {
    const activity: { $: Record<string, string | undefined> } = {
      $: { 'android:launchMode': 'singleTop' },
    };
    const warnings = applyTraciveLaunchMode(activity);
    expect(activity.$['android:launchMode']).toBe('singleTop');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('singleTop');
    expect(warnings[0]).toContain('singleTask');
  });
});

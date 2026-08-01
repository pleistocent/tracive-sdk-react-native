import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  checkAndroidManifest,
  checkEntitlements,
  checkInfoPlist,
  exitCodeFor,
  formatFindings,
  parseRedirectUri,
  type Finding,
} from './checks';

function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function findFiles(root: string, matches: (name: string) => boolean, depth = 4): string[] {
  if (depth < 0 || !existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(root, entry);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) {
      found.push(...findFiles(path, matches, depth - 1));
    } else if (matches(entry)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * The merged manifest is preferred over the source one when it exists: an aggressive
 * `tools:node="remove"` or a manifest-stripping build step can drop a block that is present in
 * the source, and what ships is what matters.
 */
export function resolveAndroidManifest(projectRoot: string): string | undefined {
  const merged = findFiles(
    join(projectRoot, 'android', 'app', 'build', 'intermediates', 'merged_manifests'),
    (name) => name === 'AndroidManifest.xml',
    5,
  );
  if (merged.length > 0) return merged[0];
  const source = join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  return existsSync(source) ? source : undefined;
}

function redirectUriFromAppConfig(projectRoot: string): string | undefined {
  const raw = readIfPresent(join(projectRoot, 'app.json'));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      expo?: { extra?: { tracive?: { redirectUri?: string } } };
    };
    return parsed.expo?.extra?.tracive?.redirectUri;
  } catch {
    return undefined;
  }
}

export interface DoctorReport {
  readonly findings: readonly Finding[];
  readonly exitCode: number;
  readonly text: string;
}

export function runDoctor(input: {
  projectRoot: string;
  redirectUri?: string | undefined;
}): DoctorReport {
  const { projectRoot } = input;
  const findings: Finding[] = [];

  const redirectUri = input.redirectUri ?? redirectUriFromAppConfig(projectRoot);
  const redirect = redirectUri === undefined ? undefined : parseRedirectUri(redirectUri);
  if (redirectUri !== undefined && redirect === undefined) {
    findings.push({
      severity: 'error',
      code: 'redirect_uri_not_claimed',
      message:
        `"${redirectUri}" is not an https URL with a bare host. The Tracive authorization server ` +
        'matches the registered https redirect exactly and rejects custom schemes outright, and ' +
        'a userinfo or port in the authority cannot be expressed in an intent-filter host or an ' +
        'associated-domains entry.',
    });
  }
  if (redirectUri === undefined) {
    findings.push({
      severity: 'warning',
      code: 'redirect_uri_unknown',
      message:
        'No redirect URI was supplied, so the link-claiming checks were skipped. Pass ' +
        '--redirect-uri https://your.app/oauth/callback, or set expo.extra.tracive.redirectUri ' +
        'in app.json.',
    });
  }

  const manifestPath = resolveAndroidManifest(projectRoot);
  if (manifestPath === undefined) {
    findings.push({
      severity: 'warning',
      code: 'android_manifest_not_found',
      message:
        'No AndroidManifest.xml was found. For an Expo prebuild project run `npx expo prebuild` ' +
        'first, or rely on the config plugin to write these entries.',
    });
  } else {
    findings.push(...checkAndroidManifest(readFileSync(manifestPath, 'utf8'), redirect));
  }

  const plists = findFiles(join(projectRoot, 'ios'), (name) => name === 'Info.plist', 3).filter(
    (path) => !path.includes('Tests'),
  );
  if (plists.length === 0) {
    findings.push({
      severity: 'warning',
      code: 'info_plist_not_found',
      message: 'No Info.plist was found under ios/.',
    });
  } else {
    for (const path of plists) findings.push(...checkInfoPlist(readFileSync(path, 'utf8')));
  }

  const entitlements = findFiles(
    join(projectRoot, 'ios'),
    (name) => name.endsWith('.entitlements'),
    3,
  );
  const entitlementsSource = entitlements[0];
  findings.push(
    ...checkEntitlements(
      entitlementsSource === undefined ? undefined : readFileSync(entitlementsSource, 'utf8'),
      redirect,
    ),
  );

  return {
    findings,
    exitCode: exitCodeFor(findings),
    text: formatFindings(findings),
  };
}

export function parseArgv(argv: readonly string[]): {
  projectRoot: string;
  redirectUri?: string | undefined;
} {
  let projectRoot = '.';
  let redirectUri: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--redirect-uri') {
      redirectUri = argv[i + 1];
      i++;
    } else if (arg !== undefined && arg.startsWith('--redirect-uri=')) {
      redirectUri = arg.slice('--redirect-uri='.length);
    } else if (arg !== undefined && !arg.startsWith('-')) {
      projectRoot = arg;
    }
  }
  return { projectRoot, ...(redirectUri !== undefined ? { redirectUri } : {}) };
}

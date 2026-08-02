import { TraciveEnvironment } from '../model/TraciveEnvironment';
import type { OAuthConfiguration } from '../model/TraciveMode';
import { CODE_CHALLENGE_METHOD } from './pkce';

/**
 * Query strings are built by hand rather than through `URL`/`URLSearchParams`. React Native's
 * URL polyfill is a partial implementation whose behaviour has historically differed between
 * platforms, and this is the one string in the SDK where a difference is a security bug.
 */
function encodeQuery(params: readonly (readonly [string, string])[]): string {
  return params
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
}

function splitUrl(url: string): { base: string; query: string; fragment: string } {
  const hashAt = url.indexOf('#');
  const fragment = hashAt === -1 ? '' : url.slice(hashAt + 1);
  const withoutFragment = hashAt === -1 ? url : url.slice(0, hashAt);
  const queryAt = withoutFragment.indexOf('?');
  return {
    base: queryAt === -1 ? withoutFragment : withoutFragment.slice(0, queryAt),
    query: queryAt === -1 ? '' : withoutFragment.slice(queryAt + 1),
    fragment,
  };
}

export function parseQueryParameters(query: string): Map<string, string> {
  // A Map, never a plain object: a parameter literally named `__proto__` or `constructor` would
  // otherwise corrupt the lookup, and this input arrives from outside the app.
  const params = new Map<string, string>();
  for (const pair of query.split('&')) {
    if (pair === '') continue;
    const equalsAt = pair.indexOf('=');
    const rawName = equalsAt === -1 ? pair : pair.slice(0, equalsAt);
    const rawValue = equalsAt === -1 ? '' : pair.slice(equalsAt + 1);
    try {
      params.set(decodeURIComponent(rawName), decodeURIComponent(rawValue.replace(/\+/g, ' ')));
    } catch {
      params.set(rawName, rawValue);
    }
  }
  return params;
}

/** Parses the query of a redirect URL. Fragments are ignored: this is the code flow. */
export function parseCallbackParameters(url: string): Map<string, string> {
  return parseQueryParameters(splitUrl(url).query);
}

/**
 * The part of a URL that a redirect registration fixes: scheme, authority and path, with the query
 * and the fragment removed.
 *
 * Lower-cased whole, and with a trailing slash dropped. Scheme and host are case-insensitive by
 * RFC 3986 (§3.1 and §3.2.2) while a path is not, so folding the path's case accepts a little more
 * than it strictly should — and a browser adds a trailing slash to a bare-authority URL where a
 * registration usually does not carry one. Both leniencies are deliberate and run in the safe
 * direction: `state` is still compared afterwards and that is what actually decides whether a code
 * may be redeemed, so being too permissive here costs nothing, while being too strict would drop a
 * genuine redirect and strand a user who really did sign in.
 */
export function redirectTarget(url: string): string {
  const { base } = splitUrl(url);
  return base.replace(/\/+$/, '').toLowerCase();
}

/**
 * How the Tracive app is named on each platform. THE one definition of each, deliberately.
 *
 * The Android application id used to be written out three times — here in the OAuth flow, in the
 * doctor's checks, and in the Expo config plugin — and the scheme twice. Those are not three
 * copies of a string; they are three copies of an agreement that has to hold with the app on the
 * user's device. The plugin writes the `<queries>` entry, the doctor reads it back and reports on
 * it, and the flow probes it at runtime, so a value edited in one place and not the others makes
 * the doctor certify a manifest the SDK will not accept, or the plugin write one the doctor calls
 * wrong. Nothing about that failure points at the discrepancy.
 */
export const TRACIVE_APP_SCHEME = 'tracive';

/**
 * URL scheme the sandbox Tracive build registers.
 *
 * Sandbox and production are separate worlds by design: neither claims the other's scheme, so a
 * probe for one cannot see the other. The scheme is what this SDK probes for; the sandbox build's
 * application id is not something it needs, and naming one here would disclose that it exists.
 */
export const TRACIVE_SANDBOX_APP_SCHEME = 'tracivedev';

/** Every scheme a host manifest must declare for the probe to answer. */
export const TRACIVE_APP_SCHEMES = [TRACIVE_APP_SCHEME, TRACIVE_SANDBOX_APP_SCHEME] as const;

export const TRACIVE_ANDROID_PACKAGE = 'com.pleistocent.tracive';

/**
 * The URL probed to decide whether the Tracive app is installed.
 *
 * **The scheme alone, with no host — and that requires the app to claim it that way.** Android
 * resolves such a probe by intent-filter matching: a filter that declares a host requires the URI to
 * carry a matching one. This probed `tracive://authorize` first, which matched nothing because no
 * custom-scheme host of that name is registered; the bare scheme then matched nothing either, for
 * the same reason — every custom-scheme filter in the app named *some* host. Both spellings
 * answered "not installed" on every Android device including the ones holding the app.
 *
 * It works now because the Tracive app gained a scheme-only intent-filter, verified on a device:
 * `tracivedev://` went from "unable to resolve Intent" to starting the app. So this function and
 * that filter are one contract — neither is correct alone.
 *
 * iOS was never affected: `canOpenURL` there is answered by LaunchServices from the installed app's
 * `CFBundleURLTypes` and inspects only the scheme.
 *
 * A custom base URL is a partner proxy or a local server; the app on the device is still the
 * production one unless the integrator says otherwise.
 */
export function appPresenceProbeUrl(environment: TraciveEnvironment): string {
  return environment.type === 'sandbox'
    ? `${TRACIVE_SANDBOX_APP_SCHEME}://`
    : `${TRACIVE_APP_SCHEME}://`;
}
export const DEFAULT_INSTALL_URL = 'https://tracive.chottu.link/install';

export interface AuthorizeUrlInput {
  readonly config: OAuthConfiguration;
  readonly state: string;
  readonly codeChallenge: string;
  /** Picks the authorize origin. See `TraciveEnvironment.authorizeUrl`. */
  readonly environment: TraciveEnvironment;
}

/**
 * The authorization request. Note what is NOT here and never will be: an API key. There is no
 * API-key parameter anywhere in this SDK's surface, in either mode.
 */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const { config } = input;
  const params: (readonly [string, string])[] = [
    ['response_type', 'code'],
    ['client_id', config.clientId],
    ['redirect_uri', config.redirectUri],
    ['code_challenge', input.codeChallenge],
    ['code_challenge_method', CODE_CHALLENGE_METHOD],
    ['state', input.state],
  ];
  if (config.scopes !== undefined && config.scopes.length > 0) {
    params.push(['scope', config.scopes.join(' ')]);
  }
  // Always present, and as written. `OAuthConfiguration` requires it, and the value is stored on
  // the grant and echoed back in `grant.revoked` — trimming it here would hand the partner back
  // something other than what they sent. This used to test `!== undefined` only, so an empty
  // string went out as `partner_user_id=` and the app rejected it exactly as it rejects an absent
  // one.
  params.push(['partner_user_id', config.partnerUserId]);
  return `${TraciveEnvironment.authorizeUrl(input.environment)}?${encodeQuery(params)}`;
}

/**
 * Anything that could carry a grant, a credential or an error across to an install page. These
 * are stripped from a configured install URL rather than trusted: the install link is a public
 * marketing URL that may be pasted, shortened and logged by parties who should never see an
 * authorization parameter.
 */
const OAUTH_PARAMETERS: readonly string[] = [
  'code',
  'state',
  'code_challenge',
  'code_challenge_method',
  'code_verifier',
  'client_id',
  'client_secret',
  'redirect_uri',
  'response_type',
  'scope',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'nonce',
  'partner_user_id',
  'error',
  'error_description',
];

export const INSTALL_UTM_SOURCE = 'tracive-sdk-react-native';

/**
 * Attribution parameters this SDK owns. They are rebuilt from the client id on every call, so any
 * value already sitting on a configured install URL is replaced rather than duplicated — two
 * `ref` parameters on one link is an ambiguity the link service would have to guess at.
 */
const ATTRIBUTION_PARAMETERS: readonly string[] = ['ref', 'utm_source', 'utm_medium'];

/**
 * The install link carries no OAuth parameters at all — only attribution: `ref` is the partner's
 * OAuth client id (never an end user's identifier) and `utm_source` names this SDK. Both are
 * public, non-sensitive values, which is the whole point: the link is opened in a browser and
 * transits a third-party link service before it ever reaches a store page.
 *
 * There is deliberately no deferred resume: a fresh PKCE pair is generated when the user comes
 * back and retries, which is both simpler and safer than parking a verifier on a public URL.
 */
export function buildInstallUrl(installUrl: string, clientId: string | undefined): string {
  const { base, query, fragment } = splitUrl(installUrl);
  const kept: (readonly [string, string])[] = [];
  for (const [name, value] of parseQueryParameters(query)) {
    if (OAUTH_PARAMETERS.includes(name)) continue;
    if (ATTRIBUTION_PARAMETERS.includes(name)) continue;
    kept.push([name, value]);
  }
  if (clientId !== undefined && clientId !== '') {
    kept.push(['ref', clientId]);
  }
  kept.push(['utm_source', INSTALL_UTM_SOURCE]);
  const rebuilt = `${base}?${encodeQuery(kept)}`;
  return fragment === '' ? rebuilt : `${rebuilt}#${fragment}`;
}

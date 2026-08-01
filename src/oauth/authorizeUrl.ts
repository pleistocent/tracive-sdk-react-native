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

export const TRACIVE_APP_SCHEME = 'tracive';
export const APP_PRESENCE_PROBE_URL = 'tracive://authorize';
export const DEFAULT_INSTALL_URL = 'https://tracive.chottu.link/install';

export interface AuthorizeUrlInput {
  readonly config: OAuthConfiguration;
  readonly state: string;
  readonly codeChallenge: string;
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
  if (config.partnerUserId !== undefined) {
    params.push(['partner_user_id', config.partnerUserId]);
  }
  return `${TRACIVE_APP_SCHEME}://authorize?${encodeQuery(params)}`;
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

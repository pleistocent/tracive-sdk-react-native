import type { ClientType } from './enums';
import type { TraciveScope } from './scopes';

export interface OAuthConfiguration {
  readonly clientId: string;
  /**
   * Must be an App Link / Universal Link the partner app owns. RFC 8252 forbids completing this
   * flow in an in-app WebView, and an App Link does not fire from inside one either.
   */
  readonly redirectUri: string;
  /**
   * Prefer {@link TraciveScopes}: a mistyped scope is refused by the authorization server as a
   * whole consent request, not as a narrower grant.
   *
   * Left OPEN rather than narrowed to {@link TraciveScope}. The server's scope set is larger than
   * the three calls this SDK makes, and a partner holding one of the others must not have to wait
   * for a release here to ask for it. `(string & {})` keeps the constants in autocomplete while
   * still accepting any string.
   */
  readonly scopes?: readonly (TraciveScope | (string & {}))[];
  /**
   * The partner's own opaque id for this end user.
   *
   * **Required, and non-blank.** The Tracive app refuses a consent without one, client-side and
   * before any network call, and by design returns no redirect at all — so your app is handed
   * nothing to handle and no log anywhere records the attempt. It is also what the grant is keyed
   * on: echoed back in `grant.revoked` and `grant.superseded` so you can map the event to your own
   * customer, and what enforces one of your accounts to one Tracive account.
   *
   * Opaque — never a raw phone number or email, and never used as a credential.
   */
  readonly partnerUserId: string;
  /** Defaults to `'PUBLIC'`. */
  readonly clientType?: ClientType;
}

/**
 * Phase 2. Present in the surface now so that adding it later is not a breaking change.
 *
 * `authHeaders` carries whatever the partner's own gateway expects. It is never logged: the
 * redacting `toJSON` keeps the header names and drops every value.
 */
export interface ProxyConfiguration {
  readonly baseUrl: string;
  readonly authHeaders?: Readonly<Record<string, string>>;
}

export type TraciveMode =
  | { readonly type: 'oauth'; readonly config: OAuthConfiguration }
  | { readonly type: 'proxy'; readonly config: ProxyConfiguration };

/**
 * A proxy configuration can end up in a crash report or a breadcrumb simply by being an object,
 * so its serialisation is redacted at the source. JavaScript leaks unless you opt out.
 */
function redactProxyConfiguration(config: ProxyConfiguration): ProxyConfiguration {
  const headers = config.authHeaders;
  const redacted: ProxyConfiguration = {
    baseUrl: config.baseUrl,
    ...(headers !== undefined
      ? {
          authHeaders: Object.fromEntries(Object.keys(headers).map((name) => [name, '[redacted]'])),
        }
      : {}),
  };
  return Object.defineProperties(redacted, {
    toJSON: {
      value: () => ({
        baseUrl: redacted.baseUrl,
        authHeaderNames: headers === undefined ? [] : Object.keys(headers),
      }),
      enumerable: false,
    },
    toString: {
      value: () => `ProxyConfiguration(baseUrl: ${redacted.baseUrl}, authHeaders: <redacted>)`,
      enumerable: false,
    },
  });
}

export const TraciveMode: {
  oauth(config: OAuthConfiguration): TraciveMode;
  proxy(config: ProxyConfiguration): TraciveMode;
} = {
  oauth(config: OAuthConfiguration): TraciveMode {
    return { type: 'oauth', config };
  },
  proxy(config: ProxyConfiguration): TraciveMode {
    return { type: 'proxy', config };
  },
};

/**
 * Wraps a proxy configuration so that `JSON.stringify` and string interpolation cannot print an
 * authorization header value. Exported for the client and for the redaction suite.
 */
export function redactedProxyConfiguration(config: ProxyConfiguration): ProxyConfiguration {
  return redactProxyConfiguration(config);
}

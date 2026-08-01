export type TraciveEnvironment =
  | { readonly type: 'production' }
  | { readonly type: 'sandbox' }
  | { readonly type: 'custom'; readonly baseUrl: string };

const PRODUCTION: TraciveEnvironment = { type: 'production' };
const SANDBOX: TraciveEnvironment = { type: 'sandbox' };

const PRODUCTION_BASE_URL = 'https://api.tracive.id/v1';
const SANDBOX_BASE_URL = 'https://api-sandbox.tracive.id/v1';

const PRODUCTION_AUTHORIZE_URL = 'https://tracive.id/oauth/authorize';
const SANDBOX_AUTHORIZE_URL = 'https://sandbox.tracive.id/oauth/authorize';

/**
 * Where the authorization request is opened.
 *
 * **This is not on the API host, and it cannot be derived from the base URL.** `api.tracive.id/v1`
 * answers the data calls; the authorize URL points at `tracive.id`, because that is the origin the
 * shipping Tracive app claims as an App Link and a Universal Link. Anything else — a different
 * host, or a custom scheme — opens a web page or nothing at all, and the consent flow cannot
 * complete. This SDK opened `tracive://authorize` until 2 August 2026, which no Tracive build has
 * ever registered.
 *
 * A custom environment appends the path to its own base URL: a partner proxy or a local server is
 * whatever the integrator points it at, and no app claims it either way.
 */
function authorizeUrl(environment: TraciveEnvironment): string {
  switch (environment.type) {
    case 'production':
      return PRODUCTION_AUTHORIZE_URL;
    case 'sandbox':
      return SANDBOX_AUTHORIZE_URL;
    case 'custom':
      return `${environment.baseUrl.replace(/\/+$/, '')}/oauth/authorize`;
  }
}

function baseUrl(environment: TraciveEnvironment): string {
  switch (environment.type) {
    case 'production':
      return PRODUCTION_BASE_URL;
    case 'sandbox':
      return SANDBOX_BASE_URL;
    case 'custom':
      return environment.baseUrl.replace(/\/+$/, '');
  }
}

export const TraciveEnvironment: {
  readonly production: TraciveEnvironment;
  readonly sandbox: TraciveEnvironment;
  custom(baseUrl: string): TraciveEnvironment;
  baseUrl(environment: TraciveEnvironment): string;
  authorizeUrl(environment: TraciveEnvironment): string;
} = {
  production: PRODUCTION,
  sandbox: SANDBOX,
  custom(url: string): TraciveEnvironment {
    return { type: 'custom', baseUrl: url };
  },
  baseUrl,
  authorizeUrl,
};

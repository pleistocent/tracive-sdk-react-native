export type TraciveEnvironment =
  | { readonly type: 'production' }
  | { readonly type: 'sandbox' }
  | { readonly type: 'custom'; readonly baseUrl: string };

const PRODUCTION: TraciveEnvironment = { type: 'production' };
const SANDBOX: TraciveEnvironment = { type: 'sandbox' };

const PRODUCTION_BASE_URL = 'https://api.tracive.id/v1';
const SANDBOX_BASE_URL = 'https://api-sandbox.tracive.id/v1';

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
} = {
  production: PRODUCTION,
  sandbox: SANDBOX,
  custom(url: string): TraciveEnvironment {
    return { type: 'custom', baseUrl: url };
  },
  baseUrl,
};

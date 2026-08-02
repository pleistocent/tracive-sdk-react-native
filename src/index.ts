/**
 * `@tracive/sdk-react-native` — the entire public surface.
 *
 * Anything not re-exported here is internal and may change without a major version.
 *
 * Three things to know before reading further:
 * - The Tracive API is not live yet. This package is the client half of a contract.
 * - There is no API key anywhere in this surface, in either mode. Authorization is OAuth 2.0
 *   with PKCE, performed by the Tracive app on the same device.
 * - Every check is billed, including one that finds nothing. That is why the query builders
 *   reject a malformed identifier locally, and why the cache is a billing feature.
 */

// ---------------------------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------------------------
export { TraciveQuery } from './query/TraciveQuery';
export { normalizePhoneNumber } from './query/phoneNumbers';
export { COUNTRIES, countryFromAlpha3 } from './query/countries';
export type { CountryInfo, CountryAlpha3 } from './query/countries';
export {
  TraciveQueryError,
  isTraciveQueryError,
  type QueryRejectionReason,
} from './query/TraciveQueryError';

// ---------------------------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------------------------
export {
  CLIENT_TYPES,
  DETAILS,
  ORIGINS,
  QUERY_KINDS,
  RISK_TIERS,
  SOURCES,
  type ClientType,
  type CreditSource,
  type Detail,
  type Origin,
  type QueryKind,
  type RiskTier,
  type Source,
} from './model/enums';

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------
export type { Billing } from './model/Billing';
export type { Chronology } from './model/Chronology';
export type { Comment } from './model/Comment';
export { toCacheableCopy, type CheckResult } from './model/CheckResult';
export type { CreditsInfo } from './model/CreditsInfo';
export type { ProfileInfo } from './model/ProfileInfo';
export { CachePolicy } from './model/CachePolicy';
export { TraciveEnvironment } from './model/TraciveEnvironment';
export { TraciveMode, type OAuthConfiguration, type ProxyConfiguration } from './model/TraciveMode';
export { TraciveScopes, type TraciveScope } from './model/scopes';

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------
export {
  isTraciveError,
  TraciveError,
  traciveErrorFrom,
  type InsufficientCreditsKind,
  type TraciveErrorInfo,
  type TraciveErrorKind,
} from './model/TraciveError';
export {
  isTraciveConfigurationError,
  TraciveConfigurationError,
} from './model/TraciveConfigurationError';
export {
  CheckCacheError,
  isCheckCacheError,
  type CheckCacheErrorKind,
} from './cache/CheckCacheError';

// ---------------------------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------------------------
export type { AuthResult, TraciveTokens } from './model/AuthResult';
export { InMemoryTokenStore, type TokenStore } from './oauth/TokenStore';
export type { AppPresenceProbe } from './oauth/AppPresenceProbe';
export type { AuthorizeLauncher } from './oauth/AuthorizeLauncher';
export {
  InMemoryPendingAuthorizationStore,
  type PendingAuthorization,
  type PendingAuthorizationStore,
} from './oauth/PendingAuthorization';
export { TraciveOAuth, type TraciveOAuthOptions } from './oauth/TraciveOAuth';

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------
export { CheckCacheKey } from './cache/CheckCacheKey';
export { InMemoryCheckCache, NoOpCheckCache, type CheckCache } from './cache/CheckCache';
export type { CachedRow, CheckCacheStore } from './cache/CheckCacheStore';
export { InMemoryCacheKeyStore, type CacheKeyStore } from './cache/CacheKeyStore';
export { AesGcmCacheCipher, type CacheCipher } from './cache/CacheCipher';
export {
  PersistentCheckCache,
  type PersistentCheckCacheOptions,
} from './cache/PersistentCheckCache';

// ---------------------------------------------------------------------------------------------
// Ports and transport
// ---------------------------------------------------------------------------------------------
export {
  FetchHttpTransport,
  type HttpMethod,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from './client/HttpTransport';
export { systemClock, type TraciveClock } from './client/TraciveClock';
export { defaultRandom, type TraciveRandom } from './crypto/random';
export { RetryPolicy } from './client/RetryPolicy';
export type { Diagnostic } from './diagnostics';

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------
export {
  TraciveClient,
  type CheckScammerOptions,
  type TraciveClientOptions,
} from './client/TraciveClient';

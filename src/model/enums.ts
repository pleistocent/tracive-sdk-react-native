/**
 * Every enumeration in this SDK is a string-literal union plus a frozen array for iteration.
 *
 * A TypeScript `enum` is nominally typed, hostile to `JSON.parse` output and creates friction
 * under `isolatedModules`, so a value decoded from the wire could not be assigned to it without
 * a cast. Literal unions round-trip through JSON for free.
 */

export const RISK_TIERS = ['HIGH', 'ELEVATED', 'CAUTION', 'NONE'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const ORIGINS = ['CACHE', 'SERVER'] as const;
export type Origin = (typeof ORIGINS)[number];

/** Lowercase on purpose: these are the wire values, not display names. */
export const DETAILS = ['minimal', 'full'] as const;
export type Detail = (typeof DETAILS)[number];

export const SOURCES = ['CACHE_FIRST', 'SERVER', 'SERVER_FIRST', 'CACHE'] as const;
export type Source = (typeof SOURCES)[number];

export const CLIENT_TYPES = ['PUBLIC', 'CONFIDENTIAL'] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

/**
 * Open union: an unknown credit source is bookkeeping metadata, so it is carried through rather
 * than failing an entire fraud check. `(string & {})` keeps literal autocomplete working.
 */
export type CreditSource = 'USER' | 'PARTNER' | (string & {});

export const QUERY_KINDS = ['PHONE', 'EMAIL', 'BANK', 'CRYPTO', 'USERNAME'] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

export function isRiskTier(value: unknown): value is RiskTier {
  return typeof value === 'string' && (RISK_TIERS as readonly string[]).includes(value);
}

export function isOrigin(value: unknown): value is Origin {
  return typeof value === 'string' && (ORIGINS as readonly string[]).includes(value);
}

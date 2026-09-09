import type { Billing } from '../model/Billing';
import { CachePolicy } from '../model/CachePolicy';
import type { CheckResult } from '../model/CheckResult';
import { isRiskTier } from '../model/enums';
import { CheckCacheError } from './CheckCacheError';

/**
 * The persisted projection of a result. Dates become epoch milliseconds, because a JSON date
 * string reintroduces a parsing question that a number does not have.
 */
interface StoredResult {
  found: boolean;
  riskTier: string;
  reportTotal: number;
  credibleReports: number;
  ambiguousReports: number;
  firstReportOnMs?: number;
  lastReportOnMs?: number;
  fraudAmount: Record<string, number>;
  tags: string[];
  relatedScammerCount: number;
  cacheTtlSeconds?: number;
  disclaimer?: string;
  fetchedAtMs: number;
}

export function encodeCacheableResult(result: CheckResult): string {
  const stored: StoredResult = {
    found: result.found,
    riskTier: result.riskTier,
    reportTotal: result.reportTotal,
    credibleReports: result.credibleReports,
    ambiguousReports: result.ambiguousReports,
    ...(result.firstReportOn !== undefined
      ? { firstReportOnMs: result.firstReportOn.getTime() }
      : {}),
    ...(result.lastReportOn !== undefined ? { lastReportOnMs: result.lastReportOn.getTime() } : {}),
    fraudAmount: { ...result.fraudAmount },
    tags: [...result.tags],
    relatedScammerCount: result.relatedScammerCount,
    ...(result.cacheTtlSeconds !== undefined ? { cacheTtlSeconds: result.cacheTtlSeconds } : {}),
    ...(result.disclaimer !== undefined ? { disclaimer: result.disclaimer } : {}),
    fetchedAtMs: result.fetchedAt.getTime(),
  };
  return JSON.stringify(stored);
}

export function decodeCacheableResult(json: string): CheckResult {
  let parsed: StoredResult;
  try {
    parsed = JSON.parse(json) as StoredResult;
  } catch (cause) {
    throw new CheckCacheError('payloadUnreadable', 'The cache record is not valid JSON.', cause);
  }
  if (typeof parsed?.found !== 'boolean' || !isRiskTier(parsed.riskTier)) {
    throw new CheckCacheError(
      'payloadUnreadable',
      'The cache record is missing a field this SDK version requires.',
    );
  }
  return {
    found: parsed.found,
    riskTier: parsed.riskTier,
    reportTotal: parsed.reportTotal ?? 0,
    credibleReports: parsed.credibleReports ?? 0,
    ambiguousReports: parsed.ambiguousReports ?? 0,
    ...(parsed.firstReportOnMs !== undefined
      ? { firstReportOn: new Date(parsed.firstReportOnMs) }
      : {}),
    ...(parsed.lastReportOnMs !== undefined
      ? { lastReportOn: new Date(parsed.lastReportOnMs) }
      : {}),
    fraudAmount: parsed.fraudAmount ?? {},
    tags: parsed.tags ?? [],
    relatedScammerCount: parsed.relatedScammerCount ?? 0,
    ...(parsed.cacheTtlSeconds !== undefined ? { cacheTtlSeconds: parsed.cacheTtlSeconds } : {}),
    ...(parsed.disclaimer !== undefined ? { disclaimer: parsed.disclaimer } : {}),
    // A replay is always labelled as one, whatever the stored bytes claim.
    origin: 'CACHE',
    fetchedAt: new Date(parsed.fetchedAtMs ?? 0),
  };
}

/** [StoredResult] plus the three fields a record keeps and a cache entry does not. */
interface StoredRecord extends StoredResult {
  checkId?: string;
  billing?: Billing;
  origin?: string;
}

/**
 * A transaction record on its way to disk.
 *
 * Separate from {@link encodeCacheableResult} rather than a flag on it, because the two projections
 * differ in the direction that matters: this one keeps `checkId`, `billing` and the original
 * `origin`, and a single function with a boolean would make the wrong one a typo away.
 */
export function encodeTransactionRecord(result: CheckResult): string {
  const stored: StoredRecord = {
    ...(JSON.parse(encodeCacheableResult(result)) as StoredResult),
    ...(result.checkId !== undefined ? { checkId: result.checkId } : {}),
    ...(result.billing !== undefined ? { billing: result.billing } : {}),
    origin: result.origin,
  };
  return JSON.stringify(stored);
}

/**
 * A transaction record on the way back.
 *
 * The stored `origin` is kept rather than replaced with `'CACHE'`. That is the one difference from
 * {@link decodeCacheableResult} and it is load-bearing: a record made from a live check says a
 * credit was spent on that transfer, and one made from a cache hit says none was.
 */
export function decodeTransactionRecord(json: string): CheckResult {
  const base = decodeCacheableResult(json);
  const parsed = JSON.parse(json) as StoredRecord;
  return {
    ...base,
    ...(typeof parsed.checkId === 'string' ? { checkId: parsed.checkId } : {}),
    ...(parsed.billing !== undefined ? { billing: parsed.billing } : {}),
    origin: parsed.origin === 'SERVER' ? 'SERVER' : 'CACHE',
  };
}

/**
 * The absolute expiry a result should be stored with, in epoch milliseconds.
 *
 * A value already in the past is returned as-is rather than clamped forward: an entry that was
 * born stale must read as stale, not enjoy a moment of validity.
 */
export function expiresAtMsFor(policy: CachePolicy, result: CheckResult): number {
  return result.fetchedAt.getTime() + CachePolicy.effectiveTtlSeconds(policy, result) * 1000;
}

import type { Billing } from './Billing';
import type { Chronology } from './Chronology';
import type { Comment } from './Comment';
import type { Origin, RiskTier } from './enums';

export interface CheckResult {
  /** Absent on a cache hit: nothing was checked, so there is no check to identify. */
  readonly checkId?: string;
  readonly found: boolean;
  readonly riskTier: RiskTier;
  readonly reportTotal: number;
  readonly credibleReports: number;
  readonly ambiguousReports: number;
  readonly firstReportOn?: Date;
  readonly lastReportOn?: Date;
  /** Keyed by currency code, e.g. `{ IDR: 12500000 }`. */
  readonly fraudAmount: Readonly<Record<string, number>>;
  readonly tags: readonly string[];
  /** A count, never a list — the SDK never returns other people's identifiers. */
  readonly relatedScammerCount: number;
  /** `detail: 'full'` only. */
  readonly topChronologies?: readonly Chronology[];
  /** `detail: 'full'` only. */
  readonly comments?: readonly Comment[];
  /** Absent on a cache hit, because a hit is free. */
  readonly billing?: Billing;
  /** A server-side TTL override that replaces the per-tier default. */
  readonly cacheTtlSeconds?: number;
  /** Legal text that MUST be surfaced in any UI built on this result. */
  readonly disclaimer?: string;
  readonly origin: Origin;
  /** The age of the DATA, not of the answer: on a cache hit this is when the check ran. */
  readonly fetchedAt: Date;
}

/**
 * The projection that is safe to persist.
 *
 * Four fields are dropped rather than stored. `topChronologies` and `comments` are free-text
 * reports about third parties and do not belong in a partner app's local database; `billing`
 * describes one transaction and would be a lie if replayed against a later cache hit; `checkId`
 * identifies a check that a cache hit did not perform. `origin` is rewritten to `'CACHE'` so a
 * caller can always tell a replay from a fresh answer.
 *
 * If a future version ever caches full detail, the cache key must become
 * `(query, detail, locale)` — a `minimal` result must never satisfy a `full` request.
 */
export function toCacheableCopy(result: CheckResult): CheckResult {
  return {
    found: result.found,
    riskTier: result.riskTier,
    reportTotal: result.reportTotal,
    credibleReports: result.credibleReports,
    ambiguousReports: result.ambiguousReports,
    ...(result.firstReportOn !== undefined ? { firstReportOn: result.firstReportOn } : {}),
    ...(result.lastReportOn !== undefined ? { lastReportOn: result.lastReportOn } : {}),
    fraudAmount: result.fraudAmount,
    tags: result.tags,
    relatedScammerCount: result.relatedScammerCount,
    ...(result.cacheTtlSeconds !== undefined ? { cacheTtlSeconds: result.cacheTtlSeconds } : {}),
    ...(result.disclaimer !== undefined ? { disclaimer: result.disclaimer } : {}),
    origin: 'CACHE',
    fetchedAt: result.fetchedAt,
  };
}

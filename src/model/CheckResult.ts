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
  /**
   * The month of the earliest matching report, as `"YYYY-MM"` (e.g. `"2026-06"`). A display
   * string, not an instant, like {@link Chronology.incidentDate}. Show the month and year only
   * (e.g. "Jun 2026"): an exact date could help identify the reporter, so the server never sends
   * one.
   */
  readonly firstReportOn?: string;
  /**
   * The month of the most recent matching report, as `"YYYY-MM"`. Month and year only, exactly
   * like `firstReportOn`.
   */
  readonly lastReportOn?: string;
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
 * What this projection cannot enforce for itself is the constraint that makes it safe to store at
 * all: `tags` and `disclaimer` come back in the requested language, and the row key is the folded
 * identifier alone with no locale in it. `TraciveClient.checkScammer` holds the other half of the
 * rule — only a `minimal` result is ever written, and `minimal` is the one detail level that sends
 * no locale. If a future version ever caches full detail, the cache key must become
 * `(query, detail, locale)` first: a `minimal` result must never satisfy a `full` request.
 */
/**
 * The projection that is safe to keep against a transaction.
 *
 * A transaction record is read back under the transaction it was filed for and never under another
 * request, so almost everything survives — including the fields `toCacheableCopy` drops for reasons
 * that do not apply here. `checkId` and `billing` describe one call, which is exactly what this
 * record is; keeping them is what lets a support agent reconcile the charge and a UI say whether
 * that transfer spent a credit. `origin` and `fetchedAt` are kept as they are, not restamped,
 * because the record is a statement about a past moment: a second transfer to an account already
 * checked was served from the cache, spent nothing, and should say so.
 *
 * `topChronologies` and `comments` go, and that is the one deliberate loss. They are other people's
 * accounts of being defrauded, written in prose; a record lives for months rather than hours, and
 * nothing on a transaction-detail screen shows them.
 */
export function toTransactionRecordCopy(result: CheckResult): CheckResult {
  return {
    ...(result.checkId !== undefined ? { checkId: result.checkId } : {}),
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
    ...(result.billing !== undefined ? { billing: result.billing } : {}),
    ...(result.disclaimer !== undefined ? { disclaimer: result.disclaimer } : {}),
    origin: result.origin,
    fetchedAt: result.fetchedAt,
  };
}

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
    ...(result.disclaimer !== undefined ? { disclaimer: result.disclaimer } : {}),
    origin: 'CACHE',
    fetchedAt: result.fetchedAt,
  };
}

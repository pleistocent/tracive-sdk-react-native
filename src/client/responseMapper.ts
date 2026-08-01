import type { Billing } from '../model/Billing';
import type { CheckResult } from '../model/CheckResult';
import type { Chronology } from '../model/Chronology';
import type { Comment } from '../model/Comment';
import type { CreditsInfo } from '../model/CreditsInfo';
import { isRiskTier, type RiskTier } from '../model/enums';
import type { ProfileInfo } from '../model/ProfileInfo';
import { TraciveError } from '../model/TraciveError';

/**
 * Unknown KEYS are ignored so a future-version server can add fields without breaking shipped
 * apps. Unknown enum VALUES are not: `found` and `riskTier` are what every caller decision rests
 * on, so a payload missing or mangling either is broken rather than merely newer.
 *
 * Quietly mapping an unrecognised future tier onto `NONE` would understate risk in a
 * fraud-warning UI — expensive, and invisible until somebody loses money. A decode error is loud
 * and is fixed by shipping an update.
 */
function requireRiskTier(value: unknown): RiskTier {
  if (!isRiskTier(value)) {
    throw new TraciveError({
      kind: 'server',
      message:
        `The server returned an unrecognised risk tier (${JSON.stringify(value)}). This SDK ` +
        'version cannot interpret it, and guessing would understate risk.',
    });
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asDate(value: unknown): Date | undefined {
  const text = asString(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : new Date(parsed);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asAmounts(value: unknown): Record<string, number> {
  const source = asRecord(value);
  const out: Record<string, number> = {};
  for (const [currency, amount] of Object.entries(source)) {
    if (typeof amount === 'number' && Number.isFinite(amount)) out[currency] = amount;
  }
  return out;
}

function decodeChronologies(value: unknown): Chronology[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const record = asRecord(entry);
    const incidentDate = asString(record.incidentDate);
    return {
      chronology: asString(record.chronology) ?? '',
      riskLevel: asNumber(record.riskLevel, 0),
      ...(incidentDate !== undefined ? { incidentDate } : {}),
    };
  });
}

function decodeComments(value: unknown): Comment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => {
    const record = asRecord(entry);
    return {
      date: asString(record.date) ?? '',
      text: asString(record.text) ?? '',
      fromCredibleReport: record.fromCredibleReport === true,
    };
  });
}

function decodeBilling(value: unknown): Billing | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = asRecord(value);
  const remaining = record.partnerBalanceRemaining;
  return {
    creditSource: asString(record.creditSource) ?? 'USER',
    unitsCharged: asNumber(record.unitsCharged, 0),
    ...(typeof remaining === 'number' ? { partnerBalanceRemaining: remaining } : {}),
  };
}

/**
 * `origin` and `fetchedAt` are stamped locally because the server sends neither. `fetchedAt` uses
 * the SAME clock the TTL is measured against, so a device with a skewed system time cannot
 * produce an entry that is eternally fresh, or instantly stale, relative to its own expiry.
 */
export function decodeCheckResult(body: unknown, nowMs: number): CheckResult {
  const record = asRecord(body);
  if (typeof record.found !== 'boolean') {
    throw new TraciveError({
      kind: 'server',
      message: 'The check response did not include a `found` flag.',
    });
  }

  const checkId = asString(record.checkId);
  const firstReportOn = asDate(record.firstReportOn);
  const lastReportOn = asDate(record.lastReportOn);
  const chronologies = decodeChronologies(record.topChronologies);
  const comments = decodeComments(record.comments);
  const billing = decodeBilling(record.billing);
  const cacheTtlSeconds = record.cacheTtlSeconds;
  const disclaimer = asString(record.disclaimer);

  return {
    ...(checkId !== undefined ? { checkId } : {}),
    found: record.found,
    riskTier: requireRiskTier(record.riskTier),
    reportTotal: asNumber(record.reportTotal, 0),
    credibleReports: asNumber(record.credibleReports, 0),
    ambiguousReports: asNumber(record.ambiguousReports, 0),
    ...(firstReportOn !== undefined ? { firstReportOn } : {}),
    ...(lastReportOn !== undefined ? { lastReportOn } : {}),
    fraudAmount: asAmounts(record.fraudAmount),
    tags: asStringArray(record.tags),
    relatedScammerCount: asNumber(record.relatedScammerCount, 0),
    ...(chronologies !== undefined ? { topChronologies: chronologies } : {}),
    ...(comments !== undefined ? { comments } : {}),
    ...(billing !== undefined ? { billing } : {}),
    ...(typeof cacheTtlSeconds === 'number' ? { cacheTtlSeconds } : {}),
    ...(disclaimer !== undefined ? { disclaimer } : {}),
    origin: 'SERVER',
    fetchedAt: new Date(nowMs),
  };
}

export function decodeCreditsInfo(body: unknown): CreditsInfo {
  const record = asRecord(body);
  const nextResetAt = asDate(record.nextResetAt);
  return {
    subscriptionCredits: asNumber(record.subscriptionCredits, 0),
    tier: asString(record.tier) ?? '',
    ...(nextResetAt !== undefined ? { nextResetAt } : {}),
  };
}

/**
 * `sub` is a pairwise pseudonymous identifier and `name` is a real person's name, so the decoded
 * object carries a redacting `toJSON`. Without it a single breadcrumb turns a profile read into
 * a privacy incident.
 */
export function decodeProfileInfo(body: unknown): ProfileInfo {
  const record = asRecord(body);
  const sub = asString(record.sub);
  if (sub === undefined) {
    throw new TraciveError({
      kind: 'server',
      message: 'The profile response did not include a subject identifier.',
    });
  }
  const name = asString(record.name);
  const country = asString(record.country);
  const tier = asString(record.tier);
  const memberSince = asDate(record.memberSince);

  const profile: ProfileInfo = {
    sub,
    ...(name !== undefined ? { name } : {}),
    ...(country !== undefined ? { country } : {}),
    ...(tier !== undefined ? { tier } : {}),
    ...(memberSince !== undefined ? { memberSince } : {}),
  };

  return Object.defineProperties(profile, {
    toJSON: {
      value: () => ({
        sub: '[redacted]',
        ...(name !== undefined ? { name: '[redacted]' } : {}),
        ...(country !== undefined ? { country } : {}),
        ...(tier !== undefined ? { tier } : {}),
        ...(memberSince !== undefined ? { memberSince: memberSince.toISOString() } : {}),
      }),
      enumerable: false,
    },
    toString: {
      value: () => `ProfileInfo(sub: <redacted>, tier: ${tier ?? 'unknown'})`,
      enumerable: false,
    },
  });
}

/**
 * `JSON.parse` for a body the server said was a success.
 *
 * Unguarded, a truncated payload or an HTML gateway/captive-portal page served with a 200 threw a
 * plain `SyntaxError`. That is neither a TraciveError nor a CheckCacheError nor a
 * TraciveQueryError, so `isTraciveError(e)` was false and every documented error path missed it;
 * worse, `SERVER_FIRST`'s cache fallback tests `instanceof TraciveError` and rethrew, so the
 * cache did not engage for exactly the failure where it would have helped. And the check had
 * already been charged.
 *
 * An empty body is deliberately still an empty object: a 204-shaped answer is not malformed.
 * `extractErrorFields` swallows a parse failure instead, which is right on the error path — there
 * is already a status to report there, and nothing more to learn from the body.
 */
export function parseSuccessBody(body: string, status: number): unknown {
  try {
    return JSON.parse(body || '{}');
  } catch (cause) {
    throw new TraciveError({
      kind: 'server',
      status,
      message: 'The server returned a body that is not JSON.',
      cause,
    });
  }
}

export function extractErrorFields(body: string): {
  code?: string;
  message?: string;
  checkId?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  const record = asRecord(parsed);
  const nested = asRecord(record.error);
  const code = asString(record.code) ?? asString(nested.code) ?? asString(record.error);
  const message = asString(record.message) ?? asString(nested.message);
  const checkId = asString(record.checkId) ?? asString(nested.checkId);
  return {
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(checkId !== undefined ? { checkId } : {}),
  };
}

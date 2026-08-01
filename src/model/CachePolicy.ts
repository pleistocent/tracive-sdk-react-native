import type { CheckResult } from './CheckResult';
import type { RiskTier } from './enums';

/**
 * Every duration carries a `Seconds` suffix. JavaScript has no `Duration` type, so a bare
 * `highTtl: number` is ambiguous between seconds and milliseconds and a 1000x TTL bug is both
 * silent and expensive. The suffix is worth breaking literal name parity with the other SDKs.
 */
export interface CachePolicy {
  readonly enabled: boolean;
  readonly highTtlSeconds: number;
  readonly elevatedTtlSeconds: number;
  readonly cautionTtlSeconds: number;
  readonly noneTtlSeconds: number;
  /** The fleet-wide invalidation lever. Leave it on. */
  readonly honorsServerTtlOverride: boolean;
  /**
   * The cap on stored entries, enforced on every write and by `prune()`.
   *
   * It defaults to 5000, the same number the Flutter SDK uses. It used to be absent by default,
   * which meant unbounded: an encrypted database on a user's phone gaining a row for every
   * identifier ever checked and never losing one, for as long as the app stayed installed. A
   * thirty-day HIGH TTL means expiry alone does not bound it either.
   *
   * Eviction drops the entries CLOSEST TO EXPIRY first, because those have the least value left:
   * a one-hour NONE verdict goes before a thirty-day HIGH one, which is also the more expensive
   * of the two to have to buy again. It is deliberately not least-recently-used — LRU needs a
   * write on every cache hit, which turns the cheap path into the expensive one.
   *
   * `undefined` still means unbounded, but `create()` cannot get you there: an override of
   * `undefined` is treated as "not overridden". Writing the policy object out by hand and
   * omitting the field is the only way to ask for an unbounded cache, which is intentional.
   */
  readonly maxEntries?: number;
}

const DEFAULT_POLICY: CachePolicy = {
  enabled: true,
  highTtlSeconds: 2_592_000,
  elevatedTtlSeconds: 604_800,
  cautionTtlSeconds: 86_400,
  noneTtlSeconds: 3_600,
  honorsServerTtlOverride: true,
  maxEntries: 5_000,
};

const DISABLED_POLICY: CachePolicy = { ...DEFAULT_POLICY, enabled: false };

function ttlSecondsFor(policy: CachePolicy, tier: RiskTier): number {
  switch (tier) {
    case 'HIGH':
      return policy.highTtlSeconds;
    case 'ELEVATED':
      return policy.elevatedTtlSeconds;
    case 'CAUTION':
      return policy.cautionTtlSeconds;
    case 'NONE':
      return policy.noneTtlSeconds;
  }
}

/**
 * A negative TTL clamps to zero. "Immediately stale" is the only safe reading of a nonsense
 * value; the alternative arithmetic would make the entry eternally fresh.
 */
function effectiveTtlSeconds(policy: CachePolicy, result: CheckResult): number {
  const override = result.cacheTtlSeconds;
  if (policy.honorsServerTtlOverride && override !== undefined) {
    return Math.max(0, override);
  }
  return Math.max(0, ttlSecondsFor(policy, result.riskTier));
}

function isFresh(policy: CachePolicy, result: CheckResult, nowMs: number): boolean {
  const ttlSeconds = effectiveTtlSeconds(policy, result);
  if (ttlSeconds <= 0) return false;
  return nowMs < result.fetchedAt.getTime() + ttlSeconds * 1000;
}

function create(overrides?: Partial<CachePolicy>): CachePolicy {
  if (overrides === undefined) return DEFAULT_POLICY;
  const merged: Record<string, unknown> = { ...DEFAULT_POLICY };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as unknown as CachePolicy;
}

export const CachePolicy: {
  readonly default: CachePolicy;
  readonly disabled: CachePolicy;
  create(overrides?: Partial<CachePolicy>): CachePolicy;
  ttlSecondsFor(policy: CachePolicy, tier: RiskTier): number;
  effectiveTtlSeconds(policy: CachePolicy, result: CheckResult): number;
  isFresh(policy: CachePolicy, result: CheckResult, nowMs: number): boolean;
} = {
  default: DEFAULT_POLICY,
  disabled: DISABLED_POLICY,
  create,
  ttlSecondsFor,
  effectiveTtlSeconds,
  isFresh,
};

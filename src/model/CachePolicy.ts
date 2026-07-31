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
  /** `undefined` means unbounded. */
  readonly maxEntries?: number;
}

const DEFAULT_POLICY: CachePolicy = {
  enabled: true,
  highTtlSeconds: 2_592_000,
  elevatedTtlSeconds: 604_800,
  cautionTtlSeconds: 86_400,
  noneTtlSeconds: 3_600,
  honorsServerTtlOverride: true,
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

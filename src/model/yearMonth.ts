const YEAR_MONTH_PREFIX = /^\d{4}-(0[1-9]|1[0-2])/;

/**
 * Keeps only the `"YYYY-MM"` prefix, so a full ISO date-time from an older server still yields
 * the month and never a day. Anything else is `undefined`.
 */
export function toYearMonth(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return YEAR_MONTH_PREFIX.test(value) ? value.slice(0, 7) : undefined;
}

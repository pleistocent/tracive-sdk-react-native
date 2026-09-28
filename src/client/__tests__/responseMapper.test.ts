import { describe, expect, it } from '@jest/globals';

import { checkResponseBody } from '../../__tests__/support/fakes';
import { decodeCheckResult } from '../responseMapper';

describe('report months', () => {
  it('keeps a "YYYY-MM" month as sent', () => {
    const result = decodeCheckResult(
      checkResponseBody({ firstReportOn: '2025-11', lastReportOn: '2026-07' }),
      0,
    );
    expect(result.firstReportOn).toBe('2025-11');
    expect(result.lastReportOn).toBe('2026-07');
  });

  it('trims a legacy ISO date-time from an older server to its month', () => {
    const result = decodeCheckResult(
      checkResponseBody({
        firstReportOn: '2025-11-15T12:00:00.000Z',
        lastReportOn: '2026-06-15T12:00:00.000Z',
      }),
      0,
    );
    expect(result.firstReportOn).toBe('2025-11');
    expect(result.lastReportOn).toBe('2026-06');
  });

  it.each([['garbage'], ['2026-13'], ['26-06'], [''], [202606], [null]])(
    'drops %p rather than inventing a month',
    (value) => {
      const result = decodeCheckResult(
        checkResponseBody({ firstReportOn: value, lastReportOn: value }),
        0,
      );
      expect(result).not.toHaveProperty('firstReportOn');
      expect(result).not.toHaveProperty('lastReportOn');
    },
  );

  it('leaves both absent when the server omits them', () => {
    const result = decodeCheckResult(checkResponseBody(), 0);
    expect(result).not.toHaveProperty('firstReportOn');
    expect(result).not.toHaveProperty('lastReportOn');
  });
});

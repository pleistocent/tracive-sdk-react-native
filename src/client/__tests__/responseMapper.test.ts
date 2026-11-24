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

describe('QRIS details and the right of reply', () => {
  const QRIS_HIT = {
    checkId: 'chk_4d2c0b9a8e7f6a5b4c3d',
    found: true,
    riskTier: 'CAUTION',
    reportTotal: 2,
    credibleReports: 1,
    ambiguousReports: 1,
    firstReportOn: '2026-08',
    lastReportOn: '2026-09',
    fraudAmount: { IDR: 350000 },
    tags: ['barang tidak dikirim'],
    relatedScammerCount: 0,
    qris: {
      merchantName: 'TOKO CONTOH',
      city: 'JAKARTA',
      criteria: 'UMI',
      acquirer: 'ID.DANA.WWW',
    },
    rightOfReply: { text: 'Kami pemilik usaha ini.', language: 'id' },
    billing: { creditSource: 'USER', unitsCharged: 1 },
    disclaimer:
      'This information is indicative, based on community reports, and is not a legal verdict. ' +
      'For a QRIS, show it to the user as a warning before they pay; never use it to block or ' +
      'hold a payment automatically.',
  };

  it('decodes both, exactly as sent', () => {
    const result = decodeCheckResult(QRIS_HIT, 0);
    expect(result.qris).toEqual({
      merchantName: 'TOKO CONTOH',
      city: 'JAKARTA',
      criteria: 'UMI',
      acquirer: 'ID.DANA.WWW',
    });
    expect(result.rightOfReply).toEqual({ text: 'Kami pemilik usaha ini.', language: 'id' });
    expect(result.riskTier).toBe('CAUTION');
  });

  it('carries a criteria it has never seen rather than failing the check', () => {
    const result = decodeCheckResult({ ...QRIS_HIT, qris: { criteria: 'UXX', city: 7 } }, 0);
    expect(result.qris).toEqual({ criteria: 'UXX' });
  });

  it('keeps a reply that names no language, and drops one with no text', () => {
    expect(
      decodeCheckResult({ ...QRIS_HIT, rightOfReply: { text: 'Kami pemilik.' } }, 0).rightOfReply,
    ).toEqual({ text: 'Kami pemilik.', language: '' });
    expect(
      decodeCheckResult({ ...QRIS_HIT, rightOfReply: { language: 'id' } }, 0),
    ).not.toHaveProperty('rightOfReply');
  });

  it('leaves both absent on a result that is not a QRIS hit', () => {
    const result = decodeCheckResult(checkResponseBody({ qris: null, rightOfReply: 'text' }), 0);
    expect(result).not.toHaveProperty('qris');
    expect(result).not.toHaveProperty('rightOfReply');
  });
});

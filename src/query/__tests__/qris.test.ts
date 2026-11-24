import { describe, expect, it } from '@jest/globals';

import { CheckCacheKey } from '../../cache/CheckCacheKey';
import { qrisCrc } from '../qris';
import { TraciveQuery } from '../TraciveQuery';
import { TraciveQueryError } from '../TraciveQueryError';

/** One TLV field, its length counted in UTF-16 units. */
function tlv(tag: string, value: string): string {
  return `${tag}${String(value.length).padStart(2, '0')}${value}`;
}

/** A payload with a valid CRC, so a test reaches the rule it is about. */
function payload(...fields: string[]): string {
  const body = `000201${fields.join('')}6304`;
  return `${body}${qrisCrc(body)}`;
}

function nationalTemplate(criteria: string): string {
  return tlv(
    '51',
    tlv('00', 'ID.CO.QRIS.WWW') + tlv('02', 'ID1020000000033') + tlv('03', criteria),
  );
}

function acquirerTemplate(tag: string, criteria: string): string {
  return tlv(
    tag,
    tlv('00', 'ID.CO.EXAMPLE.WWW') + tlv('01', '936000990000000017') + tlv('03', criteria),
  );
}

function reasonOf(build: () => unknown): string | undefined {
  try {
    build();
    return undefined;
  } catch (error) {
    if (error instanceof TraciveQueryError) return error.reason;
    throw error;
  }
}

describe('the QRIS builders', () => {
  it('are all of kind QRIS', () => {
    expect(TraciveQuery.qris(payload(nationalTemplate('UMI'))).kind).toBe('QRIS');
    expect(TraciveQuery.qrisNmid('ID1020000000033').kind).toBe('QRIS');
    expect(TraciveQuery.qrisPan('936009143100000003').kind).toBe('QRIS');
  });

  it('give a payload and its NMID one cache entry, and its PAN another', () => {
    const byPayload = TraciveQuery.qris(payload(nationalTemplate('UMI')));
    const byNmid = TraciveQuery.qrisNmid('ID1020000000033');
    const byPan = TraciveQuery.qrisPan('936009143100000003');
    expect(byPayload.equals(byNmid)).toBe(true);
    expect(CheckCacheKey.fromQuery(byPayload).hex).toBe(CheckCacheKey.fromQuery(byNmid).hex);
    expect(CheckCacheKey.fromQuery(byPan).hex).not.toBe(CheckCacheKey.fromQuery(byNmid).hex);
  });
});

describe('the QRIS payload fold', () => {
  it('computes CRC-16/CCITT-FALSE', () => {
    // The algorithm's published check value.
    expect(qrisCrc('123456789')).toBe('29B1');
  });

  it('does not trim a space outside its own set from the edges, unlike trim()', () => {
    const intact = payload(nationalTemplate('UMI'));
    expect(reasonOf(() => TraciveQuery.qris(`\u2003${intact}`))).toBe('not_a_qris');
    expect(reasonOf(() => TraciveQuery.qris(`${intact}\ufeff`))).toBe('not_a_qris');
  });

  it('takes the criteria from the acquirer when tag 51 names one it does not know', () => {
    const qr = payload(acquirerTemplate('26', 'UMI'), nationalTemplate('XYZ'));
    expect(TraciveQuery.qris(qr).searchQueryIndex).toBe('QRIS_ID1020000000033');
  });

  it('does not fall through when tag 51 names a known criteria that is never indexed', () => {
    const qr = payload(acquirerTemplate('26', 'UMI'), nationalTemplate('UME'));
    expect(reasonOf(() => TraciveQuery.qris(qr))).toBe('qris_not_indexed');
  });

  it('reads the acquirer in tag order, not payload order', () => {
    const national = tlv('51', tlv('00', 'ID.CO.QRIS.WWW') + tlv('02', 'ID1020000000033'));
    const qr = payload(acquirerTemplate('40', 'UBE'), acquirerTemplate('27', 'UKE'), national);
    expect(TraciveQuery.qris(qr).searchQueryIndex).toBe('QRIS_ID1020000000033');
  });

  it('skips a template that has no sub-tag 00', () => {
    const national = tlv('51', tlv('00', 'ID.CO.QRIS.WWW') + tlv('02', 'ID1020000000033'));
    const noGuid = tlv('26', tlv('03', 'UBE'));
    const qr = payload(noGuid, acquirerTemplate('30', 'UMI'), national);
    expect(TraciveQuery.qris(qr).searchQueryIndex).toBe('QRIS_ID1020000000033');
  });

  it('refuses a payload whose last field is not a four-character tag 63', () => {
    const body = `000201${nationalTemplate('UMI')}`;
    expect(reasonOf(() => TraciveQuery.qris(`${body}6305ABCDE`))).toBe('not_a_qris');
    expect(reasonOf(() => TraciveQuery.qris(`${body}${tlv('64', 'ABCD')}`))).toBe('not_a_qris');
  });
});

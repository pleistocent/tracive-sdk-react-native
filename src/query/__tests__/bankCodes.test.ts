import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

import { BANK_CODES_PATH } from '../../__tests__/support/fixture';
import { bankCodeTable, stripLeadingZeros } from '../bankCodes';
import { BANK_CODES_JSON } from '../bankCodesJson';
import { foldBankShortCode, foldBic } from '../folding';
import { TraciveQuery } from '../TraciveQuery';
import { TraciveQueryError } from '../TraciveQueryError';

/**
 * The embedded bank-code table, and the `bankAccount` overloads that take a national bank code or a
 * BIC. The vendored vectors run in queryGrammar.test.ts; this covers what they leave out.
 */

interface BankCodesFile {
  countries: Record<string, { shortCode: Record<string, string>; bic: Record<string, string> }>;
}

const vendored = readFileSync(BANK_CODES_PATH);
const file = JSON.parse(vendored.toString('utf8')) as BankCodesFile;

function byShortCode(country: string, bankShortCode: string, account = '1234567890'): string {
  return TraciveQuery.bankAccount({ countryAlpha3: country, bankShortCode, account })
    .searchQueryIndex;
}

function byBic(country: string, bic: string, account = '1234567890'): string {
  return TraciveQuery.bankAccount({ countryAlpha3: country, bic, account }).searchQueryIndex;
}

function byBankCode(country: string, bankCode: string): string {
  return TraciveQuery.bankAccount({ countryAlpha3: country, bankCode, account: '1234567890' })
    .searchQueryIndex;
}

/** The reason token a factory rejected with, or `undefined` when it built a query. */
function rejectionOf(build: () => unknown): string | undefined {
  try {
    build();
    return undefined;
  } catch (error) {
    if (error instanceof TraciveQueryError) return error.reason;
    throw error;
  }
}

describe('the embedded table', () => {
  it('is the vendored file byte for byte', () => {
    // Run `node scripts/embed-bank-codes.js` after re-vendoring; never edit either file by hand.
    expect(Buffer.from(BANK_CODES_JSON, 'utf8').equals(vendored)).toBe(true);
  });

  it('holds every entry of the file once parsed', () => {
    const table = bankCodeTable();
    const countries = Object.keys(file.countries);
    expect(countries.length).toBeGreaterThan(0);
    expect([...table.shortCode.keys()].sort()).toEqual([...countries].sort());
    expect([...table.bic.keys()].sort()).toEqual([...countries].sort());
    for (const [country, codes] of Object.entries(file.countries)) {
      expect(Object.fromEntries(table.shortCode.get(country) ?? [])).toEqual(codes.shortCode);
      expect(Object.fromEntries(table.bic.get(country) ?? [])).toEqual(codes.bic);
    }
  });

  it('resolves every listed code to the key its bankCode builds', () => {
    let checked = 0;
    for (const [country, codes] of Object.entries(file.countries)) {
      for (const [shortCode, bankCode] of Object.entries(codes.shortCode)) {
        // A table key that is not already in folded form could never be reached.
        expect(foldBankShortCode(shortCode)).toBe(shortCode);
        expect(byShortCode(country, shortCode)).toBe(byBankCode(country, bankCode));
        checked += 1;
      }
      for (const [bic, bankCode] of Object.entries(codes.bic)) {
        expect(foldBic(bic)).toBe(bic);
        expect(byBic(country, bic)).toBe(byBankCode(country, bankCode));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('never has two all-digit codes of one country that collide once their leading zeros go', () => {
    for (const [country, codes] of Object.entries(file.countries)) {
      const seen = new Map<string, string>();
      for (const [code, bankCode] of Object.entries(codes.shortCode)) {
        if (!/^\d+$/.test(code)) continue;
        const bare = stripLeadingZeros(code);
        expect(`${country} ${bare} ${seen.get(bare) ?? bankCode}`).toBe(
          `${country} ${bare} ${bankCode}`,
        );
        seen.set(bare, bankCode);
        expect(bankCodeTable().bareShortCode.get(country)?.get(bare)).toBe(bankCode);
      }
    }
  });
});

describe('lookups that must miss', () => {
  it('treats prototype member names as unknown codes', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(rejectionOf(() => byShortCode('IDN', name))).toBe('unknown_bank_code');
      expect(rejectionOf(() => byBic('IDN', name))).toBe('unknown_bank_code');
    }
  });

  it('never answers from an inherited member', () => {
    // The fold uppercases first, so `constructor` above never reaches a lookup as itself and would
    // miss even in a plain object. A member another library adds to Object.prototype does reach
    // it, and only a Map ignores it at every level: the country, the code and the BIC.
    const polluted = Object.prototype as unknown as Record<string, unknown>;
    let results: (string | undefined)[];
    polluted['999'] = 'BCA';
    polluted.EVILIDJA = 'BCA';
    polluted.XXX = { shortCode: { '014': 'BCA' }, bic: { CENAIDJA: 'BCA' } };
    try {
      results = [
        rejectionOf(() => byShortCode('IDN', '999')),
        rejectionOf(() => byBic('IDN', 'EVILIDJA')),
        rejectionOf(() => byShortCode('XXX', '014')),
        rejectionOf(() => byBic('XXX', 'CENAIDJA')),
      ];
    } finally {
      delete polluted['999'];
      delete polluted.EVILIDJA;
      delete polluted.XXX;
    }
    expect(results).toEqual(Array(4).fill('unknown_bank_code'));
  });

  it('treats a country the table does not list as unknown', () => {
    expect(rejectionOf(() => byShortCode('XXX', '014'))).toBe('unknown_bank_code');
    expect(rejectionOf(() => byBic('XXX', 'CENAIDJA'))).toBe('unknown_bank_code');
  });
});

describe('leading zeros', () => {
  it('are optional on either side', () => {
    // Listed as 014.
    expect(byShortCode('IDN', '14')).toBe('BANK_IDN_BCA_1234567890');
    expect(byShortCode('IDN', '00014')).toBe('BANK_IDN_BCA_1234567890');
    // Listed as 143, with no leading zero.
    expect(byShortCode('ARG', '0143')).toBe('BANK_ARG_BRUBANK_1234567890');
    // Separators go before the all-digits test, so this is the exact code 014.
    expect(byShortCode('IDN', '0-1.4')).toBe('BANK_IDN_BCA_1234567890');
  });

  it('are removed up to the last digit', () => {
    expect(stripLeadingZeros('000')).toBe('0');
    expect(stripLeadingZeros('0')).toBe('0');
    expect(stripLeadingZeros('014')).toBe('14');
    expect(stripLeadingZeros('0100')).toBe('100');
    expect(stripLeadingZeros('140')).toBe('140');
  });

  it('are kept on a code that is not all ASCII digits', () => {
    expect(byShortCode('NPL', 'HBL')).toBe('BANK_NPL_HIMALAYAN_1234567890');
    expect(rejectionOf(() => byShortCode('NPL', '0HBL'))).toBe('unknown_bank_code');
    // Arabic-Indic digits are not ASCII digits, so they are neither stripped nor matched.
    expect(rejectionOf(() => byShortCode('IDN', '٠١٤'))).toBe('unknown_bank_code');
  });
});

describe('whitespace', () => {
  it('is the JavaScript \\s class', () => {
    expect(byShortCode('IDN', '\u000b0 14﻿')).toBe('BANK_IDN_BCA_1234567890');
    expect(byBic('IDN', '﻿CENA IDJA\u000bXXX')).toBe('BANK_IDN_BCA_1234567890');
    // U+200B and U+0085 are not \s: they stay in the code, which then misses.
    for (const stray of ['​', '\u0085']) {
      expect(rejectionOf(() => byShortCode('IDN', `014${stray}`))).toBe('unknown_bank_code');
      expect(rejectionOf(() => byBic('IDN', `CENAIDJA${stray}`))).toBe('unknown_bank_code');
    }
  });
});

describe('the BIC shape', () => {
  it('is 8 or 11 characters of the right class', () => {
    expect(byBic('IDN', 'CENAIDJA123')).toBe('BANK_IDN_BCA_1234567890');
    for (const bic of [
      'CENAIDJ', // 7
      'CENAIDJAX', // 9
      'CENAIDJAXX', // 10
      'CENAIDJAXXXX', // 12
      'CENAID1A', // a digit in the country part
      'CENA-IDJA', // '-' is not removed from a BIC
      'CENA.IDJA',
      '',
    ]) {
      expect(rejectionOf(() => byBic('IDN', bic))).toBe('unknown_bank_code');
    }
  });
});

describe('the order of rejections', () => {
  it('checks the country before the code, and the code before the account', () => {
    expect(rejectionOf(() => byShortCode('ID', '999'))).toBe('country_not_alpha3');
    expect(rejectionOf(() => byBic('ID', 'CENA'))).toBe('country_not_alpha3');
    expect(rejectionOf(() => byShortCode('IDN', '999', ' '))).toBe('unknown_bank_code');
    expect(rejectionOf(() => byBic('IDN', 'CENA', ' '))).toBe('unknown_bank_code');
    expect(rejectionOf(() => byShortCode('IDN', '014', ' '))).toBe('empty_account_id');
    expect(rejectionOf(() => byBic('IDN', 'CENAIDJA', ' '))).toBe('empty_account_id');
  });
});

describe('naming the bank', () => {
  /** What untyped JavaScript can pass, and the overloads refuse to compile. */
  const untyped = TraciveQuery.bankAccount as unknown as (input: object) => TraciveQuery;

  it('takes exactly one of bankCode, bankShortCode or bic', () => {
    const base = { countryAlpha3: 'IDN', account: '1234567890' };
    expect(() => untyped({ ...base, bankCode: 'BCA', bic: 'CENAIDJA' })).toThrow(TypeError);
    expect(() => untyped({ ...base, bankShortCode: '014', bic: 'CENAIDJA' })).toThrow(TypeError);
    expect(() => untyped(base)).toThrow(TypeError);
    // An explicitly absent selector is not a second one.
    expect(untyped({ ...base, bankCode: 'BCA', bic: undefined }).searchQueryIndex).toBe(
      'BANK_IDN_BCA_1234567890',
    );
  });
});

describe('parsing', () => {
  it('happens on first use, once, and never at import or for any other factory', () => {
    const parse = jest.spyOn(JSON, 'parse');
    try {
      jest.isolateModules(() => {
        // A fresh module registry, so the SDK is imported here and not by the imports above.
        const sdk = jest.requireActual<typeof import('../../index')>('../../index');
        const parsesOfTheTable = () =>
          parse.mock.calls.filter(([text]) => text === BANK_CODES_JSON).length;

        sdk.TraciveQuery.phone('+6281234567891');
        sdk.TraciveQuery.bankAccount({ countryAlpha3: 'IDN', bankCode: 'BCA', account: '1' });
        expect(parsesOfTheTable()).toBe(0);

        sdk.TraciveQuery.bankAccount({ countryAlpha3: 'IDN', bankShortCode: '014', account: '1' });
        sdk.TraciveQuery.bankAccount({ countryAlpha3: 'IDN', bic: 'CENAIDJA', account: '1' });
        expect(parsesOfTheTable()).toBe(1);
      });
    } finally {
      parse.mockRestore();
    }
  });
});

import { describe, expect, it } from '@jest/globals';

import { TraciveQuery } from '../TraciveQuery';
import { TraciveQueryError } from '../TraciveQueryError';
import { isValidRecordKey } from '../recordKeyGuard';
import {
  codepointFromLabel,
  loadGrammarFixture,
  type GrammarVector,
  type RejectedVector,
} from '../../__tests__/support/fixture';

const fixture = loadGrammarFixture();

function buildQuery(vector: GrammarVector | RejectedVector): TraciveQuery {
  const input = vector.input as Record<string, string>;
  switch (vector.type) {
    case 'PHONE':
      return TraciveQuery.phone(input.value as string);
    case 'EMAIL':
      return TraciveQuery.email(input.value as string);
    case 'BANK':
      return vector.input.isIban === true
        ? TraciveQuery.iban(input.iban as string)
        : TraciveQuery.bankAccount({
            countryAlpha3: input.country as string,
            bankCode: input.bankCode as string,
            account: input.accountId as string,
          });
    case 'CRYPTO':
      return TraciveQuery.crypto({
        chain: input.chain as string,
        address: input.address as string,
      });
    case 'USERNAME':
      return TraciveQuery.username({
        platform: input.platform as string,
        handle: input.handle as string,
      });
    case 'RAW':
      throw new Error('RAW vectors exercise the record-key guard directly, not a factory');
  }
}

describe('shared grammar fixture', () => {
  it('is the version this suite was written against', () => {
    expect(fixture.version).toBe(3);
  });

  it('carries the expected number of vectors and rejections', () => {
    // Pinned so that a fixture update that silently drops a case cannot pass unnoticed.
    expect(fixture.vectors).toHaveLength(34);
    expect(fixture.rejected).toHaveLength(11);
    expect(fixture.documentIdGuard.cases).toHaveLength(8);
  });
});

describe('vectors', () => {
  it.each(fixture.vectors.map((vector) => [vector.id, vector] as const))(
    'folds %s byte for byte',
    (_id, vector) => {
      expect(buildQuery(vector).searchQueryIndex).toBe(vector.expected);
    },
  );
});

describe('rejections', () => {
  it.each(fixture.rejected.map((vector) => [vector.id, vector] as const))(
    'rejects %s with its exact reason',
    (_id, vector) => {
      let thrown: unknown;
      try {
        if (vector.type === 'RAW') {
          const value = vector.input.value as string;
          if (!isValidRecordKey(value)) throw new TraciveQueryError('invalid_document_id');
        } else {
          buildQuery(vector);
        }
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TraciveQueryError);
      expect((thrown as TraciveQueryError).reason).toBe(vector.reason);
    },
  );
});

describe('record-key guard cases', () => {
  it.each(fixture.documentIdGuard.cases.map((entry) => [entry.value, entry.safe] as const))(
    'treats %j as safe=%s',
    (value, safe) => {
      expect(isValidRecordKey(value)).toBe(safe);
    },
  );
});

describe('cross-language semantics', () => {
  const { trimSet, caseMapping } = fixture.crossLanguageSemantics;

  it.each(trimSet.codepoints.map((label) => [label] as const))(
    '%s is stripped by trim() and matched by /\\s/',
    (label) => {
      const char = codepointFromLabel(label);
      expect(`${char}x${char}`.trim()).toBe('x');
      expect(/\s/.test(char)).toBe(true);
    },
  );

  it.each(trimSet.notStripped.map((label) => [label] as const))(
    '%s is NOT stripped by trim()',
    (label) => {
      const char = codepointFromLabel(label);
      expect(`${char}x${char}`.trim()).toBe(`${char}x${char}`);
    },
  );

  it('strips a non-ASCII digit rather than converting it', () => {
    // U+0669 ARABIC-INDIC DIGIT NINE. An ICU-based \d port would keep it as a '9'.
    expect('12٩3'.replace(/[^0-9]/g, '')).toBe('123');
    expect(/[0-9]/.test('٩')).toBe(false);
  });

  it('uses the locale-invariant, length-changing case mappings', () => {
    expect('ß'.toUpperCase()).toBe(caseMapping.examples['ß -> uppercase']);
    expect('İ'.toLowerCase()).toBe('i̇');
    expect(caseMapping.examples['İ -> lowercase']).toBe('i + U+0307');
  });

  it('applies NFC to e-mail, username and every code field, but not to ids or addresses', () => {
    const decomposed = 'é'; // 'e' + COMBINING ACUTE ACCENT
    const composed = 'é';

    // Applied:
    expect(TraciveQuery.email(`${decomposed}@x.com`).searchQueryIndex).toBe(
      `EMAIL_${composed}@x.com`,
    );
    expect(
      TraciveQuery.username({ platform: 'INSTAGRAM', handle: decomposed }).searchQueryIndex,
    ).toBe(`USERNAME_INSTAGRAM_${composed}`);

    // Applied to the bank code too, and it must compose BEFORE uppercasing. Written with
    // explicit escapes because the two forms are indistinguishable in an editor: 'A' + U+0301
    // uppercases to two code points, the precomposed U+00C1 to one, so an implementation that
    // skips NFC on a bank code builds a key the server can never match.
    expect(
      TraciveQuery.bankAccount({
        countryAlpha3: 'IDN',
        bankCode: 'BCa\u0301',
        account: '1',
      }).searchQueryIndex,
    ).toBe('BANK_IDN_BC\u00c1_1');

    // NOT applied — a bank account id and a crypto address keep their decomposed form.
    expect(
      TraciveQuery.bankAccount({
        countryAlpha3: 'IDN',
        bankCode: 'BCA',
        account: `12${decomposed}`,
      }).searchQueryIndex,
    ).toBe(`BANK_IDN_BCA_12${decomposed.toUpperCase()}`);
    expect(TraciveQuery.crypto({ chain: 'BTC', address: `1A${decomposed}` }).searchQueryIndex).toBe(
      `CRYPTO_BTC_1A${decomposed}`,
    );
  });
});

describe('explicitly allowed record-key characters', () => {
  const probes: Readonly<Record<string, string>> = {
    spaces: 'EMAIL_a b',
    "'.' inside the string": 'EMAIL_a.b',
    '@': 'EMAIL_a@b',
    '+': 'PHONE_+62812',
    '#': 'EMAIL_a#b',
    $: 'EMAIL_a$b',
    '[': 'EMAIL_a[b',
    ']': 'EMAIL_a]b',
    '*': 'EMAIL_a*b',
    '~': 'EMAIL_a~b',
    emoji: 'EMAIL_a\u{1f600}b',
    __x: '__x',
    x__: 'x__',
    _: '_',
  };

  it('covers every entry the fixture lists', () => {
    expect(Object.keys(probes).sort()).toEqual(
      [...fixture.documentIdGuard.explicitlyAllowed].sort(),
    );
  });

  it.each(Object.entries(probes))('accepts %s', (_label, probe) => {
    expect(isValidRecordKey(probe)).toBe(true);
  });
});

describe('notImplemented', () => {
  it('exposes no domain query builder', () => {
    // A DOMAIN_<host> key would match nothing, and a miss is still billed.
    expect(fixture.notImplemented.DOMAIN).toContain('MUST NOT expose a domain() query builder');
    expect('domain' in TraciveQuery).toBe(false);
    expect(
      Object.getOwnPropertyNames(TraciveQuery).some((name) =>
        name.toLowerCase().includes('domain'),
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from '@jest/globals';

import { COUNTRIES, countryFromAlpha3 } from '../countries';
import { normalizePhoneNumber } from '../phoneNumbers';
import { TraciveQuery } from '../TraciveQuery';
import { TraciveQueryError } from '../TraciveQueryError';
import fixture from './phone-normalization-vectors.json';

/**
 * Drives the vendored `phone-normalization-vectors.json` — the app/SDK anti-drift contract.
 *
 * Expected values came from executing the Tracive app's own normalizer. If this SDK disagrees with a
 * vector, this SDK is wrong: app and SDK must fold the same person to the same record key.
 */
describe('normalizePhoneNumber', () => {
  it('folds every vector byte for byte', () => {
    expect(fixture.vectors.length).toBeGreaterThan(0);
    for (const vector of fixture.vectors) {
      expect(normalizePhoneNumber(vector.country, vector.input)).toBe(vector.expected);
    }
  });

  it('refuses every rejection with its exact reason', () => {
    expect(fixture.rejected.length).toBeGreaterThan(0);
    for (const rejection of fixture.rejected) {
      let thrown: unknown;
      try {
        normalizePhoneNumber(rejection.country, rejection.input);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TraciveQueryError);
      expect((thrown as TraciveQueryError).reason).toBe(rejection.reason);
    }
  });

  it('keeps the country table identical to the contract', () => {
    expect(COUNTRIES.length).toBe(fixture.countryCount);
    expect(new Set(COUNTRIES.map((c) => c.alpha3)).size).toBe(COUNTRIES.length);
    for (const row of fixture.countries) {
      const country = countryFromAlpha3(row.alpha3);
      expect(country).toBeDefined();
      expect(country?.dialCode).toBe(row.dialCode);
      expect(country?.alpha2).toBe(row.alpha2);
    }
  });

  it('looks alpha-3 up ignoring case and surrounding space', () => {
    expect(countryFromAlpha3('idn')?.alpha3).toBe('IDN');
    expect(countryFromAlpha3('  IDN  ')?.alpha3).toBe('IDN');
    // alpha-2 must not resolve; this SDK speaks alpha-3.
    expect(countryFromAlpha3('ID')).toBeUndefined();
  });

  it('produces something the query builder accepts', () => {
    const query = TraciveQuery.phone(normalizePhoneNumber('IDN', '0857-1860-9079'));
    expect(query.searchQueryIndex).toBe('PHONE_+6285718609079');
    expect(TraciveQuery.phone(normalizePhoneNumber('+62', '0857 1860 9079')).searchQueryIndex).toBe(
      query.searchQueryIndex,
    );
  });
});

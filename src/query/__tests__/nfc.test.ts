import { afterEach, describe, expect, it } from '@jest/globals';

import { TraciveConfigurationError } from '../../model/TraciveConfigurationError';
import { TraciveQuery } from '../TraciveQuery';
import { foldedLowerCase, foldedUpperCase, normalizeNfc, resetNfcProbeForTesting } from '../nfc';

const realNormalize = String.prototype.normalize;
const realToUpperCase = String.prototype.toUpperCase;
const realToLowerCase = String.prototype.toLowerCase;

afterEach(() => {
  String.prototype.normalize = realNormalize;
  String.prototype.toUpperCase = realToUpperCase;
  String.prototype.toLowerCase = realToLowerCase;
  resetNfcProbeForTesting();
});

/** What a reduced-Unicode engine does: map the ASCII range and leave everything else alone. */
function asciiOnlyCaseMapping(): void {
  String.prototype.toUpperCase = function asciiUpper(this: string): string {
    return String(this).replace(/[a-z]/g, (c) => realToUpperCase.call(c));
  } as typeof String.prototype.toUpperCase;
  String.prototype.toLowerCase = function asciiLower(this: string): string {
    return String(this).replace(/[A-Z]/g, (c) => realToLowerCase.call(c));
  } as typeof String.prototype.toLowerCase;
}

describe('the NFC guard', () => {
  it('fires when the engine implements normalize as identity', () => {
    // This is exactly what a Unicode-lite engine build does: it returns the input unchanged and
    // raises no error, so every folded key would be wrong, miss, and still be billed.
    String.prototype.normalize = function identity(this: string): string {
      return String(this);
    } as typeof String.prototype.normalize;
    resetNfcProbeForTesting();

    let thrown: unknown;
    try {
      normalizeNfc('é');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TraciveConfigurationError);
    expect((thrown as TraciveConfigurationError).code).toBe('nfc_unavailable');
    expect((thrown as Error).message).toContain('billed');
  });

  it('fires when normalize is missing entirely', () => {
    (String.prototype as { normalize?: unknown }).normalize = undefined;
    resetNfcProbeForTesting();
    expect(() => normalizeNfc('x')).toThrow(TraciveConfigurationError);
  });

  it('throws rather than warning and continuing', () => {
    String.prototype.normalize = function identity(this: string): string {
      return String(this);
    } as typeof String.prototype.normalize;
    resetNfcProbeForTesting();
    // A returned value here would mean a silently wrong key reached the wire.
    expect(() => normalizeNfc('café')).toThrow();
  });

  it('probes only once', () => {
    resetNfcProbeForTesting();
    expect(normalizeNfc('é')).toBe('é');

    let probes = 0;
    String.prototype.normalize = function counting(this: string): string {
      probes++;
      return realNormalize.call(this, 'NFC');
    } as typeof String.prototype.normalize;

    normalizeNfc('é');
    // One call for the conversion itself, and none for a re-probe.
    expect(probes).toBe(1);
  });

  it('composes on the real engine', () => {
    resetNfcProbeForTesting();
    expect(normalizeNfc('é')).toBe('é');
    expect(normalizeNfc('')).toBe('');
  });
});

/**
 * The reduced Unicode backend that makes `normalize` an identity function ALSO degrades
 * `toUpperCase`/`toLowerCase` to the ASCII range. Only `normalize` was probed, so the case-mapping
 * half of the same failure stayed silent: `foldEmail('É@x.com')` returned `É@x.com`, a key the
 * server can never match, and a miss is billed.
 */
describe('the case-mapping guard', () => {
  it('fires when the engine only case-maps ASCII', () => {
    asciiOnlyCaseMapping();
    resetNfcProbeForTesting();

    let thrown: unknown;
    try {
      foldedLowerCase('É');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TraciveConfigurationError);
    expect((thrown as TraciveConfigurationError).code).toBe('case_mapping_unavailable');
    expect((thrown as Error).message).toContain('billed');
  });

  it('fires on the length-changing uppercase mapping too', () => {
    // A build can get 'É' right and still not know that 'ß' uppercases to two characters.
    String.prototype.toUpperCase = function noSharpS(this: string): string {
      // Uppercases everything except the sharp s, which it leaves alone instead of expanding.
      return String(this)
        .split('\u00df')
        .map((part) => realToUpperCase.call(part))
        .join('\u00df');
    } as typeof String.prototype.toUpperCase;
    resetNfcProbeForTesting();
    expect(() => foldedUpperCase('x')).toThrow(TraciveConfigurationError);
  });

  it('guards the folds that case-map, not only the ones that normalize', () => {
    // foldBankAccount and foldCountryAlpha3 never call normalize, so a guard living only inside
    // normalizeNfc would leave them silently wrong.
    asciiOnlyCaseMapping();
    resetNfcProbeForTesting();
    expect(() => foldedUpperCase('DE89ß')).toThrow(TraciveConfigurationError);
  });

  it('probes only once', () => {
    resetNfcProbeForTesting();
    expect(foldedUpperCase('ß')).toBe('SS');

    let probes = 0;
    String.prototype.toUpperCase = function counting(this: string): string {
      probes++;
      return realToUpperCase.call(this);
    } as typeof String.prototype.toUpperCase;

    expect(foldedUpperCase('a')).toBe('A');
    expect(probes).toBe(1);
  });

  it('stops a query factory building a key that can never match', () => {
    // The symptom this guard exists for: foldEmail('E-acute@x.com') used to come back with the
    // uppercase intact — a key the server does not hold, a guaranteed miss, and a billed one.
    asciiOnlyCaseMapping();
    resetNfcProbeForTesting();
    expect(() => TraciveQuery.email('\u00c9@x.com')).toThrow(TraciveConfigurationError);
    expect(() =>
      TraciveQuery.bankAccount({ countryAlpha3: 'IDN', bankCode: 'BCA', account: 'a\u00df1' }),
    ).toThrow(TraciveConfigurationError);
  });

  it('maps correctly on the real engine', () => {
    resetNfcProbeForTesting();
    expect(foldedUpperCase('ß')).toBe('SS');
    expect(foldedLowerCase('É')).toBe('é');
    expect(foldedUpperCase('')).toBe('');
  });
});

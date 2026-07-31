import { afterEach, describe, expect, it } from '@jest/globals';

import { TraciveConfigurationError } from '../../model/TraciveConfigurationError';
import { normalizeNfc, resetNfcProbeForTesting } from '../nfc';

const realNormalize = String.prototype.normalize;

afterEach(() => {
  String.prototype.normalize = realNormalize;
  resetNfcProbeForTesting();
});

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

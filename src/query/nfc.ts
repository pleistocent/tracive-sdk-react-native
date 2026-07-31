import { TraciveConfigurationError } from '../model/TraciveConfigurationError';

/**
 * A JavaScript engine built without a real Unicode backend can implement
 * `String.prototype.normalize` as an empty function: it returns the input unchanged and raises
 * no error. Under such a build every e-mail, username, platform and chain key would fold wrong,
 * miss, and still be billed — the exact class of failure that is expensive precisely because it
 * is quiet.
 *
 * So we probe once and convert the silent wrong answer into a loud one. The guard throws; it
 * never warns and continues.
 */
const NFC_PROBE_INPUT = 'é'; // 'e' + COMBINING ACUTE ACCENT
const NFC_PROBE_EXPECTED = 'é'; // precomposed 'é'

let nfcChecked = false;

export function normalizeNfc(value: string): string {
  if (!nfcChecked) {
    const normalize = (String.prototype as { normalize?: unknown }).normalize;
    if (
      typeof normalize !== 'function' ||
      NFC_PROBE_INPUT.normalize('NFC') !== NFC_PROBE_EXPECTED
    ) {
      throw new TraciveConfigurationError(
        'nfc_unavailable',
        'This JavaScript engine does not implement Unicode NFC normalization. Tracive lookup ' +
          'keys would fold incorrectly and every check would miss while still being billed. ' +
          'This engine build is unsupported; see docs/integration.md.',
      );
    }
    nfcChecked = true;
  }
  return value.normalize('NFC');
}

/** Test-only seam so the guard can be re-armed between cases. Not exported from the package. */
export function resetNfcProbeForTesting(): void {
  nfcChecked = false;
}

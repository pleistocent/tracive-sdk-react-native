import { TraciveConfigurationError } from '../model/TraciveConfigurationError';

/**
 * The two Unicode facilities the fold depends on, each behind a one-shot probe.
 *
 * A JavaScript engine built without a real Unicode backend can implement
 * `String.prototype.normalize` as an empty function: it returns the input unchanged and raises no
 * error. The SAME reduced backend degrades `toUpperCase`/`toLowerCase` to the ASCII range, so
 * `'É'.toLowerCase()` returns `'É'` and `'ß'.toUpperCase()` returns `'ß'` instead of `'SS'`.
 *
 * Either degradation produces a lookup key the server can never match. The check misses, and a
 * miss is billed. That is the class of failure worth the most effort precisely because it is
 * quiet: nothing throws, nothing logs, and the answer is simply wrong.
 *
 * So both are probed once and the silent wrong answer becomes a loud one. The guards throw; they
 * never warn and continue.
 *
 * Every probe literal is written as an escape on purpose. These checks are worthless if the two
 * forms are ever silently the same character, and a decomposed and a precomposed 'e-acute' are
 * indistinguishable in an editor, in a diff and in a review.
 */
const NFC_PROBE_INPUT = 'e\u0301'; // 'e' + COMBINING ACUTE ACCENT
const NFC_PROBE_EXPECTED = '\u00e9'; // precomposed 'e-acute'

/** 'sharp s' -> 'SS' is length-changing, and 'E-acute' is outside ASCII. A reduced build fails both. */
const UPPERCASE_PROBE_INPUT = '\u00df';
const UPPERCASE_PROBE_EXPECTED = 'SS';
const LOWERCASE_PROBE_INPUT = '\u00c9';
const LOWERCASE_PROBE_EXPECTED = '\u00e9';

let nfcChecked = false;
let caseMappingChecked = false;

function assertNfcAvailable(): void {
  if (nfcChecked) return;
  const normalize = (String.prototype as { normalize?: unknown }).normalize;
  if (typeof normalize !== 'function' || NFC_PROBE_INPUT.normalize('NFC') !== NFC_PROBE_EXPECTED) {
    throw new TraciveConfigurationError(
      'nfc_unavailable',
      'This JavaScript engine does not implement Unicode NFC normalization. Tracive lookup ' +
        'keys would fold incorrectly and every check would miss while still being billed. ' +
        'This engine build is unsupported; see docs/integration.md.',
    );
  }
  nfcChecked = true;
}

function assertCaseMappingAvailable(): void {
  if (caseMappingChecked) return;
  if (
    UPPERCASE_PROBE_INPUT.toUpperCase() !== UPPERCASE_PROBE_EXPECTED ||
    LOWERCASE_PROBE_INPUT.toLowerCase() !== LOWERCASE_PROBE_EXPECTED
  ) {
    throw new TraciveConfigurationError(
      'case_mapping_unavailable',
      'This JavaScript engine does not implement the full Unicode case mappings: it appears to ' +
        'case-map ASCII only. Tracive lookup keys would fold incorrectly and every check would ' +
        'miss while still being billed. This engine build is unsupported; see ' +
        'docs/integration.md.',
    );
  }
  caseMappingChecked = true;
}

export function normalizeNfc(value: string): string {
  assertNfcAvailable();
  return value.normalize('NFC');
}

/**
 * `toUpperCase` behind the case-mapping guard. Every fold that uppercases user-controlled text
 * goes through here rather than calling the built-in directly, because several of them —
 * `foldBankAccount`, for one — never touch `normalizeNfc` and would otherwise be unguarded.
 */
export function foldedUpperCase(value: string): string {
  assertCaseMappingAvailable();
  return value.toUpperCase();
}

/** `toLowerCase` behind the case-mapping guard. See {@link foldedUpperCase}. */
export function foldedLowerCase(value: string): string {
  assertCaseMappingAvailable();
  return value.toLowerCase();
}

/** Test-only seam so the guards can be re-armed between cases. Not exported from the package. */
export function resetNfcProbeForTesting(): void {
  nfcChecked = false;
  caseMappingChecked = false;
}

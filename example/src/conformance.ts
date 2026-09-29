/**
 * The two shared anti-drift fixtures, executed ON THE DEVICE.
 *
 * `docs/OPEN_QUESTIONS.md` item 1 is what this file exists for. The Jest suite runs the same two
 * fixtures on Node with full ICU, where they pass regardless of how Hermes behaves — so it proves
 * nothing about the engine the SDK actually ships on. Three behaviours the fold depends on are
 * engine-specific:
 *
 * - `String.prototype.normalize('NFC')`, which on Android Hermes routes through a JNI call to the
 *   platform normalizer;
 * - the locale-invariant full case mappings, `ß -> SS` and `İ -> i` + U+0307, on `libcore`;
 * - `String.prototype.trim`'s exact 25-code-point set, and `\D` being ASCII-only.
 *
 * The SDK guards the first two and throws `nfc_unavailable` / `case_mapping_unavailable` when they
 * degrade. It does not guard the last two, and deliberately so: neither can be probed without
 * hard-coding the very table the SDK exists not to hand-write. Running the fixture is the only
 * check that catches them, and running it here is the only place it runs on Hermes.
 *
 * Everything below goes through the PUBLIC surface. The one thing it cannot reach is the two `RAW`
 * rejections and the nine `documentIdGuard` cases, which drive the internal record-key guard
 * directly; those stay Jest-only and are reported as skipped rather than silently dropped.
 */
import { normalizePhoneNumber, TraciveQuery, isTraciveQueryError } from '@tracive/sdk-react-native';

import grammarFixture from '../../test/fixtures/query-grammar-vectors.json';
import phoneFixture from '../../src/query/__tests__/phone-normalization-vectors.json';

export interface ConformanceGroup {
  readonly name: string;
  readonly passed: number;
  readonly total: number;
  readonly skipped: number;
  readonly failures: readonly string[];
}

export interface ConformanceReport {
  readonly grammarFixtureVersion: number;
  readonly phoneFixtureVersion: number;
  readonly groups: readonly ConformanceGroup[];
  readonly passed: number;
  readonly total: number;
  readonly skipped: number;
  readonly ok: boolean;
}

type Vector = { id: string; type: string; input: Record<string, unknown>; expected: string };
type Rejection = { id: string; type: string; input: Record<string, unknown>; reason: string };

/** The same switch the Jest driver uses, so a vector cannot be folded differently here. */
function buildQuery(type: string, input: Record<string, unknown>): TraciveQuery {
  const text = (name: string): string => String(input[name]);
  switch (type) {
    case 'PHONE':
      return TraciveQuery.phone(text('value'));
    case 'EMAIL':
      return TraciveQuery.email(text('value'));
    case 'BANK': {
      if (input.isIban === true) return TraciveQuery.iban(text('iban'));
      const countryAlpha3 = text('country');
      const account = text('accountId');
      if ('bankShortCode' in input) {
        return TraciveQuery.bankAccount({
          countryAlpha3,
          bankShortCode: text('bankShortCode'),
          account,
        });
      }
      if ('bic' in input) {
        return TraciveQuery.bankAccount({ countryAlpha3, bic: text('bic'), account });
      }
      return TraciveQuery.bankAccount({ countryAlpha3, bankCode: text('bankCode'), account });
    }
    case 'CRYPTO':
      return TraciveQuery.crypto({ chain: text('chain'), address: text('address') });
    case 'USERNAME':
      return TraciveQuery.username({ platform: text('platform'), handle: text('handle') });
    default:
      throw new Error(`No public factory drives a ${type} vector`);
  }
}

function group(
  name: string,
  cases: readonly { id: string; run: () => string | undefined }[],
  skipped = 0,
): ConformanceGroup {
  const failures: string[] = [];
  for (const testCase of cases) {
    let failure: string | undefined;
    try {
      failure = testCase.run();
    } catch (error) {
      failure = `threw ${error instanceof Error ? error.message : String(error)}`;
    }
    if (failure !== undefined) failures.push(`${testCase.id}: ${failure}`);
  }
  return {
    name,
    passed: cases.length - failures.length,
    total: cases.length,
    skipped,
    failures,
  };
}

/** `"U+00A0"` -> the character it names. */
function codepointFromLabel(label: string): string {
  return String.fromCodePoint(Number.parseInt(label.replace(/^U\+/, ''), 16));
}

function rejectionOf(build: () => unknown): string | undefined {
  try {
    build();
    return undefined;
  } catch (error) {
    if (isTraciveQueryError(error)) return error.reason;
    throw error;
  }
}

export function runConformance(): ConformanceReport {
  const vectors = grammarFixture.vectors as readonly Vector[];
  const rejected = grammarFixture.rejected as readonly Rejection[];
  const publicRejections = rejected.filter((entry) => entry.type !== 'RAW');
  const rawSkipped =
    rejected.length - publicRejections.length + grammarFixture.documentIdGuard.cases.length;

  const groups: ConformanceGroup[] = [
    group(
      'Grammar vectors',
      vectors.map((vector) => ({
        id: vector.id,
        run: () => {
          const folded = buildQuery(vector.type, vector.input).searchQueryIndex;
          return folded === vector.expected ? undefined : `folded to ${folded}`;
        },
      })),
    ),
    group(
      'Grammar rejections',
      publicRejections.map((vector) => ({
        id: vector.id,
        run: () => {
          const reason = rejectionOf(() => buildQuery(vector.type, vector.input));
          return reason === vector.reason ? undefined : `rejected with ${reason ?? 'nothing'}`;
        },
      })),
      rawSkipped,
    ),
    group(
      'Phone vectors',
      phoneFixture.vectors.map((vector) => ({
        id: `${vector.country} ${vector.input}`,
        run: () => {
          const folded = normalizePhoneNumber(vector.country, vector.input);
          return folded === vector.expected ? undefined : `folded to ${folded}`;
        },
      })),
    ),
    group(
      'Phone rejections',
      phoneFixture.rejected.map((vector) => ({
        id: `${vector.country} ${JSON.stringify(vector.input)}`,
        run: () => {
          const reason = rejectionOf(() => normalizePhoneNumber(vector.country, vector.input));
          return reason === vector.reason ? undefined : `rejected with ${reason ?? 'nothing'}`;
        },
      })),
    ),
    // The unguarded half of OPEN_QUESTIONS item 1. `trim()` must strip exactly these 25 code
    // points and must NOT strip U+200B; the fold calls the engine's own `trim`, so this measures
    // Hermes rather than the SDK.
    group('Trim set', [
      ...grammarFixture.crossLanguageSemantics.trimSet.codepoints.map((label) => ({
        id: `strips ${label}`,
        run: () => {
          const pad = codepointFromLabel(label);
          const folded = TraciveQuery.email(`${pad}budi@example.com${pad}`).searchQueryIndex;
          return folded === 'EMAIL_budi@example.com' ? undefined : `folded to ${folded}`;
        },
      })),
      ...grammarFixture.crossLanguageSemantics.trimSet.notStripped.map((label) => ({
        id: `keeps ${label}`,
        run: () => {
          const pad = codepointFromLabel(label);
          const folded = TraciveQuery.email(`${pad}budi@example.com`).searchQueryIndex;
          return folded === `EMAIL_${pad}budi@example.com` ? undefined : `folded to ${folded}`;
        },
      })),
    ]),
    // The length-changing case mappings, measured through the folds that use them: a bank code is
    // uppercased, an e-mail local part is lowercased.
    //
    // Every literal below is an escape on purpose, exactly as `src/query/nfc.ts` writes its own
    // probes. A decomposed and a precomposed e-acute are indistinguishable in an editor, in a diff
    // and in a review, and a check whose two sides are secretly the same string cannot fail.
    group('Case mapping', [
      {
        id: 'U+00DF -> SS (uppercase, bank code)',
        run: () => {
          const folded = TraciveQuery.bankAccount({
            countryAlpha3: 'DEU',
            bankCode: 'stra\u00dfe',
            account: '1',
          }).searchQueryIndex;
          return folded === 'BANK_DEU_STRASSE_1'
            ? undefined
            : `folded to ${JSON.stringify(folded)}`;
        },
      },
      {
        id: 'U+0130 -> i + U+0307 (lowercase, e-mail)',
        run: () => {
          const folded = TraciveQuery.email('\u0130stanbul@example.com').searchQueryIndex;
          const expected = 'EMAIL_i\u0307stanbul@example.com';
          return folded === expected ? undefined : `folded to ${JSON.stringify(folded)}`;
        },
      },
      {
        id: 'NFC composes e + U+0301 into U+00E9',
        run: () => {
          const folded = TraciveQuery.email('andre\u0301@example.com').searchQueryIndex;
          const expected = 'EMAIL_andr\u00e9@example.com';
          return folded === expected ? undefined : `folded to ${JSON.stringify(folded)}`;
        },
      },
    ]),
    // `\D` is ASCII-only in JavaScript: Arabic-Indic digits are STRIPPED, never transliterated. An
    // ICU-backed `\d` would keep them and build a key the server can never match.
    group('ASCII digit class', [
      {
        id: 'Arabic-Indic digits are stripped, not converted',
        run: () => {
          const folded = TraciveQuery.phone('+62812345678\u0669\u0661').searchQueryIndex;
          return folded === 'PHONE_+62812345678'
            ? undefined
            : `folded to ${JSON.stringify(folded)}`;
        },
      },
    ]),
  ];

  const passed = groups.reduce((sum, entry) => sum + entry.passed, 0);
  const total = groups.reduce((sum, entry) => sum + entry.total, 0);
  const skipped = groups.reduce((sum, entry) => sum + entry.skipped, 0);
  return {
    grammarFixtureVersion: grammarFixture.version,
    phoneFixtureVersion: phoneFixture.version,
    groups,
    passed,
    total,
    skipped,
    ok: passed === total,
  };
}

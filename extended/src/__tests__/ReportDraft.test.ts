import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { fakeNative, REQUIREMENTS } from './fakeNative';
import { localDay, PreparedEvidence, ReportDraft, type ReportDraftFields } from '../ReportDraft';
import type { ReportFieldProblem } from '../ReportModels';

jest.mock('../specs/NativeTraciveReports', () => ({
  __esModule: true,
  default: require('./fakeNative').fakeNative,
}));

const LIMITS = { ...REQUIREMENTS.limits, attachmentTypes: [] };
const TODAY = '2026-11-06';
const FILE = new PreparedEvidence(1, 'image/avif', 1, () => {});

function draft(overrides?: Partial<ReportDraftFields>): ReportDraft {
  return new ReportDraft({
    identifiers: ['BANK_IDN_BCA_1'],
    title: 't',
    chronology: 'c'.repeat(50),
    incidentDate: '2026-11-06',
    evidence: [FILE],
    acceptedTerms: [],
    ...overrides,
  });
}

const problems = (fields?: Partial<ReportDraftFields>) => draft(fields).problems(LIMITS, TODAY);

beforeEach(() => fakeNative.reset());

describe('problems', () => {
  it('finds none in a good draft', () => {
    expect(problems()).toEqual([]);
  });

  const cases: readonly (readonly [Partial<ReportDraftFields>, ReportFieldProblem])[] = [
    [{ identifiers: [] }, 'NO_IDENTIFIER'],
    [{ identifiers: Array.from({ length: 11 }, (_, i) => `EMAIL_${i}`) }, 'TOO_MANY_IDENTIFIERS'],
    [{ title: ' ' }, 'TITLE_MISSING'],
    [{ title: 't'.repeat(51) }, 'TITLE_TOO_LONG'],
    [{ chronology: 'c'.repeat(49) }, 'CHRONOLOGY_TOO_SHORT'],
    [{ chronology: 'c'.repeat(2001) }, 'CHRONOLOGY_TOO_LONG'],
    [{ comment: 'c'.repeat(151) }, 'COMMENT_TOO_LONG'],
    [{ evidence: [] }, 'NO_EVIDENCE'],
    [{ evidence: Array.from({ length: 6 }, () => FILE) }, 'TOO_MANY_EVIDENCE'],
    [{ incidentDate: '04/11/2026' }, 'INCIDENT_DATE_INVALID'],
    [{ incidentDate: '2026-11-07' }, 'INCIDENT_DATE_IN_FUTURE'],
  ];

  it.each(cases)('%j is %s', (fields, problem) => {
    expect(problems(fields)).toEqual([problem]);
  });

  it('passes the boundaries themselves', () => {
    expect(
      problems({
        title: 't'.repeat(50),
        chronology: 'c'.repeat(2000),
        comment: 'c'.repeat(150),
      }),
    ).toEqual([]);
  });

  it('lets a phone carry the extra files', () => {
    const identifiers = ['PHONE_+6281234567891'];
    expect(problems({ identifiers, evidence: Array.from({ length: 10 }, () => FILE) })).toEqual([]);
    expect(problems({ identifiers, evidence: Array.from({ length: 11 }, () => FILE) })).toEqual([
      'TOO_MANY_EVIDENCE',
    ]);
  });

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1', '20261106', ''])(
    'calls %j no date',
    (incidentDate) => {
      expect(problems({ incidentDate })).toEqual(['INCIDENT_DATE_INVALID']);
    },
  );

  it('knows a leap day', () => {
    expect(draft({ incidentDate: '2024-02-29' }).problems(LIMITS, TODAY)).toEqual([]);
    expect(draft({ incidentDate: '2025-02-29' }).problems(LIMITS, TODAY)).toEqual([
      'INCIDENT_DATE_INVALID',
    ]);
  });

  it('reads blank as Kotlin does', () => {
    expect(problems({ title: '\u001C' })).toEqual(['TITLE_MISSING']);
    expect(problems({ title: '\u3000\t\n' })).toEqual(['TITLE_MISSING']);
    expect(problems({ title: '\uFEFF' })).toEqual([]);
  });

  it('reports in form order', () => {
    expect(problems({ identifiers: [], title: ' ', evidence: [] })).toEqual([
      'NO_IDENTIFIER',
      'TITLE_MISSING',
      'NO_EVIDENCE',
    ]);
  });

  it('skips the file count with no identifier, as there is nothing to count against', () => {
    expect(problems({ identifiers: [], evidence: [FILE, FILE] })).toEqual(['NO_IDENTIFIER']);
  });
});

it('takes its key from native, and a saved one as it is', () => {
  expect(draft().idempotencyKey).toMatch(/^key-/);
  expect(draft({ idempotencyKey: 'saved' }).idempotencyKey).toBe('saved');
});

it('counts the files a draft may carry', () => {
  expect(draft({ identifiers: ['EMAIL_1', 'EMAIL_2'] }).maxEvidence(LIMITS)).toBe(10);
  expect(draft({ identifiers: ['PHONE_+1', 'EMAIL_2'] }).maxEvidence(LIMITS)).toBe(15);
});

it('pads a local day', () => {
  expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05');
});

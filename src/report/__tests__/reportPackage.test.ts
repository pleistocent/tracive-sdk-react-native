import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FakeClock, FakeTransport } from '../../__tests__/support/fakes';
import { TraciveClient } from '../../client/TraciveClient';
import { base64Encode } from '../../crypto/base64';
import { utf8ByteLength } from '../../crypto/utf8';
import { TraciveMode } from '../../model/TraciveMode';
import { TraciveQuery } from '../../query/TraciveQuery';
import { ReportAttachment } from '../ReportAttachment';
import type { ReportFormLaunch, ReportFormLauncher } from '../ReportFormLauncher';
import type { ReportFormError, ReportFormResult } from '../ReportFormResult';
import {
  buildReportPackage,
  isCalendarDate,
  localDate,
  PACKAGE_MAX_BYTES,
  reportFormLink,
} from '../reportPackage';

interface FixtureAttachment {
  readonly mimeType: string;
  readonly head: string;
  readonly sizeBytes: number;
}

interface FixtureCase {
  readonly name: string;
  readonly query: string;
  readonly incidentDate?: string;
  readonly attachments: readonly FixtureAttachment[];
  readonly expect:
    | {
        readonly package: {
          readonly v: number;
          readonly query: string;
          readonly incidentDate?: string;
          readonly attachments: readonly { readonly name: string; readonly mimeType: string }[];
        };
      }
    | { readonly error: string; readonly index?: number; readonly max?: number };
}

interface Fixture {
  readonly version: number;
  readonly limits: {
    readonly pdfMaxBytesExclusive: number;
    readonly maxAttachments: number;
    readonly maxAttachmentsPhone: number;
    readonly packageMaxBytes: number;
  };
  readonly cases: readonly FixtureCase[];
  readonly reportLinks: readonly { scheme: string; query: string; url: string }[];
}

// Loaded from disk, never copied into a literal: the file is byte-identical across four SDKs.
const FIXTURE = JSON.parse(
  readFileSync(join(process.cwd(), 'test', 'fixtures', 'report-package-vectors.json'), 'utf8'),
) as Fixture;

// A clock far from both ends of the fixture's dates, so "today" never decides a case by accident.
const TODAY_MS = Date.UTC(2026, 10, 4, 12);

function generatedBytes(attachment: FixtureAttachment): Uint8Array {
  const head = Buffer.from(attachment.head, 'hex');
  const bytes = new Uint8Array(attachment.sizeBytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i < head.length ? (head[i] as number) : i % 251;
  return bytes;
}

function attachmentsOf(testCase: FixtureCase): ReportAttachment[] {
  return testCase.attachments.map((attachment) =>
    attachment.mimeType === 'application/pdf'
      ? ReportAttachment.pdf(generatedBytes(attachment))
      : ReportAttachment.image(generatedBytes(attachment), attachment.mimeType),
  );
}

/** The fixture names record keys; the client takes a TraciveQuery, so each key is rebuilt. */
function queryFor(key: string): TraciveQuery {
  const query =
    key === 'BANK_IDN_BCA_1234567890'
      ? TraciveQuery.bankAccount({ countryAlpha3: 'IDN', bankCode: 'BCA', account: '1234567890' })
      : key === 'PHONE_+6281234567890'
        ? TraciveQuery.phone('+6281234567890')
        : undefined;
  if (query === undefined) throw new Error(`No TraciveQuery known for fixture key ${key}`);
  expect(query.searchQueryIndex).toBe(key);
  return query;
}

class RecordingLauncher implements ReportFormLauncher {
  readonly launches: ReportFormLaunch[] = [];
  async launch(request: ReportFormLaunch): Promise<ReportFormResult> {
    this.launches.push(request);
    return { type: 'opened', attachmentsDelivered: true };
  }
}

function clientWith(launcher: ReportFormLauncher): TraciveClient {
  return new TraciveClient({
    mode: TraciveMode.oauth({
      clientId: 'partner-app',
      redirectUri: 'https://your.app/oauth/callback',
      partnerUserId: 'partner-user-1',
    }),
    transport: new FakeTransport(),
    clock: new FakeClock(TODAY_MS),
    reportFormLauncher: launcher,
  });
}

function expectedError(expectation: { error: string; index?: number; max?: number }) {
  return {
    code: expectation.error,
    ...(expectation.index !== undefined ? { index: expectation.index } : {}),
    ...(expectation.max !== undefined ? { max: expectation.max } : {}),
  } as ReportFormError;
}

function assertPackage(json: string, testCase: FixtureCase): void {
  if (!('package' in testCase.expect)) throw new Error('not a package case');
  const expected = testCase.expect.package;
  const parsed = JSON.parse(json) as {
    v: unknown;
    query: unknown;
    incidentDate?: unknown;
    attachments: { name: string; mimeType: string; data: string }[];
  };
  expect(parsed.v).toBe(expected.v);
  expect(parsed.query).toBe(expected.query);
  if (expected.incidentDate === undefined) {
    expect('incidentDate' in parsed).toBe(false);
  } else {
    expect(parsed.incidentDate).toBe(expected.incidentDate);
  }
  expect(parsed.attachments.map(({ name, mimeType }) => ({ name, mimeType }))).toEqual(
    expected.attachments,
  );
  parsed.attachments.forEach((attachment, i) => {
    expect(attachment.data).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    expect(attachment.data.length % 4).toBe(0);
    const decoded = Buffer.from(attachment.data, 'base64');
    const source = testCase.attachments[i] as FixtureAttachment;
    expect(decoded.equals(Buffer.from(generatedBytes(source)))).toBe(true);
  });
}

describe('report-package-vectors.json', () => {
  it('is the version and the limits this SDK implements', () => {
    expect(FIXTURE.version).toBe(1);
    expect(FIXTURE.limits).toEqual({
      pdfMaxBytesExclusive: 1_048_576,
      maxAttachments: 5,
      maxAttachmentsPhone: 10,
      packageMaxBytes: PACKAGE_MAX_BYTES,
    });
    expect(FIXTURE.cases).toHaveLength(19);
  });

  describe.each(FIXTURE.cases.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      it('builds the package or refuses it with the exact code', () => {
        const built = buildReportPackage({
          query: testCase.query,
          incidentDate: testCase.incidentDate,
          attachments: attachmentsOf(testCase),
          today: localDate(TODAY_MS),
        });
        if ('error' in testCase.expect) {
          expect(built).toEqual({ ok: false, error: expectedError(testCase.expect) });
        } else {
          if (!built.ok) throw new Error(`refused with ${built.error.code}`);
          assertPackage(built.json, testCase);
        }
      });

      it('through openReportForm: hands that package over, or opens nothing', async () => {
        const launcher = new RecordingLauncher();
        const result = await clientWith(launcher).openReportForm(queryFor(testCase.query), {
          ...(testCase.incidentDate !== undefined ? { incidentDate: testCase.incidentDate } : {}),
          attachments: attachmentsOf(testCase),
        });
        if ('error' in testCase.expect) {
          expect(result).toEqual({ type: 'failed', error: expectedError(testCase.expect) });
          expect(launcher.launches).toHaveLength(0);
        } else {
          expect(result).toEqual({ type: 'opened', attachmentsDelivered: true });
          expect(launcher.launches).toHaveLength(1);
          assertPackage((launcher.launches[0] as ReportFormLaunch).packageJson, testCase);
        }
      });
    },
  );

  it.each(FIXTURE.reportLinks.map((link) => [link.url, link] as const))(
    'builds the link %s',
    (_url, link) => {
      expect(reportFormLink(link.scheme, link.query)).toBe(link.url);
    },
  );

  it('keeps the + of a phone key as %2B in the link handed to the launcher', async () => {
    const launcher = new RecordingLauncher();
    await clientWith(launcher).openReportForm(TraciveQuery.phone('+6281234567890'));
    expect(launcher.launches[0]?.fallbackUrl).toBe(
      'tracive://report/create?media=PHONE_%2B6281234567890',
    );
  });
});

describe('the package size cap', () => {
  /** A package whose encoded size is exactly `target` bytes, built by padding the query. */
  function packageOfSize(target: number) {
    const bytes = new Uint8Array(15_000_000);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const attachments = [ReportAttachment.image(bytes, 'image/png')];
    const base = buildReportPackage({
      query: 'X',
      incidentDate: undefined,
      attachments,
      today: '2026-11-04',
    });
    if (!base.ok) throw new Error('base package refused');
    const grow = target - utf8ByteLength(base.json);
    if (grow < 0) throw new Error('base package already too large');
    return buildReportPackage({
      query: `X${'x'.repeat(grow)}`,
      incidentDate: undefined,
      attachments,
      today: '2026-11-04',
    });
  }

  it('accepts a package of exactly 20 MiB', () => {
    const built = packageOfSize(PACKAGE_MAX_BYTES);
    if (!built.ok) throw new Error(`refused with ${built.error.code}`);
    expect(utf8ByteLength(built.json)).toBe(PACKAGE_MAX_BYTES);
  });

  it('refuses one byte more', () => {
    expect(packageOfSize(PACKAGE_MAX_BYTES + 1)).toEqual({
      ok: false,
      error: { code: 'PACKAGE_TOO_LARGE', max: PACKAGE_MAX_BYTES },
    });
  });

  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    for (const text of [
      '',
      'ascii',
      'é',
      '€',
      '😀',
      'a😀b€é',
      '\u0000\u007f',
      '\ud800',
      'x\udc00y',
    ]) {
      expect(utf8ByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
    }
  });
});

describe('base64Encode', () => {
  it('matches the standard encoding at every padding length and across chunk boundaries', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6143, 6144, 6145, 6146, 12_288, 100_001]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 7919 + 13) & 0xff;
      expect(base64Encode(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
  });
});

describe('incidentDate', () => {
  it.each([
    ['2026-11-04', true],
    ['2028-02-29', true],
    ['2000-02-29', true],
    ['2026-02-29', false],
    ['1900-02-29', false],
    ['2026-04-31', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['2026-1-04', false],
    ['04/11/2026', false],
    ['2026-11-04T00:00:00Z', false],
    ['', false],
  ])('%s is a calendar date: %s', (value, valid) => {
    expect(isCalendarDate(value)).toBe(valid);
  });

  it('is compared with the local date of the injected clock, not UTC', () => {
    const now = new Date(2026, 10, 4, 23, 59);
    expect(localDate(now.getTime())).toBe('2026-11-04');
    const base = { query: 'BANK_IDN_BCA_1', attachments: [], today: localDate(now.getTime()) };
    expect(buildReportPackage({ ...base, incidentDate: '2026-11-04' }).ok).toBe(true);
    expect(buildReportPackage({ ...base, incidentDate: '2026-11-05' })).toEqual({
      ok: false,
      error: { code: 'INCIDENT_DATE_IN_FUTURE' },
    });
  });
});

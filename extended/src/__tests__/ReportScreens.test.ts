import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TraciveEnvironment, TraciveQuery } from '@pleistocent/tracive-sdk-react-native';

import { fakeNative } from './fakeNative';
import { ReportPrefill, TraciveReportForm, TraciveReportStatus } from '../ReportScreens';
import { TraciveReports } from '../TraciveReports';

jest.mock('../specs/NativeTraciveReports', () => ({
  __esModule: true,
  default: require('./fakeNative').fakeNative,
}));

function reportsNow(): TraciveReports {
  return new TraciveReports({
    environment: TraciveEnvironment.sandbox,
    accessToken: async () => 't',
  });
}

const QUERY = TraciveQuery.bankAccount({
  countryAlpha3: 'IDN',
  bankCode: 'BCA',
  account: '0000000001',
});

beforeEach(() => fakeNative.reset());

describe('form', () => {
  it('sends the prefill and the theme', async () => {
    const reports = reportsNow();
    await TraciveReportForm.present(reports, {
      prefill: ReportPrefill.forQuery(QUERY, {
        incidentDate: '2026-11-05',
        title: 'Fake seller',
        attachments: [
          { uri: 'file:///r.png', mimeType: 'image/png' },
          { bytes: new Uint8Array([104, 105, 33]), mimeType: 'application/pdf' },
        ],
      }),
      theme: { primaryColor: '#00695C', cornerRadius: 16 },
    });
    const [, handle, request] = fakeNative.named('presentForm')[0] as [string, number, any];
    expect(handle).toBe(await reports.nativeHandle());
    expect(request).toEqual({
      identifiers: [QUERY.searchQueryIndex],
      incidentDate: '2026-11-05',
      title: 'Fake seller',
      attachments: [
        { mimeType: 'image/png', uri: 'file:///r.png' },
        { mimeType: 'application/pdf', base64: 'aGkh' },
      ],
      primaryColor: 0xff00695c,
      cornerRadius: 16,
    });
  });

  it.each([
    [{ type: 'submitted', reportId: 'r', status: 'SUBMITTED' }],
    [{ type: 'needsConsent' }],
    [{ type: 'cancelled' }],
  ])('answers %j', async (outcome) => {
    fakeNative.answers.presentForm = async () => outcome;
    expect(
      await TraciveReportForm.present(reportsNow(), {
        prefill: { identifiers: ['EMAIL_a'] },
      }),
    ).toEqual(outcome);
  });

  it('opens one form for a double tap, and another after it closed', async () => {
    const reports = reportsNow();
    const prefill = { identifiers: ['EMAIL_a'] };
    await Promise.all([
      TraciveReportForm.present(reports, { prefill }),
      TraciveReportForm.present(reports, { prefill }),
    ]);
    expect(fakeNative.named('presentForm')).toHaveLength(1);
    await TraciveReportForm.present(reports, { prefill });
    expect(fakeNative.named('presentForm')).toHaveLength(2);
  });

  it('refuses a prefill with no identifier', async () => {
    await expect(
      TraciveReportForm.present(reportsNow(), { prefill: { identifiers: [] } }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fakeNative.named('presentForm')).toHaveLength(0);
  });

  it('refuses a date that is no day', async () => {
    await expect(
      TraciveReportForm.present(reportsNow(), {
        prefill: { identifiers: ['EMAIL_a'], incidentDate: '05/11/2026' },
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fakeNative.named('presentForm')).toHaveLength(0);
  });

  it('refuses a colour it cannot flatten', async () => {
    await expect(
      TraciveReportForm.present(reportsNow(), {
        prefill: { identifiers: ['EMAIL_a'] },
        theme: { primaryColor: 'not-a-colour' },
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('maps a native failure', async () => {
    fakeNative.answers.presentForm = () =>
      Promise.reject(Object.assign(new Error('Busy.'), { code: 'SERVER' }));
    await expect(
      TraciveReportForm.present(reportsNow(), { prefill: { identifiers: ['EMAIL_a'] } }),
    ).rejects.toMatchObject({ code: 'SERVER', message: 'Busy.' });
  });
});

describe('status', () => {
  it('says how it ended', async () => {
    const reports = reportsNow();
    expect(await TraciveReportStatus.present(reports, { reportId: 'r' })).toEqual({
      type: 'closed',
    });
    fakeNative.answers.presentStatus = async () => 'needsConsent';
    expect(await TraciveReportStatus.present(reports, { reportId: 'r' })).toEqual({
      type: 'needsConsent',
    });
  });

  it('sends the report and the theme', async () => {
    await TraciveReportStatus.present(reportsNow(), {
      reportId: 'r',
      theme: { cornerRadius: 0 },
    });
    expect(fakeNative.named('presentStatus')[0]?.[2]).toEqual({ reportId: 'r', cornerRadius: 0 });
  });
});

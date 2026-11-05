import { describe, expect, it } from '@jest/globals';

import { FakeClock, FakeTransport } from '../../__tests__/support/fakes';
import { TraciveClient, type TraciveClientOptions } from '../../client/TraciveClient';
import { TraciveEnvironment } from '../../model/TraciveEnvironment';
import { TraciveMode } from '../../model/TraciveMode';
import { InMemoryTokenStore } from '../../oauth/TokenStore';
import { TraciveOAuth } from '../../oauth/TraciveOAuth';
import { TraciveQuery } from '../../query/TraciveQuery';
import { ReportAttachment } from '../ReportAttachment';
import type { ReportFormLaunch, ReportFormLauncher } from '../ReportFormLauncher';
import type { ReportFormResult } from '../ReportFormResult';
import { ReportFormTarget } from '../ReportFormTarget';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const QUERY = TraciveQuery.bankAccount({
  countryAlpha3: 'IDN',
  bankCode: 'BCA',
  account: '1234567890',
});
const OAUTH = {
  clientId: 'partner-app',
  redirectUri: 'https://your.app/oauth/callback',
  partnerUserId: 'partner-user-1',
};
const NOW = new Date(2026, 10, 4, 10, 0).getTime();

class Launcher implements ReportFormLauncher {
  readonly launches: ReportFormLaunch[] = [];
  release: (() => void) | undefined;
  constructor(
    private readonly answer: ReportFormResult | Error = {
      type: 'opened',
      attachmentsDelivered: true,
    },
    private readonly hold = false,
  ) {}
  async launch(request: ReportFormLaunch): Promise<ReportFormResult> {
    this.launches.push(request);
    if (this.hold) await new Promise<void>((resolve) => (this.release = resolve));
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

function client(
  launcher: ReportFormLauncher,
  overrides?: Partial<TraciveClientOptions>,
): { client: TraciveClient; transport: FakeTransport } {
  const transport = new FakeTransport();
  return {
    transport,
    client: new TraciveClient({
      mode: TraciveMode.oauth(OAUTH),
      transport,
      clock: new FakeClock(NOW),
      reportFormLauncher: launcher,
      ...overrides,
    }),
  };
}

describe('openReportForm needs no grant, no token and no network', () => {
  it.each([
    ['a public OAuth client with no grant', TraciveMode.oauth(OAUTH)],
    [
      'a confidential OAuth client',
      TraciveMode.oauth({ ...OAUTH, clientType: 'CONFIDENTIAL' as const }),
    ],
    ['proxy mode', TraciveMode.proxy({ baseUrl: 'https://gateway.your.app/tracive' })],
  ])('in %s', async (_label, mode) => {
    const launcher = new Launcher();
    const { client: subject, transport } = client(launcher, {
      mode,
      tokenStore: new InMemoryTokenStore(),
    });
    expect(await subject.isAuthorized()).toBe(false);
    expect(await subject.openReportForm(QUERY)).toEqual({
      type: 'opened',
      attachmentsDelivered: true,
    });
    expect(launcher.launches).toHaveLength(1);
    expect(transport.requests).toHaveLength(0);
  });
});

describe('the target build', () => {
  it.each([
    ['production', TraciveEnvironment.production, ReportFormTarget.production],
    ['sandbox', TraciveEnvironment.sandbox, ReportFormTarget.sandbox],
    ['custom', TraciveEnvironment.custom('https://proxy.your.app'), ReportFormTarget.production],
  ])('follows the %s environment', async (_label, environment, expected) => {
    const launcher = new Launcher();
    await client(launcher, { environment }).client.openReportForm(QUERY);
    expect(launcher.launches[0]?.target).toEqual(expected);
    expect(launcher.launches[0]?.fallbackUrl).toBe(
      `${expected.scheme}://report/create?media=BANK_IDN_BCA_1234567890`,
    );
  });

  it('is replaced by an explicit target', async () => {
    const dev = {
      androidPackage: 'com.pleistocent.tracive.dev',
      iosBundleId: 'com.pleistocent.tracive.dev',
      scheme: 'tracivedev',
      reportScheme: 'tracivedev-report',
      fileExtension: 'tracivedevreport',
    };
    const launcher = new Launcher();
    await client(launcher, { environment: TraciveEnvironment.sandbox }).client.openReportForm(
      QUERY,
      { target: dev },
    );
    expect(launcher.launches[0]?.target).toEqual(dev);
    expect(launcher.launches[0]?.fallbackUrl).toBe(
      'tracivedev://report/create?media=BANK_IDN_BCA_1234567890',
    );
  });

  it('refuses an explicit target with a blank field, before anything opens', async () => {
    const launcher = new Launcher();
    await expect(
      client(launcher).client.openReportForm(QUERY, {
        target: { ...ReportFormTarget.sandbox, androidPackage: ' ' },
      }),
    ).rejects.toThrow(TypeError);
    expect(launcher.launches).toHaveLength(0);
  });
});

describe('the install link', () => {
  it('is the authorize install link, with attribution and without the identifier', async () => {
    const launcher = new Launcher();
    await client(launcher).client.openReportForm(TraciveQuery.phone('+6281234567890'));
    const installUrl = launcher.launches[0]?.installUrl ?? '';
    expect(installUrl).toBe(
      'https://tracive.chottu.link/install?ref=partner-app&utm_source=tracive-sdk-react-native',
    );
    expect(installUrl).not.toContain('6281234567890');
  });

  it('honours the installUrl override of the OAuth flow', async () => {
    const launcher = new Launcher();
    const oauth = new TraciveOAuth({ mode: OAUTH, installUrl: 'https://your.app/get-tracive' });
    await client(launcher, { oauth }).client.openReportForm(QUERY);
    expect(launcher.launches[0]?.installUrl).toBe(
      'https://your.app/get-tracive?ref=partner-app&utm_source=tracive-sdk-react-native',
    );
  });

  it('carries no ref in proxy mode, which has no client id', async () => {
    const launcher = new Launcher();
    await client(launcher, {
      mode: TraciveMode.proxy({ baseUrl: 'https://gateway.your.app' }),
    }).client.openReportForm(QUERY);
    expect(launcher.launches[0]?.installUrl).toBe(
      'https://tracive.chottu.link/install?utm_source=tracive-sdk-react-native',
    );
  });
});

describe('the incident date', () => {
  it('is today at the latest, on the device clock', async () => {
    const launcher = new Launcher();
    const subject = client(launcher).client;
    expect(await subject.openReportForm(QUERY, { incidentDate: '2026-11-04' })).toMatchObject({
      type: 'opened',
    });
    expect(await subject.openReportForm(QUERY, { incidentDate: '2026-11-05' })).toEqual({
      type: 'failed',
      error: { code: 'INCIDENT_DATE_IN_FUTURE' },
    });
    expect(launcher.launches).toHaveLength(1);
    expect(JSON.parse(launcher.launches[0]?.packageJson ?? '{}')).toMatchObject({
      incidentDate: '2026-11-04',
    });
  });

  it.each(['2026-11-4', '2026-02-30', '04/11/2026'])(
    'throws for %s, which is not a calendar date written YYYY-MM-DD',
    async (incidentDate) => {
      const launcher = new Launcher();
      await expect(client(launcher).client.openReportForm(QUERY, { incidentDate })).rejects.toThrow(
        TypeError,
      );
      expect(launcher.launches).toHaveLength(0);
    },
  );

  it('throws for a Date, which would bring a time zone with it', async () => {
    const launcher = new Launcher();
    await expect(
      client(launcher).client.openReportForm(QUERY, {
        incidentDate: new Date(NOW) as unknown as string,
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('arguments from untyped JavaScript', () => {
  it.each([
    ['a raw string as the query', 'BANK_IDN_BCA_1234567890', undefined],
    ['an attachment of plain numbers', QUERY, [{ bytes: [0x89, 0x50], mimeType: 'image/png' }]],
    ['attachments that are not an array', QUERY, { length: 1 }],
  ])('throw a TypeError for %s', async (_label, query, attachments) => {
    const launcher = new Launcher();
    await expect(
      client(launcher).client.openReportForm(
        query as unknown as TraciveQuery,
        attachments === undefined
          ? undefined
          : { attachments: attachments as unknown as ReportAttachment[] },
      ),
    ).rejects.toThrow(TypeError);
    expect(launcher.launches).toHaveLength(0);
  });
});

describe('the hand-off', () => {
  it('passes the iOS anchor through', async () => {
    const launcher = new Launcher();
    await client(launcher).client.openReportForm(QUERY, { anchor: 17 });
    expect(launcher.launches[0]?.anchor).toBe(17);
  });

  it('reports a launcher that rejects as a platform failure', async () => {
    const result = await client(new Launcher(new Error('PHONE_+62'))).client.openReportForm(QUERY);
    expect(result).toEqual({
      type: 'failed',
      error: { code: 'PLATFORM_FAILURE', message: 'The report form launcher threw.' },
    });
  });

  it('reports a launcher that throws synchronously as a platform failure', async () => {
    const throwing: ReportFormLauncher = {
      launch: () => {
        throw new Error('PHONE_+62');
      },
    };
    expect(await client(throwing).client.openReportForm(QUERY)).toMatchObject({
      type: 'failed',
      error: { code: 'PLATFORM_FAILURE' },
    });
  });

  it('joins a call made while another is still being handed off', async () => {
    const launcher = new Launcher(undefined, true);
    const subject = client(launcher).client;
    const first = subject.openReportForm(QUERY, {
      attachments: [ReportAttachment.image(PNG, 'image/png')],
    });
    await Promise.resolve();
    const second = subject.openReportForm(QUERY, {
      attachments: [ReportAttachment.image(PNG, 'image/png')],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(launcher.launches).toHaveLength(1);
    launcher.release?.();
    expect(await second).toEqual(await first);

    const third = subject.openReportForm(QUERY);
    await new Promise((resolve) => setTimeout(resolve, 0));
    launcher.release?.();
    await third;
    expect(launcher.launches).toHaveLength(2);
  });

  it('still refuses a bad call made while another is being handed off', async () => {
    const launcher = new Launcher(undefined, true);
    const subject = client(launcher).client;
    const first = subject.openReportForm(QUERY);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await subject.openReportForm(QUERY, { incidentDate: '2999-01-01' })).toEqual({
      type: 'failed',
      error: { code: 'INCIDENT_DATE_IN_FUTURE' },
    });
    launcher.release?.();
    await first;
  });
});

describe('redaction', () => {
  it('keeps attachment bytes out of every serialisation', () => {
    const attachment = ReportAttachment.image(PNG, 'image/png');
    expect(JSON.stringify(attachment)).toBe('{"mimeType":"image/png","size":11}');
    expect(String(attachment)).toBe('ReportAttachment(mimeType: image/png, bytes: <11 redacted>)');
    expect(Object.keys(attachment)).toEqual(['bytes', 'mimeType']);
  });

  it('keeps the identifier out of the launch request the launcher receives', async () => {
    const launcher = new Launcher();
    await client(launcher).client.openReportForm(TraciveQuery.phone('+6281234567890'));
    const launch = launcher.launches[0] as ReportFormLaunch;
    expect(JSON.stringify(launch)).not.toContain('6281234567890');
    expect(String(launch)).not.toContain('6281234567890');
    expect(launch.packageJson).toContain('PHONE_+6281234567890');
  });
});

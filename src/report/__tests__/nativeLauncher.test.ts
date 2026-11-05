import { describe, expect, it } from '@jest/globals';

import type { Diagnostic } from '../../diagnostics';
import type { Spec } from '../../specs/NativeTraciveReportForm';
import {
  MISSING_NATIVE_MODULE_MESSAGE,
  NativeReportFormLauncher,
  type ReportFormUrlOpener,
} from '../NativeReportFormLauncher';
import { reportFormLaunch, type ReportFormLaunch } from '../ReportFormLauncher';
import { ReportFormTarget } from '../ReportFormTarget';
import { REPORT_PACKAGE_MIME_TYPE } from '../reportPackage';

const PACKAGE = '{"v":1,"query":"PHONE_+6281234567890","attachments":[]}';
const LINK = 'tracivesandbox://report/create?media=PHONE_%2B6281234567890';
const INSTALL = 'https://tracive.chottu.link/install?ref=partner-app&utm_source=x';

function request(overrides?: Partial<ReportFormLaunch>): ReportFormLaunch {
  return reportFormLaunch({
    packageJson: PACKAGE,
    target: ReportFormTarget.sandbox,
    fallbackUrl: LINK,
    installUrl: INSTALL,
    anchor: 42,
    ...overrides,
  });
}

type Call = readonly [string, ...unknown[]];

/** Answers each native call from `answers`; an Error is thrown, anything else resolved. */
class FakeNative implements Spec {
  readonly calls: Call[] = [];
  constructor(
    private readonly answers: {
      installed?: boolean | Error;
      delivered?: boolean | Error;
      linked?: boolean | Error;
      picked?: string | Error;
    },
  ) {}

  #answer<T>(value: T | Error | undefined, name: string): Promise<T> {
    if (value === undefined) return Promise.reject(new Error(`unexpected native call ${name}`));
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  }

  isAppInstalled(androidPackage: string): Promise<boolean> {
    this.calls.push(['isAppInstalled', androidPackage]);
    return this.#answer(this.answers.installed, 'isAppInstalled');
  }
  deliverPackage(packageJson: string, androidPackage: string, mimeType: string): Promise<boolean> {
    this.calls.push(['deliverPackage', packageJson, androidPackage, mimeType]);
    return this.#answer(this.answers.delivered, 'deliverPackage');
  }
  openLink(url: string, androidPackage: string): Promise<boolean> {
    this.calls.push(['openLink', url, androidPackage]);
    return this.#answer(this.answers.linked, 'openLink');
  }
  presentPackage(packageJson: string, fileName: string, anchorTag: number): Promise<string> {
    this.calls.push(['presentPackage', packageJson, fileName, anchorTag]);
    return this.#answer(this.answers.picked, 'presentPackage');
  }
}

class FakeLinking implements ReportFormUrlOpener {
  readonly opened: string[] = [];
  readonly probed: string[] = [];
  constructor(
    private readonly openable: readonly string[],
    private readonly openRejects = false,
  ) {}
  async canOpenURL(url: string): Promise<boolean> {
    this.probed.push(url);
    return this.openable.includes(url);
  }
  async openURL(url: string): Promise<void> {
    this.opened.push(url);
    if (this.openRejects) throw new Error('declined');
  }
}

function launcher(os: string, native: FakeNative | null, linking = new FakeLinking([])) {
  const diagnostics: Diagnostic[] = [];
  return {
    linking,
    diagnostics,
    subject: new NativeReportFormLauncher({
      native,
      linking,
      os,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    }),
  };
}

describe('Android', () => {
  it('opens the install page, carrying nothing, when the target package is absent', async () => {
    const native = new FakeNative({ installed: false });
    const { subject, linking } = launcher('android', native);
    expect(await subject.launch(request())).toEqual({ type: 'installPageOpened' });
    expect(native.calls).toEqual([['isAppInstalled', 'com.pleistocent.tracive.sandbox']]);
    expect(linking.opened).toEqual([INSTALL]);
  });

  it('delivers the package to the target package when its intent resolves', async () => {
    const native = new FakeNative({ installed: true, delivered: true });
    const { subject, linking } = launcher('android', native);
    expect(await subject.launch(request())).toEqual({
      type: 'opened',
      attachmentsDelivered: true,
    });
    expect(native.calls[1]).toEqual([
      'deliverPackage',
      PACKAGE,
      'com.pleistocent.tracive.sandbox',
      REPORT_PACKAGE_MIME_TYPE,
    ]);
    expect(linking.opened).toEqual([]);
  });

  it('sends an older app the link, addressed to that package, when nothing takes the package', async () => {
    const native = new FakeNative({ installed: true, delivered: false, linked: true });
    const { subject, linking } = launcher('android', native);
    expect(await subject.launch(request())).toEqual({
      type: 'opened',
      attachmentsDelivered: false,
    });
    expect(native.calls[2]).toEqual(['openLink', LINK, 'com.pleistocent.tracive.sandbox']);
    // Never through Linking, which would let any app claiming the scheme receive the identifier.
    expect(linking.opened).toEqual([]);
  });

  it('fails, rather than claiming an open, when the link does not resolve either', async () => {
    const native = new FakeNative({ installed: true, delivered: false, linked: false });
    const { subject } = launcher('android', native);
    const result = await subject.launch(request());
    expect(result).toMatchObject({ type: 'failed', error: { code: 'PLATFORM_FAILURE' } });
  });

  it.each([
    ['the visibility check', { installed: new Error('PHONE_+6281234567890') }],
    ['writing the package', { installed: true, delivered: new Error('PHONE_+6281234567890') }],
  ])('reports a native failure in %s without its message', async (_step, answers) => {
    const { subject } = launcher('android', new FakeNative(answers));
    const result = await subject.launch(request());
    expect(result).toMatchObject({ type: 'failed', error: { code: 'PLATFORM_FAILURE' } });
    expect(JSON.stringify(result)).not.toContain('6281234567890');
  });

  it('reports installPageOpened and a diagnostic when the OS refuses the install link', async () => {
    const { subject, diagnostics } = launcher(
      'android',
      new FakeNative({ installed: false }),
      new FakeLinking([], true),
    );
    expect(await subject.launch(request())).toEqual({ type: 'installPageOpened' });
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'install_link_launch_failed',
    ]);
  });
});

describe('iOS', () => {
  const openable = ['tracivesandbox-report://', 'tracivesandbox://'];

  it('presents the sheet with the target extension and anchor, and delivers on the target bundle id', async () => {
    const native = new FakeNative({ picked: 'com.pleistocent.tracive.sandbox' });
    const { subject } = launcher('ios', native, new FakeLinking(openable));
    expect(await subject.launch(request())).toEqual({
      type: 'opened',
      attachmentsDelivered: true,
    });
    expect(native.calls).toEqual([['presentPackage', PACKAGE, 'report.tracivesandboxreport', 42]]);
  });

  it('answers cancelled when the user sends the file to another app', async () => {
    // The production app is the likeliest "other app": a sandbox package must not count there.
    const native = new FakeNative({ picked: 'com.pleistocent.tracive' });
    const { subject } = launcher('ios', native, new FakeLinking(openable));
    expect(await subject.launch(request())).toEqual({ type: 'cancelled' });
  });

  it('answers cancelled when the sheet is dismissed without sending', async () => {
    const native = new FakeNative({ picked: '' });
    const { subject } = launcher('ios', native, new FakeLinking(openable));
    expect(await subject.launch(request())).toEqual({ type: 'cancelled' });
  });

  it('presents from the top view controller when no anchor was given', async () => {
    const native = new FakeNative({ picked: '' });
    const { subject } = launcher('ios', native, new FakeLinking(openable));
    await subject.launch(request({ anchor: undefined }));
    expect(native.calls[0]?.[3]).toBe(-1);
  });

  it('takes the link when the report scheme is not queryable but the app scheme is', async () => {
    const native = new FakeNative({});
    const linking = new FakeLinking(['tracivesandbox://']);
    const { subject } = launcher('ios', native, linking);
    expect(await subject.launch(request())).toEqual({
      type: 'opened',
      attachmentsDelivered: false,
    });
    expect(linking.probed).toEqual(['tracivesandbox-report://', 'tracivesandbox://']);
    expect(linking.opened).toEqual([LINK]);
    expect(native.calls).toEqual([]);
  });

  it('answers cancelled when iOS completes the link with false', async () => {
    const { subject } = launcher(
      'ios',
      new FakeNative({}),
      new FakeLinking(['tracivesandbox://'], true),
    );
    expect(await subject.launch(request())).toEqual({ type: 'cancelled' });
  });

  it('opens the install page when neither scheme is queryable', async () => {
    const native = new FakeNative({});
    const linking = new FakeLinking([]);
    const { subject } = launcher('ios', native, linking);
    expect(await subject.launch(request())).toEqual({ type: 'installPageOpened' });
    expect(linking.opened).toEqual([INSTALL]);
    expect(native.calls).toEqual([]);
  });

  it('reports a sheet that could not be presented as a platform failure', async () => {
    const native = new FakeNative({ picked: new Error('busy') });
    const { subject } = launcher('ios', native, new FakeLinking(openable));
    expect(await subject.launch(request())).toMatchObject({
      type: 'failed',
      error: { code: 'PLATFORM_FAILURE' },
    });
  });
});

describe('without the native module', () => {
  it('fails with the rebuild instructions and touches nothing', async () => {
    const linking = new FakeLinking(['tracivesandbox-report://', 'tracivesandbox://']);
    const { subject } = launcher('ios', null, linking);
    expect(await subject.launch(request())).toEqual({
      type: 'failed',
      error: { code: 'PLATFORM_FAILURE', message: MISSING_NATIVE_MODULE_MESSAGE },
    });
    expect(linking.probed).toEqual([]);
    expect(linking.opened).toEqual([]);
  });

  it('fails on a platform that is neither Android nor iOS', async () => {
    const { subject } = launcher('web', new FakeNative({}));
    expect(await subject.launch(request())).toMatchObject({
      type: 'failed',
      error: { code: 'PLATFORM_FAILURE' },
    });
  });
});

describe('the launch request', () => {
  it('prints neither the package nor the link', () => {
    const printed = [JSON.stringify(request()), String(request()), `${request()}`];
    for (const text of printed) {
      expect(text).not.toContain('6281234567890');
    }
  });
});

import { Linking, Platform } from 'react-native';

import { emitDiagnostic, type DiagnosticSink } from '../diagnostics';
import NativeTraciveReportForm, { type Spec } from '../specs/NativeTraciveReportForm';
import type { ReportFormLaunch, ReportFormLauncher } from './ReportFormLauncher';
import type { ReportFormResult } from './ReportFormResult';
import { REPORT_PACKAGE_MIME_TYPE } from './reportPackage';

/** The two `Linking` calls the iOS path and the install page need. */
export interface ReportFormUrlOpener {
  canOpenURL(url: string): Promise<boolean>;
  openURL(url: string): Promise<unknown>;
}

export const MISSING_NATIVE_MODULE_MESSAGE =
  'This build does not contain the native module of the Tracive SDK ' +
  '(@pleistocent/tracive-sdk-react-native). ' +
  'Rebuild the app after installing or upgrading the package: `npx expo run:android` / ' +
  '`npx expo run:ios` (a development build; Expo Go cannot load it), or a Gradle build and ' +
  '`pod install` in a bare React Native app.';

function failed(message: string): ReportFormResult {
  return { type: 'failed', error: { code: 'PLATFORM_FAILURE', message } };
}

function opened(attachmentsDelivered: boolean): ReportFormResult {
  return { type: 'opened', attachmentsDelivered };
}

/**
 * The default {@link ReportFormLauncher}.
 *
 * Android: package not installed → install page. The package intent resolves → started. Installed
 * but nothing takes the package type (an older build) → the identifier-only link, explicitly
 * addressed to that package so no other app that claims the scheme can receive the identifier.
 *
 * iOS: the report scheme is openable → the "Open in" sheet, delivered only when the user picks the
 * target's bundle id. Else the app scheme is openable → the identifier-only link. Else → install
 * page.
 *
 * Failure messages are fixed strings. A native exception's own text is never passed on, because an
 * Android intent prints its data URI, and that URI carries the identifier.
 */
export class NativeReportFormLauncher implements ReportFormLauncher {
  readonly #native: Spec | null;
  readonly #linking: ReportFormUrlOpener;
  readonly #os: string | undefined;
  readonly #onDiagnostic: DiagnosticSink | undefined;

  constructor(options?: {
    /** `null` stands for a build without the native module. */
    readonly native?: Spec | null;
    readonly linking?: ReportFormUrlOpener;
    readonly os?: string;
    readonly onDiagnostic?: DiagnosticSink;
  }) {
    this.#native =
      options !== undefined && 'native' in options && options.native !== undefined
        ? options.native
        : NativeTraciveReportForm;
    this.#linking = options?.linking ?? Linking;
    this.#os = options?.os;
    this.#onDiagnostic = options?.onDiagnostic;
  }

  async launch(request: ReportFormLaunch): Promise<ReportFormResult> {
    const native = this.#native;
    if (native === null) return failed(MISSING_NATIVE_MODULE_MESSAGE);
    const os = this.#os ?? Platform.OS;
    if (os === 'android') return this.#android(native, request);
    if (os === 'ios') return this.#ios(native, request);
    return failed('openReportForm runs on Android and iOS only.');
  }

  async #android(native: Spec, request: ReportFormLaunch): Promise<ReportFormResult> {
    const { target } = request;
    let installed: boolean;
    try {
      installed = await native.isAppInstalled(target.androidPackage);
    } catch {
      return failed('The package manager could not say whether the Tracive app is installed.');
    }
    if (!installed) {
      await this.#openInstallPage(request.installUrl);
      return { type: 'installPageOpened' };
    }

    try {
      const delivered = await native.deliverPackage(
        request.packageJson,
        target.androidPackage,
        REPORT_PACKAGE_MIME_TYPE,
      );
      if (delivered) return opened(true);
    } catch {
      return failed('The report package could not be written or handed to the Tracive app.');
    }

    let linked = false;
    try {
      linked = await native.openLink(request.fallbackUrl, target.androidPackage);
    } catch {
      linked = false;
    }
    return linked
      ? opened(false)
      : failed('The Tracive app is installed but opened neither the report package nor the link.');
  }

  async #ios(native: Spec, request: ReportFormLaunch): Promise<ReportFormResult> {
    const { target } = request;
    if (await this.#canOpen(`${target.reportScheme}://`)) {
      let bundleId: string;
      try {
        bundleId = await native.presentPackage(
          request.packageJson,
          `report.${target.fileExtension}`,
          request.anchor ?? -1,
        );
      } catch {
        return failed('The "Open in" sheet could not be presented.');
      }
      return bundleId === target.iosBundleId ? opened(true) : { type: 'cancelled' };
    }

    if (await this.#canOpen(`${target.scheme}://`)) {
      try {
        await this.#linking.openURL(request.fallbackUrl);
        return opened(false);
      } catch {
        // `Linking.openURL` rejects when iOS completes the open with `false`, which includes the
        // user answering Cancel to "Open in Tracive?".
        return { type: 'cancelled' };
      }
    }

    await this.#openInstallPage(request.installUrl);
    return { type: 'installPageOpened' };
  }

  async #canOpen(url: string): Promise<boolean> {
    try {
      return await this.#linking.canOpenURL(url);
    } catch {
      return false;
    }
  }

  /** Reported as `installPageOpened` either way, as `authorize()` does; a refusal is a diagnostic. */
  async #openInstallPage(url: string): Promise<void> {
    try {
      await this.#linking.openURL(url);
      return;
    } catch {
      emitDiagnostic(this.#onDiagnostic, {
        code: 'install_link_launch_failed',
        severity: 'warning',
        message:
          'The Tracive app is not installed and the install page could not be opened, so the ' +
          'user was not sent anywhere.',
        hint: 'The operating system declined to open the install link.',
      });
    }
  }
}

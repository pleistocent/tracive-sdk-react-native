import { TraciveEnvironment } from '../model/TraciveEnvironment';
import {
  TRACIVE_APP_SCHEME,
  TRACIVE_REPORT_SCHEME,
  TRACIVE_SANDBOX_APP_SCHEME,
  TRACIVE_SANDBOX_REPORT_SCHEME,
} from '../oauth/authorizeUrl';

/** The Tracive build `openReportForm` hands the report to, named the way each platform names it. */
export interface ReportFormTarget {
  readonly androidPackage: string;
  /** Compared with the app the user picks in the iOS "Open in" sheet. */
  readonly iosBundleId: string;
  /** The app's URL scheme, used for the identifier-only link an older build understands. */
  readonly scheme: string;
  /** iOS: registered only by builds that accept the package. */
  readonly reportScheme: string;
  /** iOS: the extension, not a UTI, decides which apps the sheet offers. One per build. */
  readonly fileExtension: string;
}

const PRODUCTION: ReportFormTarget = Object.freeze({
  androidPackage: 'com.pleistocent.tracive',
  iosBundleId: 'com.pleistocent.tracive',
  scheme: TRACIVE_APP_SCHEME,
  reportScheme: TRACIVE_REPORT_SCHEME,
  fileExtension: 'tracivereport',
});

const SANDBOX: ReportFormTarget = Object.freeze({
  androidPackage: 'com.pleistocent.tracive.sandbox',
  iosBundleId: 'com.pleistocent.tracive.sandbox',
  scheme: TRACIVE_SANDBOX_APP_SCHEME,
  reportScheme: TRACIVE_SANDBOX_REPORT_SCHEME,
  fileExtension: 'tracivesandboxreport',
});

const FIELDS = [
  'androidPackage',
  'iosBundleId',
  'scheme',
  'reportScheme',
  'fileExtension',
] as const;

export const ReportFormTarget: {
  readonly production: ReportFormTarget;
  readonly sandbox: ReportFormTarget;
  /** A custom environment is a proxy or a local server; the app on the device is production. */
  forEnvironment(environment: TraciveEnvironment): ReportFormTarget;
  /**
   * An explicit target, for testing against a build the SDK does not know about. On Android the
   * host manifest must make that package visible (`<queries><package …/></queries>`), and on iOS
   * `LSApplicationQueriesSchemes` must list both of its schemes.
   *
   * @throws {TypeError} when a field is blank.
   */
  custom(target: ReportFormTarget): ReportFormTarget;
} = {
  production: PRODUCTION,
  sandbox: SANDBOX,
  forEnvironment(environment: TraciveEnvironment): ReportFormTarget {
    return environment.type === 'sandbox' ? SANDBOX : PRODUCTION;
  },
  custom(target: ReportFormTarget): ReportFormTarget {
    for (const field of FIELDS) {
      const value: unknown = target[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`ReportFormTarget.${field} must be a non-blank string`);
      }
    }
    return Object.freeze({
      androidPackage: target.androidPackage,
      iosBundleId: target.iosBundleId,
      scheme: target.scheme,
      reportScheme: target.reportScheme,
      fileExtension: target.fileExtension,
    });
  },
};

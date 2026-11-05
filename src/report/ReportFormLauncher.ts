import type { ReportFormResult } from './ReportFormResult';
import type { ReportFormTarget } from './ReportFormTarget';

/**
 * One validated hand-off. `packageJson` and `fallbackUrl` carry the raw identifier, so
 * `JSON.stringify` and string interpolation print neither; read the fields directly.
 */
export interface ReportFormLaunch {
  readonly packageJson: string;
  readonly target: ReportFormTarget;
  /** `<scheme>://report/create?media=…`, for a Tracive build too old to take the package. */
  readonly fallbackUrl: string;
  /** Carries attribution only, never the identifier. */
  readonly installUrl: string;
  /** iOS: the React tag the "Open in" sheet is anchored to. */
  readonly anchor: number | undefined;
}

/**
 * The platform half of `openReportForm`: given a package that already passed validation, decide
 * between the package, the identifier-only link and the install page, and say which happened.
 *
 * The default talks to the SDK's native module. Supply your own to fake the hand-off in your own
 * screen tests. It should not reject; a rejection is reported as `PLATFORM_FAILURE`.
 */
export interface ReportFormLauncher {
  launch(request: ReportFormLaunch): Promise<ReportFormResult>;
}

export function reportFormLaunch(fields: ReportFormLaunch): ReportFormLaunch {
  const summary = () => ({
    target: fields.target,
    anchor: fields.anchor,
    packageJson: `<${fields.packageJson.length} chars redacted>`,
    fallbackUrl: '[redacted]',
    installUrl: fields.installUrl,
  });
  return Object.defineProperties(
    { ...fields },
    {
      toJSON: { value: summary, enumerable: false },
      toString: {
        value: () =>
          `ReportFormLaunch(target: ${fields.target.androidPackage}, package: <redacted>)`,
        enumerable: false,
      },
    },
  );
}

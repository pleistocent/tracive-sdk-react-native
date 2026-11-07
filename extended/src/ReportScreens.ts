import { processColor, type ColorValue } from 'react-native';
import type { TraciveQuery } from '@pleistocent/tracive-sdk-react-native';

import { reportBridge } from './ReportBridge';
import { isCalendarDay } from './ReportDraft';
import type { ReportFile, ReportStatus } from './ReportModels';
import type { TraciveReports } from './TraciveReports';

/**
 * Your brand on Tracive's screens, in light and dark. The terms line above the Send button ignores
 * it: the user must always be able to read what they agree to.
 */
export interface TraciveReportTheme {
  /**
   * For buttons and highlights. Transparency is ignored, and a colour too close to the background
   * is shifted until it can be seen. Omit it to use Tracive's.
   */
  readonly primaryColor?: ColorValue | undefined;
  /** From 0 to 28. Omit it to use Tracive's. */
  readonly cornerRadius?: number | undefined;
}

/**
 * What you already know about the scammer. The user writes the chronology, so it cannot be
 * prefilled.
 */
export interface ReportPrefill {
  /** `TraciveQuery.searchQueryIndex` values, shown read-only. */
  readonly identifiers: readonly string[];
  /** `YYYY-MM-DD`. The user can change it, but not to a day in the future. */
  readonly incidentDate?: string | undefined;
  /** The user can change it. */
  readonly title?: string | undefined;
  /** The user can remove them. Each is compressed when the form opens. */
  readonly attachments?: readonly ReportFile[] | undefined;
}

export const ReportPrefill: {
  /** A prefill about one query. */
  forQuery(query: TraciveQuery, fields?: Omit<ReportPrefill, 'identifiers'>): ReportPrefill;
} = {
  forQuery(query, fields) {
    return { ...fields, identifiers: [query.searchQueryIndex] };
  },
};

/** How Tracive's form ended. */
export type ReportFormOutcome =
  /** The report was filed. Keep `reportId` with your transaction: reports cannot be listed. */
  | { readonly type: 'submitted'; readonly reportId: string; readonly status: ReportStatus }
  /** No grant, or a grant without `report.create`. Authorize with the scope and open it again. */
  | { readonly type: 'needsConsent' }
  /** The user closed the form. */
  | { readonly type: 'cancelled' };

/** How Tracive's status screen ended. */
export type ReportStatusOutcome =
  /** The user closed it. */
  | { readonly type: 'closed' }
  /** No grant, or a grant without `report.read`. Authorize with the scope and open it again. */
  | { readonly type: 'needsConsent' };

function themeWire(theme: TraciveReportTheme | undefined): Record<string, number> {
  const wire: Record<string, number> = {};
  if (theme?.primaryColor !== undefined) {
    const color = processColor(theme.primaryColor);
    if (typeof color !== 'number') {
      throw new TypeError('TraciveReportTheme.primaryColor must be a plain colour.');
    }
    wire.primaryColor = color;
  }
  if (theme?.cornerRadius !== undefined) wire.cornerRadius = theme.cornerRadius;
  return wire;
}

async function presentForm(
  reports: TraciveReports,
  prefill: ReportPrefill,
  theme: TraciveReportTheme | undefined,
): Promise<ReportFormOutcome> {
  if (prefill.identifiers.length === 0) {
    throw new TypeError('A ReportPrefill needs at least one identifier.');
  }
  if (prefill.incidentDate !== undefined && !isCalendarDay(prefill.incidentDate)) {
    throw new TypeError('ReportPrefill.incidentDate must be YYYY-MM-DD.');
  }
  const request = {
    identifiers: [...prefill.identifiers],
    ...(prefill.incidentDate === undefined ? {} : { incidentDate: prefill.incidentDate }),
    ...(prefill.title === undefined ? {} : { title: prefill.title }),
    attachments: (prefill.attachments ?? []).map((file) => reportBridge.fileWire(file)),
    ...themeWire(theme),
  };
  const handle = await reports.nativeHandle();
  const reply = await reportBridge.call(handle, undefined, (native) =>
    native.presentForm(handle, request),
  );
  return reply as ReportFormOutcome;
}

async function presentStatus(
  reports: TraciveReports,
  reportId: string,
  theme: TraciveReportTheme | undefined,
): Promise<ReportStatusOutcome> {
  const request = { reportId, ...themeWire(theme) };
  const handle = await reports.nativeHandle();
  const type = await reportBridge.call(handle, undefined, (native) =>
    native.presentStatus(handle, request),
  );
  return { type } as ReportStatusOutcome;
}

let openForm: Promise<ReportFormOutcome> | undefined;
let openStatus: Promise<ReportStatusOutcome> | undefined;

/** Tracive's report form, as a native screen over your app. */
export const TraciveReportForm = {
  /**
   * Shows the form and waits for it to close. Closing it cancels an upload in progress. A second
   * call while it is open joins the first.
   */
  present(
    reports: TraciveReports,
    options: { readonly prefill: ReportPrefill; readonly theme?: TraciveReportTheme | undefined },
  ): Promise<ReportFormOutcome> {
    openForm ??= presentForm(reports, options.prefill, options.theme).finally(() => {
      openForm = undefined;
    });
    return openForm;
  },
};

/** Tracive's status screen for one report, as a native screen over your app. */
export const TraciveReportStatus = {
  /**
   * Shows the screen and waits for it to close. Needs a grant with `report.read`. A second call
   * while it is open joins the first.
   */
  present(
    reports: TraciveReports,
    options: { readonly reportId: string; readonly theme?: TraciveReportTheme | undefined },
  ): Promise<ReportStatusOutcome> {
    openStatus ??= presentStatus(reports, options.reportId, options.theme).finally(() => {
      openStatus = undefined;
    });
    return openStatus;
  },
};

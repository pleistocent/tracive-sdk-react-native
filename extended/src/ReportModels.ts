import type { TraciveReportException } from './TraciveReportException';

/** The OAuth scopes this SDK needs. Add them to the scopes your client requests. */
export const TraciveReportScopes = Object.freeze({
  /** Send reports. */
  create: 'report.create',
  /** Read the status of reports sent through your app. */
  read: 'report.read',
} as const);

/** What a report must satisfy right now. Read it before showing a form. */
export interface ReportRequirements {
  /** False while reporting is switched off. */
  readonly enabled: boolean;
  /** How many more reports this user can send today. */
  readonly remainingToday: number;
  readonly limits: ReportLimits;
  /** The documents the user accepts by submitting. Show a link to each one. */
  readonly terms: readonly RequiredTerm[];
}

/** Field limits, from the server. */
export interface ReportLimits {
  readonly titleMaxLength: number;
  readonly chronologyMinLength: number;
  readonly chronologyMaxLength: number;
  readonly commentMaxLength: number;
  readonly maxIdentifiers: number;
  readonly attachmentsPerIdentifier: number;
  readonly extraAttachmentsWithPhone: number;
  readonly maxAttachmentBytes: number;
  readonly attachmentTypes: readonly string[];
}

/** One document the user accepts by submitting. */
export interface RequiredTerm {
  readonly id: string;
  readonly version: string;
  readonly url: string;
}

/** A report's stage. It never says what a review concluded. */
export type ReportStatus = 'SUBMITTED' | 'IN_REVIEW' | 'REVIEWED' | 'NEED_REVISION';

/** Field problems a form can show before sending anything. */
export type ReportFieldProblem =
  | 'NO_IDENTIFIER'
  | 'TOO_MANY_IDENTIFIERS'
  | 'TITLE_MISSING'
  | 'TITLE_TOO_LONG'
  | 'CHRONOLOGY_TOO_SHORT'
  | 'CHRONOLOGY_TOO_LONG'
  | 'COMMENT_TOO_LONG'
  | 'NO_EVIDENCE'
  | 'TOO_MANY_EVIDENCE'
  | 'INCIDENT_DATE_INVALID'
  | 'INCIDENT_DATE_IN_FUTURE';

/** The outcome of `TraciveReports.submit`. */
export type SubmitResult =
  /** Accepted. Keep `reportId` with your transaction; there is no way to list reports. */
  | { readonly type: 'submitted'; readonly reportId: string; readonly status: ReportStatus }
  /** No grant, or a grant without `report.create`. Authorize and call again. */
  | { readonly type: 'needsConsent' }
  | { readonly type: 'failed'; readonly error: TraciveReportException };

/** A file, read on the native side. Prefer `uri`: large images then never cross as base64. */
export type ReportFile =
  /** A `file://` path, or a `content://` one on Android. */
  | { readonly uri: string; readonly mimeType: string }
  | { readonly bytes: Uint8Array; readonly mimeType: string }
  | { readonly base64: string; readonly mimeType: string };

/** Answers the native core's request for an access token. */
export type ReportAccessToken = (stale: string | null) => Promise<string>;

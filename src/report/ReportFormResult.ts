/**
 * Why `openReportForm` opened nothing. The first six are the report package's validation codes,
 * checked in this order; a failed check never opens anything. `index` is the attachment's
 * position in the array you passed, from 0.
 */
export type ReportFormError =
  /** After the device's local today. */
  | { readonly code: 'INCIDENT_DATE_IN_FUTURE' }
  /** 5 per account, 10 when the query is a phone number. */
  | { readonly code: 'TOO_MANY_ATTACHMENTS'; readonly max: number }
  | { readonly code: 'UNSUPPORTED_TYPE'; readonly index: number }
  /** The bytes do not start the way the declared type's files start. */
  | { readonly code: 'CONTENT_MISMATCH'; readonly index: number }
  /** A PDF of 1 MiB (1,048,576 bytes) or more. */
  | { readonly code: 'PDF_TOO_LARGE'; readonly index: number }
  /** The encoded package is over 20 MiB. */
  | { readonly code: 'PACKAGE_TOO_LARGE'; readonly max: number }
  /**
   * The device could not hand the form over: the native module is missing from this build, a file
   * could not be written, or the OS refused to open anything. `message` never contains the
   * identifier.
   */
  | { readonly code: 'PLATFORM_FAILURE'; readonly message: string };

export const REPORT_FORM_ERROR_CODES = [
  'INCIDENT_DATE_IN_FUTURE',
  'TOO_MANY_ATTACHMENTS',
  'UNSUPPORTED_TYPE',
  'CONTENT_MISMATCH',
  'PDF_TOO_LARGE',
  'PACKAGE_TOO_LARGE',
  'PLATFORM_FAILURE',
] as const;
export type ReportFormErrorCode = (typeof REPORT_FORM_ERROR_CODES)[number];

export type ReportFormResult =
  /**
   * The Tracive app opened its report form. `attachmentsDelivered` is false when an older app took
   * the identifier-only link, so the date and the files did not arrive.
   */
  | { readonly type: 'opened'; readonly attachmentsDelivered: boolean }
  /** iOS only: the user closed the "Open in" sheet, or picked another app or "Save to Files". */
  | { readonly type: 'cancelled' }
  /** The Tracive app is not installed. The install page was opened, carrying nothing. */
  | { readonly type: 'installPageOpened' }
  | { readonly type: 'failed'; readonly error: ReportFormError };

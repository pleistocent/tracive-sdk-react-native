/** Why a call failed. */
export const REPORT_ERROR_CODES = [
  /** No grant, or a grant without the scope. Run your authorize flow, then call again. */
  'NEEDS_CONSENT',
  /** The user must verify their email in Tracive. */
  'EMAIL_NOT_VERIFIED',
  /** Unknown, not sent through this app for this user, or older than 30 days. */
  'REPORT_NOT_FOUND',
  /** The terms changed. Read the requirements again, show the new links, build a new draft. */
  'TERMS_OUTDATED',
  /** A field failed. The message names it. */
  'INVALID_REPORT',
  /** A file is missing, or its bytes do not match its type. */
  'ATTACHMENT_INVALID',
  /** Account or device cap. See `retryAfterSeconds`. */
  'DAILY_LIMIT_REACHED',
  /** Reporting is switched off for now. */
  'REPORTING_DISABLED',
  /** No answer. Call `submit` again with the same draft: nothing is sent twice. */
  'NETWORK',
  /** The server failed, or answered something this version does not know. */
  'SERVER',
  /** Neither an image nor a PDF. */
  'UNSUPPORTED_FILE',
  /** A PDF of 1 MiB or more. */
  'FILE_TOO_LARGE',
  /** The image could not be read or decoded, or could not be brought under the size limit. */
  'IMAGE_UNREADABLE',
  /** The call was cancelled, or its `TraciveReports` disposed. */
  'CANCELLED',
] as const;

export type ReportErrorCode = (typeof REPORT_ERROR_CODES)[number];

export interface TraciveReportExceptionDetails {
  /** The HTTP status, when the error came from a response. */
  readonly httpStatus?: number | undefined;
  /** Seconds to wait, for `DAILY_LIMIT_REACHED`. */
  readonly retryAfterSeconds?: number | undefined;
}

/** A failed report call. The message never carries user data. */
export class TraciveReportException extends Error {
  override readonly name = 'TraciveReportException' as const;
  readonly code: ReportErrorCode;
  readonly httpStatus?: number | undefined;
  readonly retryAfterSeconds?: number | undefined;

  constructor(code: ReportErrorCode, message: string, details?: TraciveReportExceptionDetails) {
    super(message);
    Object.setPrototypeOf(this, TraciveReportException.prototype);
    this.code = code;
    this.httpStatus = details?.httpStatus;
    this.retryAfterSeconds = details?.retryAfterSeconds;
  }
}

export function isTraciveReportException(value: unknown): value is TraciveReportException {
  return value instanceof TraciveReportException;
}

interface NativeRejection {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly userInfo?: {
    readonly httpStatus?: unknown;
    readonly retryAfterSeconds?: unknown;
  } | null;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * A rejection from the native module. Only a code the native core sets is trusted: the text of
 * anything else is a runtime's, and it could quote what it was given.
 */
export function reportExceptionFrom(failure: unknown): TraciveReportException {
  if (failure instanceof TraciveReportException) return failure;
  const { code, message, userInfo } = (failure ?? {}) as NativeRejection;
  const known = REPORT_ERROR_CODES.find((candidate) => candidate === code);
  if (known === undefined || typeof message !== 'string') {
    return new TraciveReportException('SERVER', 'The call failed.');
  }
  return new TraciveReportException(known, message, {
    httpStatus: numberOrUndefined(userInfo?.httpStatus),
    retryAfterSeconds: numberOrUndefined(userInfo?.retryAfterSeconds),
  });
}

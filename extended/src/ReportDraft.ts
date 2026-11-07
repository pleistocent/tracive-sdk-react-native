import type { TraciveQuery } from '@pleistocent/tracive-sdk-react-native';

import { reportBridge } from './ReportBridge';
import type { ReportFieldProblem, ReportLimits, RequiredTerm } from './ReportModels';

const PHONE_PREFIX = 'PHONE_';

/** Kotlin's `isBlank`, which `trim()` is not: it keeps U+FEFF and strips U+001C to U+001F. */
// eslint-disable-next-line no-control-regex
const BLANK = /^[\t-\r\u001C-\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/;

/**
 * Evidence ready to send, from `TraciveReports.prepare`.
 *
 * The bytes stay on the native side, and this is a handle to them. They are released when `submit`
 * files a report, on {@link release}, and when the `TraciveReports` that prepared them is disposed.
 */
export class PreparedEvidence {
  /** The type after compression, such as `image/avif`. */
  readonly mimeType: string;
  /** The size after compression. */
  readonly byteCount: number;
  /** The native side's key for these bytes. */
  readonly handle: number;
  readonly #release: (evidence: PreparedEvidence) => void;
  #released = false;

  constructor(
    handle: number,
    mimeType: string,
    byteCount: number,
    release: (evidence: PreparedEvidence) => void,
  ) {
    this.handle = handle;
    this.mimeType = mimeType;
    this.byteCount = byteCount;
    this.#release = release;
  }

  /** Whether the bytes are gone. A draft holding released evidence cannot be sent. */
  get isReleased(): boolean {
    return this.#released;
  }

  /** Releases the bytes. Call it when the user removes this file. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#release(this);
  }

  /** @internal The native side dropped the bytes with their owner. */
  markReleased(): void {
    this.#released = true;
  }
}

export interface ReportDraftFields {
  /** `TraciveQuery.searchQueryIndex` values. */
  readonly identifiers: readonly string[];
  readonly title: string;
  /** What happened, in the user's own words. Never prefill it. */
  readonly chronology: string;
  readonly comment?: string | undefined;
  /** `YYYY-MM-DD`. */
  readonly incidentDate: string;
  readonly evidence: readonly PreparedEvidence[];
  /** From `ReportRequirements.terms`, only what was shown to the user. */
  readonly acceptedTerms: readonly RequiredTerm[];
  /** `id` or `en`. Omit it to use the device language. */
  readonly language?: string | undefined;
  /** Set it only to rebuild a draft saved before a restart. */
  readonly idempotencyKey?: string | undefined;
}

/** Whether `value` is `YYYY-MM-DD` and a day the calendar has. */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Today on this device, as `YYYY-MM-DD`. */
export function localDay(date: Date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${month}-${day}`;
}

/**
 * One report. Keep the same draft across retries: its {@link idempotencyKey} is what stops a retry
 * from becoming a second report. Changing anything means building a new draft, with a new key.
 */
export class ReportDraft {
  readonly identifiers: readonly string[];
  readonly title: string;
  readonly chronology: string;
  readonly comment: string | undefined;
  readonly incidentDate: string;
  readonly evidence: readonly PreparedEvidence[];
  readonly acceptedTerms: readonly RequiredTerm[];
  readonly language: string | undefined;
  readonly idempotencyKey: string;

  constructor(fields: ReportDraftFields) {
    this.identifiers = fields.identifiers;
    this.title = fields.title;
    this.chronology = fields.chronology;
    this.comment = fields.comment;
    this.incidentDate = fields.incidentDate;
    this.evidence = fields.evidence;
    this.acceptedTerms = fields.acceptedTerms;
    this.language = fields.language;
    this.idempotencyKey = fields.idempotencyKey ?? reportBridge.native.idempotencyKey();
  }

  /** A draft about one query. */
  static forQuery(
    query: TraciveQuery,
    fields: Omit<ReportDraftFields, 'identifiers' | 'idempotencyKey'>,
  ): ReportDraft {
    return new ReportDraft({ ...fields, identifiers: [query.searchQueryIndex] });
  }

  /**
   * Everything wrong with this draft, in form order. Empty means it can be sent.
   *
   * @param today `YYYY-MM-DD`. Defaults to today on this device.
   */
  problems(limits: ReportLimits, today: string = localDay()): ReportFieldProblem[] {
    const problems: ReportFieldProblem[] = [];
    if (this.identifiers.length === 0) problems.push('NO_IDENTIFIER');
    if (this.identifiers.length > limits.maxIdentifiers) problems.push('TOO_MANY_IDENTIFIERS');

    if (!isCalendarDay(this.incidentDate)) problems.push('INCIDENT_DATE_INVALID');
    else if (this.incidentDate > today) problems.push('INCIDENT_DATE_IN_FUTURE');

    if (BLANK.test(this.title)) problems.push('TITLE_MISSING');
    if (this.title.length > limits.titleMaxLength) problems.push('TITLE_TOO_LONG');
    if (this.chronology.length < limits.chronologyMinLength) problems.push('CHRONOLOGY_TOO_SHORT');
    if (this.chronology.length > limits.chronologyMaxLength) problems.push('CHRONOLOGY_TOO_LONG');
    if ((this.comment?.length ?? 0) > limits.commentMaxLength) problems.push('COMMENT_TOO_LONG');

    if (this.evidence.length === 0) problems.push('NO_EVIDENCE');
    if (this.identifiers.length > 0 && this.evidence.length > this.maxEvidence(limits)) {
      problems.push('TOO_MANY_EVIDENCE');
    }
    return problems;
  }

  /** How many files this draft may carry. */
  maxEvidence(limits: ReportLimits): number {
    const phone = this.identifiers.some((identifier) => identifier.startsWith(PHONE_PREFIX));
    return (
      this.identifiers.length * limits.attachmentsPerIdentifier +
      (phone ? limits.extraAttachmentsWithPhone : 0)
    );
  }
}

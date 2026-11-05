import { base64Encode } from '../crypto/base64';
import { utf8ByteLength } from '../crypto/utf8';
import type { ReportAttachment } from './ReportAttachment';
import type { ReportFormError } from './ReportFormResult';

/** The Android intent type, the same for every Tracive build. */
export const REPORT_PACKAGE_MIME_TYPE = 'application/vnd.tracive.report+json';

export const PDF_MAX_BYTES_EXCLUSIVE = 1_048_576;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENTS_PHONE = 10;
/**
 * Not one of the app's form limits: the receiver holds the package in memory, and any app on the
 * phone can send one, so the app refuses anything larger and the SDK refuses it first.
 */
export const PACKAGE_MAX_BYTES = 20_971_520;

// A Map, not an object literal: the type arrives from the caller, and `'constructor'` must not
// resolve to something on Object.prototype.
const EXTENSIONS = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/heic', 'heic'],
  ['image/heif', 'heif'],
  ['image/bmp', 'bmp'],
  ['application/pdf', 'pdf'],
]);

const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function normalizeMimeType(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  return lower === 'image/jpg' ? 'image/jpeg' : lower;
}

function bytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((value, i) => bytes[offset + i] === value);
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  const codes: number[] = [];
  for (let i = 0; i < text.length; i++) codes.push(text.charCodeAt(i));
  return bytesAt(bytes, offset, codes);
}

/** Empty bytes never match. */
export function contentMatches(mimeType: string, bytes: Uint8Array): boolean {
  switch (mimeType) {
    case 'image/jpeg':
      return bytesAt(bytes, 0, [0xff, 0xd8, 0xff]);
    case 'image/png':
      return bytesAt(bytes, 0, PNG_SIGNATURE);
    case 'image/webp':
      return asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP');
    case 'image/bmp':
      return asciiAt(bytes, 0, 'BM');
    case 'image/heic':
    case 'image/heif':
      return asciiAt(bytes, 4, 'ftyp') && HEIF_BRANDS.some((brand) => asciiAt(bytes, 8, brand));
    case 'application/pdf':
      return asciiAt(bytes, 0, '%PDF-');
    default:
      return false;
  }
}

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` naming a day that exists, `2028-02-29` yes and `2026-02-29` no. */
export function isCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (lengths[month - 1] as number);
}

/** The calendar date on the device's clock, in its own time zone. */
export function localDate(nowMs: number): string {
  const now = new Date(nowMs);
  const pad = (value: number, width: number) => String(value).padStart(width, '0');
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1, 2)}-${pad(now.getDate(), 2)}`;
}

export type BuiltReportPackage =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly error: ReportFormError };

/**
 * Validates in the contract's order and builds the package's JSON.
 *
 * `incidentDate` must already satisfy {@link isCalendarDate}; `today` is {@link localDate}. Both are
 * zero-padded, so comparing them as strings compares the dates.
 */
export function buildReportPackage(input: {
  readonly query: string;
  readonly incidentDate: string | undefined;
  readonly attachments: readonly ReportAttachment[];
  readonly today: string;
}): BuiltReportPackage {
  const { query, incidentDate, attachments } = input;
  if (incidentDate !== undefined && incidentDate > input.today) {
    return { ok: false, error: { code: 'INCIDENT_DATE_IN_FUTURE' } };
  }

  const max = query.startsWith('PHONE_') ? MAX_ATTACHMENTS_PHONE : MAX_ATTACHMENTS;
  if (attachments.length > max) {
    return { ok: false, error: { code: 'TOO_MANY_ATTACHMENTS', max } };
  }

  const accepted: { mimeType: string; extension: string; bytes: Uint8Array }[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const mimeType = normalizeMimeType(attachment.mimeType);
    const extension = EXTENSIONS.get(mimeType);
    if (extension === undefined) return { ok: false, error: { code: 'UNSUPPORTED_TYPE', index } };
    if (!contentMatches(mimeType, attachment.bytes)) {
      return { ok: false, error: { code: 'CONTENT_MISMATCH', index } };
    }
    if (mimeType === 'application/pdf' && attachment.bytes.length >= PDF_MAX_BYTES_EXCLUSIVE) {
      return { ok: false, error: { code: 'PDF_TOO_LARGE', index } };
    }
    accepted.push({ mimeType, extension, bytes: attachment.bytes });
  }

  const json = JSON.stringify({
    v: 1,
    query,
    ...(incidentDate !== undefined ? { incidentDate } : {}),
    attachments: accepted.map((entry, i) => ({
      name: `attachment-${i + 1}.${entry.extension}`,
      mimeType: entry.mimeType,
      data: base64Encode(entry.bytes),
    })),
  });
  if (utf8ByteLength(json) > PACKAGE_MAX_BYTES) {
    return { ok: false, error: { code: 'PACKAGE_TOO_LARGE', max: PACKAGE_MAX_BYTES } };
  }
  return { ok: true, json };
}

/**
 * `<scheme>://report/create?media=<query>`, the link every released Tracive build opens a
 * prefilled form from. Everything outside RFC 3986's unreserved set is percent-encoded, because
 * Android's `Uri.getQueryParameter` reads a literal `+` as a space and `PHONE_+62…` would arrive
 * as `PHONE_ 62…`.
 */
export function reportFormLink(scheme: string, query: string): string {
  const encoded = encodeURIComponent(query).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${scheme}://report/create?media=${encoded}`;
}

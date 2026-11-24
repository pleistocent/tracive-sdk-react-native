import { utf8Encode } from '../crypto/utf8';
import { foldedUpperCase } from './nfc';
import { TraciveQueryError } from './TraciveQueryError';

/**
 * The QRIS folds: a payload, an NMID or a PAN becomes the key the Tracive API indexes.
 *
 * Unlike every other fold in this directory, these do NOT use `trim()` or `\s`. The server spells
 * the space set out as exactly tab, LF, CR, space and U+00A0, so a U+2003 that `trim()` would strip
 * must survive here and fail the shape check, as the fixture's `qris-nmid-em-space` pins.
 */
const SPACES = /[\t\n\r \u00a0]/g;
const EDGE_SPACES = /^[\t\n\r \u00a0]+|[\t\n\r \u00a0]+$/g;
const NMID = /^ID[0-9]{13}$/;
const TWO_DIGITS = /^[0-9]{2}$/;
const PAN = /^[0-9]{18}$/;
const PAN_WITH_CHECK_DIGIT = /^[0-9]{19}$/;
/** An unknown value in tag 51 falls through to the merchant account template, as on the server. */
const KNOWN_CRITERIA: readonly string[] = ['UMI', 'UKE', 'UME', 'UBE'];
const INDEXED_CRITERIA: readonly string[] = ['UMI', 'UKE'];

/** CRC-16/CCITT-FALSE, as four upper-case hex digits. */
export function qrisCrc(data: string): string {
  // Over the UTF-8 bytes, while the TLV lengths count UTF-16 units: `KOPI SÉDAP` is 10 of one and
  // 11 of the other, and the fixture pins both.
  const bytes = utf8Encode(data);
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= (bytes[i] as number) << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** `undefined` when the framing breaks: a tag or length not two ASCII digits, or a short value. */
function readTlv(data: string): [string, string][] | undefined {
  const out: [string, string][] = [];
  let i = 0;
  while (i < data.length) {
    const tag = data.slice(i, i + 2);
    const length = data.slice(i + 2, i + 4);
    if (!TWO_DIGITS.test(tag) || !TWO_DIGITS.test(length)) return undefined;
    const end = i + 4 + Number(length);
    if (end > data.length) return undefined;
    out.push([tag, data.slice(i + 4, end)]);
    i = end;
  }
  return out;
}

function firstByTag(tlv: readonly [string, string][]): Map<string, string> {
  const map = new Map<string, string>();
  for (const [tag, value] of tlv) if (!map.has(tag)) map.set(tag, value);
  return map;
}

function subTags(value: string | undefined): Map<string, string> {
  return firstByTag((value !== undefined ? readTlv(value) : undefined) ?? []);
}

function knownCriteria(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const upper = foldedUpperCase(value);
  return KNOWN_CRITERIA.includes(upper) ? upper : undefined;
}

/** Sub-tag 03 of the first merchant account template (26 to 45, in tag order) with a sub-tag 00. */
function acquirerCriteria(top: Map<string, string>): string | undefined {
  const templates = [...top.keys()].filter((tag) => Number(tag) >= 26 && Number(tag) <= 45).sort();
  for (const tag of templates) {
    const sub = subTags(top.get(tag));
    if (sub.has('00')) return knownCriteria(sub.get('03'));
  }
  return undefined;
}

function nmidOrUndefined(value: string): string | undefined {
  const nmid = foldedUpperCase(value.replace(SPACES, ''));
  return NMID.test(nmid) ? nmid : undefined;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Every tab, LF, CR, space and U+00A0 removed, upper-cased, then `ID` and 13 ASCII digits. */
export function foldQrisNmid(value: string): string {
  const nmid = nmidOrUndefined(value);
  if (nmid === undefined) throw new TraciveQueryError('not_an_nmid');
  return nmid;
}

/** 18 ASCII digits, or 19 whose last is their Luhn digit, folded to the first 18. */
export function foldQrisPan(value: string): string {
  const digits = value.replace(SPACES, '');
  if (PAN.test(digits)) return digits;
  if (PAN_WITH_CHECK_DIGIT.test(digits) && luhnValid(digits)) return digits.slice(0, 18);
  throw new TraciveQueryError('not_a_pan');
}

/**
 * The NMID of an intact UMI or UKE QRIS payload. The checks run in the fixture's order:
 * `not_a_qris`, `qris_crc_mismatch`, `qris_no_nmid`, `qris_not_indexed`.
 */
export function foldQrisPayload(value: string): string {
  const payload = value.replace(EDGE_SPACES, '');
  if (!payload.startsWith('000201')) throw new TraciveQueryError('not_a_qris');
  const tlv = readTlv(payload);
  const last = tlv?.[tlv.length - 1];
  if (tlv === undefined || last === undefined || last[0] !== '63' || last[1].length !== 4) {
    throw new TraciveQueryError('not_a_qris');
  }
  if (qrisCrc(payload.slice(0, -4)) !== foldedUpperCase(last[1])) {
    throw new TraciveQueryError('qris_crc_mismatch');
  }

  const top = firstByTag(tlv);
  const national = subTags(top.get('51'));
  const rawNmid = national.get('02');
  const nmid = rawNmid !== undefined ? nmidOrUndefined(rawNmid) : undefined;
  if (nmid === undefined) throw new TraciveQueryError('qris_no_nmid');

  const criteria = knownCriteria(national.get('03')) ?? acquirerCriteria(top);
  if (criteria === undefined || !INDEXED_CRITERIA.includes(criteria)) {
    throw new TraciveQueryError('qris_not_indexed');
  }
  return nmid;
}

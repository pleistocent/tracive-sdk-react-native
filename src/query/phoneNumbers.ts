import { countryFromAlpha3 } from './countries';
import { TraciveQueryError } from './TraciveQueryError';

/**
 * Countries whose trunk prefix is 8, with how many digits follow that 8. Belarus counts the 0 it
 * writes after the 8 (`8 029 123 45 67`); the leading-zero strip removes it afterwards. Source: ITU
 * "Dialling procedures" and each country's numbering plan filed with the ITU.
 */
const DIGITS_AFTER_TRUNK_8: Readonly<Record<string, number>> = {
  '375': 10, // Belarus
  '370': 8, // Lithuania
  '992': 9, // Tajikistan
  '993': 8, // Turkmenistan
  '998': 9, // Uzbekistan
};

/**
 * Turns a phone number written the way people in a country actually write it into E.164.
 *
 * `TraciveQuery.phone` deliberately refuses a local format such as `081234567891`, and says why: the
 * SDK cannot know the caller's dial code, and a wrong guess still costs a credit. This function is
 * where that missing dial code comes from, so the strictness downstream stays intact:
 *
 * ```ts
 * TraciveQuery.phone(normalizePhoneNumber('IDN', '0857-1860-9079')); // +6285718609079
 * TraciveQuery.phone(normalizePhoneNumber('+62', '0857 1860 9079')); // the same key
 * ```
 *
 * It is a plain exported function on purpose: a partner needs the E.164 form for their own records,
 * logging and outbound messaging, not only for a Tracive lookup.
 *
 * The rules are a deliberate copy of the Tracive app's normalizer, heuristics included — if the app
 * folded a number one way and this SDK another, one person would become two record keys, and a
 * report filed in the app would be invisible to a check made here.
 * `phone-normalization-vectors.json` pins the agreement and is vendored byte-identically into all
 * four SDK repositories.
 *
 * @param countryOrDialCode an ISO 3166-1 **alpha-3** code (`IDN`, `USA` — case-insensitive) or a
 *   dial code with or without `+` (`+62`, `62`). Told apart by shape: letters mean alpha-3, digits
 *   mean a dial code. Alpha-2 (`ID`) is refused, because this SDK speaks alpha-3 everywhere.
 * @param phoneNumber the number as written locally. Spaces, dashes, brackets and a leading `+` are
 *   all fine.
 * @returns the number in E.164. Never an empty string.
 * @throws TraciveQueryError `empty_country`, `unknown_country`, `empty_phone_number` or
 *   `country_conflict`.
 */
export function normalizePhoneNumber(countryOrDialCode: string, phoneNumber: string): string {
  const dialCode = resolveDialCode(countryOrDialCode);
  let digits = digitsOf(phoneNumber);
  if (digits === '') throw new TraciveQueryError('empty_phone_number');

  // A leading `+` is the caller stating "this is already international". If the code that follows
  // disagrees with the country they named, the two arguments contradict each other, and guessing
  // which one is right is exactly what costs a credit: ('IDN', '+64857…') used to yield
  // +626485718609079, a New Zealand number wearing an Indonesian dial code.
  //
  // Three deliberate departures from the Tracive app's normalizer live here, and they are not the
  // same kind of thing. A dial code that disagrees with the country named is safe to reject: every
  // such input produced an unusable key in the app too. `+00<dial>` is not — the app accepts it and
  // folds it correctly, so here the SDK is genuinely stricter. That is the intended trade: `+` and
  // `00` are alternative spellings, not stackable ones; what follows `+` must be a country code,
  // and `00` is none. An earlier version of this comment claimed the first reason covered both.
  //
  // A third, quieter one: emptiness is re-checked *after* the trunk prefix is stripped, so `000`,
  // `62` and `1` are refused. The app folds those to `+62` and `+1`, which cannot match any record,
  // so this belongs with the first kind — safe, not stricter.
  if (trimStartCanonically(phoneNumber).startsWith('+') && !digits.startsWith(dialCode)) {
    throw new TraciveQueryError('country_conflict');
  }

  if (digits.startsWith(`00${dialCode}`)) {
    digits = digits.slice(2 + dialCode.length);
  } else if (digits.startsWith(dialCode)) {
    digits = digits.slice(dialCode.length);
  }

  switch (dialCode) {
    // Russia and Kazakhstan: trunk prefix 8, local numbers are 10 digits.
    case '7':
      if (digits.startsWith('8') && digits.length === 11) digits = digits.slice(1);
      break;
    // Italy and San Marino: the leading 0 IS part of the number for landlines.
    case '39':
    case '378':
      break;
    // Côte d'Ivoire, Benin and the Republic of the Congo have no trunk prefix, and their regulators
    // require the 0 after the country code (+225 07…, +229 01…, +242 06…).
    case '225':
    case '229':
    case '242':
      break;
    // Hungary: the trunk prefix is 06. A national number may start with 6 (Szeged is 62), so the
    // pair is dropped, never a 0 and then a 6 on its own.
    case '36':
      if (digits.startsWith('06')) digits = digits.slice(2);
      digits = withoutLeadingZeros(digits);
      break;
    // A trunk 8 (Lithuania's until March 2024, 0 since). Some national numbers start with 8
    // themselves (Belarusian 801 and Lithuanian 800 freephone, Uzbek 88 mobile), so the 8 goes only
    // when exactly a national number's length follows it.
    case '375':
    case '370':
    case '992':
    case '993':
    case '998':
      if (
        digits.startsWith('8') &&
        digits.length === (DIGITS_AFTER_TRUNK_8[dialCode] as number) + 1
      ) {
        digits = digits.slice(1);
      }
      digits = withoutLeadingZeros(digits);
      break;
    // North America: trunk prefix 1, local numbers are 10 digits.
    case '1':
      if (digits.startsWith('1') && digits.length === 11) digits = digits.slice(1);
      break;
    // Everywhere else, including Indonesia, the UK and Germany: trunk prefix 0.
    default:
      digits = withoutLeadingZeros(digits);
      break;
  }

  // A number that is nothing but zeros is refused here, not left to `phone()`. For most countries the
  // trunk-prefix rule strips the zeros away and the emptiness check above catches it — but Italy, San
  // Marino, Côte d'Ivoire, Benin, the Congo, North America and Russia do not strip leading zeros, so
  // `+390000000` survived, matched E.164, reached the network and was billed for a miss it could
  // only ever be. Refusing it here also makes the reason the same in every country instead of
  // `empty_phone_number` in Indonesia and `not_e164` in Italy for the identical input.
  if (digits === '' || /^0+$/.test(digits)) throw new TraciveQueryError('empty_phone_number');
  return `+${dialCode}${digits}`;
}

function digitsOf(value: string): string {
  let out = '';
  for (const character of value) {
    if (character >= '0' && character <= '9') out += character;
  }
  return out;
}

function withoutLeadingZeros(value: string): string {
  let index = 0;
  while (index < value.length && value[index] === '0') index += 1;
  return value.slice(index);
}

/** Alpha-3 in, dial code out; or digits in, the same digits out. */
function resolveDialCode(countryOrDialCode: string): string {
  const trimmed = trimCanonically(countryOrDialCode);
  if (trimmed === '') throw new TraciveQueryError('empty_country');

  const digits = digitsOf(trimmed);
  if (digits !== '') {
    const stripped = withoutLeadingZeros(digits);
    if (stripped === '') throw new TraciveQueryError('empty_country');
    return stripped;
  }

  const country = countryFromAlpha3(trimmed);
  if (country === undefined) throw new TraciveQueryError('unknown_country');
  return country.dialCode;
}

/**
 * The characters trimmed from a country or dial code, defined here rather than delegated to
 * `String.prototype.trim()`.
 *
 *
 * ASCII whitespace only, and deliberately **not** U+FEFF. A byte-order mark inside a data value is
 * an encoding fault upstream; swallowing it here would tell a partner their pipeline is clean while
 * the same mark waits to land in a phone number or an account id, where nothing trims it and the key
 * comes out wrong. Each platform's own trim() disagrees about this — Kotlin's follows Unicode
 * White_Space plus U+FEFF, JavaScript's strips a different set — which made one input behave two
 * ways across the four SDKs.
 */
const TRIMMED = new Set([' ', '\t', '\n', '\u000B', '\u000C', '\r']);

function trimCanonically(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && TRIMMED.has(value[start] as string)) start += 1;
  while (end > start && TRIMMED.has(value[end - 1] as string)) end -= 1;
  return value.slice(start, end);
}

function trimStartCanonically(value: string): string {
  let start = 0;
  while (start < value.length && TRIMMED.has(value[start] as string)) start += 1;
  return value.slice(start);
}

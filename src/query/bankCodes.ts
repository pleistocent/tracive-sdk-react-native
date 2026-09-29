import { BANK_CODES_JSON } from './bankCodesJson';
import { foldBankShortCode, foldBic } from './folding';

/**
 * A partner's own bank identifier -> Tracive's `bankCode`, per ISO 3166-1 alpha-3 country.
 *
 * The server translates a national bank code (`014`) or a BIC (`CENAIDJA`) to `bankCode` (`BCA`)
 * before it builds `BANK_<country>_<bankCode>_<account>`. This does the same on the device, from the
 * same table, because that key is also the local cache key: keyed on the untranslated code, a check
 * could never hit the cache and every one would be billed.
 *
 * Every level is a `Map`, never a plain object, so an inherited member — `constructor`,
 * `__proto__`, or anything another library adds to `Object.prototype` — is an ordinary miss.
 */
export interface BankCodeTable {
  readonly shortCode: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** The all-digit short codes only, keyed without their leading zeros. */
  readonly bareShortCode: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly bic: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

interface BankCodesFile {
  readonly countries: Readonly<
    Record<
      string,
      {
        readonly shortCode: Readonly<Record<string, string>>;
        readonly bic: Readonly<Record<string, string>>;
      }
    >
  >;
}

const ALL_DIGITS = /^\d+$/;

/** `000` becomes `0`: the last digit always stays. */
export function stripLeadingZeros(code: string): string {
  return code.replace(/^0+(?=\d)/, '');
}

function parseBankCodes(json: string): BankCodeTable {
  const file = JSON.parse(json) as BankCodesFile;
  const shortCode = new Map<string, ReadonlyMap<string, string>>();
  const bareShortCode = new Map<string, ReadonlyMap<string, string>>();
  const bic = new Map<string, ReadonlyMap<string, string>>();
  for (const [country, codes] of Object.entries(file.countries)) {
    const entries = Object.entries(codes.shortCode);
    shortCode.set(country, new Map(entries));
    // bankCodes.test.ts proves no two all-digit codes of one country collide once stripped, so
    // insertion order can never choose between two banks here.
    bareShortCode.set(
      country,
      new Map(
        entries
          .filter(([code]) => ALL_DIGITS.test(code))
          .map(([code, bankCode]) => [stripLeadingZeros(code), bankCode]),
      ),
    );
    bic.set(country, new Map(Object.entries(codes.bic)));
  }
  return { shortCode, bareShortCode, bic };
}

let table: BankCodeTable | undefined;

/** Parsed on first use, not at import: an app that never names a bank by code never pays for it. */
export function bankCodeTable(): BankCodeTable {
  if (table === undefined) table = parseBankCodes(BANK_CODES_JSON);
  return table;
}

/**
 * The `bankCode` for a national bank code, or `undefined` when `country` does not list it. Never
 * `''`: like the server, an empty entry is a miss.
 *
 * @param country already folded by `foldCountryAlpha3`.
 */
export function bankCodeByShortCode(country: string, raw: string): string | undefined {
  const code = foldBankShortCode(raw);
  const { shortCode, bareShortCode } = bankCodeTable();
  const exact = shortCode.get(country)?.get(code);
  if (exact) return exact;
  // National codes are fixed-width (`014`), but a partner storing them as numbers sends `14`.
  if (!ALL_DIGITS.test(code)) return undefined;
  return bareShortCode.get(country)?.get(stripLeadingZeros(code)) || undefined;
}

/**
 * The `bankCode` for an 8- or 11-character BIC, or `undefined` when it is malformed or `country`
 * does not list it. A BIC is looked up within `country` only.
 *
 * @param country already folded by `foldCountryAlpha3`.
 */
export function bankCodeByBic(country: string, raw: string): string | undefined {
  const bic = foldBic(raw);
  if (bic === undefined) return undefined;
  return bankCodeTable().bic.get(country)?.get(bic) || undefined;
}

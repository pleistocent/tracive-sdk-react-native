import type { QueryKind } from '../model/enums';
import {
  foldBankAccount,
  foldBankCode,
  foldChain,
  foldCountryAlpha3,
  foldCryptoAddress,
  foldEmail,
  foldHandle,
  foldPhone,
  foldPlatform,
} from './folding';
import { bankCodeByBic, bankCodeByShortCode } from './bankCodes';
import { isValidRecordKey } from './recordKeyGuard';
import { TraciveQueryError } from './TraciveQueryError';

function assertValidRecordKey(key: string): string {
  if (!isValidRecordKey(key)) throw new TraciveQueryError('invalid_document_id');
  return key;
}

/**
 * A folded lookup key plus the identifier type it came from.
 *
 * Every factory throws {@link TraciveQueryError} rather than returning a doomed query, because a
 * lookup the server can never match is still billed. The multi-field factories take an object
 * bag rather than positional strings so that a call site cannot silently transpose two arguments
 * of the same type.
 *
 * There is deliberately no `domain()` factory. The Tracive API indexes exactly five identifier
 * types, so a domain key would match nothing and the miss would still cost a credit. Domain
 * checking is planned for a future release built on vector similarity search, which does not fit
 * exact-match record keys; adding it later is not a breaking change.
 */
export class TraciveQuery {
  readonly kind: QueryKind;
  /**
   * The folded lookup key, e.g. `PHONE_+6281234567891`. It CONTAINS THE RAW IDENTIFIER — never
   * log it. It is hashed before it becomes a cache key, and `toString`/`toJSON` redact it.
   */
  readonly searchQueryIndex: string;

  private constructor(kind: QueryKind, searchQueryIndex: string) {
    this.kind = kind;
    this.searchQueryIndex = searchQueryIndex;
  }

  static phone(e164: string): TraciveQuery {
    return new TraciveQuery('PHONE', assertValidRecordKey(`PHONE_${foldPhone(e164)}`));
  }

  static email(value: string): TraciveQuery {
    return new TraciveQuery('EMAIL', assertValidRecordKey(`EMAIL_${foldEmail(value)}`));
  }

  static bankAccount(input: {
    countryAlpha3: string;
    bankCode: string;
    account: string;
  }): TraciveQuery;
  /**
   * A domestic bank account, with the bank named by its national bank code, e.g. `014`.
   *
   * The code is translated to Tracive's `bankCode` through a table shipped inside the SDK, so
   * `{ countryAlpha3: 'IDN', bankShortCode: '014' }` builds exactly the key `bankCode: 'BCA'` builds
   * and shares its cache entries. Case, whitespace, `.` and `-` are ignored, and leading zeros are
   * optional: `14` finds `014`. The country is checked first.
   *
   * @throws {TraciveQueryError} `unknown_bank_code` when the table does not list the code for that
   *   country, before any request, so it is never billed.
   */
  static bankAccount(input: {
    countryAlpha3: string;
    bankShortCode: string;
    account: string;
  }): TraciveQuery;
  /**
   * A domestic bank account, with the bank named by its BIC, e.g. `CENAIDJA` or `CENAIDJAXXX`.
   *
   * Translated from the same table as `bankShortCode`, so this builds the key `bankCode` builds for
   * that bank. An 11-character BIC is looked up by its first 8 (the branch is ignored), within the
   * given country only; case and whitespace are ignored.
   *
   * @throws {TraciveQueryError} `unknown_bank_code` when the BIC is malformed or the table does not
   *   list it for that country, before any request, so it is never billed.
   */
  static bankAccount(input: { countryAlpha3: string; bic: string; account: string }): TraciveQuery;
  static bankAccount(input: {
    countryAlpha3: string;
    bankCode?: string;
    bankShortCode?: string;
    bic?: string;
    account: string;
  }): TraciveQuery {
    const { bankCode: given, bankShortCode, bic } = input;
    // Only reachable from untyped JavaScript. Picking one of two codes could build the key of a bank
    // the caller did not mean, and that miss is billed.
    if ([given, bankShortCode, bic].filter((selector) => selector != null).length !== 1) {
      throw new TypeError('bankAccount takes exactly one of bankCode, bankShortCode or bic');
    }
    const country = foldCountryAlpha3(input.countryAlpha3);
    let resolved = given;
    if (bankShortCode != null) resolved = bankCodeByShortCode(country, bankShortCode);
    if (bic != null) resolved = bankCodeByBic(country, bic);
    if (resolved === undefined) throw new TraciveQueryError('unknown_bank_code');
    const bankCode = foldBankCode(resolved);
    const account = foldBankAccount(input.account);
    return new TraciveQuery('BANK', assertValidRecordKey(`BANK_${country}_${bankCode}_${account}`));
  }

  static iban(iban: string): TraciveQuery {
    return new TraciveQuery('BANK', assertValidRecordKey(`BANK_IBAN_${foldBankAccount(iban)}`));
  }

  static crypto(input: { chain: string; address: string }): TraciveQuery {
    const chain = foldChain(input.chain);
    const address = foldCryptoAddress(input.address);
    return new TraciveQuery('CRYPTO', assertValidRecordKey(`CRYPTO_${chain}_${address}`));
  }

  static username(input: { platform: string; handle: string }): TraciveQuery {
    const platform = foldPlatform(input.platform);
    const handle = foldHandle(input.handle);
    return new TraciveQuery('USERNAME', assertValidRecordKey(`USERNAME_${platform}_${handle}`));
  }

  equals(other: TraciveQuery): boolean {
    return this.kind === other.kind && this.searchQueryIndex === other.searchQueryIndex;
  }

  toString(): string {
    return `TraciveQuery(kind: ${this.kind}, key: <redacted>)`;
  }

  toJSON(): { kind: QueryKind; searchQueryIndex: '[redacted]' } {
    return { kind: this.kind, searchQueryIndex: '[redacted]' };
  }
}

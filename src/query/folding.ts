import { foldedLowerCase, foldedUpperCase, normalizeNfc } from './nfc';
import { TraciveQueryError } from './TraciveQueryError';

/**
 * THE fold. Order of operations is part of the cross-SDK contract; reordering changes the output
 * on edge inputs and would silently split one entity into two record keys.
 *
 * This file deliberately uses plain JavaScript built-ins. The Tracive API folds keys with
 * JavaScript string semantics, and the SDKs for Kotlin, Flutter and Swift hand-write character
 * classes in order to *emulate* those semantics. This SDK's platform already IS JavaScript, so
 * porting their emulations would emulate an emulation and add a fresh table to drift from:
 *
 * - `trim()` strips exactly the 25 code points the contract names, and does not strip U+200B.
 * - `\s` in a regex matches exactly that same set.
 * - `\D` / `[^0-9]` is ASCII-only, so an Arabic-Indic digit is STRIPPED, never converted.
 * - `toUpperCase()` / `toLowerCase()` are the locale-invariant full case mappings, which are
 *   length-changing (`ß` -> `SS`, `İ` -> `i` + U+0307). They are reached through
 *   `foldedUpperCase`/`foldedLowerCase` rather than called directly, because an engine that
 *   degrades `normalize` degrades these to ASCII-only in the same breath, and that variant is
 *   just as silent — see `nfc.ts`.
 *
 * The single case-mapping rule that still applies: never `toLocaleUpperCase` /
 * `toLocaleLowerCase` / `localeCompare`. Those are locale-sensitive and break under the Turkish
 * locale. ESLint enforces the ban across this directory.
 */

const E164 = /^\+[1-9][0-9]{6,14}$/;
const ALPHA3 = /^[A-Z]{3}$/;
/** An EVM address. The lowercase `0x` prefix is load-bearing: `0X...` is deliberately not folded. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BIC = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;

/** trim -> remember a leading `+` -> strip non-ASCII-digits -> restore the `+`. */
export function foldPhone(value: string): string {
  const trimmed = value.trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  const folded = (hadPlus ? '+' : '') + digits;
  if (!E164.test(folded)) {
    // The server cannot up-convert a local number to E.164 — it does not know the dial code at
    // that layer — so a local number becomes a DIFFERENT entity and the miss is still billed.
    throw new TraciveQueryError('not_e164');
  }
  return folded;
}

/**
 * NFC -> lowercase -> trim, then require an `@`.
 *
 * The `@` test is deliberately the whole of the shape check. The server applies NO shape
 * validation to an e-mail: `EMAIL_budi` is a legal record key, so it is looked up, missed, and
 * billed — the same commercial hole {@link foldPhone} closes with its E.164 test, and client-side
 * rejection is the only thing that closes it. Anything stricter than "contains an `@`" would start
 * refusing addresses the server would happily match, and a refused lookup is an answer the caller
 * never gets. Local parts may be quoted, domains may be a bare host or a bracketed literal, and
 * none of that is this SDK's business.
 */
export function foldEmail(value: string): string {
  const folded = foldedLowerCase(normalizeNfc(value)).trim();
  if (folded === '') throw new TraciveQueryError('empty_value');
  if (!folded.includes('@')) throw new TraciveQueryError('not_an_email');
  return folded;
}

/** uppercase -> trim. Must be ISO 3166-1 alpha-3. */
export function foldCountryAlpha3(value: string): string {
  // Deliberately NOT guarded: the result must match /^[A-Z]{3}$/, so a degraded case mapping
  // produces a loud `country_not_alpha3` rejection here rather than a silently wrong key.
  const folded = value.toUpperCase().trim();
  if (!ALPHA3.test(folded)) {
    // The server would up-convert alpha-2, but then the local cache key and the server key would
    // disagree, so the SDK requires callers to pass alpha-3.
    throw new TraciveQueryError('country_not_alpha3');
  }
  return folded;
}

/** NFC -> uppercase -> trim -> drop every `_`, because the record key is split on `_`. */
export function foldBankCode(value: string): string {
  const folded = foldedUpperCase(normalizeNfc(value)).trim().replace(/_/g, '');
  if (folded === '') throw new TraciveQueryError('empty_bank_code');
  return folded;
}

/**
 * uppercase -> strip `[\s-]`. There is deliberately NO separate trim and NO NFC here: adding
 * either is a silent behaviour change on inputs whose leading whitespace is not JS whitespace.
 * Underscores are kept — everything past the bank code is rejoined when the key is parsed.
 */
export function foldBankAccount(value: string): string {
  const folded = foldedUpperCase(value).replace(/[\s-]/g, '');
  if (folded === '') throw new TraciveQueryError('empty_account_id');
  return folded;
}

/**
 * NFC -> uppercase -> remove every `\s`, `.` and `-` anywhere: the form the bank-code table stores.
 * Never throws for an empty result, which simply misses the table.
 */
export function foldBankShortCode(value: string): string {
  return foldedUpperCase(normalizeNfc(value)).replace(/[\s.-]/g, '');
}

/**
 * NFC -> uppercase -> remove every `\s`, then the 8- or 11-character BIC shape. Returns the first 8
 * characters — the institution without its branch — or `undefined` when it is not a BIC. A `-` or
 * `.` is not removed here, unlike in a short code.
 */
export function foldBic(value: string): string | undefined {
  const folded = foldedUpperCase(normalizeNfc(value)).replace(/\s/g, '');
  return BIC.test(folded) ? folded.slice(0, 8) : undefined;
}

/** NFC -> uppercase -> trim. */
export function foldChain(value: string): string {
  const folded = foldedUpperCase(normalizeNfc(value)).trim();
  if (folded === '') throw new TraciveQueryError('empty_chain');
  return folded;
}

/**
 * trim, then lowercase ONLY when the value is an EVM address. Base58 and bech32 are not folded:
 * base58 is case-sensitive, so lowercasing yields a different and invalid address, and bech32's
 * own grammar admits only the lowercase form so the other case never reaches the index.
 */
export function foldCryptoAddress(value: string): string {
  const trimmed = value.trim();
  // Named for the field, not just "empty": `CRYPTO_ETH_` and `CRYPTO__1A1zP1` are two different
  // caller mistakes, and a shared token left a caller unable to tell them apart or say which one
  // to fix.
  if (trimmed === '') throw new TraciveQueryError('empty_address');
  // Deliberately NOT guarded: the branch is taken only for a string already proven to be ASCII
  // hex, and ASCII case mapping is the one thing a reduced Unicode build still gets right.
  return EVM_ADDRESS.test(trimmed) ? trimmed.toLowerCase() : trimmed;
}

/** NFC -> uppercase -> trim. */
export function foldPlatform(value: string): string {
  const folded = foldedUpperCase(normalizeNfc(value)).trim();
  // As with the crypto address: `USERNAME__scammerx` and `USERNAME_INSTAGRAM_` are different
  // mistakes and now say so.
  if (folded === '') throw new TraciveQueryError('empty_platform');
  return folded;
}

/**
 * NFC -> lowercase -> trim. A leading `@` is KEPT: the server preserves it, so stripping it here
 * would build a key that misses a report filed with the `@`.
 */
export function foldHandle(value: string): string {
  const folded = foldedLowerCase(normalizeNfc(value)).trim();
  if (folded === '') throw new TraciveQueryError('empty_handle');
  return folded;
}

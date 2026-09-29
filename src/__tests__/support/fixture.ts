import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The shared grammar fixture is loaded from disk, never from a hand-copied literal. A literal
 * would drift the moment somebody "tidied" it, which is exactly the failure the fixture exists
 * to prevent.
 */
export const FIXTURE_PATH = join(process.cwd(), 'test', 'fixtures', 'query-grammar-vectors.json');
export const BANK_CODES_PATH = join(process.cwd(), 'test', 'fixtures', 'bank-codes.json');

export interface GrammarVector {
  readonly id: string;
  readonly type: 'PHONE' | 'EMAIL' | 'BANK' | 'CRYPTO' | 'USERNAME';
  readonly input: Readonly<Record<string, string | boolean>>;
  readonly expected: string;
  readonly why?: string;
}

export interface RejectedVector {
  readonly id: string;
  readonly type: 'PHONE' | 'EMAIL' | 'BANK' | 'CRYPTO' | 'USERNAME' | 'RAW';
  readonly input: Readonly<Record<string, string | boolean>>;
  readonly reason: string;
  readonly why?: string;
}

export interface GrammarFixture {
  readonly version: number;
  readonly crossLanguageSemantics: {
    readonly trimSet: {
      readonly codepoints: readonly string[];
      readonly notStripped: readonly string[];
    };
    readonly caseMapping: { readonly examples: Readonly<Record<string, string>> };
  };
  readonly documentIdGuard: {
    readonly maxUtf8Bytes: number;
    readonly explicitlyAllowed: readonly string[];
    readonly cases: readonly { readonly value: string; readonly safe: boolean }[];
  };
  readonly notImplemented: Readonly<Record<string, string>>;
  readonly vectors: readonly GrammarVector[];
  readonly rejected: readonly RejectedVector[];
}

export function loadGrammarFixture(): GrammarFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as GrammarFixture;
}

/** `"U+00A0"` -> the character it names. */
export function codepointFromLabel(label: string): string {
  return String.fromCodePoint(Number.parseInt(label.replace(/^U\+/, ''), 16));
}

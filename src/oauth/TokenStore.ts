import { redactedTokens, type TraciveTokens } from '../model/AuthResult';

/**
 * Where a grant lives is a platform-security decision. Tokens must never go into AsyncStorage or
 * MMKV: on iOS they belong in the Keychain, and on Android behind a non-exportable Keystore key
 * so that only ciphertext reaches shared preferences.
 */
export interface TokenStore {
  read(): Promise<TraciveTokens | undefined>;
  write(tokens: TraciveTokens): Promise<void>;
  clear(): Promise<void>;
}

/** The default. Correct for tests and for a session-scoped grant; wrong for a shipping app. */
export class InMemoryTokenStore implements TokenStore {
  #tokens: TraciveTokens | undefined;

  constructor(initial?: TraciveTokens) {
    this.#tokens = initial === undefined ? undefined : redactedTokens(initial);
  }

  read(): Promise<TraciveTokens | undefined> {
    return Promise.resolve(this.#tokens);
  }

  write(tokens: TraciveTokens): Promise<void> {
    this.#tokens = redactedTokens(tokens);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#tokens = undefined;
    return Promise.resolve();
  }
}

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAtMs?: number;
  scopes: string[];
}

/** Shared by every persistent `TokenStore` adapter, so the on-disk shape cannot diverge. */
export function serializeTokens(tokens: TraciveTokens): string {
  const stored: StoredTokens = {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    tokenType: tokens.tokenType,
    ...(tokens.expiresAt !== undefined ? { expiresAtMs: tokens.expiresAt.getTime() } : {}),
    scopes: [...tokens.scopes],
  };
  return JSON.stringify(stored);
}

export function deserializeTokens(json: string): TraciveTokens | undefined {
  let parsed: StoredTokens;
  try {
    parsed = JSON.parse(json) as StoredTokens;
  } catch {
    return undefined;
  }
  if (typeof parsed?.accessToken !== 'string') return undefined;
  return redactedTokens({
    accessToken: parsed.accessToken,
    ...(parsed.refreshToken !== undefined ? { refreshToken: parsed.refreshToken } : {}),
    tokenType: parsed.tokenType ?? 'Bearer',
    ...(parsed.expiresAtMs !== undefined ? { expiresAt: new Date(parsed.expiresAtMs) } : {}),
    scopes: parsed.scopes ?? [],
  });
}

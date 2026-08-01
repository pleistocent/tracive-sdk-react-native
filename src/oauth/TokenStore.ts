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

/**
 * EVERY field is checked, and a record failing any check is reported as absent — exactly as
 * unparseable JSON already was. Absence is a state the whole SDK already handles: the caller
 * authorizes again.
 *
 * Only `accessToken` used to be checked, and the other four were handed straight back. That did not
 * make a damaged record work; it moved the failure somewhere else, later, and out of sight of the
 * thing that could have named it. `refreshToken: null` is not `undefined`, so the refresh path took
 * it for a token and reached `null.trim()`. An `expiresAtMs` the serializer never wrote became an
 * Invalid Date, or — for `null` and for `true` — a confident expiry in 1970. A `scopes` that was a
 * string was published from `grantedScopes()` one character per entry. This is the same family as
 * the pending record whose unvalidated `createdAtMs` made `NaN > 600` false and so never expired.
 *
 * A field that is ABSENT is not a failure: `refreshToken` and `expiresAtMs` are genuinely optional,
 * and `tokenType` and `scopes` keep the defaults they have always had. A field that is PRESENT and
 * of the wrong type is a failure, `null` included — `serializeTokens` never writes one, so a record
 * containing it was not written by this SDK, and guessing a default for it would be inventing a
 * grant rather than restoring one.
 */
export function deserializeTokens(json: string): TraciveTokens | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  // `typeof null === 'object'`, and an array is an object too. Neither is a record.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;

  const accessToken = record.accessToken;
  if (typeof accessToken !== 'string') return undefined;

  const refreshToken = record.refreshToken;
  if (refreshToken !== undefined && typeof refreshToken !== 'string') return undefined;

  const storedTokenType = record.tokenType;
  if (storedTokenType !== undefined && typeof storedTokenType !== 'string') return undefined;

  const storedExpiresAtMs = record.expiresAtMs;
  let expiresAt: Date | undefined;
  if (storedExpiresAtMs !== undefined) {
    if (typeof storedExpiresAtMs !== 'number') return undefined;
    expiresAt = new Date(storedExpiresAtMs);
    // A number can still be no date: `NaN` and anything beyond ±8.64e15 both produce an Invalid
    // Date, whose `getTime()` is `NaN` and every comparison against which is false.
    if (Number.isNaN(expiresAt.getTime())) return undefined;
  }

  const storedScopes = record.scopes;
  const scopes: string[] = [];
  if (storedScopes !== undefined) {
    if (!Array.isArray(storedScopes)) return undefined;
    for (const scope of storedScopes as unknown[]) {
      if (typeof scope !== 'string') return undefined;
      scopes.push(scope);
    }
  }

  return redactedTokens({
    accessToken,
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    tokenType: storedTokenType ?? 'Bearer',
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    scopes,
  });
}

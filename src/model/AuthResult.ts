import type { TraciveError } from './TraciveError';

export interface TraciveTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly tokenType: string;
  readonly expiresAt?: Date;
  /** What was GRANTED, which may be narrower than what was requested. */
  readonly scopes: readonly string[];
}

export type AuthResult =
  | { readonly type: 'authorized'; readonly grantedScopes: readonly string[] }
  | {
      readonly type: 'codeReceived';
      readonly code: string;
      readonly codeVerifier: string;
      readonly redirectUri: string;
    }
  | { readonly type: 'denied' }
  | { readonly type: 'appNotInstalled' }
  | { readonly type: 'failed'; readonly error: TraciveError };

/**
 * JavaScript objects serialise by default, so a `console.log(result)` or a crash-reporter
 * breadcrumb would print a live authorization code. The sibling SDKs had to opt IN to leaking
 * this; JavaScript leaks unless you opt OUT, so every credential-bearing object built here gets
 * a redacting `toJSON` AND a redacting `toString`, both non-enumerable so they do not widen the
 * public shape.
 */
function redacting<T extends object>(value: T, json: () => unknown, text: () => string): T {
  return Object.defineProperties(value, {
    toJSON: { value: json, enumerable: false },
    toString: { value: text, enumerable: false },
  });
}

export function codeReceived(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): AuthResult {
  const result = {
    type: 'codeReceived',
    code: input.code,
    codeVerifier: input.codeVerifier,
    redirectUri: input.redirectUri,
  } as const;
  return redacting(
    result,
    () => ({
      type: 'codeReceived',
      redirectUri: input.redirectUri,
      code: '[redacted]',
      codeVerifier: '[redacted]',
    }),
    () => `AuthResult(codeReceived, redirectUri: ${input.redirectUri}, code: <redacted>)`,
  );
}

export function redactedTokens(tokens: TraciveTokens): TraciveTokens {
  return redacting(
    { ...tokens },
    () => ({
      accessToken: '[redacted]',
      ...(tokens.refreshToken !== undefined ? { refreshToken: '[redacted]' } : {}),
      tokenType: tokens.tokenType,
      ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt.toISOString() } : {}),
      scopes: [...tokens.scopes],
    }),
    () =>
      `TraciveTokens(tokenType: ${tokens.tokenType}, scopes: ${tokens.scopes.join(' ')}, ` +
      'accessToken: <redacted>)',
  );
}

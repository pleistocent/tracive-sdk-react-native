import { base64UrlEncode } from '../crypto/base64url';
import { defaultRandom, type TraciveRandom } from '../crypto/random';
import { sha256OfString } from '../crypto/sha256';

/**
 * S256 only. `plain` is not a value in any type here, not a parameter and not a fallback: a
 * downgrade to `plain` is the one PKCE misconfiguration that looks like it works.
 */
export const CODE_CHALLENGE_METHOD = 'S256' as const;

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
}

/** 32 random bytes as base64url: 43 characters, entirely within the RFC 7636 unreserved set. */
export function createPkcePair(random: TraciveRandom = defaultRandom): PkcePair {
  const codeVerifier = base64UrlEncode(random.randomBytes(32));
  return { codeVerifier, codeChallenge: base64UrlEncode(sha256OfString(codeVerifier)) };
}

export function createState(random: TraciveRandom = defaultRandom): string {
  return base64UrlEncode(random.randomBytes(32));
}

/**
 * Compared without an early return so that the number of matching leading characters is not
 * readable from the timing. A length difference is unavoidably observable, which is why the
 * value is a fixed-length random string in the first place.
 */
export function statesMatch(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return difference === 0;
}

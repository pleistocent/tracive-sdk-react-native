import { TraciveConfigurationError } from '../model/TraciveConfigurationError';
import { toHex } from './base64url';

/** The single random seam. Everything that needs unpredictability goes through it. */
export interface TraciveRandom {
  randomBytes(length: number): Uint8Array;
}

const CSPRNG_UNAVAILABLE_MESSAGE =
  'Tracive needs a cryptographically secure random source for PKCE and cache encryption, and ' +
  'this React Native runtime does not provide globalThis.crypto.getRandomValues. Install ONE of:\n' +
  '  - Expo:    npx expo install expo-crypto, then pass `random: expoRandom` (from\n' +
  '             @pleistocent/tracive-sdk-react-native/expo) to TraciveClient, TraciveOAuth and openExpoCheckCache.\n' +
  '  - Bare RN: npm i react-native-get-random-values, then `import ' +
  "'react-native-get-random-values'` at the very top of your entry file.\n" +
  'Alternatively pass your own `random` implementation to TraciveClient.';

interface WebCryptoLike {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/**
 * React Native ships no WebCrypto, so this throws a named, actionable error when the host app has
 * not installed a polyfill.
 *
 * It must NEVER degrade to `Math.random()`. A deterministic PRNG here produces predictable PKCE
 * verifiers and predictable cache nonces, and it does so silently — the code keeps working and
 * the tests keep passing while the security property is gone.
 */
export const defaultRandom: TraciveRandom = {
  randomBytes(length: number): Uint8Array {
    const webCrypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
    if (webCrypto === undefined || typeof webCrypto.getRandomValues !== 'function') {
      throw new TraciveConfigurationError('csprng_unavailable', CSPRNG_UNAVAILABLE_MESSAGE);
    }
    const out = new Uint8Array(length);
    webCrypto.getRandomValues(out);
    return out;
  },
};

/**
 * A version-4 UUID, drawn from the same seam as everything else that needs unpredictability.
 *
 * Written by hand rather than reached for: `crypto.randomUUID` is absent from Hermes and from
 * several of the polyfills a host may have installed, so calling it would work in a simulator and
 * throw on a device.
 *
 * The version and variant bits are set so the value is a real RFC 9562 v4 UUID rather than 32 hex
 * characters with dashes in familiar places. The point is not ceremony: a server-side log holding
 * keys from four SDKs is much easier to reason about when they are all the same documented shape.
 */
export function randomUuid(random: TraciveRandom = defaultRandom): string {
  const bytes = random.randomBytes(16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

import { TraciveConfigurationError } from '../model/TraciveConfigurationError';

/** The single random seam. Everything that needs unpredictability goes through it. */
export interface TraciveRandom {
  randomBytes(length: number): Uint8Array;
}

const CSPRNG_UNAVAILABLE_MESSAGE =
  'Tracive needs a cryptographically secure random source for PKCE and cache encryption, and ' +
  'this React Native runtime does not provide globalThis.crypto.getRandomValues. Install ONE of:\n' +
  '  - Expo:    npx expo install expo-standard-web-crypto   (or expo-crypto)\n' +
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

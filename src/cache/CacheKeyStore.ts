import { base64UrlDecode, base64UrlEncode } from '../crypto/base64url';
import { defaultRandom, type TraciveRandom } from '../crypto/random';
import { CheckCacheError } from './CheckCacheError';

/**
 * Holds the 32-byte cache data key. It is a port because where a data key may live is a
 * platform-security decision, not an SDK decision: on device it belongs in the Keychain or behind
 * a non-exportable Keystore key, never in AsyncStorage.
 */
export interface CacheKeyStore {
  loadOrCreateDataKey(): Promise<Uint8Array>;
  clear(): Promise<void>;
}

export const DATA_KEY_LENGTH = 32;

/** Both platform secure stores are string-only, so the key is persisted as base64url text. */
export function encodeDataKey(dataKey: Uint8Array): string {
  return base64UrlEncode(dataKey);
}

export function decodeDataKey(encoded: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = base64UrlDecode(encoded);
  } catch (cause) {
    // A stored key in the wrong alphabet is corrupt in exactly the same sense as one of the
    // wrong length, and a caller should not have to catch two error families to find that out.
    throw new CheckCacheError(
      'dataKeyCorrupt',
      'The stored cache data key is not base64url. It will be replaced and the cache goes cold.',
      cause,
    );
  }
  if (bytes.length !== DATA_KEY_LENGTH) {
    throw new CheckCacheError(
      'dataKeyCorrupt',
      'The stored cache data key is not 32 bytes. It will be replaced and the cache goes cold.',
    );
  }
  return bytes;
}

export function createDataKey(random: TraciveRandom = defaultRandom): Uint8Array {
  return random.randomBytes(DATA_KEY_LENGTH);
}

/**
 * The default. A process-lifetime data key is exactly right for the in-memory cache and exactly
 * wrong for a persistent one, where it would make every relaunch a cold start.
 */
export class InMemoryCacheKeyStore implements CacheKeyStore {
  #dataKey: Uint8Array | undefined;
  readonly #random: TraciveRandom;

  constructor(options?: { random?: TraciveRandom }) {
    this.#random = options?.random ?? defaultRandom;
  }

  loadOrCreateDataKey(): Promise<Uint8Array> {
    if (this.#dataKey === undefined) this.#dataKey = createDataKey(this.#random);
    return Promise.resolve(this.#dataKey);
  }

  clear(): Promise<void> {
    this.#dataKey = undefined;
    return Promise.resolve();
  }
}

import { gcm } from '@noble/ciphers/aes.js';

import { defaultRandom, type TraciveRandom } from '../crypto/random';
import { CheckCacheError } from './CheckCacheError';

/**
 * Per-record authenticated encryption.
 *
 * This is row-level AEAD rather than whole-database encryption on purpose: encrypting the file
 * stops the file being read but does not stop a row being MOVED, whereas binding the additional
 * authenticated data to the row's own cache key makes a row-swap fail closed as well. It also
 * lets the SQL adapter stay entirely crypto-free, which keeps a fragile encrypted-SQLite compile
 * flag out of every integrator's build.
 */
export interface CacheCipher {
  seal(plaintext: Uint8Array, aad: Uint8Array): Uint8Array;
  /** Throws {@link CheckCacheError} rather than returning a partial or forged plaintext. */
  open(envelope: Uint8Array, aad: Uint8Array): Uint8Array;
}

const ENVELOPE_VERSION = 1;
const NONCE_LENGTH = 12; // 96 bits, the GCM-preferred nonce size
const TAG_LENGTH = 16; // 128 bits

/**
 * Envelope layout: `version byte || 96-bit nonce || ciphertext || 128-bit tag`.
 *
 * The nonce is random rather than a durable counter. The counter design exists in a sibling SDK
 * only because its shared source set has no CSPRNG at all; here a CSPRNG is already required for
 * PKCE, so a random nonce is available and it removes the counter-rewind hazard — a restored
 * backup replaying an old counter value — entirely.
 */
export class AesGcmCacheCipher implements CacheCipher {
  readonly #dataKey: Uint8Array;
  readonly #random: TraciveRandom;

  constructor(options: { dataKey: Uint8Array; random?: TraciveRandom }) {
    if (options.dataKey.length !== 32) {
      throw new CheckCacheError('dataKeyCorrupt', 'The cache data key must be exactly 32 bytes.');
    }
    this.#dataKey = options.dataKey;
    this.#random = options.random ?? defaultRandom;
  }

  seal(plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
    try {
      const nonce = this.#random.randomBytes(NONCE_LENGTH);
      const sealed = gcm(this.#dataKey, nonce, aad).encrypt(plaintext);
      const envelope = new Uint8Array(1 + NONCE_LENGTH + sealed.length);
      envelope[0] = ENVELOPE_VERSION;
      envelope.set(nonce, 1);
      envelope.set(sealed, 1 + NONCE_LENGTH);
      return envelope;
    } catch (cause) {
      // A missing CSPRNG surfaces as itself: it is a configuration error, not a cache fault.
      if (cause instanceof CheckCacheError) throw cause;
      if (cause instanceof Error && cause.name === 'TraciveConfigurationError') throw cause;
      throw new CheckCacheError('encryptionFailed', 'The cache record could not be sealed.', cause);
    }
  }

  open(envelope: Uint8Array, aad: Uint8Array): Uint8Array {
    if (envelope.length < 1 + NONCE_LENGTH + TAG_LENGTH || envelope[0] !== ENVELOPE_VERSION) {
      throw new CheckCacheError(
        'payloadUnreadable',
        'The cache record is not a recognised envelope.',
      );
    }
    const nonce = envelope.subarray(1, 1 + NONCE_LENGTH);
    const sealed = envelope.subarray(1 + NONCE_LENGTH);
    try {
      return gcm(this.#dataKey, nonce, aad).decrypt(sealed);
    } catch (cause) {
      // A wrong data key, a moved row and a flipped byte are indistinguishable here, and all
      // three mean the same thing to the caller: this record cannot be trusted, drop it.
      throw new CheckCacheError(
        'payloadUnreadable',
        'The cache record could not be opened. The data key has changed or the record was ' +
          'modified.',
        cause,
      );
    }
  }
}

export const CACHE_ENVELOPE_VERSION = ENVELOPE_VERSION;
export const CACHE_NONCE_LENGTH = NONCE_LENGTH;
export const CACHE_TAG_LENGTH = TAG_LENGTH;

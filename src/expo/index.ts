/**
 * Adapters for an Expo app, behind the `@tracive/sdk-react-native/expo` subpath.
 *
 * Every import below is an OPTIONAL peer dependency. Importing this subpath without the peer
 * installed fails with a module-not-found error naming the missing package, which is correct and
 * diagnosable. There is deliberately no runtime auto-detection of "whichever native library the
 * host happens to have": it defeats static analysis, confuses bundlers, and turns a missing
 * dependency into a crash report nobody can read.
 */
import * as SecureStore from 'expo-secure-store';
import * as ExpoCrypto from 'expo-crypto';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

import { NoOpCheckCache, type CheckCache } from '../cache/CheckCache';
import { CheckCacheError } from '../cache/CheckCacheError';
import type { CacheKeyStore } from '../cache/CacheKeyStore';
import { createDataKey, decodeDataKey, encodeDataKey } from '../cache/CacheKeyStore';
import type { CachedRow, CheckCacheStore } from '../cache/CheckCacheStore';
import { PersistentCheckCache } from '../cache/PersistentCheckCache';
import type { TraciveRandom } from '../crypto/random';
import type { CachePolicy } from '../model/CachePolicy';
import {
  deserializePendingAuthorization,
  serializePendingAuthorization,
  type PendingAuthorization,
  type PendingAuthorizationStore,
} from '../oauth/PendingAuthorization';
import { deserializeTokens, serializeTokens, type TokenStore } from '../oauth/TokenStore';
import { CREATE_TABLE_SQL, DELETE_WHERE_SQL, toUint8Array } from '../cache/sql';

const DEFAULT_SERVICE = 'id.tracive.sdk';
const TOKENS_KEY = 'tracive.tokens.v1';
const PENDING_KEY = 'tracive.pending-authorization.v1';
const DATA_KEY_KEY = 'tracive.cache-data-key.v1';
const DEFAULT_DATABASE = 'tracive-cache.db';

/**
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` on iOS, for both the grant and the cache data key.
 *
 * `AfterFirstUnlock` lets a background refresh or a share-extension check read the cache while
 * the phone is locked, which `WhenUnlocked` would not. `ThisDeviceOnly` keeps the item out of
 * device backups, so a restored backup cannot carry a live grant onto another handset.
 */
function secureStoreOptions(service: string): SecureStore.SecureStoreOptions {
  return {
    keychainService: service,
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  };
}

export function expoSecureTokenStore(options?: { service?: string }): TokenStore {
  const settings = secureStoreOptions(options?.service ?? DEFAULT_SERVICE);
  return {
    async read() {
      const raw = await SecureStore.getItemAsync(TOKENS_KEY, settings);
      return raw === null ? undefined : deserializeTokens(raw);
    },
    async write(tokens) {
      await SecureStore.setItemAsync(TOKENS_KEY, serializeTokens(tokens), settings);
    },
    async clear() {
      await SecureStore.deleteItemAsync(TOKENS_KEY, settings);
    },
  };
}

/**
 * The pending record holds a live PKCE verifier, so it belongs in the same secure storage as the
 * grant. Using this store is what makes an authorization survive Android killing the process
 * while the Tracive app is in the foreground.
 */
export function expoSecurePendingAuthorizationStore(options?: {
  service?: string;
}): PendingAuthorizationStore {
  const settings = secureStoreOptions(options?.service ?? DEFAULT_SERVICE);
  return {
    async read(): Promise<PendingAuthorization | undefined> {
      const raw = await SecureStore.getItemAsync(PENDING_KEY, settings);
      return raw === null ? undefined : deserializePendingAuthorization(raw);
    },
    async write(pending: PendingAuthorization) {
      await SecureStore.setItemAsync(PENDING_KEY, serializePendingAuthorization(pending), settings);
    },
    async clear() {
      await SecureStore.deleteItemAsync(PENDING_KEY, settings);
    },
  };
}

export function expoCacheKeyStore(options?: { service?: string }): CacheKeyStore {
  const settings = secureStoreOptions(options?.service ?? DEFAULT_SERVICE);
  return {
    async loadOrCreateDataKey(): Promise<Uint8Array> {
      const existing = await SecureStore.getItemAsync(DATA_KEY_KEY, settings);
      if (existing !== null) {
        try {
          return decodeDataKey(existing);
        } catch {
          // A corrupt key means the cache is unreadable, not that the app is broken. Replace it
          // and let every existing row fail to open and be dropped.
        }
      }
      const created = createDataKey(expoRandom);
      await SecureStore.setItemAsync(DATA_KEY_KEY, encodeDataKey(created), settings);
      return created;
    },
    async clear() {
      await SecureStore.deleteItemAsync(DATA_KEY_KEY, settings);
    },
  };
}

/** Expo apps already ship a CSPRNG, so this is the satisfier rather than a new dependency. */
export const expoRandom: TraciveRandom = {
  randomBytes(length: number): Uint8Array {
    return ExpoCrypto.getRandomValues(new Uint8Array(length));
  },
};

interface CacheRowShape {
  key_hex: string;
  payload: unknown;
  fetched_at_ms: number;
  expires_at_ms: number;
}

export async function expoSqliteCheckCacheStore(options?: {
  databaseName?: string;
}): Promise<CheckCacheStore> {
  const database: SQLiteDatabase = await openDatabaseAsync(
    options?.databaseName ?? DEFAULT_DATABASE,
  );
  await database.execAsync(CREATE_TABLE_SQL);

  return {
    async get(keyHex: string): Promise<CachedRow | undefined> {
      const row = await database.getFirstAsync<CacheRowShape>(
        'SELECT key_hex, payload, fetched_at_ms, expires_at_ms FROM tracive_check_cache WHERE key_hex = ?',
        [keyHex],
      );
      if (row === null) return undefined;
      return {
        keyHex: row.key_hex,
        payload: toUint8Array(row.payload),
        fetchedAtMs: row.fetched_at_ms,
        expiresAtMs: row.expires_at_ms,
      };
    },
    async put(row: CachedRow): Promise<void> {
      await database.runAsync(
        'INSERT OR REPLACE INTO tracive_check_cache (key_hex, payload, fetched_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)',
        [row.keyHex, row.payload, row.fetchedAtMs, row.expiresAtMs],
      );
    },
    async delete(keyHex: string): Promise<void> {
      await database.runAsync('DELETE FROM tracive_check_cache WHERE key_hex = ?', [keyHex]);
    },
    async deleteWhere(criteria): Promise<number> {
      const statement = DELETE_WHERE_SQL(criteria);
      if (statement === undefined) return 0;
      const result = await database.runAsync(statement.sql, statement.params);
      return result.changes;
    },
    async count(): Promise<number> {
      const row = await database.getFirstAsync<{ n: number }>(
        'SELECT COUNT(*) AS n FROM tracive_check_cache',
      );
      return row?.n ?? 0;
    },
  };
}

/**
 * Never throws. A cache that cannot open degrades to a cold cache with `lastStoreError`
 * populated, never to a broken SDK — the whole point of the cache is that losing it costs
 * credits, not correctness.
 */
export async function openExpoCheckCache(options?: {
  policy?: CachePolicy;
  databaseName?: string;
  service?: string;
}): Promise<CheckCache> {
  try {
    const store = await expoSqliteCheckCacheStore(
      options?.databaseName === undefined ? {} : { databaseName: options.databaseName },
    );
    return await PersistentCheckCache.open({
      store,
      keyStore: expoCacheKeyStore(
        options?.service === undefined ? {} : { service: options.service },
      ),
      ...(options?.policy !== undefined ? { policy: options.policy } : {}),
    });
  } catch (cause) {
    return new NoOpCheckCache(
      options?.policy,
      cause instanceof CheckCacheError
        ? cause
        : new CheckCacheError('cannotOpenStore', 'The Tracive cache could not be opened.', cause),
    );
  }
}

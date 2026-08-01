/**
 * Adapters for a bare React Native app, behind the `@tracive/sdk-react-native/bare` subpath.
 *
 * Both imports are OPTIONAL peer dependencies; see the note at the top of the Expo adapter for
 * why there is no runtime auto-detection.
 *
 * There is no `bareRandom` export here on purpose. `react-native-get-random-values` installs a
 * global `crypto.getRandomValues` polyfill, so importing it once at the top of the entry file is
 * what the SDK's own `defaultRandom` needs — a second wrapper would just be a way to forget the
 * import and still appear to work.
 */
import * as Keychain from 'react-native-keychain';
import { open, type DB } from '@op-engineering/op-sqlite';

import { NoOpCheckCache, type CheckCache } from '../cache/CheckCache';
import { CheckCacheError } from '../cache/CheckCacheError';
import {
  createDataKey,
  decodeDataKey,
  encodeDataKey,
  type CacheKeyStore,
} from '../cache/CacheKeyStore';
import type { CachedRow, CheckCacheStore } from '../cache/CheckCacheStore';
import { PersistentCheckCache } from '../cache/PersistentCheckCache';
import { CREATE_TABLE_SQL, DELETE_WHERE_SQL, toUint8Array } from '../cache/sql';
import type { TraciveRandom } from '../crypto/random';
import type { CachePolicy } from '../model/CachePolicy';
import {
  deserializePendingAuthorization,
  serializePendingAuthorization,
  type PendingAuthorization,
  type PendingAuthorizationStore,
} from '../oauth/PendingAuthorization';
import { deserializeTokens, serializeTokens, type TokenStore } from '../oauth/TokenStore';

const DEFAULT_TOKEN_SERVICE = 'id.tracive.sdk.tokens';
const DEFAULT_PENDING_SERVICE = 'id.tracive.sdk.pending';
const DEFAULT_DATA_KEY_SERVICE = 'id.tracive.sdk.cache-key';
const DEFAULT_DATABASE = 'tracive-cache.db';

/** See the Expo adapter for why this accessibility class, and not `WhenUnlocked`. */
function keychainOptions(service: string): Keychain.Options {
  return {
    service,
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  };
}

/**
 * `react-native-keychain` stores a username/password pair, so the serialised record goes in the
 * password slot and the username slot carries a fixed label.
 */
function keychainStringStore(
  service: string,
  label: string,
): {
  read(): Promise<string | undefined>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
} {
  const options = keychainOptions(service);
  return {
    async read(): Promise<string | undefined> {
      const entry = await Keychain.getGenericPassword(options);
      return entry === false ? undefined : entry.password;
    },
    async write(value: string): Promise<void> {
      await Keychain.setGenericPassword(label, value, options);
    },
    async clear(): Promise<void> {
      await Keychain.resetGenericPassword(options);
    },
  };
}

export function keychainTokenStore(options?: { service?: string }): TokenStore {
  const slot = keychainStringStore(options?.service ?? DEFAULT_TOKEN_SERVICE, 'tracive-tokens');
  return {
    async read() {
      const raw = await slot.read();
      return raw === undefined ? undefined : deserializeTokens(raw);
    },
    async write(tokens) {
      await slot.write(serializeTokens(tokens));
    },
    clear: slot.clear,
  };
}

export function keychainPendingAuthorizationStore(options?: {
  service?: string;
}): PendingAuthorizationStore {
  const slot = keychainStringStore(options?.service ?? DEFAULT_PENDING_SERVICE, 'tracive-pending');
  return {
    async read(): Promise<PendingAuthorization | undefined> {
      const raw = await slot.read();
      return raw === undefined ? undefined : deserializePendingAuthorization(raw);
    },
    async write(pending: PendingAuthorization) {
      await slot.write(serializePendingAuthorization(pending));
    },
    clear: slot.clear,
  };
}

export function keychainCacheKeyStore(options?: {
  service?: string;
  random?: TraciveRandom;
}): CacheKeyStore {
  const slot = keychainStringStore(
    options?.service ?? DEFAULT_DATA_KEY_SERVICE,
    'tracive-cache-key',
  );
  return {
    async loadOrCreateDataKey(): Promise<Uint8Array> {
      const existing = await slot.read();
      if (existing !== undefined) {
        try {
          return decodeDataKey(existing);
        } catch {
          // A corrupt key means the cache goes cold, not that the app fails.
        }
      }
      const created = createDataKey(options?.random);
      await slot.write(encodeDataKey(created));
      return created;
    },
    clear: slot.clear,
  };
}

export async function opSqliteCheckCacheStore(options?: {
  databaseName?: string;
}): Promise<CheckCacheStore> {
  const database: DB = open({ name: options?.databaseName ?? DEFAULT_DATABASE });
  for (const statement of CREATE_TABLE_SQL.split(';')) {
    const trimmed = statement.trim();
    if (trimmed !== '') await database.execute(trimmed);
  }

  return {
    async get(keyHex: string): Promise<CachedRow | undefined> {
      const result = await database.execute(
        'SELECT key_hex, payload, fetched_at_ms, expires_at_ms FROM tracive_check_cache WHERE key_hex = ?',
        [keyHex],
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return {
        keyHex: String(row.key_hex),
        payload: toUint8Array(row.payload),
        fetchedAtMs: Number(row.fetched_at_ms),
        expiresAtMs: Number(row.expires_at_ms),
      };
    },
    async put(row: CachedRow): Promise<void> {
      await database.execute(
        'INSERT OR REPLACE INTO tracive_check_cache (key_hex, payload, fetched_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)',
        [row.keyHex, row.payload, row.fetchedAtMs, row.expiresAtMs],
      );
    },
    async delete(keyHex: string): Promise<void> {
      await database.execute('DELETE FROM tracive_check_cache WHERE key_hex = ?', [keyHex]);
    },
    async deleteWhere(criteria): Promise<number> {
      const statement = DELETE_WHERE_SQL(criteria);
      if (statement === undefined) return 0;
      const result = await database.execute(statement.sql, statement.params);
      return result.rowsAffected;
    },
    async count(): Promise<number> {
      const result = await database.execute('SELECT COUNT(*) AS n FROM tracive_check_cache');
      return Number(result.rows[0]?.n ?? 0);
    },
  };
}

/** Never throws — see `openExpoCheckCache`. */
export async function openBareCheckCache(options?: {
  policy?: CachePolicy;
  databaseName?: string;
  service?: string;
  /** Only needed on a runtime with no global `crypto`; see `TraciveClient`'s `random`. */
  random?: TraciveRandom;
}): Promise<CheckCache> {
  try {
    const store = await opSqliteCheckCacheStore(
      options?.databaseName === undefined ? {} : { databaseName: options.databaseName },
    );
    return await PersistentCheckCache.open({
      store,
      keyStore: keychainCacheKeyStore({
        ...(options?.service !== undefined ? { service: options.service } : {}),
        ...(options?.random !== undefined ? { random: options.random } : {}),
      }),
      ...(options?.policy !== undefined ? { policy: options.policy } : {}),
      ...(options?.random !== undefined ? { random: options.random } : {}),
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

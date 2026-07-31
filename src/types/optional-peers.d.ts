/**
 * Minimal ambient declarations for the OPTIONAL peer dependencies the adapter subpaths import.
 *
 * They are declared rather than installed so that `npm install` on this repository does not drag
 * in half a gigabyte of native SQL drivers and the whole Expo module infrastructure just to
 * typecheck two hundred lines of adapter. Only the members the adapters actually call are
 * declared; an integrator always resolves the real package, because installing it is what makes
 * the subpath usable at all.
 *
 * Nothing here is published: TypeScript does not re-emit a declaration file, so these ambient
 * modules exist only while this repository is being compiled. Shipping them would put a
 * competing `declare module` next to the real ones in a consumer's program.
 */

declare module 'expo-secure-store' {
  export interface SecureStoreOptions {
    keychainService?: string;
    keychainAccessible?: number;
  }
  export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: number;
  export function getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
  export function setItemAsync(
    key: string,
    value: string,
    options?: SecureStoreOptions,
  ): Promise<void>;
  export function deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
}

declare module 'expo-crypto' {
  export function getRandomValues(array: Uint8Array): Uint8Array;
}

declare module 'expo-sqlite' {
  export interface SQLiteDatabase {
    execAsync(source: string): Promise<void>;
    runAsync(source: string, params?: unknown[]): Promise<{ changes: number }>;
    getFirstAsync<T>(source: string, params?: unknown[]): Promise<T | null>;
    getAllAsync<T>(source: string, params?: unknown[]): Promise<T[]>;
  }
  export function openDatabaseAsync(databaseName: string): Promise<SQLiteDatabase>;
}

declare module 'react-native-keychain' {
  export const ACCESSIBLE: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: string;
  };
  export interface Options {
    service?: string;
    accessible?: string;
  }
  export function setGenericPassword(
    username: string,
    password: string,
    options?: Options,
  ): Promise<false | { service: string; storage: string }>;
  export function getGenericPassword(
    options?: Options,
  ): Promise<false | { username: string; password: string; service: string; storage: string }>;
  export function resetGenericPassword(options?: Options): Promise<boolean>;
}

declare module '@op-engineering/op-sqlite' {
  export interface QueryResult {
    rows: Record<string, unknown>[];
    rowsAffected: number;
  }
  export interface DB {
    execute(query: string, params?: unknown[]): Promise<QueryResult>;
  }
  export function open(options: { name: string; location?: string }): DB;
}

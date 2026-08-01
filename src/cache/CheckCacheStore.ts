/**
 * The SQL seam: exactly four methods, so writing one against a host application's existing
 * database is a short afternoon rather than a project.
 *
 * Everything crossing it is opaque — a hex digest, an encrypted blob and two integer timestamps.
 * The store never sees an identifier, a risk tier or a report count, which is what allows the
 * driver to be chosen for its build properties alone.
 */
export interface CheckCacheStore {
  get(keyHex: string): Promise<CachedRow | undefined>;
  put(row: CachedRow): Promise<void>;
  delete(keyHex: string): Promise<void>;
  /**
   * `keepLongestLived: n` keeps the `n` rows with the most life left and deletes the rest, so
   * eviction takes the rows closest to expiry first. Order by `expires_at_ms` descending and use
   * `fetched_at_ms` descending to break a tie; `DELETE_WHERE_SQL` in `sql.ts` is the reference
   * statement, and both shipped adapters use it verbatim.
   */
  deleteWhere(criteria: {
    expiredBeforeMs?: number;
    all?: boolean;
    keepLongestLived?: number;
  }): Promise<number>;
  /**
   * Optional fifth method, and the only one that is. `CheckCache.count()` cannot be derived from
   * the other four, but a store written against a host's existing database may have no cheap way
   * to answer it, so implementing it is a choice rather than part of the afternoon's work. Both
   * adapters shipped here implement it; `PersistentCheckCache.count()` reports a storage failure
   * when a store does not.
   */
  count?(): Promise<number>;
}

export interface CachedRow {
  readonly keyHex: string;
  /** An AES-256-GCM envelope. Never plaintext. */
  readonly payload: Uint8Array;
  readonly fetchedAtMs: number;
  readonly expiresAtMs: number;
}

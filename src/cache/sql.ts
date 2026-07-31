/**
 * The SQL both shipped adapters share, so the two cannot drift into different schemas.
 *
 * The table holds a hex digest, an encrypted blob and two integer timestamps. It contains no
 * identifier, no risk tier and no report count, which is what allows the driver to be chosen for
 * its build properties alone and keeps an encrypted-SQLite compile flag out of the build.
 */
export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS tracive_check_cache (
  key_hex TEXT PRIMARY KEY NOT NULL,
  payload BLOB NOT NULL,
  fetched_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tracive_check_cache_expires_at
  ON tracive_check_cache (expires_at_ms);
`;

export interface DeleteCriteria {
  expiredBeforeMs?: number;
  all?: boolean;
  keepNewest?: number;
}

export function DELETE_WHERE_SQL(
  criteria: DeleteCriteria,
): { sql: string; params: unknown[] } | undefined {
  if (criteria.all === true) {
    return { sql: 'DELETE FROM tracive_check_cache', params: [] };
  }
  if (criteria.expiredBeforeMs !== undefined) {
    return {
      sql: 'DELETE FROM tracive_check_cache WHERE expires_at_ms <= ?',
      params: [criteria.expiredBeforeMs],
    };
  }
  if (criteria.keepNewest !== undefined) {
    return {
      sql:
        'DELETE FROM tracive_check_cache WHERE key_hex NOT IN (' +
        'SELECT key_hex FROM tracive_check_cache ORDER BY fetched_at_ms DESC LIMIT ?)',
      params: [criteria.keepNewest],
    };
  }
  return undefined;
}

/** Drivers hand back a blob as an `ArrayBuffer`, a `Uint8Array` or a plain array of numbers. */
export function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return new Uint8Array(0);
}

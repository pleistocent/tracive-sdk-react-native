import type { QrisCriteria } from './enums';

/** What the reported QR says about its merchant. The PAN is never sent back. */
export interface QrisDetails {
  readonly merchantName?: string;
  readonly city?: string;
  readonly criteria?: QrisCriteria;
  /** The acquirer's id as the QR names it, e.g. `ID.DANA.WWW`. */
  readonly acquirer?: string;
}

function optionalString<K extends keyof QrisDetails>(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
  return typeof value === 'string' ? ({ [key]: value } as Partial<Record<K, string>>) : {};
}

/** Read from the wire or the cache. `undefined` when the value is not an object. */
export function decodeQrisDetails(value: unknown): QrisDetails | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return {
    ...optionalString('merchantName', record.merchantName),
    ...optionalString('city', record.city),
    ...optionalString('criteria', record.criteria),
    ...optionalString('acquirer', record.acquirer),
  };
}

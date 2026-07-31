import type { HttpRequest, HttpResponse, HttpTransport } from '../../client/HttpTransport';
import type { TraciveClock } from '../../client/TraciveClock';
import type { TraciveRandom } from '../../crypto/random';
import type { CachedRow, CheckCacheStore } from '../../cache/CheckCacheStore';

/**
 * No unit test in this repository opens a socket, touches a device or launches a browser. The
 * Tracive API is not live, so a test that contacted a real host could only ever be a test of
 * somebody else's DNS.
 */
export class FakeTransport implements HttpTransport {
  readonly requests: HttpRequest[] = [];
  #responses: (HttpResponse | Error)[] = [];
  #fallback: HttpResponse | Error | undefined;

  constructor(responses?: (HttpResponse | Error)[]) {
    if (responses !== undefined) this.#responses = [...responses];
  }

  enqueue(...responses: (HttpResponse | Error)[]): this {
    this.#responses.push(...responses);
    return this;
  }

  always(response: HttpResponse | Error): this {
    this.#fallback = response;
    return this;
  }

  get lastRequest(): HttpRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    // Resolve on a later microtask so that a latch bug in single-flight code has a real window
    // to interleave in, rather than being hidden by a synchronous resolution.
    await Promise.resolve();
    const next = this.#responses.shift() ?? this.#fallback;
    if (next === undefined) {
      throw new Error(`FakeTransport has no response queued for ${request.method} ${request.url}`);
    }
    if (next instanceof Error) throw next;
    return next;
  }
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

export class FakeClock implements TraciveClock {
  #nowMs: number;
  readonly sleeps: number[] = [];

  constructor(nowMs = 1_700_000_000_000) {
    this.#nowMs = nowMs;
  }

  nowMs(): number {
    return this.#nowMs;
  }

  advance(ms: number): void {
    this.#nowMs += ms;
  }

  /** Records the requested delay and returns immediately: no test should wait in real time. */
  sleep(seconds: number): Promise<void> {
    this.sleeps.push(seconds);
    this.#nowMs += seconds * 1000;
    return Promise.resolve();
  }
}

/** Deterministic bytes. Never used for anything a real deployment depends on. */
export function fixedRandom(seed = 7): TraciveRandom {
  let state = seed;
  return {
    randomBytes(length: number): Uint8Array {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        out[i] = state & 0xff;
      }
      return out;
    },
  };
}

/** An in-memory implementation of the SQL seam, so the cache logic is testable without SQLite. */
export class FakeCheckCacheStore implements CheckCacheStore {
  readonly rows = new Map<string, CachedRow>();
  failNext: Error | undefined;

  get(keyHex: string): Promise<CachedRow | undefined> {
    if (this.failNext !== undefined) {
      const error = this.failNext;
      this.failNext = undefined;
      return Promise.reject(error);
    }
    return Promise.resolve(this.rows.get(keyHex));
  }

  put(row: CachedRow): Promise<void> {
    if (this.failNext !== undefined) {
      const error = this.failNext;
      this.failNext = undefined;
      return Promise.reject(error);
    }
    this.rows.set(row.keyHex, row);
    return Promise.resolve();
  }

  delete(keyHex: string): Promise<void> {
    this.rows.delete(keyHex);
    return Promise.resolve();
  }

  deleteWhere(criteria: {
    expiredBeforeMs?: number;
    all?: boolean;
    keepNewest?: number;
  }): Promise<number> {
    if (criteria.all === true) {
      const removed = this.rows.size;
      this.rows.clear();
      return Promise.resolve(removed);
    }
    if (criteria.expiredBeforeMs !== undefined) {
      let removed = 0;
      for (const [key, row] of this.rows) {
        if (row.expiresAtMs <= criteria.expiredBeforeMs) {
          this.rows.delete(key);
          removed++;
        }
      }
      return Promise.resolve(removed);
    }
    if (criteria.keepNewest !== undefined) {
      const ordered = [...this.rows.values()].sort((a, b) => b.fetchedAtMs - a.fetchedAtMs);
      const doomed = ordered.slice(criteria.keepNewest);
      for (const row of doomed) this.rows.delete(row.keyHex);
      return Promise.resolve(doomed.length);
    }
    return Promise.resolve(0);
  }

  count(): Promise<number> {
    return Promise.resolve(this.rows.size);
  }
}

export function checkResponseBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    checkId: 'chk_123',
    found: true,
    riskTier: 'HIGH',
    reportTotal: 12,
    credibleReports: 9,
    ambiguousReports: 3,
    fraudAmount: { IDR: 12500000 },
    tags: ['investment'],
    relatedScammerCount: 4,
    billing: { creditSource: 'USER', unitsCharged: 1 },
    disclaimer: 'Community reports, not a legal determination.',
    ...(overrides ?? {}),
  };
}

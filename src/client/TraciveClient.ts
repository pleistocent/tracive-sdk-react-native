import { CheckCacheError } from '../cache/CheckCacheError';
import { CheckCacheKey } from '../cache/CheckCacheKey';
import { InMemoryCheckCache, type CheckCache } from '../cache/CheckCache';
import { emitDiagnostic, type Diagnostic, type DiagnosticSink } from '../diagnostics';
import type { TraciveRandom } from '../crypto/random';
import { CachePolicy } from '../model/CachePolicy';
import type { CheckResult } from '../model/CheckResult';
import type { CreditsInfo } from '../model/CreditsInfo';
import type { AuthResult } from '../model/AuthResult';
import type { Detail, Source } from '../model/enums';
import type { ProfileInfo } from '../model/ProfileInfo';
import { TraciveEnvironment } from '../model/TraciveEnvironment';
import { parseRetryAfterSeconds, TraciveError, traciveErrorFrom } from '../model/TraciveError';
import { redactedProxyConfiguration, type TraciveMode } from '../model/TraciveMode';
import { TraciveOAuth } from '../oauth/TraciveOAuth';
import type { TokenStore } from '../oauth/TokenStore';
import type { TraciveQuery } from '../query/TraciveQuery';
import {
  FetchHttpTransport,
  redactedRequest,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from './HttpTransport';
import {
  decodeCheckResult,
  decodeCreditsInfo,
  decodeProfileInfo,
  extractErrorFields,
} from './responseMapper';
import { backoffSecondsFor, RetryPolicy } from './RetryPolicy';
import { apiUrl, proxyUrl, TRACIVE_API_PATHS } from './TraciveApi';
import { systemClock, type TraciveClock } from './TraciveClock';

export interface TraciveClientOptions {
  readonly mode: TraciveMode;
  readonly environment?: TraciveEnvironment;
  readonly cachePolicy?: CachePolicy;
  readonly defaultSource?: Source;
  readonly retryPolicy?: RetryPolicy;
  readonly cache?: CheckCache;
  readonly transport?: HttpTransport;
  readonly clock?: TraciveClock;
  readonly random?: TraciveRandom;
  readonly tokenStore?: TokenStore;
  /** Wins over `tokenStore` when present. */
  readonly oauth?: TraciveOAuth;
  readonly onDiagnostic?: DiagnosticSink;
}

export interface CheckScammerOptions {
  readonly source?: Source;
  readonly detail?: Detail;
  /** BCP-47. Only meaningful for `detail: 'full'`. */
  readonly locale?: string;
  /**
   * Pass one if you intend to retry.
   *
   * WITHOUT IT THE SDK WILL NOT RETRY a 5xx, a 429 or a timeout, because it cannot tell whether
   * the first attempt was already charged and a blind retry risks a double charge. The same key
   * is reused on every attempt, which is what lets the server deduplicate.
   */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

interface Attempt {
  readonly response: HttpResponse;
}

export class TraciveClient {
  /**
   * Safe to serialise. In proxy mode this is NOT the object the caller passed: the header values
   * are replaced with `[redacted]` and a non-enumerable `toJSON` reduces it further to header
   * names. The live values live in `#mode`, which `JSON.stringify` cannot see.
   */
  readonly mode: TraciveMode;
  readonly environment: TraciveEnvironment;
  readonly cachePolicy: CachePolicy;
  readonly defaultSource: Source;
  readonly retryPolicy: RetryPolicy;
  readonly cache: CheckCache;
  /** `undefined` in proxy mode, where the partner's own backend holds the credentials. */
  readonly oauth: TraciveOAuth | undefined;

  /**
   * The caller's mode, with the proxy credentials intact. Private so that a breadcrumb, a
   * Reactotron dump or a bare `console.log(client)` cannot reach it.
   */
  readonly #mode: TraciveMode;
  readonly #transport: HttpTransport;
  readonly #clock: TraciveClock;
  readonly #onDiagnostic: DiagnosticSink | undefined;

  constructor(options: TraciveClientOptions) {
    this.#mode = options.mode;
    this.mode =
      options.mode.type === 'proxy'
        ? { type: 'proxy', config: redactedProxyConfiguration(options.mode.config) }
        : options.mode;
    this.environment = options.environment ?? TraciveEnvironment.production;
    this.cachePolicy = options.cachePolicy ?? CachePolicy.default;
    this.defaultSource = options.defaultSource ?? 'CACHE_FIRST';
    this.retryPolicy = options.retryPolicy ?? RetryPolicy.default;
    this.#transport = options.transport ?? new FetchHttpTransport();
    this.#clock = options.clock ?? systemClock;
    this.#onDiagnostic = options.onDiagnostic;
    this.cache =
      options.cache ?? new InMemoryCheckCache({ policy: this.cachePolicy, clock: this.#clock });

    if (options.mode.type === 'oauth') {
      this.oauth =
        options.oauth ??
        new TraciveOAuth({
          mode: options.mode.config,
          environment: this.environment,
          transport: this.#transport,
          clock: this.#clock,
          ...(options.tokenStore !== undefined ? { tokenStore: options.tokenStore } : {}),
          ...(options.random !== undefined ? { random: options.random } : {}),
          ...(options.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
        });
    } else {
      this.oauth = undefined;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Checks
  // ---------------------------------------------------------------------------------------

  async checkScammer(query: TraciveQuery, options?: CheckScammerOptions): Promise<CheckResult> {
    const source = options?.source ?? this.defaultSource;
    const key = CheckCacheKey.fromQuery(query);

    if (source === 'CACHE') {
      // A storage fault surfaces as itself here. Answering "no reports" when the truth is "the
      // disk is broken" would be a fabricated clean verdict, which is the single worst thing a
      // fraud SDK can do.
      const cached = await this.cache.read(key);
      if (cached === undefined) {
        throw new TraciveError({
          kind: 'cacheMiss',
          message: 'No cached result for this query, and source was CACHE.',
        });
      }
      return cached;
    }

    if (source === 'CACHE_FIRST') {
      const cached = await this.#readCacheTolerantly(key);
      if (cached !== undefined) return cached;
      const fresh = await this.#fetchCheck(query, options);
      await this.#writeCacheTolerantly(fresh, key);
      return fresh;
    }

    if (source === 'SERVER') {
      const fresh = await this.#fetchCheck(query, options);
      await this.#writeCacheTolerantly(fresh, key);
      return fresh;
    }

    // SERVER_FIRST
    try {
      const fresh = await this.#fetchCheck(query, options);
      await this.#writeCacheTolerantly(fresh, key);
      return fresh;
    } catch (error) {
      // Fall back only when the failure was transport-shaped. A 402 or a 403 is a real answer
      // about the caller's account, and serving a cached verdict instead would hide a billing or
      // permission problem until it became someone else's incident.
      if (!(error instanceof TraciveError) || !this.#isTransportShaped(error)) throw error;
      const cached = await this.#readCacheTolerantly(key);
      if (cached !== undefined) return cached;
      throw error;
    }
  }

  async credits(options?: { signal?: AbortSignal }): Promise<CreditsInfo> {
    // Do not poll this. Handle the 402 from checkScammer instead: it saves a round trip per
    // transaction, and a balance read a moment earlier can be stale by the time the check lands.
    const { response } = await this.#execute({
      method: 'GET',
      path: TRACIVE_API_PATHS.credits,
      retryable: true,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
    return decodeCreditsInfo(JSON.parse(response.body || '{}'));
  }

  async profile(options?: { signal?: AbortSignal }): Promise<ProfileInfo> {
    const { response } = await this.#execute({
      method: 'GET',
      path: TRACIVE_API_PATHS.profile,
      retryable: true,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
    return decodeProfileInfo(JSON.parse(response.body || '{}'));
  }

  async clearCache(): Promise<void> {
    await this.cache.clear();
  }

  // ---------------------------------------------------------------------------------------
  // Authorization passthrough
  // ---------------------------------------------------------------------------------------

  authorize(): Promise<AuthResult | null> {
    return this.#requireOAuth().authorize();
  }

  handleCallback(url: string): Promise<AuthResult> {
    return this.#requireOAuth().handleCallback(url);
  }

  startLinkListener(): () => void {
    return this.#requireOAuth().startLinkListener();
  }

  onAuthResult(listener: (result: AuthResult) => void): () => void {
    return this.#requireOAuth().onAuthResult(listener);
  }

  signOut(): Promise<void> {
    return this.#requireOAuth().signOut();
  }

  isAuthorized(): Promise<boolean> {
    const oauth = this.oauth;
    return oauth === undefined ? Promise.resolve(false) : oauth.isAuthorized();
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  #requireOAuth(): TraciveOAuth {
    const oauth = this.oauth;
    if (oauth === undefined) {
      throw new TraciveError({
        kind: 'configuration',
        message: 'This client is in proxy mode, where authorization belongs to your own backend.',
      });
    }
    return oauth;
  }

  #isTransportShaped(error: TraciveError): boolean {
    if (error.kind === 'network' || error.kind === 'rateLimited' || error.kind === 'server') {
      return true;
    }
    return error.status !== undefined && error.status >= 500;
  }

  async #readCacheTolerantly(key: CheckCacheKey): Promise<CheckResult | undefined> {
    try {
      return await this.cache.read(key);
    } catch (error) {
      this.#diagnose({
        code: 'cache_read_failed',
        severity: 'warning',
        message: 'The cache could not be read, so this check went to the server.',
        hint:
          error instanceof CheckCacheError
            ? `Cache fault: ${error.kind}. Inspect cache.lastStoreError.`
            : 'Inspect cache.lastStoreError.',
      });
      return undefined;
    }
  }

  async #writeCacheTolerantly(result: CheckResult, key: CheckCacheKey): Promise<void> {
    try {
      await this.cache.write(result, key);
    } catch {
      // A failed cache write must never fail a check that already succeeded. It costs one credit
      // next time, and nothing more.
      this.#diagnose({
        code: 'cache_write_failed',
        severity: 'warning',
        message: 'A result could not be cached, so the next identical check will be billed again.',
        hint: 'Inspect cache.lastStoreError.',
      });
    }
  }

  async #fetchCheck(
    query: TraciveQuery,
    options: CheckScammerOptions | undefined,
  ): Promise<CheckResult> {
    const detail: Detail = options?.detail ?? 'minimal';
    const body: Record<string, string> = {
      searchQueryIndex: query.searchQueryIndex,
      detail,
    };
    if (options?.locale !== undefined) body.locale = options.locale;

    const idempotencyKey = options?.idempotencyKey;
    const { response } = await this.#execute({
      method: 'POST',
      path: TRACIVE_API_PATHS.scammerChecks,
      body: JSON.stringify(body),
      // The one rule that costs real money if it is wrong: a check is retryable only when the
      // caller supplied an idempotency key. Without one, the first 5xx, 429 or timeout is
      // surfaced immediately rather than gambling the caller's credit on a guess.
      retryable: idempotencyKey !== undefined,
      ...(idempotencyKey !== undefined
        ? { extraHeaders: { 'idempotency-key': idempotencyKey } }
        : {}),
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });

    return decodeCheckResult(JSON.parse(response.body || '{}'), this.#clock.nowMs());
  }

  async #authorizationHeaders(): Promise<Record<string, string>> {
    if (this.#mode.type === 'proxy') {
      // Deliberately the RAW mode. `this.mode` holds `[redacted]` in place of every value.
      return { ...(this.#mode.config.authHeaders ?? {}) };
    }
    const token = await this.#requireOAuth().ensureAccessToken();
    return { authorization: `Bearer ${token}` };
  }

  #urlFor(path: string): string {
    return this.#mode.type === 'proxy'
      ? proxyUrl(this.#mode.config.baseUrl, path)
      : apiUrl(this.environment, path);
  }

  async #execute(input: {
    method: 'GET' | 'POST';
    path: string;
    body?: string;
    retryable: boolean;
    extraHeaders?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<Attempt> {
    const maxAttempts = input.retryable ? Math.max(1, this.retryPolicy.maxAttempts) : 1;
    let attempt = 1;
    let refreshed = false;

    for (;;) {
      const request: HttpRequest = {
        method: input.method,
        url: this.#urlFor(input.path),
        headers: {
          accept: 'application/json',
          ...(input.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(await this.#authorizationHeaders()),
          ...(input.extraHeaders ?? {}),
        },
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      };

      let response: HttpResponse;
      try {
        // `redactedRequest` is what actually crosses the seam. `HttpTransport` is a documented,
        // encouraged injection point, so a partner transport that logs its argument would
        // otherwise log a live bearer token or a live gateway key. The values are still there
        // for the transport to read; only the serialisations are redacted.
        response = await this.#transport.send(redactedRequest(request));
      } catch (cause) {
        const error =
          cause instanceof TraciveError
            ? cause
            : new TraciveError({ kind: 'network', message: 'The request failed.', cause });
        if (attempt >= maxAttempts) throw error;
        await this.#backoff(++attempt, undefined);
        continue;
      }

      if (response.status >= 200 && response.status < 300) return { response };

      const fields = extractErrorFields(response.body);
      const retryAfterSeconds = parseRetryAfterSeconds(
        response.headers['retry-after'],
        this.#clock.nowMs(),
      );
      const error = traciveErrorFrom({
        status: response.status,
        ...fields,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });

      if (response.status === 401) {
        if (error.kind === 'grantRevoked') {
          // Terminal. Usually the server's refresh-token reuse detection firing: the grant is
          // gone, so there is nothing to retry into.
          await this.oauth?.clearTokens();
          throw error;
        }
        if (error.kind === 'expiredToken' && !refreshed && this.#mode.type === 'oauth') {
          // A 401 is rejected before billing, so re-sending after a refresh cannot double-charge
          // and deliberately does NOT consume the retry budget.
          refreshed = true;
          await this.#requireOAuth().refreshTokens();
          continue;
        }
        throw error;
      }

      const worthRetrying = response.status === 429 || response.status >= 500;
      if (!worthRetrying || attempt >= maxAttempts) throw error;
      await this.#backoff(++attempt, retryAfterSeconds);
    }
  }

  async #backoff(nextAttempt: number, retryAfterSeconds: number | undefined): Promise<void> {
    // Jitter is a scheduling nicety, never a security primitive, so it deliberately does NOT go
    // through the CSPRNG port — a missing WebCrypto polyfill must not break retrying.
    const seconds = backoffSecondsFor(
      this.retryPolicy,
      nextAttempt,
      retryAfterSeconds,
      Math.random(),
    );
    if (seconds > 0) await this.#clock.sleep(seconds);
  }

  #diagnose(diagnostic: Diagnostic): void {
    emitDiagnostic(this.#onDiagnostic, diagnostic);
  }
}

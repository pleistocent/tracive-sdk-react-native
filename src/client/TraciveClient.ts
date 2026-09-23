import { CheckCacheError } from '../cache/CheckCacheError';
import { CheckCacheKey } from '../cache/CheckCacheKey';
import { InMemoryCheckCache, type CheckCache } from '../cache/CheckCache';
import { emitDiagnostic, type Diagnostic, type DiagnosticSink } from '../diagnostics';
import { defaultRandom, randomUuid, type TraciveRandom } from '../crypto/random';
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
  parseSuccessBody,
} from './responseMapper';
import { backoffSecondsFor, RetryPolicy } from './RetryPolicy';
import { apiUrl, proxyUrl, TRACIVE_API_PATHS } from './TraciveApi';
import { abortedRequestError, systemClock, type TraciveClock } from './TraciveClock';

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
   * WITHOUT IT THE SDK WILL NOT RETRY a 5xx or a timeout, because it cannot tell whether the
   * first attempt was already charged and a blind retry risks a double charge. The same key is
   * reused on every attempt, which is what lets the server deduplicate. A 429 is never retried,
   * key or no key: it surfaces as `rateLimited` with `retryAfterSeconds`.
   *
   * The request always carries SOME `Idempotency-Key`: when you supply none, the SDK generates a
   * per-call one so that its own replay after a 401 token refresh can be collapsed server-side.
   * That does not give you a retry budget — only your own key does — and it is no substitute for
   * a key derived from your transaction if you want retries or deduplication across processes.
   * An empty string is treated as no key at all.
   */
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

interface Attempt {
  readonly response: HttpResponse;
}

/**
 * The caller's OWN idempotency key, or `undefined` when they supplied none.
 *
 * An empty string is not a key. Sent as one it would give the caller a retry budget backed by a
 * header no server can deduplicate on, which is the exact trade the budget exists to refuse.
 *
 * It is one function because two places decide on it — the retry budget and the header in
 * `#sendCheck`, and the single-flight latch key in `#fetchCheck` — and the two must agree on what
 * counts as a key. If they drifted, a caller passing `''` would be latched apart from a caller
 * passing nothing while sending the identical unkeyed request, which is a second billed check for
 * the double tap the latch exists to collapse.
 */
function callerIdempotencyKey(options: CheckScammerOptions | undefined): string | undefined {
  const supplied = options?.idempotencyKey;
  // Blank counts as absent, not as a key. A key of `'   '` is a build variable that did not expand
  // or a trimmed-to-nothing form field, and treating it as real gives that check a latch of its own
  // and a retry budget, both on the strength of whitespace. The same rule as everywhere else this
  // SDK asks whether a credential-shaped string is there.
  //
  // The value itself is passed through untouched, whitespace included. It is what the server
  // deduplicates on and what the partner recorded against their transaction, so trimming it would
  // send a key that differs from the one they wrote down. Only the "is there a key" reading trims.
  return supplied !== undefined && supplied.trim() !== '' ? supplied : undefined;
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
  readonly #random: TraciveRandom;
  readonly #onDiagnostic: DiagnosticSink | undefined;
  /**
   * Single-flight for checks, keyed on the folded record key plus the detail level and the locale,
   * and on the caller's idempotency key when they supplied one. See `#fetchCheck` for why this
   * exists and what it deliberately does not cover.
   */
  readonly #inFlightChecks = new Map<string, Promise<CheckResult>>();

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
    this.#random = options.random ?? defaultRandom;
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
    const detail: Detail = options?.detail ?? 'minimal';
    const key = CheckCacheKey.fromQuery(query);

    /**
     * One flag gates every place the cache is touched — the `CACHE` read, the `CACHE_FIRST` read,
     * all three writes and the `SERVER_FIRST` fallback — decided once here so that the read side
     * and the write side of the rule cannot drift apart. Each is wrong for `full` detail for its
     * own reason.
     *
     * The read is wrong because of `detail`. A stored row never carries `topChronologies` or
     * `comments` — `toCacheableCopy` drops them — so serving one to a caller who asked for `full`
     * hands back both fields as `undefined`, which is byte-identical to "the server answered in
     * full and there is no narrative on file". A screen rendering "no incident reports" from that
     * is showing a wrong fraud answer rather than a stale one, and it is silent: nothing throws,
     * nothing is logged, and no request leaves the device.
     *
     * The write is wrong because of `locale`. The stored projection keeps `tags` and `disclaimer`,
     * both of which come back in the requested language, and the row key is the folded identifier
     * alone with no locale in it. Only a `full` request sends a locale. Storing its projection
     * would file localised text under a locale-less key, and the very next `minimal` check — which
     * sends no locale at all — would read it straight back as if it were the default. `disclaimer`
     * is the one string this SDK asks every integrator to put on screen.
     *
     * The fallback is wrong because falling back trades freshness for an answer. For `minimal`
     * that trade is sound: a risk tier is the same fact an hour later. There is no stale version
     * of narrative content, only a missing one that renders as an empty one.
     *
     * The alternative design — keying rows by `(query, detail, locale)` — was deliberately not
     * taken. It is a larger contract change for no gain, because a `full` row could only ever be
     * served to a caller who wanted the very content it is not allowed to keep, and the Kotlin,
     * Swift and Flutter SDKs all carry this same gate. The test is `=== 'minimal'` rather than
     * `!== 'full'` so that a third detail level, if one is ever added, does not silently start
     * being cached.
     */
    const cacheApplies = detail === 'minimal';

    if (source === 'CACHE') {
      // This source is forbidden to call the network, and the cache holds nothing that answers a
      // full-detail question, so the honest reply is the miss the caller already handles. The
      // cache is not even consulted: a stored row is not a hit here.
      if (!cacheApplies) {
        throw new TraciveError({
          kind: 'cacheMiss',
          message: 'Only minimal-detail results are cached, and source was CACHE.',
        });
      }
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
      if (cacheApplies) {
        const cached = await this.#readCacheTolerantly(key);
        if (cached !== undefined) return cached;
      }
      const fresh = await this.#fetchCheck(query, options, key);
      if (cacheApplies) await this.#writeCacheTolerantly(fresh, key);
      return fresh;
    }

    if (source === 'SERVER') {
      const fresh = await this.#fetchCheck(query, options, key);
      if (cacheApplies) await this.#writeCacheTolerantly(fresh, key);
      return fresh;
    }

    // SERVER_FIRST
    try {
      const fresh = await this.#fetchCheck(query, options, key);
      if (cacheApplies) await this.#writeCacheTolerantly(fresh, key);
      return fresh;
    } catch (error) {
      // Fall back only when the failure was transport-shaped. A 402 or a 403 is a real answer
      // about the caller's account, and serving a cached verdict instead would hide a billing or
      // permission problem until it became someone else's incident.
      if (!cacheApplies) throw error;
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
    return decodeCreditsInfo(parseSuccessBody(response.body, response.status));
  }

  async profile(options?: { signal?: AbortSignal }): Promise<ProfileInfo> {
    const { response } = await this.#execute({
      method: 'GET',
      path: TRACIVE_API_PATHS.profile,
      retryable: true,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });
    return decodeProfileInfo(parseSuccessBody(response.body, response.status));
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

  /** `null` when the URL is not this client's redirect; see `TraciveOAuth.handleCallback`. */
  handleCallback(url: string): Promise<AuthResult | null> {
    return this.#requireOAuth().handleCallback(url);
  }

  startLinkListener(): () => void {
    return this.#requireOAuth().startLinkListener();
  }

  onAuthResult(listener: (result: AuthResult) => void): () => void {
    return this.#requireOAuth().onAuthResult(listener);
  }

  /**
   * Revokes the grant best effort, clears the stored tokens, and empties the check cache.
   *
   * The cache goes too, and that is not housekeeping. Every row in it was fetched under the grant
   * of the user who just signed out, and a cached verdict is readable without any credential at
   * all — `source: 'CACHE'` never touches the network — so leaving them behind hands the next
   * person to hold the device the departing user's check history, on a phone that now reports
   * `isAuthorized() === false`.
   *
   * The client owns the clearing because the flow cannot do it. `TraciveOAuth` has no reference to
   * a cache, and giving it one would be wrong rather than merely awkward: a `CheckCache` is an
   * injected object, so two clients — a partner running one in each of two contexts — can be handed
   * the same instance, and the flow has no way to know which of them a sign-out belongs to. Clearing
   * from here empties that shared cache for the other client too, and that is the answer this SDK
   * chooses on purpose: the rows are one user's answers about identifiers they looked up, and the
   * cost of dropping them is that the other client pays for a re-check, while the cost of keeping
   * them is that a signed-out user's history stays readable. Only one of those two is recoverable.
   *
   * A partner driving `TraciveOAuth` directly, rather than through this class, owns their own
   * cache and has to clear it themselves — `TraciveOAuth.signOut()` cannot reach it.
   */
  async signOut(): Promise<void> {
    await this.#requireOAuth().signOut();
    await this.cache.clear();
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

  /**
   * Single-flight, because the cost of getting this wrong is money.
   *
   * Two overlapping checks for the same identifier both read the cache, both missed, both POSTed
   * and both were charged — the cache write is the only serialisation point and it happens after
   * both requests have already gone out. A double-tapped button, or a list screen rendering the
   * same identifier in two cells, doubled the bill. `TraciveOAuth.refreshTokens` has had the
   * correct shape all along; this is the same latch in the one place where the unit is currency.
   *
   * The key includes the detail level and the locale, not just the record key: a `minimal` result
   * must never be handed back to a caller who asked for `full`. The assignment happens with no
   * `await` between the lookup and the `set`, which is the whole point — otherwise two callers
   * both observe an empty map and both start a flight.
   *
   * It also includes the CALLER's idempotency key when there is one, and is left exactly as it was
   * when there is not. Those first three fields describe the query; an idempotency key describes
   * the transaction, and two callers who supplied different ones have said in as many words that
   * these are two billable transactions. Collapsing them answered both from one request and sent
   * the first caller's key on it, which is the same collapse the generated key already refuses to
   * make through the other door: deriving one from the query "would collapse two deliberate
   * re-checks of the same identifier into one". A caller who supplied a key could also be handed a
   * flight started by a caller who had not, and inherit that flight's refusal to retry — a retry
   * budget is granted by the caller's own key and by nothing else, and losing it that way was
   * silent.
   *
   * What the latch exists for is untouched, because that case carries no caller key at all: a
   * double-tapped button and a list rendering the same identifier in two cells both go through one
   * code path with one set of options, so they still share a flight and are still billed once.
   *
   * A call carrying an `AbortSignal` deliberately neither starts nor joins a shared flight. One
   * caller's abort would otherwise cancel another caller's check, or — if the signal were dropped
   * on the way in — an abort would stop stopping anything, spending the credit H2 exists to save.
   * A caller who passes a signal has asked for control of that request's lifetime, and sharing
   * takes it away.
   */
  #fetchCheck(
    query: TraciveQuery,
    options: CheckScammerOptions | undefined,
    key: CheckCacheKey,
  ): Promise<CheckResult> {
    if (options?.signal !== undefined) return this.#sendCheck(query, options);

    const detail: Detail = options?.detail ?? 'minimal';
    const callerKey = callerIdempotencyKey(options);
    const latchKey =
      `${key.hex}|${detail}|${options?.locale ?? ''}` +
      (callerKey === undefined ? '' : `|${callerKey}`);
    const existing = this.#inFlightChecks.get(latchKey);
    if (existing !== undefined) return existing;

    const inFlight = this.#sendCheck(query, options).finally(() => {
      this.#inFlightChecks.delete(latchKey);
    });
    this.#inFlightChecks.set(latchKey, inFlight);
    return inFlight;
  }

  async #sendCheck(
    query: TraciveQuery,
    options: CheckScammerOptions | undefined,
  ): Promise<CheckResult> {
    const detail: Detail = options?.detail ?? 'minimal';
    // The field is `query`, not `searchQueryIndex`. The API takes either a structured `input` it
    // normalizes itself or a `query` string the client folded — and the second is the one every
    // Tracive SDK uses, because folding on the device is what lets an invalid identifier be
    // rejected before a billable call goes out. A body naming the field anything else is a 400.
    //
    // `creditSource` is optional and defaults to USER for a bearer-only caller, which is every
    // call this SDK makes. It is sent explicitly all the same: the sibling SDKs send it, so a
    // captured request from one is comparable with another, and an explicit value cannot be
    // changed by a server-side default moving later.
    const body: Record<string, string> = {
      creditSource: 'USER',
      detail,
      query: query.searchQueryIndex,
    };
    if (options?.locale !== undefined) body.locale = options.locale;

    // The same rule the latch key in `#fetchCheck` uses, so the two cannot drift.
    const callerKey = callerIdempotencyKey(options);

    const { response } = await this.#execute({
      method: 'POST',
      path: TRACIVE_API_PATHS.scammerChecks,
      body: JSON.stringify(body),
      // The one rule that costs real money if it is wrong: a check is retryable only when the
      // CALLER supplied an idempotency key. Without one, the first 5xx or timeout is
      // surfaced immediately rather than gambling the caller's credit on a guess. A key the SDK
      // generated below does not change that and must not: the caller's key is the only thing
      // that survives a process restart and a new client instance, which is what a retry budget
      // actually needs.
      retryable: callerKey !== undefined,
      // Every check carries an Idempotency-Key, whether the caller supplied one or not.
      //
      // The SDK re-sends this exact POST after a 401 refresh (see `#execute`). With no key the
      // two attempts are indistinguishable to the server, so anything billed before or during
      // authorisation is billed twice with no way for the caller to detect it. The old reasoning
      // for allowing that was "a 401 is rejected before billing" — an assumption about the server's
      // ordering that nothing on the client can verify, and the one premise this SDK otherwise
      // refuses to make anywhere.
      // Generating a key removes the need to assume anything. The prefix keeps an SDK-invented key
      // distinguishable from a partner's own in a server-side log, which is what a disputed charge
      // gets reconciled against.
      //
      // It is generated per call and never derived from the query: deriving it would collapse two
      // deliberate re-checks of the same identifier into one answer and one charge, silently.
      extraHeaders: { 'idempotency-key': callerKey ?? `sdk-${randomUuid(this.#random)}` },
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
    });

    return decodeCheckResult(parseSuccessBody(response.body, response.status), this.#clock.nowMs());
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
      // Re-read on every pass, not just before the first send. A retry entered after a backoff
      // would otherwise fire a fresh POST — and therefore spend a credit — for a caller who gave
      // up seconds ago. The check also covers the refresh-and-resend `continue` below, and it
      // does not rely on the clock honouring the signal, because a caller may inject their own.
      if (input.signal?.aborted === true) throw abortedRequestError();

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
        await this.#backoff(++attempt, undefined, input.signal);
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
        // Refresh on ANY 401 that is not terminal, rather than only on an exact
        // `expired_token` body. A bare 401 — no body, or a WWW-Authenticate header and nothing
        // else — is what CDNs, API gateways and misconfigured reverse proxies emit, and this SDK
        // is designed to sit behind a partner gateway. Requiring the code left the client
        // permanently stuck in that state: never refreshing, every call failing identically,
        // until the app happened to call authorize() again.
        //
        // `invalidToken` is excluded alongside `grantRevoked`: the server is saying the token is
        // not a usable credential at all, so a fresh one earns nothing.
        //
        // A 401 is rejected before billing, so re-sending after a refresh cannot double-charge,
        // and this deliberately does NOT consume the retry budget. It can happen at most once
        // per request either way.
        if (error.kind !== 'invalidToken' && !refreshed && this.#mode.type === 'oauth') {
          refreshed = true;
          await this.#requireOAuth().refreshTokens();
          continue;
        }
        throw error;
      }

      // A 429 is never retried, keyed or not: its Retry-After can run to the next UTC midnight, and
      // sleeping on it inside one call would hold the caller for hours. The caller gets
      // `rateLimited` with `retryAfterSeconds` at once and decides whether waiting is acceptable.
      const worthRetrying = response.status >= 500;
      if (!worthRetrying || attempt >= maxAttempts) throw error;
      await this.#backoff(++attempt, retryAfterSeconds, input.signal);
    }
  }

  async #backoff(
    nextAttempt: number,
    retryAfterSeconds: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    // Jitter is a scheduling nicety, never a security primitive, so it deliberately does NOT go
    // through the CSPRNG port — a missing WebCrypto polyfill must not break retrying.
    const seconds = backoffSecondsFor(
      this.retryPolicy,
      nextAttempt,
      retryAfterSeconds,
      Math.random(),
    );
    if (seconds > 0) await this.#clock.sleep(seconds, signal);
  }

  #diagnose(diagnostic: Diagnostic): void {
    emitDiagnostic(this.#onDiagnostic, diagnostic);
  }
}

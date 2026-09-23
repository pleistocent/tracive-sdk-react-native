import { apiUrl, formUrlEncode, TRACIVE_API_PATHS } from '../client/TraciveApi';
import {
  FetchHttpTransport,
  redactedRequest,
  type HttpResponse,
  type HttpTransport,
} from '../client/HttpTransport';
import { systemClock, type TraciveClock } from '../client/TraciveClock';
import { defaultRandom, type TraciveRandom } from '../crypto/random';
import { emitDiagnostic, type Diagnostic, type DiagnosticSink } from '../diagnostics';
import {
  codeReceived,
  redactedTokens,
  type AuthResult,
  type TraciveTokens,
} from '../model/AuthResult';
import { TraciveConfigurationError } from '../model/TraciveConfigurationError';
import { TraciveEnvironment } from '../model/TraciveEnvironment';
import { TraciveError, traciveErrorFrom } from '../model/TraciveError';
import type { OAuthConfiguration } from '../model/TraciveMode';
import { LinkingAppPresenceProbe, type AppPresenceProbe } from './AppPresenceProbe';
import { LinkingAuthorizeLauncher, type AuthorizeLauncher } from './AuthorizeLauncher';
import {
  appPresenceProbeUrl,
  buildAuthorizeUrl,
  buildInstallUrl,
  DEFAULT_INSTALL_URL,
  parseCallbackParameters,
  redirectTarget,
  TRACIVE_APP_SCHEME,
} from './authorizeUrl';
import { linkingLinkSource, startLinkListener, type LinkSource } from './linkListener';
import {
  InMemoryPendingAuthorizationStore,
  STALE_PENDING_AUTHORIZATION_HINT,
  type PendingAuthorization,
  type PendingAuthorizationStore,
} from './PendingAuthorization';
import { createPkcePair, createState, statesMatch } from './pkce';
import { InMemoryTokenStore, type TokenStore } from './TokenStore';

/**
 * How long a pending authorization record stays usable.
 *
 * Ten minutes because that is the authorization code's own budget: RFC 6749 section 4.1.2 puts the
 * recommended maximum lifetime of an authorization code at ten minutes. The verifier in this record
 * exists for exactly one purpose — redeeming that code — so keeping it past the code's expiry buys
 * no recovery. The exchange would go out, reach the server, and be refused there for a reason this
 * SDK cannot improve on, having spent a round trip to learn what the local clock already knew.
 *
 * It is not shorter for the mirror reason. Consent happens in another app, and a user who reads the
 * screen, switches away to check something and comes back has done nothing wrong. Ten minutes is
 * what the code allows, so refusing earlier would throw away attempts the server would still honour.
 */
const DEFAULT_PENDING_MAX_AGE_SECONDS = 600;

/**
 * How many spent refresh tokens are remembered, oldest evicted first.
 *
 * A short history rather than a single slot, because one slot cannot answer for a token two
 * rotations back — the Flutter SDK shipped a single slot first and it was wrong for exactly that
 * reason. Eight is comfortably more rotations than a stored grant can go through between one
 * caller reading it and that caller reaching the wire, and an under-estimate here is not a
 * correctness problem: the flight re-reads the store itself, so a token too old to be recognised
 * has already been replaced in the store and cannot be sent.
 */
const SPENT_REFRESH_TOKEN_HISTORY = 8;

/**
 * A blank `installUrl` is REFUSED. It is never treated as absent and never replaced by
 * {@link DEFAULT_INSTALL_URL}.
 *
 * Every Tracive SDK refuses it, and they all name the failure `blank_install_url`. Setting the
 * option at all is a statement that Tracive's own install page is not where these users should go,
 * so substituting it back in overrides that decision silently — and a blank value means something
 * in the host app's build produced an empty string, which is a bug the default would hide rather
 * than fix.
 *
 * It is refused HERE, at construction, rather than left to fail at the launch. A blank value used
 * to survive as far as `buildInstallUrl`, which turned it into `?ref=…&utm_source=…` — neither the
 * default nor the partner's value, but a schemeless string no OS will open. That only surfaced for
 * a user without the Tracive app, only after a real `authorize()`, and only as an optional
 * diagnostic the host may not have subscribed to: silent in every way that matters, on the one
 * path where the SDK has nothing else to offer. A throw on the first construction is loud, is
 * immediate, and reaches whoever set the option.
 *
 * Only a blank value is refused. A non-blank URL is passed through exactly as given, including one
 * that turns out to be wrong — that failure is the partner's own and is visible to them, which is
 * the whole reason not to paper over it.
 */
const PARTNER_USER_ID_MAX_LENGTH = 200;

/**
 * Why the server would refuse `value` as a `partner_user_id` (backend `partnerUserIdProblem`), or
 * null when it accepts it. KEEP IN SYNC with the server and the other three SDKs.
 */
function partnerUserIdProblem(value: string): string | null {
  const v = value.trim();
  if (v === '') return 'must not be blank';
  if (v.length > PARTNER_USER_ID_MAX_LENGTH) {
    return `must be at most ${PARTNER_USER_ID_MAX_LENGTH} characters`;
  }
  if (v.includes('@')) return 'looks like an email address';
  const compact = v.replace(/[\s\-().]/g, '');
  if (/^\+\d{7,15}$/.test(compact) || /^(08|628)\d{8,11}$/.test(compact)) {
    return 'looks like a phone number';
  }
  return null;
}

/**
 * Refuses a `partnerUserId` the server would refuse, where the mistake was made.
 *
 * TypeScript makes the field required, which is nothing at all for a JavaScript caller or a value
 * from a form or config. The server refuses a blank, over-long, email- or phone-shaped id before a
 * redirect exists (audit SDK-2), so the partner app would receive nothing to handle.
 */
function requirePartnerUserId(configuration: OAuthConfiguration): void {
  const problem = partnerUserIdProblem(configuration.partnerUserId);
  if (problem === null) return;
  const blank = configuration.partnerUserId.trim() === '';
  throw new TraciveConfigurationError(
    blank ? 'blank_partner_user_id' : 'invalid_partner_user_id',
    `partnerUserId ${problem}. Send an opaque id you store — a UUID or your own customer key — ` +
      'because it is stored as sent and echoed back in grant.revoked so you can map the event ' +
      'to your own customer. The Tracive app refuses anything else with no redirect, so the ' +
      'failure would reach you as silence rather than as an error.',
  );
}

function resolveInstallUrl(configured: string | undefined): string {
  if (configured === undefined) return DEFAULT_INSTALL_URL;
  if (configured.trim() === '') {
    throw new TraciveConfigurationError(
      'blank_install_url',
      'installUrl is blank. It is refused rather than replaced with the built-in install link, ' +
        'because setting the option is a statement that the built-in page is not where these ' +
        'users should go — substituting it back would override that decision without saying so, ' +
        'and would hide whatever produced the empty string. Pass the install URL you want, or ' +
        'omit the option entirely to accept the built-in one.',
    );
  }
  return configured;
}

export interface TraciveOAuthOptions {
  readonly mode: OAuthConfiguration;
  readonly environment?: TraciveEnvironment;
  readonly transport?: HttpTransport;
  readonly tokenStore?: TokenStore;
  /**
   * Where the pending PKCE record is written before the authorize URL is opened.
   *
   * The default is in-memory, so the record dies with the process — and the process is backgrounded
   * for the whole of consent, which on Android is when it is most likely to be killed. Supply
   * `expoSecurePendingAuthorizationStore()` or `keychainPendingAuthorizationStore()` from the
   * adapter subpaths to get the process-death behaviour this record exists for. See
   * `PendingAuthorizationStore` for what the default costs.
   */
  readonly pendingStore?: PendingAuthorizationStore;
  readonly launcher?: AuthorizeLauncher;
  readonly presence?: AppPresenceProbe;
  readonly linkSource?: LinkSource;
  readonly clock?: TraciveClock;
  readonly random?: TraciveRandom;
  /**
   * Where a user without the Tracive app is sent. Omit it to accept
   * {@link TraciveOAuth.defaultInstallUrl}.
   *
   * A BLANK value throws {@link TraciveConfigurationError} (`blank_install_url`) from the
   * constructor. It is not treated as "unset": see `resolveInstallUrl`.
   */
  readonly installUrl?: string;
  /** Defaults to ten minutes; see `DEFAULT_PENDING_MAX_AGE_SECONDS` for why that number. */
  readonly pendingAuthorizationMaxAgeSeconds?: number;
  readonly onDiagnostic?: DiagnosticSink;
}

interface TokenResponseBody {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function parseJsonBody(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The error to raise when a REFRESH is over for good, or null when it may be tried again.
 *
 * Two codes mean the same thing in two envelopes. The Tracive envelope says `grant_revoked`; the
 * token endpoint answers in RFC 6749's shape instead, where `invalid_grant` covers all three
 * terminal cases — the grant was revoked, the refresh token idled out, and reuse detection fired.
 * Read only as "unknown", it left dead tokens on the device: every later check spent two round
 * trips failing, and nothing ever told the host to send the user through authorize again.
 *
 * Scoped to the refresh path on purpose, rather than mapped globally in `traciveErrorFrom`.
 * `invalid_grant` is terminal because of where it arrived, not because of what it says, and the
 * code exchange — which has no stored credentials to discard — must keep treating it as an
 * ordinary failure.
 */
function terminalRefreshFailure(error: unknown): TraciveError | null {
  if (!(error instanceof TraciveError)) return null;
  if (error.kind === 'grantRevoked') return error;
  if (error.serverCode !== 'invalid_grant') return null;
  return new TraciveError({
    kind: 'grantRevoked',
    message: error.message,
    status: error.status,
    info: error.info,
    cause: error,
  });
}

export class TraciveOAuth {
  static readonly traciveAppScheme = TRACIVE_APP_SCHEME;
  /**
   * The presence probe for an environment. A function rather than a constant since 2 August 2026:
   * the sandbox build registers its own scheme, and probing production's cannot see it.
   */
  static readonly appPresenceProbeUrl = appPresenceProbeUrl;
  static readonly defaultInstallUrl = DEFAULT_INSTALL_URL;

  readonly #config: OAuthConfiguration;
  readonly #environment: TraciveEnvironment;
  readonly #transport: HttpTransport;
  readonly #tokenStore: TokenStore;
  readonly #pendingStore: PendingAuthorizationStore;
  readonly #launcher: AuthorizeLauncher;
  readonly #presence: AppPresenceProbe;
  readonly #linkSource: LinkSource;
  readonly #clock: TraciveClock;
  readonly #random: TraciveRandom;
  readonly #installUrl: string;
  readonly #pendingMaxAgeSeconds: number;
  readonly #onDiagnostic: DiagnosticSink | undefined;

  readonly #listeners = new Set<(result: AuthResult) => void>();
  #bufferedResult: AuthResult | undefined;
  #inFlightRefresh: Promise<TraciveTokens> | null = null;

  /**
   * The refresh tokens this instance has already handed to the server, oldest first.
   *
   * A refresh token is single-use and rotates, and re-presenting one is precisely what a server's
   * reuse detection looks for: the answer is to revoke the whole grant, not to refuse one call.
   *
   * The single-flight latch does not cover this, because the hazard is sequential rather than
   * concurrent. A refresh that fails with NO response — a socket timeout, a connection dropped
   * mid-flight — is indistinguishable from a success whose reply was lost, so the server may
   * already have rotated the token and be waiting to see the new one. The latch is clear by then,
   * the store still holds the token that was sent, and the next caller would present it again.
   * This records what has been handed over so that caller can be turned away on the token's
   * identity rather than on timing.
   *
   * Emptied whenever the grant is dropped, so a fresh authorization starts from a clean slate.
   *
   * **Deliberately in memory only: it dies with the process, and is not persisted.** What it would
   * buy is protection across a restart — a store rolled back by a device-backup restore holds a
   * refresh token this SDK already spent, and after a cold start there is nothing here to recognise
   * it. That case ends at the server, which sees the reuse and revokes the grant, so the user
   * re-consents once. Buying it back would mean writing dead refresh tokens to secure storage: more
   * credential-shaped strings on disk, permanently, to spare a rare and recoverable prompt. Not
   * worth it. All four SDKs make the same call.
   */
  readonly #spentRefreshTokens: string[] = [];

  /**
   * The id of the authorization THIS instance started and has not yet resolved.
   *
   * Memory-only on purpose, so it is `undefined` after a process death even when a record is still
   * in the store. That asymmetry is the point: a cancel means "this process watched the flow end
   * without a redirect", and a process that never opened anything has no such observation to
   * offer. See {@link cancelPendingAuthorization}.
   */
  #pendingAuthorizationId: string | undefined;
  #authorizationCounter = 0;

  /**
   * Moved every time the grant is deliberately dropped — {@link signOut}, {@link clearTokens}, and
   * the `grantRevoked` discard inside a refresh.
   *
   * Every token write that follows a round trip is conditional on this being unchanged since that
   * round trip began. Discarding a credential is instantaneous and acquiring one is not, so a
   * refresh or a code exchange that was already on the wire when the user signed out still
   * completes — and its write would refill the store that was just emptied, leaving a live and
   * freshly rotated refresh token on a device the user believes is signed out, and may be about to
   * hand over.
   *
   * Awaiting the in-flight work inside `signOut` is not the alternative: that would make signing
   * out wait on a network call, which `signOut` deliberately refuses to do. Gating the write is
   * what makes a sign-out both immediate and final. The check sits directly before the write with
   * no `await` between them, so nothing can interleave in the gap.
   */
  #credentialEpoch = 0;

  constructor(options: TraciveOAuthOptions) {
    requirePartnerUserId(options.mode);
    this.#config = options.mode;
    this.#environment = options.environment ?? TraciveEnvironment.production;
    this.#transport = options.transport ?? new FetchHttpTransport();
    this.#tokenStore = options.tokenStore ?? new InMemoryTokenStore();
    this.#pendingStore = options.pendingStore ?? new InMemoryPendingAuthorizationStore();
    this.#onDiagnostic = options.onDiagnostic;
    this.#presence =
      options.presence ??
      new LinkingAppPresenceProbe({
        environment: this.#environment,
        ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
      });
    this.#launcher = options.launcher ?? new LinkingAuthorizeLauncher();
    this.#linkSource = options.linkSource ?? linkingLinkSource;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? defaultRandom;
    this.#installUrl = resolveInstallUrl(options.installUrl);
    this.#pendingMaxAgeSeconds =
      options.pendingAuthorizationMaxAgeSeconds ?? DEFAULT_PENDING_MAX_AGE_SECONDS;
  }

  /** A stored-grant check, NOT a liveness check: it never touches the network. */
  async isAuthorized(): Promise<boolean> {
    return (await this.#tokenStore.read()) !== undefined;
  }

  async grantedScopes(): Promise<readonly string[]> {
    return (await this.#tokenStore.read())?.scopes ?? [];
  }

  isTraciveAppInstalled(): Promise<boolean> {
    return this.#presence.isTraciveAppInstalled();
  }

  /**
   * The install link for a device without the Tracive app.
   *
   * {@link authorize} already OPENS this link itself before reporting `appNotInstalled`, so a
   * partner does not have to. This accessor stays for the partner who would rather render the
   * link than have the user jump straight out of the app, and it is what to fall back on if the
   * OS refuses the launch.
   *
   * Carries attribution only — `ref` (the partner's OAuth client id) and `utm_source` — and never
   * an OAuth parameter.
   */
  installUrlForDisplay(): string {
    return buildInstallUrl(this.#installUrl, this.#config.clientId);
  }

  /**
   * Returns `null` when the flow was launched successfully: the outcome arrives later at
   * {@link handleCallback}, because an app-to-app hop can outlive this process.
   *
   * When the Tracive app is absent, the install page is opened and `appNotInstalled` is returned.
   * No OAuth flow is started in that case: no PKCE pair, no state, nothing persisted.
   */
  async authorize(): Promise<AuthResult | null> {
    if (!(await this.#presence.isTraciveAppInstalled())) {
      await this.#launchInstall();
      return { type: 'appNotInstalled' };
    }

    let previous: PendingAuthorization | undefined;
    try {
      previous = await this.#pendingStore.read();
    } catch {
      // Not fatal here: a new record is about to be written over whatever was there. Worth a
      // diagnostic, because a store that cannot be read usually cannot be written either, and
      // the write below IS fatal.
      this.#diagnose({
        code: 'pending_authorization_read_failed',
        severity: 'warning',
        message: 'The previous authorization record could not be read.',
        hint: 'The secure store rejected a read. A new record will be written over it.',
      });
    }
    if (previous !== undefined) {
      const ageSeconds = (this.#clock.nowMs() - previous.createdAtMs) / 1000;
      if (ageSeconds > this.#pendingMaxAgeSeconds) {
        this.#diagnose({
          code: 'pending_authorization_stale',
          severity: 'warning',
          message: `A previous authorization launched ${Math.round(
            ageSeconds,
          )}s ago never returned a result.`,
          hint: STALE_PENDING_AUTHORIZATION_HINT,
        });
      }
      await this.#clearPendingQuietly();
    }

    const pkce = createPkcePair(this.#random);
    const state = createState(this.#random);

    // Written BEFORE the URL is opened. If the process dies during the hop, the record survives.
    try {
      await this.#pendingStore.write({
        state,
        codeVerifier: pkce.codeVerifier,
        redirectUri: this.#config.redirectUri,
        createdAtMs: this.#clock.nowMs(),
      });
    } catch (cause) {
      // Fatal, and it must be caught BEFORE the launch. Opening the authorize URL without the
      // record means the redirect can never be completed — the callback finds no state to match
      // and no verifier to exchange — so the user would sign in for nothing. Returned rather
      // than thrown because this method is typed `Promise<AuthResult | null>` and its two other
      // failure modes, the presence probe and the launcher, are both returned.
      return {
        type: 'failed',
        error:
          cause instanceof TraciveError
            ? cause
            : new TraciveError({
                kind: 'unknown',
                message:
                  'The pending authorization record could not be stored, so the flow was not ' +
                  'started. The redirect could not have been completed without it.',
                cause,
              }),
      };
    }

    this.#authorizationCounter += 1;
    this.#pendingAuthorizationId = `authorization-${this.#authorizationCounter}`;

    const url = buildAuthorizeUrl({
      config: this.#config,
      state,
      codeChallenge: pkce.codeChallenge,
      environment: this.#environment,
    });

    let opened: boolean;
    try {
      opened = await this.#launcher.openExternally(url);
    } catch {
      opened = false;
    }

    if (!opened) {
      // Roll the record back: leaving it would age into a misleading "stale authorization"
      // diagnostic on the next attempt, blaming the host's link configuration for a launch that
      // never happened.
      await this.#clearPendingQuietly();
      return {
        type: 'failed',
        error: new TraciveError({
          kind: 'configuration',
          message:
            'The operating system declined to open the Tracive authorization URL. The app ' +
            'reported as installed but nothing claimed the `tracive` scheme.',
        }),
      };
    }

    return null;
  }

  /**
   * Completes the authorization the redirect in `url` belongs to, and says how it ended.
   *
   * Returns `null` when `url` is not addressed to this client's own redirect URI — "not mine",
   * which is neither a result nor an error, and nothing was touched. Hosts are encouraged to route
   * every incoming deep link through here, and most apps have several that have nothing to do with
   * Tracive; without the check, one of them would land as a `failed` result and be delivered to
   * `onAuthResult` as if a sign-in had gone wrong. A private-use scheme makes it worse, because any
   * app on the device may declare one and fire it.
   *
   * Ownership is decided on scheme, authority and path — everything a redirect registration fixes —
   * and deliberately errs towards accepting; see `redirectTarget`. It is not a security boundary
   * and is not asked to be one. `state` is compared immediately afterwards, and that is what
   * decides whether a code may be redeemed.
   */
  async handleCallback(url: string): Promise<AuthResult | null> {
    if (redirectTarget(url) !== redirectTarget(this.#config.redirectUri)) return null;

    const params = parseCallbackParameters(url);

    let pending: PendingAuthorization | undefined;
    try {
      pending = await this.#pendingStore.read();
    } catch (cause) {
      // Backed by the platform secure store in both adapters, and that genuinely rejects:
      // Keychain before first unlock, a SecureStore fault, a corrupted keystore. This method is
      // typed `Promise<AuthResult>` and callers treat it as total, so a store fault has to come
      // back as a result rather than as a rejection nobody is positioned to catch.
      return {
        type: 'failed',
        error:
          cause instanceof TraciveError
            ? cause
            : new TraciveError({
                kind: 'unknown',
                message: 'The pending authorization record could not be read.',
                cause,
              }),
      };
    }

    if (pending === undefined) {
      return {
        type: 'failed',
        error: new TraciveError({
          kind: 'stateMismatch',
          message: 'No authorization is in progress, so this redirect cannot be completed.',
        }),
      };
    }

    // The state is compared BEFORE `error` or `code` are read. An attacker-supplied redirect
    // must not be able to make the SDK act on its error message or its code.
    const returnedState = params.get('state') ?? '';
    if (!statesMatch(pending.state, returnedState)) {
      // The pending record is deliberately NOT cleared here. Any app on the device can hand yours a
      // URL, so erasing on a mismatch would let a stray or hostile redirect cancel the consent the
      // user is genuinely in the middle of, for the cost of one `openURL`. The attempt stays alive:
      // the real redirect still completes it, and an abandoned one is erased by the ten-minute
      // expiry above rather than by whoever shouted last.
      return {
        type: 'failed',
        error: new TraciveError({
          kind: 'stateMismatch',
          message: 'The authorization state did not match the one this SDK generated.',
        }),
      };
    }

    const ageSeconds = (this.#clock.nowMs() - pending.createdAtMs) / 1000;
    if (ageSeconds > this.#pendingMaxAgeSeconds) {
      await this.#clearPendingQuietly();
      this.#diagnose({
        code: 'pending_authorization_stale',
        severity: 'warning',
        message: `The authorization record was ${Math.round(ageSeconds)}s old when the redirect arrived.`,
        hint: STALE_PENDING_AUTHORIZATION_HINT,
      });
      return {
        type: 'failed',
        error: new TraciveError({
          kind: 'stateMismatch',
          message: 'The authorization attempt expired before the redirect arrived.',
        }),
      };
    }

    await this.#clearPendingQuietly();

    const error = params.get('error');
    if (error !== undefined && error !== '') {
      if (error === 'access_denied') return { type: 'denied' };
      return {
        type: 'failed',
        error: new TraciveError({
          kind: 'invalidRequest',
          message: params.get('error_description') ?? error,
          info: { code: error },
        }),
      };
    }

    const code = params.get('code');
    if (code === undefined || code === '') {
      return {
        type: 'failed',
        error: new TraciveError({
          kind: 'invalidRequest',
          message: 'The redirect carried neither an authorization code nor an error.',
        }),
      };
    }

    // A confidential client never sees a token: the partner's own backend completes the exchange
    // with its client secret, which must not ship inside a mobile app.
    if (this.#config.clientType === 'CONFIDENTIAL') {
      return codeReceived({
        code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
      });
    }

    // Captured before the exchange goes out, for the same reason the refresh path captures it: a
    // sign-out landing while the code is being exchanged has to win over the tokens that come
    // back. Storing them would hand the user a live grant they had already asked to be rid of.
    const epoch = this.#credentialEpoch;
    try {
      const tokens = await this.#exchange([
        ['grant_type', 'authorization_code'],
        ['code', code],
        ['redirect_uri', pending.redirectUri],
        ['client_id', this.#config.clientId],
        ['code_verifier', pending.codeVerifier],
      ]);
      if (epoch !== this.#credentialEpoch) {
        // `stateMismatch` is the kind this method already uses for every "there is no longer an
        // attempt this redirect can complete" — no authorization in progress, a state that did not
        // match, an attempt that expired. The grant being dropped mid-exchange is one more of
        // those. `info.code` is what tells the three apart in a log.
        return {
          type: 'failed',
          error: new TraciveError({
            kind: 'stateMismatch',
            message: 'The grant was dropped while the authorization was completing.',
            info: { code: 'authorization_cancelled' },
          }),
        };
      }
      await this.#tokenStore.write(tokens);
      return { type: 'authorized', grantedScopes: tokens.scopes };
    } catch (cause) {
      return {
        type: 'failed',
        error:
          cause instanceof TraciveError
            ? cause
            : new TraciveError({ kind: 'unknown', message: 'The token exchange failed.', cause }),
      };
    }
  }

  /**
   * The id of the authorization this instance is waiting on, or `undefined` when there is none.
   *
   * Read it once {@link authorize} has returned and hand it back to
   * {@link cancelPendingAuthorization} later. That is the only way a cancel can be sure of what it
   * is cancelling — see that method.
   */
  get pendingAuthorizationId(): string | undefined {
    return this.#pendingAuthorizationId;
  }

  /**
   * Abandons the pending authorization, so that nothing can complete it later.
   *
   * Call it when the flow ends without a redirect: the user came back with the system gesture, or
   * the screen that started the sign-in was dismissed. No redirect is coming in that case, and
   * without this the record sits in the store with a live PKCE verifier beside the `state` it
   * answers to until the ten-minute expiry reaches it. The host is the only party that can see
   * that happen — the SDK is not told that an app-to-app hop was abandoned.
   *
   * **Pass `authorizationId` whenever the caller can.** The signal comes from a screen or an
   * activity, not from the code that called {@link authorize}, and it can arrive late. Consider a
   * double tap: `authorize()` runs twice, the second supersedes the first, and only then does the
   * first screen's dismissal arrive. Cancelling unconditionally at that point kills the second
   * attempt — the one the user is looking at. With the id, a stale signal is recognised and
   * ignored.
   *
   * @param authorizationId the value {@link pendingAuthorizationId} held when the flow was
   *   launched. Omitting it cancels whatever is pending, which is right for a host that never has
   *   two authorizations in flight and is the hazard above for one that does.
   * @returns whether an authorization was abandoned. `false` means there was nothing pending, or
   *   that what is pending is not what `authorizationId` named.
   */
  async cancelPendingAuthorization(authorizationId?: string): Promise<boolean> {
    const current = this.#pendingAuthorizationId;
    if (authorizationId !== undefined && authorizationId !== current) return false;
    if (current === undefined) {
      // The store is consulted only when this instance has nothing of its own, which is the one
      // case where the answer cannot be known without looking: a record an earlier process left
      // behind. A read that fails is reported as absence — the caller has nothing to do with the
      // distinction, and a store that cannot be read is one the record will age out of anyway.
      let recovered: PendingAuthorization | undefined;
      try {
        recovered = await this.#pendingStore.read();
      } catch {
        recovered = undefined;
      }
      if (recovered === undefined) return false;
    }
    await this.#clearPendingQuietly();
    return true;
  }

  startLinkListener(): () => void {
    return startLinkListener(this.#linkSource, (url) => {
      void this.handleCallback(url)
        .then((result) => {
          // `null` means the link was not addressed to this client's redirect URI. Publishing it
          // would tell every subscriber that an authorization ended, for a link that has nothing
          // to do with Tracive.
          if (result !== null) this.#publish(result);
        })
        .catch((cause: unknown) => {
          // `handleCallback` is total, so nothing should reach here. It exists anyway because
          // the alternative is an unhandled rejection that drops the authorization result for
          // good: the user finishes signing in, comes back, and the app never hears about it.
          // On React Native that is a red box in development and near-silence in release.
          this.#publish({
            type: 'failed',
            error:
              cause instanceof TraciveError
                ? cause
                : new TraciveError({
                    kind: 'unknown',
                    message: 'The authorization redirect could not be processed.',
                    cause,
                  }),
          });
        });
    });
  }

  onAuthResult(listener: (result: AuthResult) => void): () => void {
    this.#listeners.add(listener);
    const buffered = this.#bufferedResult;
    if (buffered !== undefined) {
      this.#bufferedResult = undefined;
      // Through #deliver, because this happens BEFORE the unsubscribe closure is returned: a
      // listener that threw here used to leave itself registered with no way to remove it.
      this.#deliver(listener, buffered);
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * The stored access token, sent as it is. The stored expiry is NOT consulted.
   *
   * Renewal is driven by the server's answer and by nothing else: a 401 that is neither
   * `grant_revoked` nor `invalid_token` triggers one single-flight refresh and a replay of the
   * request. That path is mandatory whatever this method does — a token can be revoked
   * server-side, and one can expire between a local check and the send — so a proactive check on
   * top of it is a second mechanism doing one job. The redundant one is the more expensive
   * mistake of the two, because it always wins first: the 401 path then almost never runs in
   * production, and a bug in the mandatory mechanism sits there unexercised.
   *
   * It also rested on a clock this SDK does not own. A device running ten minutes fast reads
   * every token as expired and refreshes on every single call; against refresh-token rotation
   * with server-side reuse detection that is not merely wasteful, it is a stream of rotations,
   * and a stream of rotations is how a grant trips revocation and signs the user out.
   *
   * What the reactive-only shape costs is one wasted round trip per token lifetime, single-flighted
   * so only one caller pays it — and not a billed one, since authentication precedes billing and an
   * invalid bearer token is answered with a 401 before any credit is spent.
   *
   * `expiresAt` is still stored, still persisted and still readable on `TraciveTokens`. Only the
   * automatic behaviour is gone; see that field for what it is good for.
   */
  async ensureAccessToken(): Promise<string> {
    const tokens = await this.#tokenStore.read();
    if (tokens === undefined) {
      throw new TraciveError({
        kind: 'invalidToken',
        message: 'No Tracive grant is stored. Call authorize() first.',
      });
    }
    // A stored grant holding a blank access token is NOT the same case as no grant at all: the
    // refresh token beside it is the grant, and it is still good. The state is reachable through
    // `adoptTokens()`, which stores whatever a confidential client's backend handed back and
    // validates none of it, and from there into any persistent store, since `deserializeTokens`
    // asks only that the field be a string. Sending `Bearer ` would spend a round trip to be told
    // what is already known here. With no refresh token to spend, `refreshTokens()` throws
    // `invalidToken`, which is the right answer for a grant that cannot be renewed.
    //
    // BLANK, not empty. A token of spaces or a stray newline is exactly as unusable as `''` and
    // arrives the same way — a backend that built the field by concatenation, a value round-tripped
    // through a text column — but tested for emptiness it slips through and goes out as
    // `Bearer    `, which is the request this branch exists to prevent. The Kotlin SDK applies its
    // blank test here; this is the same rule.
    if (tokens.accessToken.trim() === '') {
      // The blank token itself is named as the stale one, not `''`. `#doRefresh` compares what it
      // reads from the store against this value to spot a caller that arrived after somebody
      // else's refresh; passing a token that was never stored makes every such caller look raced
      // and hand back the damaged grant it was sent here to repair.
      const refreshed = await this.refreshTokens({ staleAccessToken: tokens.accessToken });
      return refreshed.accessToken;
    }
    return tokens.accessToken;
  }

  /**
   * Single-flight. The latch is assigned with NO `await` between entry and assignment, so two
   * concurrent callers cannot both observe a null latch and both start a refresh. That shape is
   * the whole point: two simultaneous refreshes with the same rotating token look exactly like
   * token reuse to a server, and reuse detection revokes the grant.
   *
   * The latch answers the concurrent hazard only. The sequential one — a caller arriving after a
   * refresh that failed without ever hearing back, holding the same stored token — is answered by
   * the spent-token history in `#doRefresh`, and it has to be, because by then there is no latch
   * left to observe. Nothing is checked here: this method reads no store, so the only token it
   * could judge is one it has not looked up yet.
   */
  refreshTokens(options?: { staleAccessToken?: string }): Promise<TraciveTokens> {
    if (this.#inFlightRefresh !== null) return this.#inFlightRefresh;
    const inFlight = this.#doRefresh(options).finally(() => {
      // Only if this flight is still the one on the latch. `signOut` drops the latch so a caller
      // arriving afterwards does not join a flight that can no longer write; without this test,
      // that older flight's completion would then clear the latch belonging to the NEW flight, and
      // a third caller would start a second one alongside it. Two simultaneous refreshes with the
      // same rotating token look exactly like token reuse to a server, and reuse detection revokes
      // the grant.
      if (this.#inFlightRefresh === inFlight) this.#inFlightRefresh = null;
    });
    this.#inFlightRefresh = inFlight;
    return inFlight;
  }

  /** For confidential clients: hand a backend-obtained grant back for on-device use. */
  async adoptTokens(tokens: TraciveTokens): Promise<void> {
    await this.#tokenStore.write(redactedTokens(tokens));
  }

  /**
   * Drops the stored grant without contacting the server, and moves the credential epoch so that
   * a token round trip already on the wire cannot put one back.
   */
  async clearTokens(): Promise<void> {
    await this.#discardCredentials();
  }

  /**
   * Revokes the REFRESH token, not the access token: revoking one access token leaves the grant
   * alive and immediately re-issuable, which is not what a user pressing "sign out" means.
   * Local state is cleared regardless of what the server said — a sign-out that fails because
   * the network is down is not a sign-out a user would accept.
   *
   * Scope note: this clears the GRANT, not the check cache. A `CheckCache` is not something this
   * class holds or can reach. `TraciveClient.signOut()` clears both and is what a partner should
   * call; anyone driving this class directly owns their cache and has to empty it themselves, or
   * the departing user's verdicts stay readable on the device — a cached result needs no
   * credential to read.
   */
  async signOut(): Promise<void> {
    const tokens = await this.#tokenStore.read();
    const refreshToken = tokens?.refreshToken;

    // Everything that invalidates the grant happens HERE, before the revoke round trip. The epoch
    // move turns any token write already on the wire into a no-op, and the store is empty from
    // this point even if the revoke below hangs, fails, or the process is killed during it.
    // Clearing after the revoke instead left a live grant on the device for the whole duration of
    // a network call the method does not even require to succeed.
    await this.#discardCredentials();
    await this.#clearPendingQuietly();

    if (refreshToken !== undefined) {
      try {
        // Redacted at the seam: the body carries the refresh token, which is the whole grant.
        await this.#transport.send(
          redactedRequest({
            method: 'POST',
            url: apiUrl(this.#environment, TRACIVE_API_PATHS.revoke),
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              accept: 'application/json',
            },
            body: formUrlEncode([
              ['token', refreshToken],
              ['token_type_hint', 'refresh_token'],
              ['client_id', this.#config.clientId],
            ]),
          }),
        );
      } catch {
        // Best effort by design.
      }
    }
  }

  /**
   * Opens the install page, and reports a refusal rather than propagating it.
   *
   * Routed through the same {@link AuthorizeLauncher} as the authorize URL, not through `Linking`
   * directly, so a host that substituted its own launcher still owns both launches and a test can
   * observe this one.
   *
   * A refusal is deliberately NOT turned into `failed`. The Kotlin, Swift and Flutter SDKs all
   * open this link and return app-not-installed regardless of what the OS did, and a partner
   * porting an integration between them must not meet a different contract here. It is also the
   * honest answer: the app really is missing, and the partner shows the same "install Tracive
   * first, then try again" message either way.
   *
   * What it must not be is silent — the user would tap "install", nothing would happen, and there
   * would be nothing to act on. The siblings have no channel for that; this SDK does, so a
   * refusal goes out as a diagnostic naming `installUrlForDisplay()` as the one remaining move.
   */
  async #launchInstall(): Promise<void> {
    let opened: boolean;
    try {
      opened = await this.#launcher.openExternally(this.installUrlForDisplay());
    } catch {
      // `Linking.openURL` rejects rather than resolving false, and an injected launcher may do
      // the same. `authorize()` is typed as total, so a rejection cannot be allowed to escape.
      opened = false;
    }
    if (opened) return;
    this.#diagnose({
      code: 'install_link_launch_failed',
      severity: 'warning',
      message:
        'The Tracive app is not installed and the install page could not be opened, so the user ' +
        'was not sent anywhere.',
      hint:
        'The operating system declined to open the install link. Present it yourself with ' +
        'installUrlForDisplay() so the user still has somewhere to go.',
    });
  }

  /**
   * Throws away every credential this instance holds, and moves the epoch so that anything already
   * on the wire cannot put one back.
   *
   * The latch goes with it. A caller arriving after this must not join a flight whose write is
   * about to be refused — it would receive the refusal as its own answer, having asked for a
   * refresh that could still have succeeded.
   *
   * The spent-token history goes with it too. It is a fact about the grant being dropped here, and
   * the next authorization issues tokens that have nothing to do with it. Keeping the entries
   * would only leave a way for a brand-new grant to be refused for a resemblance to a dead one.
   * The epoch guard above is what protects the flight that is already on the wire: it cannot write
   * whatever it comes back with, so it does not need its marker kept for it.
   */
  async #discardCredentials(): Promise<void> {
    this.#credentialEpoch += 1;
    this.#inFlightRefresh = null;
    this.#spentRefreshTokens.length = 0;
    await this.#tokenStore.clear();
  }

  /**
   * Records `token` as handed to the server, evicting the oldest entry once the history is full.
   */
  #markRefreshTokenSpent(token: string): void {
    if (this.#spentRefreshTokens.includes(token)) return;
    this.#spentRefreshTokens.push(token);
    if (this.#spentRefreshTokens.length > SPENT_REFRESH_TOKEN_HISTORY) {
      this.#spentRefreshTokens.shift();
    }
  }

  /** Takes the marker back off `token`, for the one case that proves it was never consumed. */
  #releaseRefreshToken(token: string): void {
    const at = this.#spentRefreshTokens.indexOf(token);
    if (at >= 0) this.#spentRefreshTokens.splice(at, 1);
  }

  /**
   * Clearing the record is cleanup, not the outcome. A store that cannot clear must not turn an
   * authorization that otherwise succeeded into a failure; the stale record ages out on its own
   * and the next `authorize()` overwrites it.
   */
  async #clearPendingQuietly(): Promise<void> {
    // Dropped first and unconditionally. The id names an attempt this instance is waiting on, and
    // once the record is on its way out there is nothing left for a later cancel to name — even
    // if the store below refuses the erase.
    this.#pendingAuthorizationId = undefined;
    try {
      await this.#pendingStore.clear();
    } catch {
      this.#diagnose({
        code: 'pending_authorization_clear_failed',
        severity: 'warning',
        message: 'The pending authorization record could not be cleared.',
        hint:
          'The secure store rejected a write. The record ages out after ' +
          'pendingAuthorizationMaxAgeSeconds, so this is not fatal, but a store that cannot be ' +
          'written is worth investigating.',
      });
    }
  }

  #publish(result: AuthResult): void {
    if (this.#listeners.size === 0) {
      // Cold start: `getInitialURL()` resolves before the React tree has mounted anything that
      // would show this. One slot is buffered for the first subscriber, so the first
      // authorization after an install is not silently dropped.
      this.#bufferedResult = result;
      return;
    }
    for (const listener of this.#listeners) this.#deliver(listener, result);
  }

  /**
   * A listener throwing is the host app's bug. Losing the authorization result for every OTHER
   * listener because of it would be this SDK's, so the failure is isolated and reported rather
   * than propagated — and propagating it would land in `#publish`'s caller, which on the link
   * path is a promise chain nobody can catch.
   */
  #deliver(listener: (result: AuthResult) => void, result: AuthResult): void {
    try {
      listener(result);
    } catch (cause) {
      this.#diagnose({
        code: 'auth_result_listener_threw',
        severity: 'error',
        message: 'An onAuthResult listener threw; the remaining listeners were still called.',
        hint:
          'The error came from host-app code, not from the SDK: ' +
          (cause instanceof Error ? cause.message : String(cause)),
      });
    }
  }

  async #doRefresh(options?: { staleAccessToken?: string }): Promise<TraciveTokens> {
    const current = await this.#tokenStore.read();
    const refreshToken = current?.refreshToken;
    // A blank refresh token is no refresh token. It reaches the store the same way a blank access
    // token does, and the damaged-grant repair in `ensureAccessToken` now leads straight here, so
    // sending one would be a request that cannot succeed — and one that marks the value spent, so
    // a transport failure on it would refuse a grant that was never renewable in the first place.
    if (refreshToken === undefined || refreshToken.trim() === '') {
      throw new TraciveError({
        kind: 'invalidToken',
        message: 'There is no usable refresh token stored, so the grant cannot be renewed.',
      });
    }

    // Another caller may have refreshed while this one waited for the store.
    const stale = options?.staleAccessToken;
    if (stale !== undefined && current !== undefined && current.accessToken !== stale) {
      return current;
    }

    // The store still holds a token this instance has already presented, which means an earlier
    // refresh went out and never came back with an answer that would have replaced it. Sending it
    // is the one move that can cost the whole grant rather than one call, so it is refused here,
    // locally, without a request. See `#spentRefreshTokens`.
    if (this.#spentRefreshTokens.includes(refreshToken)) {
      throw new TraciveError({
        kind: 'invalidToken',
        message:
          'The stored refresh token has already been presented to the server, so it cannot be ' +
          'sent again. Authorize again.',
      });
    }

    const epoch = this.#credentialEpoch;

    // Marked BEFORE the request goes out, and what happens to the marker afterwards depends on
    // which of exactly two failures this turns out to be.
    //
    // A complete HTTP response settles the question whatever its status. A token endpoint that
    // answers with an error has issued no tokens (RFC 6749 section 5.2), so the refresh token was
    // not consumed and the marker comes back off below — without that, a single 500 would end the
    // grant permanently.
    //
    // No response at all settles nothing. A timeout or a dropped connection is indistinguishable
    // from a success whose reply was lost, so the server may already have rotated this token and
    // be waiting to see its replacement. The marker stays and the caller is told to authorize
    // again. That is the strictly better trade rather than merely the more cautious one: if the
    // token really was consumed, the grant needs re-authorization regardless, and holding the
    // marker is what keeps a retry from turning that into a revocation on top of it; if it was
    // not consumed, the whole cost is one consent the user did not strictly need. Retrying loses
    // in the first case and only draws in the second.
    //
    // A connect-phase or DNS failure would in principle prove the request never arrived, and its
    // marker could be released. It is deliberately NOT detected: the transport is an injectable
    // seam, so that error is whatever some other package chose to throw, and pattern-matching it
    // would make the ambiguous-versus-safe distinction this whole rule turns on depend on a guess.
    this.#markRefreshTokenSpent(refreshToken);

    let response: HttpResponse;
    try {
      response = await this.#postTokenRequest([
        ['grant_type', 'refresh_token'],
        ['refresh_token', refreshToken],
        ['client_id', this.#config.clientId],
      ]);
    } catch (cause) {
      throw new TraciveError({
        kind: 'invalidToken',
        message:
          'The refresh request failed before any answer arrived, so whether the refresh token ' +
          'was spent cannot be known. It will not be presented again. Authorize again.',
        cause,
      });
    }

    if (response.status < 200 || response.status >= 300) {
      this.#releaseRefreshToken(refreshToken);
    }

    let tokens: TraciveTokens;
    try {
      tokens = this.#decodeTokenResponse(response, refreshToken);
    } catch (error) {
      // A terminal answer means the grant is gone, so retrying can only produce more of the same.
      // Discard locally so the app asks for authorization instead of looping — and move the epoch
      // with it, so a second round trip already out cannot restore what the server just said is
      // finished.
      const terminal = terminalRefreshFailure(error);
      if (terminal !== null) {
        await this.#discardCredentials();
        throw terminal;
      }
      throw error;
    }

    // The token that went out is the token this grant keeps, either because the response omitted
    // `refresh_token` — "keep the one you have" — or because the server re-issued the identical
    // value. The mark set before the request has to come off in both cases: a 2xx does not release
    // it above, so leaving it would refuse the very NEXT refresh, locally, for a token the server
    // itself just handed back. That is not the hazard the marker exists for. It exists for a token
    // whose fate is unknown, and this one's fate is exactly what the server has answered.
    if (tokens.refreshToken === refreshToken) this.#releaseRefreshToken(refreshToken);

    // Outside the `try` deliberately. Thrown inside it, this would fall into the branch above and
    // discard a second time — dropping a latch that by then may belong to a NEWER flight, which is
    // how two concurrent refreshes start.
    if (epoch !== this.#credentialEpoch) {
      // The grant was dropped while this round trip was in flight. Writing now would undo a
      // sign-out the user has already been told succeeded, and would leave the ROTATED refresh
      // token — the newest and longest-lived one — on a device the user believes is signed out.
      // The refresh fails instead and the fresh pair is simply abandoned, which is what the
      // server's own rotation already assumes for a token that is never used.
      throw new TraciveError({
        kind: 'grantRevoked',
        message: 'The grant was dropped while the refresh was in flight.',
        info: { code: 'grant_revoked' },
      });
    }

    await this.#tokenStore.write(tokens);
    return tokens;
  }

  async #exchange(fields: readonly (readonly [string, string])[]): Promise<TraciveTokens> {
    return this.#decodeTokenResponse(await this.#postTokenRequest(fields));
  }

  /**
   * The round trip on its own, separated from decoding so that the refresh path can tell "the
   * server answered, with whatever status" from "nothing came back". Those two are the same
   * outcome to every other caller and are the entire question for a rotating refresh token; see
   * `#doRefresh`. `HttpTransport` throws only for a transport-level failure, which is what makes
   * the distinction readable here at all.
   */
  #postTokenRequest(fields: readonly (readonly [string, string])[]): Promise<HttpResponse> {
    // Redacted at the seam: this body carries the PKCE code verifier or the refresh token.
    return this.#transport.send(
      redactedRequest({
        method: 'POST',
        url: apiUrl(this.#environment, TRACIVE_API_PATHS.token),
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: formUrlEncode(fields),
      }),
    );
  }

  /**
   * @param previousRefreshToken the refresh token that was PRESENTED to obtain this response, when
   *   there was one. Only the refresh path has one; the code exchange does not, and there an absent
   *   `refresh_token` is genuinely absent rather than withheld.
   */
  #decodeTokenResponse(response: HttpResponse, previousRefreshToken?: string): TraciveTokens {
    const body = parseJsonBody(response.body) as TokenResponseBody;

    if (response.status < 200 || response.status >= 300) {
      throw traciveErrorFrom({
        status: response.status,
        ...(body.error !== undefined ? { code: body.error } : {}),
        ...(body.error_description !== undefined ? { message: body.error_description } : {}),
      });
    }

    const accessToken = body.access_token;
    // Blank counts as absent, for the same reason it does in `ensureAccessToken`: a token of
    // spaces cannot authenticate anything, so storing one only defers the failure to the next
    // request and makes it look like a rejection by the server rather than a malformed reply.
    if (typeof accessToken !== 'string' || accessToken.trim() === '') {
      throw new TraciveError({
        kind: 'server',
        status: response.status,
        message: 'The token response carried no access token.',
      });
    }

    // A refresh response is ALLOWED to carry no `refresh_token`, and RFC 6749 section 6 says what
    // that means: keep the one you have. Building the grant without it read the omission as "you no
    // longer have one" — so a fully conforming reply left this SDK unable to refresh again and sent
    // the user back through consent for a grant that never ended. The Flutter and Swift SDKs carry
    // the previous token forward here; this is the same rule.
    //
    // Blank counts as omitted, exactly as it does for the access token above. A refresh token of
    // spaces can renew nothing — `#doRefresh` refuses to present one — so accepting it as the
    // server's new credential would replace a working token with an unusable one.
    const issued = body.refresh_token;
    const refreshToken =
      typeof issued === 'string' && issued.trim() !== '' ? issued : previousRefreshToken;

    const expiresIn = body.expires_in;
    return redactedTokens({
      accessToken,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      tokenType: body.token_type ?? 'Bearer',
      ...(typeof expiresIn === 'number'
        ? { expiresAt: new Date(this.#clock.nowMs() + expiresIn * 1000) }
        : {}),
      scopes: typeof body.scope === 'string' && body.scope !== '' ? body.scope.split(' ') : [],
    });
  }

  #diagnose(diagnostic: Diagnostic): void {
    emitDiagnostic(this.#onDiagnostic, diagnostic);
  }
}

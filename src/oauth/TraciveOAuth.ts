import { apiUrl, formUrlEncode, TRACIVE_API_PATHS } from '../client/TraciveApi';
import { FetchHttpTransport, type HttpTransport } from '../client/HttpTransport';
import { systemClock, type TraciveClock } from '../client/TraciveClock';
import { defaultRandom, type TraciveRandom } from '../crypto/random';
import { emitDiagnostic, type Diagnostic, type DiagnosticSink } from '../diagnostics';
import {
  codeReceived,
  redactedTokens,
  type AuthResult,
  type TraciveTokens,
} from '../model/AuthResult';
import { TraciveEnvironment } from '../model/TraciveEnvironment';
import { TraciveError, traciveErrorFrom } from '../model/TraciveError';
import type { OAuthConfiguration } from '../model/TraciveMode';
import { LinkingAppPresenceProbe, type AppPresenceProbe } from './AppPresenceProbe';
import { LinkingAuthorizeLauncher, type AuthorizeLauncher } from './AuthorizeLauncher';
import {
  APP_PRESENCE_PROBE_URL,
  buildAuthorizeUrl,
  buildInstallUrl,
  DEFAULT_INSTALL_URL,
  parseCallbackParameters,
  TRACIVE_APP_SCHEME,
} from './authorizeUrl';
import { linkingLinkSource, startLinkListener, type LinkSource } from './linkListener';
import {
  InMemoryPendingAuthorizationStore,
  STALE_PENDING_AUTHORIZATION_HINT,
  type PendingAuthorizationStore,
} from './PendingAuthorization';
import { createPkcePair, createState, statesMatch } from './pkce';
import { InMemoryTokenStore, type TokenStore } from './TokenStore';

const TRACIVE_ANDROID_PACKAGE = 'com.pleistocent.tracive';

export interface TraciveOAuthOptions {
  readonly mode: OAuthConfiguration;
  readonly environment?: TraciveEnvironment;
  readonly transport?: HttpTransport;
  readonly tokenStore?: TokenStore;
  /**
   * Where the pending PKCE record is written before the authorize URL is opened. The default is
   * in-memory, which gives up the process-death guarantee; the Expo and bare adapters supply one
   * backed by the platform secure store.
   */
  readonly pendingStore?: PendingAuthorizationStore;
  readonly launcher?: AuthorizeLauncher;
  readonly presence?: AppPresenceProbe;
  readonly linkSource?: LinkSource;
  readonly clock?: TraciveClock;
  readonly random?: TraciveRandom;
  readonly installUrl?: string;
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

export class TraciveOAuth {
  static readonly traciveAppScheme = TRACIVE_APP_SCHEME;
  static readonly traciveAndroidPackage = TRACIVE_ANDROID_PACKAGE;
  static readonly appPresenceProbeUrl = APP_PRESENCE_PROBE_URL;
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

  constructor(options: TraciveOAuthOptions) {
    this.#config = options.mode;
    this.#environment = options.environment ?? TraciveEnvironment.production;
    this.#transport = options.transport ?? new FetchHttpTransport();
    this.#tokenStore = options.tokenStore ?? new InMemoryTokenStore();
    this.#pendingStore = options.pendingStore ?? new InMemoryPendingAuthorizationStore();
    this.#onDiagnostic = options.onDiagnostic;
    this.#presence =
      options.presence ??
      new LinkingAppPresenceProbe(
        options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic },
      );
    this.#launcher = options.launcher ?? new LinkingAuthorizeLauncher();
    this.#linkSource = options.linkSource ?? linkingLinkSource;
    this.#clock = options.clock ?? systemClock;
    this.#random = options.random ?? defaultRandom;
    this.#installUrl = options.installUrl ?? DEFAULT_INSTALL_URL;
    this.#pendingMaxAgeSeconds = options.pendingAuthorizationMaxAgeSeconds ?? 600;
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

  /** The install link the SDK opens when the app is absent. Carries attribution only. */
  installUrlForDisplay(): string {
    return buildInstallUrl(this.#installUrl, this.#config.clientId);
  }

  /**
   * Returns `null` when the flow was launched successfully: the outcome arrives later at
   * {@link handleCallback}, because an app-to-app hop can outlive this process.
   */
  async authorize(): Promise<AuthResult | null> {
    if (!(await this.#presence.isTraciveAppInstalled())) {
      return { type: 'appNotInstalled' };
    }

    const previous = await this.#pendingStore.read();
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
      await this.#pendingStore.clear();
    }

    const pkce = createPkcePair(this.#random);
    const state = createState(this.#random);

    // Written BEFORE the URL is opened. If the process dies during the hop, the record survives.
    await this.#pendingStore.write({
      state,
      codeVerifier: pkce.codeVerifier,
      redirectUri: this.#config.redirectUri,
      createdAtMs: this.#clock.nowMs(),
    });

    const url = buildAuthorizeUrl({
      config: this.#config,
      state,
      codeChallenge: pkce.codeChallenge,
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
      await this.#pendingStore.clear();
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

  async handleCallback(url: string): Promise<AuthResult> {
    const params = parseCallbackParameters(url);
    const pending = await this.#pendingStore.read();

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
      await this.#pendingStore.clear();
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
      await this.#pendingStore.clear();
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

    await this.#pendingStore.clear();

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

    try {
      const tokens = await this.#exchange([
        ['grant_type', 'authorization_code'],
        ['code', code],
        ['redirect_uri', pending.redirectUri],
        ['client_id', this.#config.clientId],
        ['code_verifier', pending.codeVerifier],
      ]);
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

  startLinkListener(): () => void {
    return startLinkListener(this.#linkSource, (url) => {
      void this.handleCallback(url).then((result) => {
        this.#publish(result);
      });
    });
  }

  onAuthResult(listener: (result: AuthResult) => void): () => void {
    this.#listeners.add(listener);
    const buffered = this.#bufferedResult;
    if (buffered !== undefined) {
      this.#bufferedResult = undefined;
      listener(buffered);
    }
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async ensureAccessToken(): Promise<string> {
    const tokens = await this.#tokenStore.read();
    if (tokens === undefined) {
      throw new TraciveError({
        kind: 'invalidToken',
        message: 'No Tracive grant is stored. Call authorize() first.',
      });
    }
    const expiresAt = tokens.expiresAt;
    if (expiresAt !== undefined && expiresAt.getTime() <= this.#clock.nowMs()) {
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
   */
  refreshTokens(options?: { staleAccessToken?: string }): Promise<TraciveTokens> {
    if (this.#inFlightRefresh !== null) return this.#inFlightRefresh;
    const inFlight = this.#doRefresh(options).finally(() => {
      this.#inFlightRefresh = null;
    });
    this.#inFlightRefresh = inFlight;
    return inFlight;
  }

  /** For confidential clients: hand a backend-obtained grant back for on-device use. */
  async adoptTokens(tokens: TraciveTokens): Promise<void> {
    await this.#tokenStore.write(redactedTokens(tokens));
  }

  async clearTokens(): Promise<void> {
    await this.#tokenStore.clear();
  }

  /**
   * Revokes the REFRESH token, not the access token: revoking one access token leaves the grant
   * alive and immediately re-issuable, which is not what a user pressing "sign out" means.
   * Local state is cleared regardless of what the server said — a sign-out that fails because
   * the network is down is not a sign-out a user would accept.
   */
  async signOut(): Promise<void> {
    const tokens = await this.#tokenStore.read();
    const refreshToken = tokens?.refreshToken;
    if (refreshToken !== undefined) {
      try {
        await this.#transport.send({
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
        });
      } catch {
        // Best effort by design.
      }
    }
    await this.#tokenStore.clear();
    await this.#pendingStore.clear();
  }

  #publish(result: AuthResult): void {
    if (this.#listeners.size === 0) {
      // Cold start: `getInitialURL()` resolves before the React tree has mounted anything that
      // would show this. One slot is buffered for the first subscriber, so the first
      // authorization after an install is not silently dropped.
      this.#bufferedResult = result;
      return;
    }
    for (const listener of this.#listeners) listener(result);
  }

  async #doRefresh(options?: { staleAccessToken?: string }): Promise<TraciveTokens> {
    const current = await this.#tokenStore.read();
    const refreshToken = current?.refreshToken;
    if (refreshToken === undefined) {
      throw new TraciveError({
        kind: 'invalidToken',
        message: 'There is no refresh token stored, so the grant cannot be renewed.',
      });
    }

    // Another caller may have refreshed while this one waited for the store.
    const stale = options?.staleAccessToken;
    if (stale !== undefined && current !== undefined && current.accessToken !== stale) {
      return current;
    }

    try {
      const tokens = await this.#exchange([
        ['grant_type', 'refresh_token'],
        ['refresh_token', refreshToken],
        ['client_id', this.#config.clientId],
      ]);
      await this.#tokenStore.write(tokens);
      return tokens;
    } catch (error) {
      // `grant_revoked` is terminal: the grant is gone, so retrying can only produce more of the
      // same. Clear locally so the app asks for authorization instead of looping.
      if (error instanceof TraciveError && error.kind === 'grantRevoked') {
        await this.#tokenStore.clear();
      }
      throw error;
    }
  }

  async #exchange(fields: readonly (readonly [string, string])[]): Promise<TraciveTokens> {
    const response = await this.#transport.send({
      method: 'POST',
      url: apiUrl(this.#environment, TRACIVE_API_PATHS.token),
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: formUrlEncode(fields),
    });

    const body = parseJsonBody(response.body) as TokenResponseBody;

    if (response.status < 200 || response.status >= 300) {
      throw traciveErrorFrom({
        status: response.status,
        ...(body.error !== undefined ? { code: body.error } : {}),
        ...(body.error_description !== undefined ? { message: body.error_description } : {}),
      });
    }

    const accessToken = body.access_token;
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new TraciveError({
        kind: 'server',
        status: response.status,
        message: 'The token response carried no access token.',
      });
    }

    const expiresIn = body.expires_in;
    return redactedTokens({
      accessToken,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
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

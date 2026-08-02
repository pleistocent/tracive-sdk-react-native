import { describe, expect, it } from '@jest/globals';

import {
  completed,
  FakeClock,
  FakeTransport,
  fixedRandom,
  jsonResponse,
} from '../../__tests__/support/fakes';
import type { Diagnostic } from '../../diagnostics';
import {
  isTraciveConfigurationError,
  TraciveConfigurationError,
} from '../../model/TraciveConfigurationError';
import type { OAuthConfiguration } from '../../model/TraciveMode';
import {
  buildInstallUrl,
  DEFAULT_INSTALL_URL,
  parseCallbackParameters,
  parseQueryParameters,
} from '../authorizeUrl';
import {
  InMemoryPendingAuthorizationStore,
  type PendingAuthorization,
  type PendingAuthorizationStore,
} from '../PendingAuthorization';
import { TraciveEnvironment } from '../../model/TraciveEnvironment';
import { TraciveOAuth } from '../TraciveOAuth';

const CONFIG: OAuthConfiguration = {
  clientId: 'partner-app',
  redirectUri: 'https://your.app/oauth/callback',
  partnerUserId: 'partner-user-1',
};

/** Records the exact order of pending-store writes relative to the launch. */
class RecordingPendingStore implements PendingAuthorizationStore {
  readonly events: string[] = [];
  #pending: PendingAuthorization | undefined;

  read(): Promise<PendingAuthorization | undefined> {
    return Promise.resolve(this.#pending);
  }

  write(pending: PendingAuthorization): Promise<void> {
    this.events.push('write');
    this.#pending = pending;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.events.push('clear');
    this.#pending = undefined;
    return Promise.resolve();
  }
}

function build(options?: {
  installed?: boolean;
  opens?: boolean;
  /** A launcher that REJECTS rather than resolving false — `Linking.openURL` does exactly that. */
  throwsOnOpen?: boolean;
  clock?: FakeClock;
  pendingStore?: PendingAuthorizationStore;
  installUrl?: string;
  maxAgeSeconds?: number;
  onDiagnostic?: (diagnostic: Diagnostic) => void;
}): {
  oauth: TraciveOAuth;
  transport: FakeTransport;
  opened: string[];
  pendingStore: PendingAuthorizationStore;
} {
  const transport = new FakeTransport();
  const opened: string[] = [];
  const pendingStore = options?.pendingStore ?? new InMemoryPendingAuthorizationStore();
  const oauth = new TraciveOAuth({
    mode: CONFIG,
    transport,
    clock: options?.clock ?? new FakeClock(),
    random: fixedRandom(),
    pendingStore,
    presence: {
      isTraciveAppInstalled: () => Promise.resolve(options?.installed ?? true),
    },
    launcher: {
      openExternally: (url) => {
        opened.push(url);
        if (options?.throwsOnOpen === true) return Promise.reject(new Error('no handler'));
        return Promise.resolve(options?.opens ?? true);
      },
    },
    ...(options?.installUrl !== undefined ? { installUrl: options.installUrl } : {}),
    ...(options?.maxAgeSeconds !== undefined
      ? { pendingAuthorizationMaxAgeSeconds: options.maxAgeSeconds }
      : {}),
    ...(options?.onDiagnostic !== undefined ? { onDiagnostic: options.onDiagnostic } : {}),
  });
  return { oauth, transport, opened, pendingStore };
}

describe('authorize()', () => {
  it('returns null after launching, because the outcome arrives at handleCallback', async () => {
    const { oauth, opened } = build();
    expect(await oauth.authorize()).toBeNull();
    expect(opened).toHaveLength(1);
    // The origin, not just the path. This assertion used to read
    // `tracive://authorize?`, a custom-scheme URL no Tracive build registers —
    // the app claims `https://tracive.id/oauth/authorize` as an App Link, and
    // registers custom-scheme hosts `home`, `auth`, `search`, `report` and
    // `dev-tools` only. Opening the old URL did nothing at all, and this test
    // agreed with it, so nothing in this repository could have caught it.
    expect(opened[0]).toContain('https://tracive.id/oauth/authorize?');
  });

  it('persists the pending record BEFORE the URL is opened', async () => {
    // If the process dies during the app-to-app hop, a record written afterwards would not exist.
    const pendingStore = new RecordingPendingStore();
    const order: string[] = [];
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport: new FakeTransport(),
      clock: new FakeClock(),
      random: fixedRandom(),
      pendingStore,
      presence: { isTraciveAppInstalled: () => Promise.resolve(true) },
      launcher: {
        openExternally: () => {
          order.push('open');
          return Promise.resolve(true);
        },
      },
    });
    const originalWrite = pendingStore.write.bind(pendingStore);
    pendingStore.write = (pending) => {
      order.push('write');
      return originalWrite(pending);
    };

    await oauth.authorize();
    expect(order).toEqual(['write', 'open']);
  });

  it('rolls the pending record back when the launch is refused', async () => {
    const pendingStore = new RecordingPendingStore();
    const { oauth } = build({ opens: false, pendingStore });
    const result = await oauth.authorize();

    expect(result?.type).toBe('failed');
    expect(await pendingStore.read()).toBeUndefined();
    // Leaving the record would age into a misleading "stale authorization" diagnostic that
    // blames the host's link configuration for a launch that never happened.
    expect(pendingStore.events[pendingStore.events.length - 1]).toBe('clear');
  });

  it('opens the install link itself and reports appNotInstalled', async () => {
    const { oauth, opened, pendingStore, transport } = build({ installed: false });

    expect((await oauth.authorize())?.type).toBe('appNotInstalled');

    // The SDK opens the link rather than leaving that to the partner. All three sibling SDKs do,
    // and a partner porting an integration between them must not silently get a different flow —
    // here it would mean the user is never sent anywhere at all.
    expect(opened).toEqual([
      'https://tracive.chottu.link/install?ref=partner-app&utm_source=tracive-sdk-react-native',
    ]);
    // And no OAuth flow was started: no authorize URL, no pending record, nothing on the wire.
    expect(opened[0]).not.toContain('tracive://authorize');
    expect(await pendingStore.read()).toBeUndefined();
    expect(transport.requests).toHaveLength(0);
  });

  it('still reports appNotInstalled when the OS refuses the install link', async () => {
    const diagnostics: Diagnostic[] = [];
    const { oauth, opened, pendingStore } = build({
      installed: false,
      opens: false,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    // NOT `failed`. The siblings return app-not-installed whatever the OS did, and it is also the
    // honest answer: the app really is missing, and the partner shows the same "install Tracive
    // first" message either way.
    expect((await oauth.authorize())?.type).toBe('appNotInstalled');
    expect(opened).toHaveLength(1);
    expect(await pendingStore.read()).toBeUndefined();
    // A refused launch is still not allowed to be silent — the user would tap "install" and watch
    // nothing happen, which is the one outcome nobody can act on.
    const refused = diagnostics.find((d) => d.code === 'install_link_launch_failed');
    expect(refused).toBeDefined();
    expect(refused?.hint).toContain('installUrlForDisplay');
  });

  it('still reports appNotInstalled when the launcher rejects', async () => {
    // `Linking.openURL` rejects rather than resolving false, and a host may substitute a launcher
    // that does the same. A rejection here must not escape a method typed as total.
    const diagnostics: Diagnostic[] = [];
    const { oauth } = build({
      installed: false,
      throwsOnOpen: true,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect((await oauth.authorize())?.type).toBe('appNotInstalled');
    expect(diagnostics.map((d) => d.code)).toContain('install_link_launch_failed');
  });

  it('opens a configured install URL rather than the default', async () => {
    const { oauth, opened } = build({
      installed: false,
      installUrl: 'https://install.example/app?campaign=spring',
    });
    await oauth.authorize();
    expect(opened).toEqual([
      'https://install.example/app?campaign=spring&ref=partner-app' +
        '&utm_source=tracive-sdk-react-native',
    ]);
  });

  it('emits the three-cause diagnostic when it finds a stale record', async () => {
    const diagnostics: Diagnostic[] = [];
    const clock = new FakeClock();
    const { oauth } = build({
      clock,
      maxAgeSeconds: 600,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await oauth.authorize();
    clock.advance(601 * 1000);
    await oauth.authorize();

    const stale = diagnostics.find((d) => d.code === 'pending_authorization_stale');
    expect(stale).toBeDefined();
    expect(stale?.hint).toContain('asset-links');
    expect(stale?.hint).toContain('intent-filter');
    expect(stale?.hint).toContain('cold start');
  });
});

/** Every OAuth parameter name that must never reach a third-party link service. */
const FORBIDDEN_ON_THE_INSTALL_LINK = [
  'code',
  'state',
  'code_challenge',
  'code_challenge_method',
  'code_verifier',
  'client_id',
  'client_secret',
  'redirect_uri',
  'response_type',
  'scope',
  'partner_user_id',
  'access_token',
  'refresh_token',
  'id_token',
  'nonce',
  'api_key',
];

describe('the install URL', () => {
  it('is the exact URL the sibling SDKs open, in full', () => {
    expect(buildInstallUrl(DEFAULT_INSTALL_URL, 'partner-app')).toBe(
      'https://tracive.chottu.link/install?ref=partner-app&utm_source=tracive-sdk-react-native',
    );
  });

  it('carries attribution and NO OAuth parameter', () => {
    const url = buildInstallUrl(DEFAULT_INSTALL_URL, 'partner-app');
    const params = parseQueryParameters(url.split('?')[1] ?? '');
    // `ref` is the PARTNER's client id. It is never an end user's identifier.
    expect(params.get('ref')).toBe('partner-app');
    expect(params.get('utm_source')).toBe('tracive-sdk-react-native');
    expect([...params.keys()].sort()).toEqual(['ref', 'utm_source']);
    for (const forbidden of FORBIDDEN_ON_THE_INSTALL_LINK) {
      expect([...params.keys()]).not.toContain(forbidden);
    }
  });

  it('omits ref rather than sending an empty one', () => {
    expect(buildInstallUrl(DEFAULT_INSTALL_URL, '')).toBe(
      'https://tracive.chottu.link/install?utm_source=tracive-sdk-react-native',
    );
    expect(buildInstallUrl(DEFAULT_INSTALL_URL, undefined)).toBe(
      'https://tracive.chottu.link/install?utm_source=tracive-sdk-react-native',
    );
  });

  it('strips OAuth parameters already present on a misconfigured constant', () => {
    // Trusted, they would park a live verifier on a public marketing URL.
    const url = buildInstallUrl(
      'https://install.example/app?code=leaked&state=leaked&code_verifier=leaked' +
        '&partner_user_id=leaked&redirect_uri=leaked&scope=leaked&campaign=spring',
      'partner-app',
    );
    const params = parseQueryParameters(url.split('?')[1] ?? '');
    for (const forbidden of FORBIDDEN_ON_THE_INSTALL_LINK) {
      expect([...params.keys()]).not.toContain(forbidden);
    }
    // A non-attribution parameter the partner set on purpose survives.
    expect(params.get('campaign')).toBe('spring');
    expect(url).not.toContain('leaked');
  });

  it('is what installUrlForDisplay() hands the caller by default', () => {
    const { oauth } = build({ installed: false });
    expect(oauth.installUrlForDisplay()).toBe(
      'https://tracive.chottu.link/install?ref=partner-app&utm_source=tracive-sdk-react-native',
    );
  });

  it('is the same link authorize() opens, so the two cannot drift apart', async () => {
    // A partner that renders the link and a user the SDK sends out must land on the same page.
    const { oauth, opened } = build({ installed: false });
    await oauth.authorize();
    expect(opened).toEqual([oauth.installUrlForDisplay()]);
  });

  /**
   * A blank override is the one case where falling back to the default is tempting, and it is the
   * one case where doing so is worst: the partner set the option, so something in their build
   * produced an empty value, and quietly sending their users to Tracive's own install page hides
   * that at the exact moment the SDK has nothing else to offer an un-onboarded user.
   *
   * Every Tracive SDK refuses it under the same `blank_install_url` name. This one refuses at
   * construction rather than at the launch: the launch happens only for a user without the Tracive
   * app, only after a real authorize() call, and its one signal is an optional diagnostic. A throw
   * the first time the object is built cannot be missed by anyone.
   */
  it('refuses a blank override rather than silently substituting the default', () => {
    expect(() => build({ installUrl: '' })).toThrow(TraciveConfigurationError);
    expect(() => build({ installUrl: '' })).toThrow(/blank/i);

    try {
      build({ installUrl: '' });
    } catch (error) {
      expect(isTraciveConfigurationError(error)).toBe(true);
      expect((error as TraciveConfigurationError).code).toBe('blank_install_url');
      // The default must not appear in the remedy: the point is that it is NOT what a blank
      // value means, and a message offering it invites pasting it back in.
      expect((error as TraciveConfigurationError).message).not.toContain(DEFAULT_INSTALL_URL);
    }
  });

  it('refuses a whitespace-only override for the same reason', () => {
    // `'  '` is an empty value that survived a trim somewhere, not a URL anyone chose.
    expect(() => build({ installUrl: '   ' })).toThrow(TraciveConfigurationError);
  });

  it('still takes the default when the override is simply absent', () => {
    // The refusal above is about a blank value, not about defaulting. Omitting the option is a
    // deliberate "use yours" and must keep working.
    const { oauth } = build({});
    expect(oauth.installUrlForDisplay()).toBe(
      'https://tracive.chottu.link/install?ref=partner-app&utm_source=tracive-sdk-react-native',
    );
  });

  it('does not duplicate attribution when the URL already has some', () => {
    const url = buildInstallUrl(
      'https://install.example/app?ref=old&utm_source=old&utm_medium=old',
      'partner-app',
    );
    expect(url).toBe(
      'https://install.example/app?ref=partner-app&utm_source=tracive-sdk-react-native',
    );
    expect(url.match(/ref=/g)).toHaveLength(1);
    expect(url.match(/utm_source=/g)).toHaveLength(1);
  });
});

describe('handleCallback()', () => {
  async function launched(options?: Parameters<typeof build>[0]): Promise<{
    oauth: TraciveOAuth;
    transport: FakeTransport;
    state: string;
  }> {
    const { oauth, transport, opened } = build(options);
    await oauth.authorize();
    const state = parseCallbackParameters(opened[0] ?? '').get('state') ?? '';
    return { oauth, transport, state };
  }

  it('exchanges the code and stores the grant for a public client', async () => {
    const { oauth, transport, state } = await launched();
    transport.enqueue(
      jsonResponse(200, {
        access_token: 'at',
        refresh_token: 'rt',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'checks:read profile:read',
      }),
    );
    const result = await completed(
      oauth.handleCallback(
        `https://your.app/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(result.type).toBe('authorized');
    if (result.type === 'authorized') {
      expect(result.grantedScopes).toEqual(['checks:read', 'profile:read']);
    }
    expect(await oauth.isAuthorized()).toBe(true);
  });

  it('stops at the code for a confidential client and never sees a token', async () => {
    const transport = new FakeTransport();
    const opened: string[] = [];
    const oauth = new TraciveOAuth({
      mode: { ...CONFIG, clientType: 'CONFIDENTIAL' },
      transport,
      clock: new FakeClock(),
      random: fixedRandom(),
      presence: { isTraciveAppInstalled: () => Promise.resolve(true) },
      launcher: {
        openExternally: (url) => {
          opened.push(url);
          return Promise.resolve(true);
        },
      },
    });
    await oauth.authorize();
    const state = parseCallbackParameters(opened[0] ?? '').get('state') ?? '';
    const result = await completed(
      oauth.handleCallback(
        `https://your.app/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
      ),
    );

    expect(result.type).toBe('codeReceived');
    expect(transport.requests).toHaveLength(0);
    expect(await oauth.isAuthorized()).toBe(false);
  });

  it('reports a denial', async () => {
    const { oauth, state } = await launched();
    const result = await completed(
      oauth.handleCallback(
        `https://your.app/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(result.type).toBe('denied');
  });

  it('reports a non-denial error without exchanging', async () => {
    const { oauth, transport, state } = await launched();
    const result = await completed(
      oauth.handleCallback(
        `https://your.app/oauth/callback?error=server_error&error_description=boom&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(result.type).toBe('failed');
    if (result.type === 'failed') expect(result.error.serverCode).toBe('server_error');
    expect(transport.requests).toHaveLength(0);
  });

  it('fails when no authorization is in progress', async () => {
    const { oauth } = build();
    const result = await completed(
      oauth.handleCallback('https://your.app/oauth/callback?code=x&state=y'),
    );
    expect(result.type).toBe('failed');
    if (result.type === 'failed') expect(result.error.kind).toBe('stateMismatch');
  });

  /**
   * Hosts are told to route every incoming deep link through here, and most apps have several that
   * have nothing to do with Tracive. A link that is not this client's redirect is not a failed
   * sign-in and must not be reported as one.
   */
  describe('a URL that is not this client’s redirect', () => {
    const FOREIGN = [
      'myapp://payment/done?code=abc&state=xyz',
      'https://someone.else/oauth/callback?code=abc&state=xyz',
      'https://your.app/other/path?code=abc&state=xyz',
    ];

    it.each(FOREIGN)('answers null for %s', async (url) => {
      const { oauth } = await launched();
      expect(await oauth.handleCallback(url)).toBeNull();
    });

    it('leaves the attempt intact, so the genuine redirect still completes', async () => {
      const { oauth, transport, state } = await launched();

      expect(await oauth.handleCallback('myapp://payment/done?code=attacker-code')).toBeNull();
      expect(transport.requests).toHaveLength(0);

      transport.enqueue(jsonResponse(200, { access_token: 'at', token_type: 'Bearer' }));
      const result = await completed(
        oauth.handleCallback(
          `https://your.app/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
        ),
      );
      expect(result.type).toBe('authorized');
    });

    /**
     * Ownership errs towards accepting on purpose: scheme and host are case-insensitive, and a
     * browser adds a trailing slash where a registration usually does not carry one. Refusing
     * either would strand a user who really did sign in, and `state` is still what decides whether
     * the code may be redeemed.
     */
    it('still recognises the redirect through a browser’s cosmetic changes', async () => {
      const { oauth, transport, state } = await launched();
      transport.enqueue(jsonResponse(200, { access_token: 'at', token_type: 'Bearer' }));
      const result = await completed(
        oauth.handleCallback(
          `HTTPS://YOUR.APP/oauth/callback/?code=abc&state=${encodeURIComponent(state)}`,
        ),
      );
      expect(result.type).toBe('authorized');
    });
  });

  it('fails when the record aged out before the redirect arrived', async () => {
    const clock = new FakeClock();
    const diagnostics: Diagnostic[] = [];
    const { oauth, transport, opened } = build({
      clock,
      maxAgeSeconds: 60,
      onDiagnostic: (d) => diagnostics.push(d),
    });
    await oauth.authorize();
    const state = parseCallbackParameters(opened[0] ?? '').get('state') ?? '';
    clock.advance(61 * 1000);

    const result = await completed(
      oauth.handleCallback(
        `https://your.app/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(result.type).toBe('failed');
    expect(transport.requests).toHaveLength(0);
    expect(diagnostics.some((d) => d.code === 'pending_authorization_stale')).toBe(true);
  });
});

describe('signOut()', () => {
  it('revokes the refresh token and clears locally even when revocation fails', async () => {
    const { oauth, transport, state } = await (async () => {
      const built = build();
      await built.oauth.authorize();
      const s = parseCallbackParameters(built.opened[0] ?? '').get('state') ?? '';
      return { ...built, state: s };
    })();

    transport.enqueue(
      jsonResponse(200, { access_token: 'at', refresh_token: 'rt', token_type: 'Bearer' }),
    );
    await completed(
      oauth.handleCallback(
        `https://your.app/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
      ),
    );
    expect(await oauth.isAuthorized()).toBe(true);

    transport.enqueue(new Error('offline'));
    await oauth.signOut();

    const revoke = transport.lastRequest;
    expect(revoke?.url).toContain('/oauth/revoke');
    const body = parseQueryParameters(revoke?.body ?? '');
    // The REFRESH token is revoked: revoking one access token leaves the grant re-issuable.
    expect(body.get('token')).toBe('rt');
    expect(body.get('token_type_hint')).toBe('refresh_token');
    expect(await oauth.isAuthorized()).toBe(false);
  });
});

describe('the SDK constants', () => {
  it('matches the sibling SDKs', () => {
    expect(TraciveOAuth.traciveAppScheme).toBe('tracive');
    expect(TraciveOAuth.traciveAndroidPackage).toBe('com.pleistocent.tracive');
    expect(TraciveOAuth.defaultInstallUrl).toBe('https://tracive.chottu.link/install');
  });

  it('refuses a blank partnerUserId, in every form', () => {
    // TypeScript makes the field required, which is worth nothing to a JavaScript caller or to a
    // value that arrived from a form or a config file. Left unchecked it went out as
    // `partner_user_id=`, which the Tracive app rejects client-side with no redirect — so the
    // partner app receives nothing at all. Kotlin, Swift and Flutter all reject at construction.
    for (const blank of ['', '   ', '\t\n']) {
      expect(
        () =>
          new TraciveOAuth({
            mode: { clientId: 'c', redirectUri: 'https://p.test/cb', partnerUserId: blank },
          }),
      ).toThrow(TraciveConfigurationError);
    }
  });

  it('probes the bare scheme, and the sandbox one in sandbox', () => {
    // This assertion used to read `tracive://authorize`, under a test named
    // "matches the sibling SDKs" — and no sibling used it. Kotlin checks the package id, Swift
    // probes the bare scheme. Android resolves a probe by intent-filter matching and the app
    // registers no custom-scheme host named `authorize`, so the old probe answered
    // "not installed" on every Android device, including the ones holding the app.
    expect(TraciveOAuth.appPresenceProbeUrl(TraciveEnvironment.production)).toBe('tracive://');
    expect(TraciveOAuth.appPresenceProbeUrl(TraciveEnvironment.sandbox)).toBe('tracivedev://');
    // A custom base URL is a partner proxy; the app on the device is still the production one.
    expect(TraciveOAuth.appPresenceProbeUrl(TraciveEnvironment.custom('https://p.test/v1'))).toBe(
      'tracive://',
    );
  });
});

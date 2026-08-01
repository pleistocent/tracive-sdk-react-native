import { describe, expect, it } from '@jest/globals';

import { FakeClock, FakeTransport, fixedRandom, jsonResponse } from '../../__tests__/support/fakes';
import type { Diagnostic } from '../../diagnostics';
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
import { TraciveOAuth } from '../TraciveOAuth';

const CONFIG: OAuthConfiguration = {
  clientId: 'partner-app',
  redirectUri: 'https://your.app/oauth/callback',
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
    expect(opened[0]).toContain('tracive://authorize?');
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

  it('reports appNotInstalled without launching anything', async () => {
    const { oauth, opened, pendingStore } = build({ installed: false });
    expect((await oauth.authorize())?.type).toBe('appNotInstalled');
    expect(opened).toHaveLength(0);
    expect(await pendingStore.read()).toBeUndefined();
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
    const result = await oauth.handleCallback(
      `https://your.app/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
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
    const result = await oauth.handleCallback(
      `https://your.app/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
    );

    expect(result.type).toBe('codeReceived');
    expect(transport.requests).toHaveLength(0);
    expect(await oauth.isAuthorized()).toBe(false);
  });

  it('reports a denial', async () => {
    const { oauth, state } = await launched();
    const result = await oauth.handleCallback(
      `https://your.app/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );
    expect(result.type).toBe('denied');
  });

  it('reports a non-denial error without exchanging', async () => {
    const { oauth, transport, state } = await launched();
    const result = await oauth.handleCallback(
      `https://your.app/oauth/callback?error=server_error&error_description=boom&state=${encodeURIComponent(state)}`,
    );
    expect(result.type).toBe('failed');
    if (result.type === 'failed') expect(result.error.serverCode).toBe('server_error');
    expect(transport.requests).toHaveLength(0);
  });

  it('fails when no authorization is in progress', async () => {
    const { oauth } = build();
    const result = await oauth.handleCallback('https://your.app/oauth/callback?code=x&state=y');
    expect(result.type).toBe('failed');
    if (result.type === 'failed') expect(result.error.kind).toBe('stateMismatch');
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

    const result = await oauth.handleCallback(
      `https://your.app/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
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
    await oauth.handleCallback(
      `https://your.app/oauth/callback?code=abc&state=${encodeURIComponent(state)}`,
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
    expect(TraciveOAuth.appPresenceProbeUrl).toBe('tracive://authorize');
    expect(TraciveOAuth.defaultInstallUrl).toBe('https://tracive.chottu.link/install');
  });
});

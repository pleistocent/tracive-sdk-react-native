import { describe, expect, it } from '@jest/globals';

import {
  completed,
  FakeClock,
  FakeTransport,
  fixedRandom,
  jsonResponse,
} from '../../__tests__/support/fakes';
import type { OAuthConfiguration } from '../../model/TraciveMode';
import { parseCallbackParameters, parseQueryParameters } from '../authorizeUrl';
import {
  deserializePendingAuthorization,
  InMemoryPendingAuthorizationStore,
  serializePendingAuthorization,
  type PendingAuthorization,
  type PendingAuthorizationStore,
} from '../PendingAuthorization';
import { TraciveOAuth } from '../TraciveOAuth';

const CONFIG: OAuthConfiguration = {
  clientId: 'partner-app',
  redirectUri: 'https://your.app/oauth/callback',
  partnerUserId: 'partner-user-1',
};

/**
 * Storage that outlives the object holding it. That is the whole of what separates the secure-store
 * adapters from the in-memory default, so it is the whole of what these tests need to model.
 */
interface Device {
  slot: string | undefined;
}

function newDevice(): Device {
  return { slot: undefined };
}

/**
 * A store on the {@link Device} above. It keeps a serialised string rather than the record itself,
 * so the round trip goes through the same two helpers both shipped adapters call — a record that
 * survived here would survive a keychain too.
 */
class PersistentPendingStore implements PendingAuthorizationStore {
  readonly #device: Device;

  constructor(device: Device) {
    this.#device = device;
  }

  read(): Promise<PendingAuthorization | undefined> {
    const raw = this.#device.slot;
    return Promise.resolve(raw === undefined ? undefined : deserializePendingAuthorization(raw));
  }

  write(pending: PendingAuthorization): Promise<void> {
    this.#device.slot = serializePendingAuthorization(pending);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#device.slot = undefined;
    return Promise.resolve();
  }
}

interface Session {
  oauth: TraciveOAuth;
  transport: FakeTransport;
  opened: string[];
}

/**
 * One process lifetime.
 *
 * The store and the clock are passed IN rather than built here, so calling this twice models a
 * restart: a brand-new `TraciveOAuth` over storage and a clock that outlived the previous one.
 * Omitting `pendingStore` takes the SDK's own default, which is what pins it.
 */
function session(options: {
  pendingStore?: PendingAuthorizationStore;
  clock: FakeClock;
  maxAgeSeconds?: number;
  confidential?: boolean;
}): Session {
  const transport = new FakeTransport();
  const opened: string[] = [];
  const oauth = new TraciveOAuth({
    mode: options.confidential === true ? { ...CONFIG, clientType: 'CONFIDENTIAL' } : CONFIG,
    transport,
    clock: options.clock,
    random: fixedRandom(),
    presence: { isTraciveAppInstalled: () => Promise.resolve(true) },
    launcher: {
      openExternally: (url) => {
        opened.push(url);
        return Promise.resolve(true);
      },
    },
    ...(options.pendingStore !== undefined ? { pendingStore: options.pendingStore } : {}),
    ...(options.maxAgeSeconds !== undefined
      ? { pendingAuthorizationMaxAgeSeconds: options.maxAgeSeconds }
      : {}),
  });
  return { oauth, transport, opened };
}

function stateOf(url: string): string {
  return parseCallbackParameters(url).get('state') ?? '';
}

function redirect(params: string, state: string): string {
  return `https://your.app/oauth/callback?${params}&state=${encodeURIComponent(state)}`;
}

function grantResponse(): ReturnType<typeof jsonResponse> {
  return jsonResponse(200, {
    access_token: 'at',
    refresh_token: 'rt',
    token_type: 'Bearer',
    expires_in: 3600,
    scope: 'scammer.check',
  });
}

describe('a pending authorization across a process restart', () => {
  /**
   * The reason the record exists at all. Consent happens in the Tracive app, so the host process is
   * backgrounded for its whole duration, and on Android that is when the OS reclaims it.
   */
  it('survives when the store is persistent', async () => {
    const device = newDevice();
    const clock = new FakeClock();

    const before = session({ pendingStore: new PersistentPendingStore(device), clock });
    expect(await before.oauth.authorize()).toBeNull();
    const state = stateOf(before.opened[0] ?? '');
    expect(device.slot).toBeDefined();

    // The process dies here. Everything the first TraciveOAuth held is gone with it; the second one
    // starts from nothing but what reached storage.
    const after = session({ pendingStore: new PersistentPendingStore(device), clock });
    after.transport.enqueue(grantResponse());

    const result = await completed(after.oauth.handleCallback(redirect('code=abc', state)));

    expect(result.type).toBe('authorized');
    expect(await after.oauth.isAuthorized()).toBe(true);
    // The verifier is spent, so it does not stay on the device.
    expect(device.slot).toBeUndefined();
  });

  it('carries the verifier and the redirect URI into the exchange, not just the state', async () => {
    // Matching the state only proves the record was found. The exchange is what the record is FOR,
    // and it needs two more fields that a process restart is equally capable of losing.
    const device = newDevice();
    const clock = new FakeClock();

    const before = session({ pendingStore: new PersistentPendingStore(device), clock });
    await before.oauth.authorize();
    const state = stateOf(before.opened[0] ?? '');
    const stored = deserializePendingAuthorization(device.slot ?? '');

    const after = session({ pendingStore: new PersistentPendingStore(device), clock });
    after.transport.enqueue(grantResponse());
    await completed(after.oauth.handleCallback(redirect('code=abc', state)));

    const body = parseQueryParameters(after.transport.lastRequest?.body ?? '');
    expect(body.get('code_verifier')).toBe(stored?.codeVerifier);
    expect(body.get('code_verifier')).not.toBe('');
    expect(body.get('redirect_uri')).toBe(CONFIG.redirectUri);
  });

  it('is lost when the store is in-memory, and the user is left with nothing', async () => {
    const clock = new FakeClock();

    const before = session({ pendingStore: new InMemoryPendingAuthorizationStore(), clock });
    await before.oauth.authorize();
    const state = stateOf(before.opened[0] ?? '');

    // A new in-memory store, because an in-memory store is exactly as new as the process holding it.
    const after = session({ pendingStore: new InMemoryPendingAuthorizationStore(), clock });
    const result = await completed(after.oauth.handleCallback(redirect('code=abc', state)));

    // The user granted consent. There is no way back from here: no verifier, so no exchange.
    expect(result.type).toBe('failed');
    if (result.type === 'failed') expect(result.error.kind).toBe('stateMismatch');
    expect(after.transport.requests).toHaveLength(0);
    expect(await after.oauth.isAuthorized()).toBe(false);
  });

  /**
   * Pinned on purpose, and it pins a LIMITATION rather than a feature.
   *
   * The core package depends on no storage library — both secure stores live behind optional peer
   * dependencies, reachable only through the adapter subpaths — so the default cannot be made
   * persistent without changing what this package depends on. If that packaging decision is ever
   * revisited, this test fails, and docs/oauth.md and the README have to be revisited with it. The
   * limitation being documented is the only thing that makes it acceptable.
   */
  it('does not survive a restart with the SDK default, which is documented, not accidental', async () => {
    const clock = new FakeClock();

    const before = session({ clock });
    await before.oauth.authorize();
    const state = stateOf(before.opened[0] ?? '');

    const after = session({ clock });
    const result = await completed(after.oauth.handleCallback(redirect('code=abc', state)));

    expect(result.type).toBe('failed');
    if (result.type === 'failed') expect(result.error.kind).toBe('stateMismatch');
  });
});

/**
 * Reachable exactly when an integrator does the RIGHT thing and installs a persistent store. The
 * in-memory default never holds a record across the write that damages it, so a partial flush, a
 * truncated keychain item or a record written by an older layout only ever surfaces on a device
 * that is configured properly.
 */
describe('a damaged pending record', () => {
  it('is unreadable whichever field went missing, rather than partly trusted', () => {
    const intact = {
      state: 'the-state',
      codeVerifier: 'the-verifier',
      redirectUri: 'https://your.app/oauth/callback',
      createdAtMs: 1_700_000_000_000,
    };
    expect(deserializePendingAuthorization(JSON.stringify(intact))).toEqual(intact);

    for (const field of ['state', 'codeVerifier', 'redirectUri', 'createdAtMs'] as const) {
      const damaged: Record<string, unknown> = { ...intact };
      delete damaged[field];
      expect(deserializePendingAuthorization(JSON.stringify(damaged))).toBeUndefined();
    }

    // A timestamp of the wrong type is the same damage wearing a plausible shape.
    for (const createdAtMs of ['1700000000000', null, Number.NaN]) {
      expect(
        deserializePendingAuthorization(JSON.stringify({ ...intact, createdAtMs })),
      ).toBeUndefined();
    }
  });

  /**
   * A record with no timestamp used to be immortal. `(now - undefined) / 1000` is `NaN`, every
   * comparison against `NaN` is false, so the ten-minute expiry never fired at any age — and the
   * verifier was still spent on whatever code eventually turned up.
   */
  it('does not redeem a code against a record whose age cannot be computed', async () => {
    const device = newDevice();
    const clock = new FakeClock();
    const { oauth, transport, opened } = session({
      pendingStore: new PersistentPendingStore(device),
      clock,
    });

    await oauth.authorize();
    const state = stateOf(opened[0] ?? '');

    const stored = JSON.parse(device.slot ?? '{}') as Record<string, unknown>;
    delete stored.createdAtMs;
    device.slot = JSON.stringify(stored);
    clock.advance(30 * 24 * 3600 * 1000);

    transport.enqueue(grantResponse());
    const result = await completed(oauth.handleCallback(redirect('code=abc', state)));

    expect(result.type).toBe('failed');
    // Nothing was exchanged: a month-old attempt must not be able to hide behind a missing field.
    expect(transport.requests).toHaveLength(0);
    expect(await oauth.isAuthorized()).toBe(false);
  });
});

describe('the maximum age of a pending record', () => {
  /**
   * Ten minutes is the authorization code's own recommended maximum lifetime (RFC 6749 4.1.2), and
   * the verifier is only ever used to redeem that code. Both boundaries are pinned here: the value
   * itself, and that the comparison is strictly greater-than rather than inclusive.
   */
  it('defaults to ten minutes, and a record exactly that old is still redeemable', async () => {
    const device = newDevice();
    const clock = new FakeClock();
    const { oauth, transport, opened } = session({
      pendingStore: new PersistentPendingStore(device),
      clock,
    });

    await oauth.authorize();
    const state = stateOf(opened[0] ?? '');
    clock.advance(600 * 1000);
    transport.enqueue(grantResponse());

    expect((await completed(oauth.handleCallback(redirect('code=abc', state)))).type).toBe(
      'authorized',
    );
  });

  it('refuses a record one second past ten minutes, without spending the code', async () => {
    const device = newDevice();
    const clock = new FakeClock();
    const { oauth, transport, opened } = session({
      pendingStore: new PersistentPendingStore(device),
      clock,
    });

    await oauth.authorize();
    const state = stateOf(opened[0] ?? '');
    clock.advance(601 * 1000);

    const result = await completed(oauth.handleCallback(redirect('code=abc', state)));

    expect(result.type).toBe('failed');
    if (result.type === 'failed') expect(result.error.kind).toBe('stateMismatch');
    // Refused locally. Holding the verifier longer would only have bought a round trip to be told
    // the same thing by the server, because the code expired on the same schedule.
    expect(transport.requests).toHaveLength(0);
    expect(device.slot).toBeUndefined();
  });

  it('refuses a record that outlived a lowered maximum', async () => {
    const device = newDevice();
    const clock = new FakeClock();
    const { oauth, opened } = session({
      pendingStore: new PersistentPendingStore(device),
      clock,
      maxAgeSeconds: 60,
    });

    await oauth.authorize();
    const state = stateOf(opened[0] ?? '');
    clock.advance(61 * 1000);

    expect((await completed(oauth.handleCallback(redirect('code=abc', state)))).type).toBe(
      'failed',
    );
  });
});

/**
 * A host that abandons the flow mid-way is the only party that can see it happen: the SDK is never
 * told an app-to-app hop was given up on. Without a cancel, the record sits in the store with a
 * live PKCE verifier until the ten-minute expiry reaches it.
 */
describe('cancelPendingAuthorization()', () => {
  it('erases the record so a later redirect cannot complete the flow', async () => {
    const device = newDevice();
    const clock = new FakeClock();
    const { oauth, transport, opened } = session({
      pendingStore: new PersistentPendingStore(device),
      clock,
    });

    await oauth.authorize();
    const state = stateOf(opened[0] ?? '');
    expect(device.slot).toBeDefined();

    expect(await oauth.cancelPendingAuthorization()).toBe(true);

    expect(device.slot).toBeUndefined();
    expect(oauth.pendingAuthorizationId).toBeUndefined();
    const result = await completed(oauth.handleCallback(redirect('code=abc', state)));
    expect(result.type).toBe('failed');
    expect(transport.requests).toHaveLength(0);
  });

  it('reports false when there is nothing to cancel, including a second time', async () => {
    const device = newDevice();
    const clock = new FakeClock();
    const { oauth } = session({ pendingStore: new PersistentPendingStore(device), clock });

    expect(await oauth.cancelPendingAuthorization()).toBe(false);
    await oauth.authorize();
    expect(await oauth.cancelPendingAuthorization()).toBe(true);
    expect(await oauth.cancelPendingAuthorization()).toBe(false);
  });

  /**
   * The double tap. `authorize()` runs twice, the second supersedes the first, and only then does
   * the first screen's dismissal arrive. Without the id that late signal cancels the attempt the
   * user is actually looking at.
   */
  it('ignores a signal naming an attempt that has already been superseded', async () => {
    const device = newDevice();
    const clock = new FakeClock();
    const { oauth } = session({ pendingStore: new PersistentPendingStore(device), clock });

    await oauth.authorize();
    const first = oauth.pendingAuthorizationId;
    await oauth.authorize();
    const second = oauth.pendingAuthorizationId;
    expect(first).toBeDefined();
    expect(second).not.toBe(first);

    expect(await oauth.cancelPendingAuthorization(first)).toBe(false);
    expect(device.slot).toBeDefined();

    expect(await oauth.cancelPendingAuthorization(second)).toBe(true);
    expect(device.slot).toBeUndefined();
  });

  /**
   * The id is memory-only, so a new process has none — and an unqualified cancel is the only kind
   * it can honestly make. A cancel naming an id from a process that is gone is refused, because
   * this instance never saw that attempt and cannot say the signal belongs to what is on disk.
   */
  it('can still cancel a record a previous process left, but only unqualified', async () => {
    const device = newDevice();
    const clock = new FakeClock();

    const before = session({ pendingStore: new PersistentPendingStore(device), clock });
    await before.oauth.authorize();
    const idFromTheOldProcess = before.oauth.pendingAuthorizationId;

    const after = session({ pendingStore: new PersistentPendingStore(device), clock });
    expect(after.oauth.pendingAuthorizationId).toBeUndefined();
    expect(await after.oauth.cancelPendingAuthorization(idFromTheOldProcess)).toBe(false);
    expect(device.slot).toBeDefined();

    expect(await after.oauth.cancelPendingAuthorization()).toBe(true);
    expect(device.slot).toBeUndefined();
  });
});

describe('a terminal outcome clears the pending record', () => {
  /**
   * The record holds a live PKCE verifier, so leaving it behind after the flow has ended is both a
   * credential kept for no reason and a record that will age into a misleading stale-authorization
   * diagnostic on the next attempt.
   */
  async function launched(options?: { confidential?: boolean }): Promise<{
    oauth: TraciveOAuth;
    transport: FakeTransport;
    device: Device;
    state: string;
  }> {
    const device = newDevice();
    const clock = new FakeClock();
    const { oauth, transport, opened } = session({
      pendingStore: new PersistentPendingStore(device),
      clock,
      ...(options?.confidential === true ? { confidential: true } : {}),
    });
    await oauth.authorize();
    expect(device.slot).toBeDefined();
    return { oauth, transport, device, state: stateOf(opened[0] ?? '') };
  }

  it('clears it after a successful exchange', async () => {
    const { oauth, transport, device, state } = await launched();
    transport.enqueue(grantResponse());
    expect((await completed(oauth.handleCallback(redirect('code=abc', state)))).type).toBe(
      'authorized',
    );
    expect(device.slot).toBeUndefined();
  });

  it('clears it after a denial', async () => {
    const { oauth, device, state } = await launched();
    expect(
      (await completed(oauth.handleCallback(redirect('error=access_denied', state)))).type,
    ).toBe('denied');
    expect(device.slot).toBeUndefined();
  });

  it('clears it after a non-denial error on the redirect', async () => {
    const { oauth, device, state } = await launched();
    expect(
      (await completed(oauth.handleCallback(redirect('error=server_error', state)))).type,
    ).toBe('failed');
    expect(device.slot).toBeUndefined();
  });

  it('KEEPS it after a state mismatch, so a forgery cannot cancel the attempt', async () => {
    const { oauth, device } = await launched();
    expect(
      (await completed(oauth.handleCallback(redirect('code=abc', 'not-the-state')))).type,
    ).toBe('failed');
    expect(device.slot).toBeDefined();
  });

  // This test used to assert the opposite, on the grounds that a forged redirect must not leave a
  // live verifier parked on the device. The trade-off runs the other way. Any app can send that
  // redirect, so erasing on it hands any app a one-call cancel button for a consent in progress —
  // and the verifier is not parked any *longer* because of the forgery. It was already going to sit
  // there for the ten minutes the user has to finish consenting, and the expiry above still ends it
  // on time. A forgery that fails to shorten the window is not the same as one that extends it.

  it('clears it when the code is handed to a confidential client', async () => {
    const { oauth, transport, device, state } = await launched({ confidential: true });
    expect((await completed(oauth.handleCallback(redirect('code=abc', state)))).type).toBe(
      'codeReceived',
    );
    // The caller now holds the verifier; the device does not need a second copy of it.
    expect(device.slot).toBeUndefined();
    expect(transport.requests).toHaveLength(0);
  });

  it('clears it on signOut(), even with no exchange in between', async () => {
    const { oauth, device } = await launched();
    await oauth.signOut();
    expect(device.slot).toBeUndefined();
  });
});

import { describe, expect, it } from '@jest/globals';

import { completed, FakeClock, FakeTransport, fixedRandom } from '../../__tests__/support/fakes';
import type { Diagnostic } from '../../diagnostics';
import type { AuthResult } from '../../model/AuthResult';
import type { OAuthConfiguration } from '../../model/TraciveMode';
import { startLinkListener, type LinkSource } from '../linkListener';
import type {
  PendingAuthorization,
  PendingAuthorizationStore,
} from '../PendingAuthorization';
import { TraciveOAuth } from '../TraciveOAuth';

const CONFIG: OAuthConfiguration = {
  clientId: 'partner-app',
  redirectUri: 'https://your.app/oauth/callback',
};

/** A link source whose cold-start URL resolves on a controllable later tick. */
class ControllableLinkSource implements LinkSource {
  listener: ((url: string) => void) | undefined;
  subscribedBeforeInitialResolved = false;
  #resolveInitial: ((url: string | null) => void) | undefined;
  #initial = new Promise<string | null>((resolve) => {
    this.#resolveInitial = resolve;
  });

  addUrlListener(listener: (url: string) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  getInitialUrl(): Promise<string | null> {
    this.subscribedBeforeInitialResolved = this.listener !== undefined;
    return this.#initial;
  }

  resolveInitial(url: string | null): void {
    this.#resolveInitial?.(url);
  }

  emit(url: string): void {
    this.listener?.(url);
  }
}

describe('startLinkListener', () => {
  it('subscribes to warm events BEFORE awaiting the cold-start URL', async () => {
    // Awaiting first opens a window in which a warm event arrives with nobody listening.
    const source = new ControllableLinkSource();
    const seen: string[] = [];
    const stop = startLinkListener(source, (url) => seen.push(url));

    expect(source.subscribedBeforeInitialResolved).toBe(true);
    source.emit('https://your.app/oauth/callback?code=warm');
    source.resolveInitial(null);
    await Promise.resolve();

    expect(seen).toEqual(['https://your.app/oauth/callback?code=warm']);
    stop();
  });

  it('drops an exact duplicate delivery of the same URL', async () => {
    // Both sources can hand over the same URL. The second delivery would find an empty pending
    // record and surface a spurious "no authorization in progress" to a user who did sign in.
    const source = new ControllableLinkSource();
    const seen: string[] = [];
    const stop = startLinkListener(source, (url) => seen.push(url));

    const url = 'https://your.app/oauth/callback?code=abc&state=xyz';
    source.emit(url);
    source.resolveInitial(url);
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual([url]);
    stop();
  });

  it('delivers a genuinely different second URL', async () => {
    const source = new ControllableLinkSource();
    const seen: string[] = [];
    const stop = startLinkListener(source, (url) => seen.push(url));
    source.emit('https://your.app/oauth/callback?code=one');
    source.emit('https://your.app/oauth/callback?code=two');
    source.resolveInitial(null);
    await Promise.resolve();
    expect(seen).toHaveLength(2);
    stop();
  });

  it('stops delivering after unsubscribe', async () => {
    const source = new ControllableLinkSource();
    const seen: string[] = [];
    const stop = startLinkListener(source, (url) => seen.push(url));
    stop();
    source.emit('https://your.app/oauth/callback?code=late');
    source.resolveInitial('https://your.app/oauth/callback?code=colder');
    await Promise.resolve();
    expect(seen).toHaveLength(0);
  });

  it('survives a cold-start read that rejects', async () => {
    const source: LinkSource = {
      addUrlListener: () => () => undefined,
      getInitialUrl: () => Promise.reject(new Error('debugger attached')),
    };
    const stop = startLinkListener(source, () => undefined);
    await Promise.resolve();
    stop();
  });
});

describe('cold-start buffering', () => {
  function build(): { oauth: TraciveOAuth; source: ControllableLinkSource } {
    const source = new ControllableLinkSource();
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport: new FakeTransport(),
      clock: new FakeClock(),
      random: fixedRandom(),
      linkSource: source,
      presence: { isTraciveAppInstalled: () => Promise.resolve(true) },
      launcher: { openExternally: () => Promise.resolve(true) },
    });
    return { oauth, source };
  }

  it('buffers one result and hands it to the first subscriber', async () => {
    // getInitialURL resolves before the React tree has mounted anything that would show this.
    const { oauth, source } = build();
    const stop = oauth.startLinkListener();

    source.emit('https://your.app/oauth/callback?code=abc&state=nope');
    source.resolveInitial(null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const received: AuthResult[] = [];
    oauth.onAuthResult((result) => received.push(result));

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('failed');
    stop();
  });

  it('drains the buffer so a second subscriber does not see a stale result', async () => {
    const { oauth, source } = build();
    const stop = oauth.startLinkListener();
    source.emit('https://your.app/oauth/callback?code=abc&state=nope');
    source.resolveInitial(null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    oauth.onAuthResult(() => undefined);
    const second: AuthResult[] = [];
    oauth.onAuthResult((result) => second.push(result));
    expect(second).toHaveLength(0);
    stop();
  });

  it('delivers live to an already-attached subscriber instead of buffering', async () => {
    const { oauth, source } = build();
    const received: AuthResult[] = [];
    oauth.onAuthResult((result) => received.push(result));
    const stop = oauth.startLinkListener();

    source.resolveInitial('https://your.app/oauth/callback?code=abc&state=nope');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(1);
    stop();
  });

  it('unsubscribes cleanly', () => {
    const { oauth } = build();
    const unsubscribe = oauth.onAuthResult(() => undefined);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });

  /**
   * The listener is fed every deep link the app receives, and most apps have links that have
   * nothing to do with Tracive. Publishing a result for one of those tells every subscriber a
   * sign-in ended — and a private-use scheme makes it worse, because any app on the device may
   * declare one and fire it.
   */
  it('publishes nothing for a link addressed somewhere else', async () => {
    const { oauth, source } = build();
    const received: AuthResult[] = [];
    oauth.onAuthResult((result) => received.push(result));
    const stop = oauth.startLinkListener();

    source.emit('myapp://payment/done?code=abc&state=xyz');
    source.resolveInitial('https://someone.else/oauth/callback?code=abc&state=xyz');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(0);
    stop();
  });
});

/**
 * The platform secure store backs the pending record in both adapters, and it genuinely rejects:
 * Keychain before first unlock, a SecureStore fault, a corrupted keystore. Every one of those
 * used to surface as an unhandled promise rejection with the authorization result dropped on the
 * floor — the user signs in, comes back, and nothing ever happens.
 */
describe('a pending store that rejects', () => {
  const REDIRECT = 'https://your.app/oauth/callback?code=abc&state=xyz';

  class ThrowingPendingStore implements PendingAuthorizationStore {
    readonly failure = new Error('SecureStore unavailable');
    read(): Promise<PendingAuthorization | undefined> {
      return Promise.reject(this.failure);
    }
    write(): Promise<void> {
      return Promise.reject(this.failure);
    }
    clear(): Promise<void> {
      return Promise.reject(this.failure);
    }
  }

  function build(): { oauth: TraciveOAuth; source: ControllableLinkSource } {
    const source = new ControllableLinkSource();
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport: new FakeTransport(),
      clock: new FakeClock(),
      random: fixedRandom(),
      linkSource: source,
      pendingStore: new ThrowingPendingStore(),
      presence: { isTraciveAppInstalled: () => Promise.resolve(true) },
      launcher: { openExternally: () => Promise.resolve(true) },
    });
    return { oauth, source };
  }

  it('makes authorize return a failed result rather than rejecting', async () => {
    // `authorize()` is typed `Promise<AuthResult | null>`; the presence probe and the launcher
    // already convert their failures into a returned result, and the store write is the one
    // remaining way for a raw error to escape.
    const { oauth } = build();
    const result = await oauth.authorize();
    expect(result?.type).toBe('failed');
  });

  it('does not launch the authorize URL when the record could not be written', async () => {
    // Launching without the record guarantees the redirect cannot be completed: the callback
    // would find nothing to match its state against, so the user signs in for nothing.
    const source = new ControllableLinkSource();
    let launches = 0;
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport: new FakeTransport(),
      clock: new FakeClock(),
      random: fixedRandom(),
      linkSource: source,
      pendingStore: new ThrowingPendingStore(),
      presence: { isTraciveAppInstalled: () => Promise.resolve(true) },
      launcher: {
        openExternally: () => {
          launches += 1;
          return Promise.resolve(true);
        },
      },
    });

    const result = await oauth.authorize();
    expect(result?.type).toBe('failed');
    expect(launches).toBe(0);
  });

  it('makes handleCallback return a failed result rather than rejecting', async () => {
    const { oauth } = build();
    const result = await completed(oauth.handleCallback(REDIRECT));
    expect(result.type).toBe('failed');
  });

  it('still delivers a result through the link listener', async () => {
    const { oauth, source } = build();
    const received: AuthResult[] = [];
    oauth.onAuthResult((result) => received.push(result));
    const stop = oauth.startLinkListener();

    source.resolveInitial(REDIRECT);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('failed');
    stop();
  });

  it('leaves no unhandled rejection behind', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      const { oauth, source } = build();
      oauth.onAuthResult(() => undefined);
      const stop = oauth.startLinkListener();
      source.resolveInitial(REDIRECT);
      await new Promise((resolve) => setTimeout(resolve, 20));
      stop();
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });
});

/**
 * Listeners are host-app code. One of them throwing is the host's bug, but dropping the
 * authorization result for every OTHER listener because of it is this SDK's.
 */
describe('a listener that throws', () => {
  function build(): { oauth: TraciveOAuth; source: ControllableLinkSource; seen: Diagnostic[] } {
    const source = new ControllableLinkSource();
    const seen: Diagnostic[] = [];
    const oauth = new TraciveOAuth({
      mode: CONFIG,
      transport: new FakeTransport(),
      clock: new FakeClock(),
      random: fixedRandom(),
      linkSource: source,
      presence: { isTraciveAppInstalled: () => Promise.resolve(true) },
      launcher: { openExternally: () => Promise.resolve(true) },
      onDiagnostic: (diagnostic) => seen.push(diagnostic),
    });
    return { oauth, source, seen };
  }

  it('does not stop delivery to the listeners after it', async () => {
    const { oauth, source, seen } = build();
    const delivered: string[] = [];
    oauth.onAuthResult(() => delivered.push('first'));
    oauth.onAuthResult(() => {
      throw new Error('host bug');
    });
    oauth.onAuthResult(() => delivered.push('third'));

    const stop = oauth.startLinkListener();
    source.resolveInitial('https://your.app/oauth/callback?code=abc&state=nope');
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();

    expect(delivered).toEqual(['first', 'third']);
    expect(seen.some((diagnostic) => diagnostic.code === 'auth_result_listener_threw')).toBe(true);
  });

  it('still hands back a working unsubscribe when it throws on the buffered result', async () => {
    // The buffered result is delivered synchronously BEFORE the unsubscribe closure is returned,
    // so a listener that throws there used to leave itself registered with no way to remove it.
    const { oauth, source } = build();
    const stop = oauth.startLinkListener();
    source.resolveInitial('https://your.app/oauth/callback?code=abc&state=nope');
    await new Promise((resolve) => setTimeout(resolve, 0));

    let calls = 0;
    const unsubscribe = oauth.onAuthResult(() => {
      calls += 1;
      throw new Error('host bug');
    });
    expect(calls).toBe(1);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();

    const later: AuthResult[] = [];
    oauth.onAuthResult((result) => later.push(result));
    source.emit('https://your.app/oauth/callback?code=def&state=nope');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect(later).toHaveLength(1);
    stop();
  });
});

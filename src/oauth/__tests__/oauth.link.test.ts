import { describe, expect, it } from '@jest/globals';

import { FakeClock, FakeTransport, fixedRandom } from '../../__tests__/support/fakes';
import type { AuthResult } from '../../model/AuthResult';
import type { OAuthConfiguration } from '../../model/TraciveMode';
import { startLinkListener, type LinkSource } from '../linkListener';
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
});

import { Linking } from 'react-native';

export interface LinkSource {
  addUrlListener(listener: (url: string) => void): () => void;
  getInitialUrl(): Promise<string | null>;
}

/** The default source. Kept behind a port so the ordering rules below are testable. */
export const linkingLinkSource: LinkSource = {
  addUrlListener(listener: (url: string) => void): () => void {
    const subscription = Linking.addEventListener('url', ({ url }) => {
      listener(url);
    });
    return () => {
      subscription.remove();
    };
  },
  getInitialUrl(): Promise<string | null> {
    return Linking.getInitialURL();
  },
};

/**
 * Three React-Native-specific hazards are designed out here rather than documented as caveats.
 *
 * 1. The `'url'` subscription is installed BEFORE `getInitialURL()` is awaited. Awaiting first
 *    opens a window in which a warm event arrives with nobody listening and is lost.
 * 2. Both sources can hand over the same URL. An exact repeat of the last-delivered URL is
 *    dropped, because the second delivery would find an empty pending record and surface a
 *    spurious "no authorization in progress" error to a user whose sign-in actually worked.
 * 3. `getInitialURL()` resolves before the React tree has mounted anything that would display a
 *    result, so the first cold-start authorization would otherwise be silently lost. The caller
 *    buffers one result for the first subscriber; this function guarantees the delivery order
 *    that makes that possible.
 */
export function startLinkListener(source: LinkSource, onUrl: (url: string) => void): () => void {
  let stopped = false;
  let lastUrl: string | undefined;

  const deliver = (url: string): void => {
    if (stopped) return;
    if (url === lastUrl) return;
    lastUrl = url;
    onUrl(url);
  };

  // Subscribe first. Always.
  const unsubscribe = source.addUrlListener(deliver);

  void source
    .getInitialUrl()
    .then((url) => {
      if (url !== null && url !== undefined) deliver(url);
    })
    .catch(() => {
      // A failed cold-start read is not worth failing a subscription over: the warm listener is
      // already installed and will catch anything that arrives from here on.
    });

  return () => {
    stopped = true;
    unsubscribe();
  };
}

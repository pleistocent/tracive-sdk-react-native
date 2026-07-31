import { Linking } from 'react-native';

export interface AuthorizeLauncher {
  /** Resolves `false` when the OS declined to route the URL anywhere. */
  openExternally(url: string): Promise<boolean>;
}

/**
 * `Linking.openURL`, and nothing else.
 *
 * Every in-app-browser library exists to KEEP a URL inside a browser surface, and this flow needs
 * the OS to ROUTE AWAY from the browser to a claiming app. An in-app browser on iOS will not fire
 * a Universal Link to another app, and pinning an Android Custom Tab to a browser package defeats
 * App Link resolution for the same reason. A web-authentication session is a web-consent
 * primitive, and phase 1 has no web consent page to host.
 *
 * The cost accepted is styling: there are no custom browser chrome options. On the happy path no
 * web page is ever rendered.
 */
export class LinkingAuthorizeLauncher implements AuthorizeLauncher {
  async openExternally(url: string): Promise<boolean> {
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      return false;
    }
  }
}

import { Linking } from 'react-native';

import type { Diagnostic } from '../diagnostics';
import { APP_PRESENCE_PROBE_URL } from './authorizeUrl';

export interface AppPresenceProbe {
  isTraciveAppInstalled(): Promise<boolean>;
}

/**
 * Presence UNKNOWN reports NOT INSTALLED. This fails closed on purpose: routing a user who does
 * have the app to an install page is a recoverable annoyance, whereas opening an authorization
 * URL that nothing claims drops them on a browser error with no way forward.
 *
 * On Android, `canOpenURL` REJECTS its promise rather than returning `false` when the host app
 * targets API 30+ without the matching `<queries>` entry. That rejection is a host-configuration
 * bug with a user-visible symptom indistinguishable from "nobody has the app", so it is caught,
 * reported as not-installed, AND surfaced as a diagnostic naming the missing block.
 */
export class LinkingAppPresenceProbe implements AppPresenceProbe {
  readonly #onDiagnostic: ((diagnostic: Diagnostic) => void) | undefined;

  constructor(options?: { onDiagnostic?: (diagnostic: Diagnostic) => void }) {
    this.#onDiagnostic = options?.onDiagnostic;
  }

  async isTraciveAppInstalled(): Promise<boolean> {
    try {
      return await Linking.canOpenURL(APP_PRESENCE_PROBE_URL);
    } catch (error) {
      this.#onDiagnostic?.({
        code: 'app_presence_probe_failed',
        severity: 'warning',
        message:
          'Could not determine whether the Tracive app is installed, so the SDK is reporting ' +
          `not-installed. Underlying failure: ${
            error instanceof Error ? error.message : String(error)
          }`,
        hint:
          'On Android this almost always means the host AndroidManifest.xml has no <queries> ' +
          'block declaring the `tracive` scheme. On iOS it means LSApplicationQueriesSchemes ' +
          'does not list `tracive`. Run `npx tracive-doctor` for the exact block to paste.',
      });
      return false;
    }
  }
}

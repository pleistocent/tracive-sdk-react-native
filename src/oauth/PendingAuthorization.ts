/**
 * The record that lets an authorization survive the app process being killed.
 *
 * On Android, process death while another app is in the foreground is routine, so a promise that
 * suspends until the redirect comes back cannot be the design: it would simply never resolve.
 * Instead the state needed to finish the exchange is written down BEFORE the authorize URL is
 * opened, and the outcome is delivered later to `handleCallback`.
 *
 * This also makes `launchMode="singleTask"` non-fatal: a second activity instance still finds the
 * record.
 */
export interface PendingAuthorization {
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly createdAtMs: number;
}

/**
 * Where the pending record lives.
 *
 * It holds a PKCE verifier, so it belongs in the same secure storage as the tokens — the default
 * below is in-memory, which is correct for tests and for a foreground-only flow but gives up the
 * process-death property the record exists for. The Expo and bare adapters return one backed by
 * the platform secure store.
 */
export interface PendingAuthorizationStore {
  read(): Promise<PendingAuthorization | undefined>;
  write(pending: PendingAuthorization): Promise<void>;
  clear(): Promise<void>;
}

export class InMemoryPendingAuthorizationStore implements PendingAuthorizationStore {
  #pending: PendingAuthorization | undefined;

  read(): Promise<PendingAuthorization | undefined> {
    return Promise.resolve(this.#pending);
  }

  write(pending: PendingAuthorization): Promise<void> {
    this.#pending = pending;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#pending = undefined;
    return Promise.resolve();
  }
}

export function serializePendingAuthorization(pending: PendingAuthorization): string {
  return JSON.stringify(pending);
}

export function deserializePendingAuthorization(json: string): PendingAuthorization | undefined {
  try {
    const parsed = JSON.parse(json) as PendingAuthorization;
    if (typeof parsed?.state !== 'string' || typeof parsed?.codeVerifier !== 'string') {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export const STALE_PENDING_AUTHORIZATION_HINT =
  'An authorization was launched but its result never came back before the record aged out. ' +
  'There are exactly three real causes: (1) the associated-domain or asset-links file for the ' +
  'redirect host is not being served, or names the wrong signing fingerprint, so the link was ' +
  'never verified; (2) the redirect host does not match any intent-filter or associated domain ' +
  'the app declares; (3) the link was delivered to the OS but never reached JavaScript on cold ' +
  'start. Run `npx tracive-doctor` — it checks the first two statically.';

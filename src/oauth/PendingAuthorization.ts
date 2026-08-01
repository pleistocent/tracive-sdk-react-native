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
 * It holds a PKCE verifier, so it belongs in the same secure storage as the tokens. The Expo and
 * bare adapters return one backed by the platform secure store; `TraciveOAuth` does not use either
 * by default, because the core package deliberately depends on no storage library and both of those
 * live behind optional peer dependencies.
 *
 * That default has a cost, and it is stated here rather than left to be discovered: with a
 * non-persistent store, an authorization interrupted by process death cannot be completed. Consent
 * happens in the Tracive app, so the host process is backgrounded for its whole duration, which on
 * Android is exactly when the OS reclaims it. The record dies with the process, the redirect comes
 * back to a `read()` that returns `undefined`, and `handleCallback` can only report `stateMismatch`
 * — the user granted consent and the app has nothing to show for it. Nothing throws and nothing is
 * logged: from the SDK's side it is indistinguishable from a redirect that no `authorize()` call
 * preceded. Supply a persistent store to close it.
 */
export interface PendingAuthorizationStore {
  read(): Promise<PendingAuthorization | undefined>;
  write(pending: PendingAuthorization): Promise<void>;
  clear(): Promise<void>;
}

/** The default. Correct for tests and for a foreground-only flow; wrong for a shipping app. */
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

/**
 * Every field is validated, because every field decides something and a damaged one decides it
 * wrongly rather than loudly.
 *
 * `createdAtMs` is the one that used to be trusted, and it is the one whose absence is silent.
 * `TraciveOAuth` computes `(now - createdAtMs) / 1000` and compares that against the maximum age;
 * with the field missing the subtraction is `NaN`, and every comparison against `NaN` is `false`,
 * so the record reads as fresh no matter how old it is. The expiry that is supposed to end an
 * abandoned attempt never fires, the PKCE verifier stays on the device, and a code that arrives
 * days later is still redeemed. Nothing throws and nothing is logged.
 *
 * `redirectUri` is validated for the same reason at one remove: it is sent as `redirect_uri` in
 * the token exchange, and a missing one turns a redeemable code into a server-side rejection.
 *
 * A record that fails any of these is reported as absent, exactly as unparseable JSON already is.
 * Both mean the same thing to a caller — there is nothing here that can finish an authorization —
 * and `handleCallback` already has an answer for that.
 */
export function deserializePendingAuthorization(json: string): PendingAuthorization | undefined {
  try {
    const parsed = JSON.parse(json) as PendingAuthorization;
    if (
      typeof parsed?.state !== 'string' ||
      typeof parsed?.codeVerifier !== 'string' ||
      typeof parsed?.redirectUri !== 'string' ||
      // `Number.isFinite` rather than a `typeof` test: it rejects a non-number without coercing
      // one, and it also rejects the `NaN` and `Infinity` that a `typeof` test would let through.
      !Number.isFinite(parsed?.createdAtMs)
    ) {
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

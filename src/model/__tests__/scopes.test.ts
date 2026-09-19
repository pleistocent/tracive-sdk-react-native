import { describe, expect, it } from '@jest/globals';

import * as publicSurface from '../../index';
import { TraciveScopes, type TraciveScope } from '../scopes';

/**
 * Every expectation below names the wire string as a LITERAL and never reads it back off the
 * constant it is checking. An assertion written as
 * `expect(TraciveScopes.scammerCheck).toBe(TraciveScopes.scammerCheck)` would pass through any
 * rename, so the contract these constants exist to pin would be redefinable in silence.
 *
 * The contract is shared with the Kotlin, Swift and Flutter SDKs and enforced by the authorization
 * server. A wrong string here cannot be caught anywhere else: the server rejects the whole consent
 * request rather than granting a narrower grant, so the symptom is an integration that cannot
 * authorize at all, and no test here can ask the server to show it.
 */
describe('the OAuth scope constants', () => {
  it('carries the exact wire strings the authorization server accepts', () => {
    expect(TraciveScopes.scammerCheck).toBe('scammer.check');
    expect(TraciveScopes.creditsRead).toBe('credits.read');
    expect(TraciveScopes.profileRead).toBe('profile.read');
  });

  it('carries exactly the three scopes and nothing else', () => {
    expect([...Object.values(TraciveScopes)].sort()).toEqual([
      'credits.read',
      'profile.read',
      'scammer.check',
    ]);
  });

  it('has no constant for an endpoint this SDK does not model', () => {
    // A constant for a call this SDK cannot make would only invite asking a user to consent to
    // something no code here will ever exercise. The omission is the feature.
    expect([...Object.values(TraciveScopes)]).not.toContain('usage.read');
    expect(Object.keys(TraciveScopes)).not.toContain('usageRead');
  });

  it('is frozen, so one integration cannot rewrite the scope another one requests', () => {
    expect(Object.isFrozen(TraciveScopes)).toBe(true);
  });

  it('is reachable from the package entry point', () => {
    expect(publicSurface.TraciveScopes).toBe(TraciveScopes);
  });

  /**
   * Checked by `npm run typecheck`, not by Jest: `tsconfig.json` includes this directory, and an
   * unused `@ts-expect-error` is itself an error — so if the union ever stopped rejecting these,
   * the build would fail rather than pass quietly.
   */
  it('rejects a mistyped or unmodelled scope at compile time', () => {
    const spelled: readonly TraciveScope[] = ['scammer.check', 'credits.read', 'profile.read'];
    // @ts-expect-error one transposition, and the server refuses the entire consent request
    const mistyped: readonly TraciveScope[] = ['scammer.chekc'];
    // @ts-expect-error this SDK models no such call, so it must not offer to ask for it
    const unmodelled: readonly TraciveScope[] = ['usage.read'];

    expect(spelled).toHaveLength(3);
    expect(mistyped).toHaveLength(1);
    expect(unmodelled).toHaveLength(1);
  });
});

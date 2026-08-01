# Authorization

Phase 1 is OAuth 2.0 with PKCE, and the authorization happens **in the Tracive app already installed
on the user's device**. There is no API key, no password prompt and no web consent page.

## The flow

```
your app  --(1) tracive://authorize?...-->  Tracive app
                                               |
your app  <--(2) https://your.app/oauth/callback?code=...&state=...
   |
   +--(3) POST /oauth/token  (public client)  -->  tokens
```

```ts
// 1. Launch. Resolves to `null` on success — read on. The presence check is inside: if the
//    Tracive app is missing, the SDK opens the install page itself and reports `appNotInstalled`
//    without starting any flow. Presence unknown reports NOT installed — see docs/integration.md.
const outcome = await client.authorize();
if (outcome?.type === 'appNotInstalled') {
  // The install page is already opening. Show your own "install Tracive, then try again".
}

// 2. The terminal result arrives here.
client.onAuthResult((result) => {
  /* authorized | codeReceived | denied | appNotInstalled | failed */
});
```

`client.oauth?.isTraciveAppInstalled()` is still available if you want to know before you ask, for
example to label a button — but you do not have to call it to be correct.

## Scopes

Ask for them through `TraciveScopes`. Retyping the strings is the one mistake nothing here can
catch: the scope set is validated by the authorization server, which refuses the **whole** consent
request rather than granting a narrower one, so a single wrong character is not a reduced grant —
it is an integration that cannot authorize at all.

```ts
import { TraciveScopes, TraciveMode } from '@tracive/sdk-react-native';

TraciveMode.oauth({
  clientId: 'your-client-id',
  redirectUri: 'https://your.app/oauth/callback',
  scopes: [TraciveScopes.scammerCheck, TraciveScopes.creditsRead],
});
```

| Constant                     | Wire string     | Grants           |
| ---------------------------- | --------------- | ---------------- |
| `TraciveScopes.scammerCheck` | `scammer.check` | `checkScammer()` |
| `TraciveScopes.creditsRead`  | `credits.read`  | `credits()`      |
| `TraciveScopes.profileRead`  | `profile.read`  | `profile()`      |

The same three strings appear in the Kotlin, Swift and Flutter SDKs, and the test suite pins them as
literals rather than through the constants, so a rename fails the build instead of quietly
redefining the shared contract.

`TraciveScope` is the union of the three, for a caller who would rather write the literal than the
constant — `const scopes: TraciveScope[] = ['scammer.check']` is checked at compile time.
`OAuthConfiguration.scopes` deliberately does **not** require that union: the server's scope set is
larger than the three calls this SDK makes, and narrowing the field would lock a partner out of
asking for one of the others until this package shipped a release.

There is no constant for a call this SDK cannot make. The scope for API usage reporting is one such:
this package does not model that endpoint, and offering a constant for it would only invite asking a
user to consent to something no code here will ever exercise.

## Why `authorize()` resolves to `null` instead of waiting

This is the one place where this SDK deliberately diverges from its Kotlin and Swift siblings, which
suspend `authorize()` until the callback arrives.

On Android, the OS killing your process while another app is in the foreground is routine. A promise
that suspends until the redirect returns cannot survive that: it would simply never resolve, and the
user would come back to a screen waiting forever on a sign-in that actually succeeded.

So instead:

- the pending record — `{ state, codeVerifier, redirectUri, createdAt }` — is **persisted to secure
  storage before the authorize URL is opened**;
- `authorize()` resolves to `null` for "launched, the outcome will arrive at `handleCallback`", or
  to `appNotInstalled`, or to `failed`;
- the terminal outcome is delivered to `onAuthResult` (or returned from `handleCallback` if you
  route links yourself).

A useful side effect: `launchMode="singleTask"` stops being load-bearing, because a stacked second
activity instance still finds the pending record on disk.

**Use a persistent `PendingAuthorizationStore`.** The default is in-memory, which is correct for
tests but gives up exactly the property described above. The Expo and bare adapters provide one
backed by the platform secure store; the record holds a live PKCE verifier, so it belongs there.

## Why `Linking.openURL` and nothing else

Every in-app-browser library exists to **keep** a URL inside a browser surface. This flow needs the
OS to **route away** from the browser to a claiming app, which is the opposite requirement:

- an in-app browser on iOS will not fire a Universal Link to another app;
- pinning an Android Custom Tab to a specific browser package defeats App Link resolution;
- a web-authentication session is a web-consent primitive, and phase 1 has no web consent page.

The cost accepted is styling: no custom browser chrome. On the happy path no web page is rendered at
all, and the browser only appears when the App Link is unverified — a configuration bug
`tracive-doctor` catches at build time.

> This rationale is inherited doctrine from the sibling SDKs and has **not** been re-tested against
> current OS behaviour. See [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md).

## PKCE, state and single-flight refresh

- **S256 only.** `plain` is not a value in any type here, not a parameter, and not a fallback.
- The verifier is 32 random bytes as base64url: 43 characters, entirely within the RFC 7636
  unreserved set.
- `state` is 32 random bytes, compared without an early return, and compared **before** `error` or
  `code` are read — so a forged redirect cannot make the SDK act on its error message or exchange
  its code.
- A stale pending record (default max age **10 minutes**) is refused and produces the three-cause
  diagnostic described in [integration.md](integration.md).
- Token refresh is **single-flight**, with the latch assigned before any `await`. Two simultaneous
  refreshes with the same rotating refresh token look exactly like token reuse to an authorization
  server, and reuse detection revokes the grant.
- `grant_revoked` is terminal: stored tokens are cleared and nothing is retried.
- `signOut()` revokes the **refresh** token (revoking one access token would leave the grant alive
  and immediately re-issuable), then clears locally **regardless of what the server said** — a
  sign-out that fails because the network is down is not a sign-out any user would accept.

## Public and confidential clients

`ClientType.PUBLIC` (the default): the SDK performs the token exchange and stores the grant.

`ClientType.CONFIDENTIAL`: the SDK stops at
`{ type: 'codeReceived', code, codeVerifier, redirectUri }` and **never sees a token**. Your backend
completes the exchange with its `client_secret`, which must never ship inside a mobile app. Hand the
resulting grant back with `oauth.adoptTokens(...)` if you want on-device use.

That result object redacts its code and verifier on both `toJSON` and `toString`, because in
JavaScript a single breadcrumb would otherwise print a live authorization code.

## The install link

When the app is absent, `authorize()` starts no OAuth flow — no PKCE pair, no state, nothing
persisted — **opens the install link itself**, and reports `appNotInstalled`. That matches the
Kotlin, Swift and Flutter SDKs exactly, so an integration ported between them behaves the same way.
Show your own "install Tracive, then try again" message on that result; the two are complementary,
not alternatives.

`oauth.installUrlForDisplay()` returns the very same link, for a partner who would rather render it
than have the user jump straight out — and as the fallback if the OS refused the launch, which
arrives as an `install_link_launch_failed` diagnostic. The result stays `appNotInstalled` either
way, as it does in the siblings: the app really is missing, and that is the outcome the partner has
to handle regardless.

The link is `https://tracive.chottu.link/install` — the same base URL in all four Tracive SDKs —
carrying **attribution only**:

| Parameter    | Value                      | Notes                                                                                   |
| ------------ | -------------------------- | --------------------------------------------------------------------------------------- |
| `ref`        | your OAuth client id       | The **partner's** identifier, never an end user's. Omitted when the client id is empty. |
| `utm_source` | `tracive-sdk-react-native` | Which SDK sent the user.                                                                |

Both are optional and both are public, non-sensitive values. Any OAuth parameter already present on
a configured install URL is **stripped, not trusted**, and so is any attribution the URL already
carries — that is rebuilt rather than duplicated. An install link is public, gets pasted, shortened
and logged, and it travels through a third-party link service on its way to a store page: it is no
place for a verifier, a state value or a user identifier.

There is no deferred resume. Nothing is parked on the link for the user to come back with: they
install the app, return to your app and retry, and a fresh PKCE pair is generated then — which is
both simpler and safer than parking a verifier on a public URL.

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

- the pending record — `{ state, codeVerifier, redirectUri, createdAt }` — is **written to the
  `PendingAuthorizationStore` before the authorize URL is opened**, and the launch is abandoned if
  that write fails, because a flow whose record never reached storage could not have been completed;
- `authorize()` resolves to `null` for "launched, the outcome will arrive at `handleCallback`", or
  to `appNotInstalled`, or to `failed`;
- the terminal outcome is delivered to `onAuthResult` (or returned from `handleCallback` if you
  route links yourself).

A useful side effect: `launchMode="singleTask"` stops being load-bearing, because a stacked second
activity instance still finds the pending record.

## The default pending store is not persistent

Writing the record before the launch only survives process death if the store does. The default is
`InMemoryPendingAuthorizationStore`, and it does not: **out of the box, an authorization interrupted
by process death cannot be completed.** You have to supply a persistent store to get the property
the section above describes.

The failure is worth spelling out, because nothing about it is loud. Consent happens in the Tracive
app, so your process is backgrounded for its whole duration — on Android, exactly when the OS is
most likely to reclaim it. If that happens the record goes with it, the redirect comes back to a
fresh process, `handleCallback` finds nothing, and the only thing it can report is:

```
failed — stateMismatch — "No authorization is in progress, so this redirect cannot be completed."
```

Nothing throws, nothing is logged and no diagnostic fires, because from the SDK's side that redirect
is indistinguishable from one that no `authorize()` call preceded. The user granted consent and your
app has nothing to show for it; the only way forward is to ask them to do it again. The 10-minute
maximum age is inert in this configuration too — no record ever lives long enough to expire.

Both adapter subpaths ship a store that closes it, backed by the same platform secure storage as the
tokens. The record holds a live PKCE verifier, so that is where it belongs.

```ts
import { TraciveClient, TraciveMode, TraciveOAuth, TraciveScopes } from '@tracive/sdk-react-native';
// Expo — needs expo-secure-store.
import {
  expoSecurePendingAuthorizationStore,
  expoSecureTokenStore,
} from '@tracive/sdk-react-native/expo';
// Bare React Native — needs react-native-keychain:
// import {
//   keychainPendingAuthorizationStore,
//   keychainTokenStore,
// } from '@tracive/sdk-react-native/bare';

const config = {
  clientId: 'your-client-id',
  redirectUri: 'https://your.app/oauth/callback',
  scopes: [TraciveScopes.scammerCheck],
};

const client = new TraciveClient({
  mode: TraciveMode.oauth(config),
  cache,
  oauth: new TraciveOAuth({
    mode: config,
    tokenStore: expoSecureTokenStore(),
    pendingStore: expoSecurePendingAuthorizationStore(),
  }),
});
```

Two things about that wiring, both easy to get wrong:

- **It goes through `oauth:`, not through a `pendingStore:` option on the client.**
  `TraciveClientOptions` forwards `tokenStore` but has no `pendingStore` field, so building the
  `TraciveOAuth` yourself is currently the only way to supply one.
- **A `TraciveOAuth` you build is used as-is.** The client wires up its own only when you do not
  pass one, so `environment`, `transport`, `clock`, `random` and `onDiagnostic` are **not** carried
  across. Set on the client alone, they will not reach authorization — a client pointed at
  `TraciveEnvironment.sandbox` with a hand-built `TraciveOAuth` still authorizes against production.
  Pass the same values to both.

`TokenStore` defaults to in-memory for the same reason, with a comparable cost: the grant is lost on
every app restart and the user re-authorizes. That is why both stores are supplied together above.

Neither default can be made persistent without this package depending on a storage library, and it
depends on none. `expo-secure-store` and `react-native-keychain` are optional peer dependencies
reached only through the adapter subpaths, and choosing between them at runtime would defeat static
analysis, confuse bundlers and turn a missing dependency into a crash report nobody can read. Either
store can equally be your own implementation of its three-method interface — a `read`, a `write` and
a `clear` over whatever secure storage you already trust.

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
  diagnostic described in [integration.md](integration.md). Ten because that is the authorization
  code's own budget — RFC 6749 puts the recommended maximum lifetime of a code at ten minutes — and
  the verifier exists only to redeem that code. Holding it longer buys no recovery: the exchange
  would reach the server and be refused there anyway, a round trip spent learning what the local
  clock already knew. `pendingAuthorizationMaxAgeSeconds` moves it if your server disagrees.
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

### A blank `installUrl` is refused, not defaulted

`new TraciveOAuth({ ..., installUrl })` takes your own install page. Pass a **blank** string and the
constructor throws `TraciveConfigurationError` with code `blank_install_url`. It is not treated as
"unset", and the built-in link is never substituted for it.

Setting the option at all says the built-in page is not where your users should go, so quietly
putting it back would override that decision without telling anyone — and a blank value means
something in your build produced an empty string, which the default would hide rather than fix. This
is a deliberate divergence from the Kotlin SDK, which folds blank into its default; it matches the
Flutter SDK, and the reasoning is the same on both: silently substituting a default for an explicit
value is the worse failure.

The refusal is at construction rather than at the launch, because the launch happens only for a user
without the Tracive app, only after a real `authorize()` call, and reports only through an optional
diagnostic — invisible on exactly the path where the SDK has nothing else to offer.

Only blank is refused. A non-blank URL is used exactly as given, wrong ones included: that failure is
yours and you can see it, which is the whole reason not to paper over it.

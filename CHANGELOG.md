# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Audit follow-up. Nothing here is a published change yet — 0.1.0 has not shipped — so this section
records what a reader of the 0.1.0 notes above would otherwise be misled by.

### Breaking

- **`partnerUserId` is now required, and a blank one is refused.** A blank one now raises a
  `blank_partner_user_id` configuration error: the type made the field required, which is worth
  nothing to a JavaScript caller or to a value that arrived from a form. It was optional in all four
  SDKs, and the documentation here told you to omit it when your integration has no user accounts.
  Following that reached a consent screen that refuses **client-side, before any network call, and
  returns no redirect at all** — so your app is handed nothing to handle, the user sees a generic
  "invalid request", and no server-side log records that it happened. The field is what the grant is
  keyed on: stored as you sent it, echoed back in `grant.revoked` and `grant.superseded` so you can
  map the event to your own customer, and what enforces one of your accounts to one Tracive account.
  Send an opaque identifier — never a raw phone number or email.

### Fixed

- **The authorize URL pointed at a host no Tracive build claims.** This SDK built
  `tracive://authorize`, a custom-scheme URL nothing registers. The Tracive app claims
  `https://tracive.id/oauth/authorize`, and `sandbox.tracive.id` for its sandbox build, as an App
  Link and a Universal Link — nothing else opens the app, so consent could not start at all. Both
  wrong spellings were pinned by their own repository's tests, so no single-repo check could have
  caught it.

- **The app-presence probe reported "not installed" on every Android device, including the ones
  holding the app.** It probed a custom-scheme URL carrying a host the app does not register, and
  Android resolves such a probe by intent-filter matching: a filter that declares a host requires
  the URI to carry a matching one. It now probes the bare scheme, which the Tracive app claims with
  a scheme-only intent-filter added for the purpose. Verified on a device — `tracivedev://` went
  from "unable to resolve Intent" to starting the app.

- **The presence probe now follows the environment.** It was hardcoded to production, so testing
  against sandbox on a device carrying only the sandbox build reported the app as absent.

### Added

- **`cancelPendingAuthorization(authorizationId?)` and `pendingAuthorizationId`.** No redirect
  arrives when the user comes back with the system gesture or the screen that started the sign-in
  is dismissed, and the host app is the only party that can see it — the SDK is never told an
  app-to-app hop was abandoned. Until now there was no way to say so, and the pending record sat in
  the store with a live PKCE verifier until the ten-minute expiry reached it.

  Pass the id whenever you can. The signal comes from a screen rather than from the code that
  called `authorize()`, and it can arrive late: a double tap starts a second attempt, and only then
  does the first screen's dismissal turn up, at which point an unqualified cancel kills the attempt
  the user is looking at. The id is memory-only, so a process that did not start the flow reports
  none and can only cancel unqualified — a cancel means "this process watched the flow end", and a
  process that opened nothing has no such observation to offer. Cancelling a record an earlier
  process left still works. The call answers whether anything was actually abandoned.

  The shape matches the Kotlin SDK's, which has had this since the beginning; Swift has its own.

- **`TraciveScopes`, the OAuth scope names as constants**, plus the `TraciveScope` union of the
  same three strings — `scammer.check`, `credits.read` and `profile.read`. Integrators were
  retyping the literals, and a mistyped scope is not a narrower grant: the authorization server
  refuses the whole consent request, so the failure is an integration that cannot authorize at all,
  visible only against a live server. The constants match the Kotlin, Swift and Flutter SDKs, and
  the suite pins the wire strings as literals rather than through the constants, so a rename fails
  the build instead of redefining the shared contract. There is deliberately no constant for the
  usage-reporting scope: this SDK does not model that endpoint. `OAuthConfiguration.scopes` still
  accepts any string, because the server's scope set is larger than the three calls made here.

### Fixed

- **A whitespace-only `idempotencyKey` counted as a key you had chosen.** The two places that ask
  "did the caller supply a key" — the header the request sends, and the single-flight latch key —
  both tested for `''` alone, so `'   '` (a trimmed-to-nothing form field, a template that
  interpolated to spaces) was treated as real. That gave the check a private latch no other check
  could ever join, defeating the collapse the latch exists for, and put a blank-looking key on the
  wire in place of a generated `sdk-<uuid>` a server-side log can attribute. Blank now means
  whitespace-only as well as empty, in both places, so the two cannot disagree. Kotlin, Swift and
  Flutter already read it this way.

  The value you pass is still sent untouched, whitespace included: it is what the server
  deduplicates on and what you recorded against the transaction.

- **The single-flight latch on checks ignored your idempotency key, and overrode what it says.**
  The latch keyed on the folded record key, the detail level and the locale — three fields that
  describe the _query_. An idempotency key describes the _transaction_, so two concurrent checks
  carrying different keys are you saying these are two billable transactions, and they were
  collapsed into one anyway: one request, one answer for both callers, and the first caller's key
  on the wire. That is the same collapse the generated key already refuses to make through the
  other door, where deriving a key from the query would "collapse two deliberate re-checks of the
  same identifier into one".

  It cost a retry budget as well. Only a caller-supplied key grants one, and a caller who supplied
  a key could be handed a flight started by a caller who had not — inheriting that flight's refusal
  to retry a 5xx, a 429 or a timeout, with nothing said about it.

  The caller's key is now part of the latch key when there is one, and the latch key is unchanged
  when there is not. **What the latch exists for is untouched**: a double-tapped button and a list
  rendering the same identifier in two cells both go through one code path with one set of options,
  so they still share a flight and are still billed once. An empty string still counts as no key,
  here as everywhere else, so it cannot split a flight that should be shared. This change is
  landing in all four SDKs together.

- **A stored grant was restored with one field of five validated.** `deserializeTokens` checked
  that `accessToken` was a string and handed `refreshToken`, `tokenType`, `expiresAtMs` and `scopes`
  straight back as it found them. That never made a damaged record work — it moved the failure
  somewhere else, later, and out of reach of the code that could have named it. `refreshToken: null`
  is not `undefined`, so the refresh path took it for a token and reached `null.trim()`, throwing a
  raw `TypeError` that is not a `TraciveError` and that no documented error path catches; before the
  blank-token rule landed it went out on the wire as the literal `refresh_token=null`. An
  `expiresAtMs` that was a string became an Invalid Date, and one that was `null` or `true` became a
  confident expiry in 1970. A `scopes` that was a string was published from `grantedScopes()` one
  character per entry.

  Every field is now checked, and a record failing any check is reported as absent — exactly as
  unparseable JSON already was, and exactly as the pending-authorization record whose unvalidated
  `createdAtMs` made `NaN > 600` false and so never expired. Absence is a state the SDK already
  handles everywhere: the caller authorizes again. An **absent** optional field is still not a
  failure — `refreshToken` and `expiresAtMs` stay optional, and `tokenType` and `scopes` keep the
  defaults they have always had — but a field that is present and of the wrong type is, `null`
  included: `serializeTokens` never writes one, so a record holding it was not written by this SDK,
  and defaulting it would be inventing a grant rather than restoring one.

  Only reachable through a persistent `TokenStore`, which is the configuration this SDK asks for.

- **A refresh response that omitted `refresh_token` threw the grant away.** RFC 6749 §6 lets a
  token endpoint leave the field out of a refresh response, and leaving it out means _keep the one
  you have_ — not _you no longer have one_. The decoder built a fresh record and copied the field
  across only when the server sent one, so a fully conforming reply left the stored grant with no
  refresh token at all: the next renewal failed with `invalidToken`, and the user was sent back
  through consent for a grant that had never ended. The token that was presented is now carried
  forward whenever the response withholds one, and a blank value counts as withheld for the same
  reason a blank access token does — it can renew nothing, so accepting it would replace a working
  credential with an unusable one. The code exchange is deliberately untouched: it has no previous
  token, so an absent one there is genuinely absent. Flutter and Swift have always carried it
  forward.

  Carrying it forward needed a second half to be worth anything. A refresh token is marked as
  presented before the request leaves, and only a **non-2xx** response takes that mark back off — so
  the carried-forward token, which is the very string that was just marked, was refused locally on
  its next use. The grant was lost one step later rather than kept. The mark now comes off whenever
  the token that comes back is the token that went out, which also repairs the same failure reached
  from the other side: a server that does not rotate answers with the identical value, and this SDK
  refused to present it a second time.

- **A whitespace-only access token was sent as `Bearer    ` instead of being repaired.** The
  damaged-grant repair added earlier in this section tested the stored access token for
  _emptiness_, so `''` healed itself and `'  '` did not — and a token of spaces or a stray newline
  reaches the store exactly the same way, through a backend that built the field by concatenation
  or a value round-tripped through a text column. The rule is now blankness, which is the test the
  Kotlin and Swift SDKs apply at the same point.

  The repair also names the blank token as the stale one when it asks for a refresh. It passed `''`
  before, which was accidentally correct only while the damaged value could only ever be `''`: the
  refresh compares the token it reads from the store against that value to spot a caller who
  arrived after somebody else's refresh, so a value that was never stored makes every such caller
  look raced and hand back the damaged grant unrepaired.

  Two neighbouring places take the same rule. A **refresh token that is only whitespace is refused
  locally** with `invalidToken` rather than presented — the repair path leads straight to it, the
  request cannot succeed, and sending it marks the value as presented, so a timeout would refuse a
  grant that was never renewable. And a **token response whose access token is only whitespace is
  rejected as malformed** rather than stored, where it would defer the failure to the next request
  and look there like a rejected grant.

- **The cache was unbounded by default, and it is an encrypted database on a user's phone.**
  `CachePolicy.maxEntries` existed but the default policy omitted it, so nothing ever evicted: the
  store gained a row for every identifier ever checked and lost one only to expiry — and a HIGH
  verdict is held for thirty days, so expiry is no bound at all on a busy app. The default is now
  **5000 entries**, the figure the Flutter SDK already used, enforced on every write and by
  `prune()`. Raise it if your app needs more; `CachePolicy.create()` cannot switch it off, which is
  deliberate.

  **Eviction now drops the entries closest to expiry** rather than the oldest, in memory and on
  disk alike. Those rows have the least value left: a one-hour `NONE` verdict goes before a
  thirty-day `HIGH` one, which is also the more expensive of the two to have to buy again. Evicting
  by age is the opposite choice whenever a long-lived verdict was stored before a short-lived one,
  and with no default cap it had never run in a shipping configuration. The Swift and Flutter SDKs
  evict in the same order.

  The `deleteWhere` criterion that expresses it is renamed from `keepNewest` to
  `keepLongestLived`, because it no longer means what the old name said: order by `expires_at_ms`
  descending, breaking a tie with `fetched_at_ms` descending. Both shipped adapters build the
  statement from `DELETE_WHERE_SQL` and needed no change. **A custom `CheckCacheStore` that
  implements `deleteWhere` itself must be updated** — an unrecognised criterion deletes nothing, so
  the cap would silently stop being enforced.

- **A refresh token could be presented to the server twice, and re-presenting one costs the whole
  grant.** The single-flight latch only ever answered simultaneous callers. The hazard it cannot see
  is sequential: a refresh that fails with no response at all — a socket timeout, a connection
  dropped mid-flight — is indistinguishable from a success whose reply was lost, so the server may
  already have rotated that token and be waiting for its replacement. The latch is clear by then and
  the store still holds the token that went out, so the next caller sent it again. That is precisely
  the pattern reuse detection exists to catch, and its answer is to revoke the grant rather than
  refuse one call — the user is signed out.

  A refresh token is now marked before the request leaves, and a marked one is refused locally with
  `invalidToken` instead of being sent. A complete HTTP response, whatever its status, takes the
  mark back off: a token endpoint that answers with an error has issued no tokens (RFC 6749 §5.2),
  so a 500 costs a call and not a grant. Only a failure with no response keeps it, and the caller is
  told to authorize again. That trade is the better one in both directions — if the token really was
  spent, the grant needed re-authorization anyway and this avoids a revocation on top of it; if it
  was not, the cost is one consent nobody strictly needed.

  A short history is kept rather than a single slot, because one slot cannot answer for a token two
  rotations back. It is emptied on sign-out, so a fresh authorization starts clean. A connect-phase
  or DNS failure would in principle prove the request never arrived, and is deliberately not
  detected: the transport is an injectable seam, so that error is whatever some other package chose
  to throw, and pattern-matching it would rest the ambiguous-versus-safe distinction on a guess.
  The Flutter SDK has the same guard, and its wording is the reference for this one.

- **A zero server TTL did not withdraw the verdict already on the device.** Both caches returned
  without writing and left any existing row exactly where it was. That honoured the server's
  instruction for the answer in hand and ignored it for the one already stored — the wrong half,
  because a zero TTL is the only channel the server has for retracting an answer that has already
  reached a device. A `HIGH` verdict the server had since corrected kept being served from disk for
  the rest of its thirty-day TTL, and no request went out that could have learned otherwise. Both
  caches now delete the row. A negative override arrives as zero, because `CachePolicy` clamps it,
  and means the same thing. The Kotlin SDK has always deleted.

- **A pending authorization record with a damaged timestamp never expired.** The deserializer
  checked `state` and `codeVerifier` and passed everything else through, so a record missing
  `createdAtMs` came back as usable. The age check then computed `(now - undefined) / 1000`, which
  is `NaN`, and every comparison against `NaN` is false — the ten-minute expiry could not fire at
  any age. The PKCE verifier stayed on the device indefinitely and a code arriving a month later
  was still exchanged, with nothing thrown and nothing logged. `redirectUri` was unvalidated on the
  same path and is sent as `redirect_uri` in the exchange, so it is checked too; a record failing
  any check is now reported as absent, exactly as unparseable JSON already was.

  Only reachable when you install a persistent pending store — which is the configuration this SDK
  asks for. The in-memory default never holds a record across the write that damages it.

- **A redirect that was not this client's own was processed anyway.** Hosts are told to route every
  incoming deep link through `handleCallback`, and most apps have several that have nothing to do
  with Tracive. Every one of them failed the state comparison and came back as
  `failed` / `stateMismatch`, which the link listener then published to every subscriber as though
  a sign-in had gone wrong. A private-use scheme makes it worse, because any app on the device may
  declare one and fire it.

  `handleCallback` now answers `null` for a URL that is not addressed to your `redirectUri`, having
  touched nothing — "not mine", neither a result nor an error — and the link listener publishes
  nothing for it. Ownership is decided on scheme, authority and path, compared case-insensitively
  and with a trailing slash ignored; both leniencies are deliberate, because `state` is compared
  immediately afterwards and that is what decides whether a code may be redeemed, while being too
  strict would drop a genuine redirect and strand a user who really did sign in.

  **The signature widens to `Promise<AuthResult | null>`** on both `TraciveOAuth` and
  `TraciveClient`. This is the Kotlin SDK's shape, including the null return.

- **Signing out left the check cache full.** `TraciveClient.signOut()` cleared the grant and every
  cached verdict stayed. A cached result needs no credential to read — `source: 'CACHE'` never
  touches the network — so the departing user's check history remained on a device now reporting
  `isAuthorized() === false`, readable by whoever held it next.

  The client does the clearing because the flow cannot: `TraciveOAuth` holds no cache, and a
  `CheckCache` is injected, so two clients can share one instance. Clearing from here does empty
  that shared cache for the other client too, and that is chosen on purpose — the cost of dropping
  the rows is one re-check, the cost of keeping them is a signed-out user's history staying
  readable, and only one of those is recoverable. A partner driving `TraciveOAuth` directly owns
  their own cache and must call `clearCache()` themselves.

- **A token round trip in flight could undo a sign-out.** Discarding a credential is instantaneous
  and acquiring one is not, so a refresh or a code exchange already on the wire when `signOut()`
  ran still completed — and its write refilled the store the sign-out had just emptied. The device
  kept a live and freshly _rotated_ refresh token, the newest and longest-lived one there is, while
  reporting `isAuthorized() === false`. A user who signs out before handing their phone over got
  exactly the outcome they were trying to avoid, and nothing reported it.

  Every token write that follows a round trip is now conditional on the grant not having been
  dropped since that round trip began, and the flight fails with `grantRevoked` instead. `signOut()`
  moves that marker _before_ the revoke call rather than after, so local state is gone even if the
  revoke hangs, fails, or the process dies during it. Awaiting the in-flight work inside `signOut()`
  is not the alternative — it would make signing out wait on the network. Swift and Flutter both
  carry this guard.

- **Every check now carries an `Idempotency-Key`, generated per call when you supply none.** The
  SDK re-sends the identical POST after a 401 refresh; with no key those two attempts are
  indistinguishable to the server, so anything billed before or during authorisation is billed
  twice with no way for you to detect it. The reason for accepting that was "a 401 is rejected
  before billing" — an assumption about a server that does not exist yet, and the one premise this
  SDK otherwise refuses to make anywhere.

  A generated key is `sdk-` plus a v4 UUID, so it stays distinguishable from yours in a server-side
  log, and it is never derived from the query — deriving it would collapse two deliberate re-checks
  of the same identifier into one answer and one charge. **It buys no retry budget**: retrying is
  still gated on _your_ key, the only one that survives a process restart. An empty string is now
  treated as no key, rather than as one that granted a retry budget backed by an unusable header.

  One new requirement: the key is drawn from the SDK's CSPRNG seam, so a runtime with no WebCrypto
  polyfill and no injected `random` now fails a check with the existing, actionable
  `csprng_unavailable` error. `TraciveClient` accepts `random` for exactly this.

- **The check request named a field the API does not have.** The body sent
  `searchQueryIndex`; the field is `query`. The API accepts either a structured `input` it
  normalizes itself or a `query` string the client already folded, and the second is the one every
  Tracive SDK uses — folding on the device is what lets an invalid identifier be rejected before a
  billable call goes out. Under the wrong name the whole body is unreadable, so every check would
  have failed against a server built to the contract.

  It survived because nothing asserted the shape. The one test that looked at the body asserted
  three fields by name and never the set of keys, so a wrong spelling and a missing field both read
  as a pass. The assertions are now `toEqual` over the entire body, in both the full and minimal
  configurations, which is what makes a silent divergence from the sibling SDKs impossible to keep.

  `creditSource: "USER"` is now sent explicitly as well. It is optional and defaults to exactly
  that for a bearer-only caller, so this changes nothing the server sees today — but the sibling
  SDKs send it, and an explicit value cannot be moved later by a change to a server-side default.

- **A forged redirect could cancel a consent the user was in the middle of.** A callback whose
  `state` did not match erased the pending authorization record before returning `stateMismatch`.
  Any app on the device can hand yours a URL, so that made one `openURL` from anywhere enough to
  kill a live authorization: the user would finish consenting in the Tracive app, come back, and
  find the attempt already abandoned with nothing to complete.

  The record now survives a mismatch. The genuine redirect still completes it, and an attempt the
  user really did abandon is erased by the ten-minute expiry rather than by whoever shouted last.
  Nothing else about the mismatch changes — the state is still compared before `error` or `code` is
  read, no exchange is attempted, and the result is still `stateMismatch`.

  This matches the Kotlin, Swift and Flutter SDKs, which all keep the record for the same reason.

- **The pending authorization record was documented as surviving process death, and by default it
  does not.** No behaviour changed here. What changed is that the limitation is now stated in every
  place the guarantee used to be claimed, including the 0.1.0 note above, which says the flow
  "survives process death" — true with a persistent store, false with the default one.

  `TraciveOAuth` writes the record before opening the authorize URL, and that ordering is right, but
  it only buys anything if the store outlives the process. The default
  `InMemoryPendingAuthorizationStore` does not. Consent happens in the Tracive app, so the host
  process is backgrounded for the whole of it, which on Android is precisely when the OS reclaims
  it; the PKCE verifier went with it, the redirect returned to a process holding no record, and
  `handleCallback` reported `stateMismatch` with "No authorization is in progress". A user who had
  granted consent, an app with nothing to show for it, and no throw, no log and no diagnostic
  anywhere — because that redirect is indistinguishable from one no `authorize()` call preceded. The
  10-minute maximum age was inert in the same configuration, since no record ever lived long enough
  to expire.

  The default stays in-memory, and that is a packaging decision rather than an oversight. This
  package depends on no storage library: `expo-secure-store` and `react-native-keychain` are
  optional peer dependencies reached only through the adapter subpaths, and choosing between them at
  runtime would defeat static analysis, confuse bundlers and turn a missing dependency into a crash
  report nobody can read. Both subpaths already export a persistent `PendingAuthorizationStore`;
  what was missing was any statement that you have to pass one. The README, `docs/oauth.md` and
  diagram B of `docs/architecture.md` now say so and show the wiring, including the two parts that
  are easy to get wrong — `TraciveClientOptions` has no `pendingStore` field, so the store goes in
  through a hand-built `TraciveOAuth`, and a hand-built one inherits neither `environment` nor
  `onDiagnostic` from the client it is passed to. A new suite pins the behaviour rather than the
  prose: a record surviving a simulated process restart against a persistent store, the same record
  lost against an in-memory one, the ten-minute boundary from both sides, and every terminal
  outcome — exchange, denial, redirect error, state mismatch, confidential hand-off and `signOut()`
  — clearing the record so a live verifier is not left on the device.

- **The ten-minute pending maximum now records why it is ten.** It was a bare `?? 600` with nothing
  saying what it was chosen against. Ten minutes is the authorization code's own budget — RFC 6749
  recommends capping a code's lifetime there — and the verifier exists only to redeem that code, so
  holding it longer buys no recovery: the exchange would go out, reach the server and be refused
  there, a round trip spent learning what the local clock already knew. Shorter is worse for the
  mirror reason, since a user who reads a consent screen and switches away briefly has done nothing
  wrong. It is now a named constant carrying that reasoning, so the next person to tune it can see
  what they would be trading.

- **`detail: 'full'` used the cache, and was wrong in both directions.** It now neither reads it nor
  writes it. Two independent defects, one rule.

  _The read._ The cache stores only the fields that do not vary with `detail`, so `topChronologies`
  and `comments` are dropped on the way in — but the read path never consulted `detail`. A `full`
  request on the default `CACHE_FIRST` source was answered from that stripped row, with both fields
  `undefined` and no network call. `undefined` there is byte-identical to "the server answered in
  full and there are no incidents on file", so a partner screen could tell someone about to send
  money that an identifier with a dozen reports against it has no narrative on file. That is a wrong
  fraud answer rather than a caching subtlety: it is silent, it is on the default source, and the
  content it drops is exactly the narrative a person reads before deciding.

  _The write._ The stored projection keeps `tags` and `disclaimer`, and the row key carries no
  locale — while a `full` request is the only kind that sends one. Storing its projection filed
  localised text under a locale-less key, and the next `minimal` check, which sends no locale, read
  it straight back as if it were the default. `disclaimer` is the one string this SDK asks every
  integrator to display, so the result was a legal notice rendered in a language the user never
  asked for. Gating only the read would not have helped: the row is spoiled on the way in, by the
  `full` call, and collected later by a `minimal` call that is reading the cache quite legitimately.

  A single `cacheApplies` flag, `detail === 'minimal'`, is decided once per check and gates all four
  places the cache is touched, so the read side and the write side of the rule cannot drift apart.
  `CACHE_FIRST` skips the read, `CACHE` throws `cacheMiss` without reading anything, `SERVER_FIRST`
  surfaces the network error instead of degrading to a row, and none of them stores the response.
  The alternative — keying rows by `(query, detail, locale)` — was deliberately not taken: it is a
  larger contract change for no gain, because a full-detail row could only ever be served to a caller
  who wanted the very content it is not allowed to keep, and the Kotlin, Swift and Flutter SDKs all
  carry this same gate. The predicate is `=== 'minimal'` rather than `!== 'full'` so a third detail
  level, if one is ever added, does not silently start being cached.

  `minimal` routing is untouched and nothing in the public surface changed. Three behaviours to plan
  for: a `full` request is never served free from the cache; it no longer warms the cache, so `full`
  then `minimal` on one identifier costs two credits rather than one; and a `full` request with no
  network now fails rather than returning a partial answer that looks complete.

- **`TraciveQuery.email` rejects a value with no `@`, so a doomed lookup is no longer billed.** It
  previously rejected only an empty value, so `email('budi')` built `EMAIL_budi` and sent it. The
  server applies no shape validation to an e-mail — that is a legal record key, so it is looked up,
  missed, and charged for. Client-side rejection is the only thing that prevents the charge, exactly
  as `phone()` already does with its E.164 test. The new reason is `not_an_email`. The check is an
  `@`-presence test and deliberately not an address grammar: over-validating would refuse addresses
  the server would have matched, which is the worse failure of the two.

- **The record-key guard no longer refuses a key containing a newline.** The reserved-key rule is
  `^__.*__$`, and `.` does not match a line terminator without the `s` flag, so the server accepts
  `"__a\nb__"`. The guard implemented that rule as "at least four characters, starts with `__`,
  ends with `__`", which is stricter than the server: it refused a query the API would have
  answered. Nothing was billed by this, but a refused lookup is an answer a caller never gets. The
  guard now mirrors the pattern literally. This was carried as an open question — which side was
  wrong could not be settled without reading the server's rule — and is now settled by execution
  and pinned by the shared fixture at v5.

- **The SDK now opens the install link itself.** `authorize()` used to report `appNotInstalled` and
  open nothing, leaving the partner app to call `installUrlForDisplay()` and open the page. The
  Kotlin, Swift and Flutter SDKs all open the link and return the same result, so this was a
  contract difference rather than a style one: a partner porting an integration across SDKs got
  silently different behaviour, and on React Native a user without the Tracive app was simply never
  sent anywhere. The result is still `appNotInstalled` whatever the OS does with the link — matching
  the siblings, and honest, because the app really is missing either way — but a refused launch now
  emits an `install_link_launch_failed` diagnostic rather than passing in silence. The launch goes
  through the existing `AuthorizeLauncher` seam, so a host that substituted its own launcher owns
  this launch too. `installUrlForDisplay()` is unchanged and still supported, for a partner who
  would rather render the link than have the user jump straight out.

- **The install link now points at the page that exists.** The default was
  `https://tracive.chottu.link/app`, a guessed path: every partner's first un-onboarded user would
  have followed a link that silently 404s at the one moment the SDK has nothing else to offer them.
  It is `https://tracive.chottu.link/install`, matching the sibling SDKs. Its attribution also
  matches them now — `ref=<your client id>` and `utm_source=tracive-sdk-react-native`, replacing the
  previous `utm_source=<clientId>` / `utm_medium` pair — and a test pins the whole URL rather than
  its host, so drift from the shared contract fails the build.

- **The redaction layer is now actually applied.** `redactedProxyConfiguration`, `redactedRequest`
  and `redactedResponse` existed and were tested, and nothing in production called any of them.
  `JSON.stringify(client)` printed a partner's proxy authorization header verbatim, and the raw
  `HttpRequest` — bearer token included — was handed to the injectable transport. The 0.1.0 note
  about redacting `toJSON`/`toString` was true of the helpers and false of the shipping paths.
- **An aborted check no longer spends a credit.** `AbortSignal` reached `fetch` and neither the
  retry loop nor the backoff sleep, so an aborted call still sent its next attempt. A long
  `Retry-After` also held the caller with no way out; `TraciveClock.sleep` is now cancellable, and
  serves waits longer than a 32-bit millisecond count in slices instead of firing immediately.
- **A failing secure store no longer loses an authorization.** A rejecting pending-store read
  produced an unhandled rejection and dropped the result permanently; `handleCallback` and
  `authorize` are now total, and a throwing `onAuthResult` listener no longer stops delivery to
  the others.
- **Concurrent identical checks are billed once**, and a malformed 2xx body surfaces as a
  `TraciveError` rather than a raw `SyntaxError`.
- **A bare 401 now triggers a token refresh**, which matters behind a partner gateway.
- The Unicode guard covers the case mappings as well as NFC; the Expo plugin merges the Android
  `<queries>` block instead of overwriting it and no longer rewrites a `launchMode` the host chose;
  a redirect URI carrying userinfo or a port is rejected rather than folded into the host; the
  injected CSPRNG port reaches the cache cipher; `base64UrlDecode` rejects foreign characters
  instead of silently dropping them; body sizes are counted in bytes.

### Changed

- **The Tracive app's Android application id and URL scheme are defined once**, beside the rest of
  the app's identity in the OAuth layer; the doctor's checks and the Expo config plugin re-export
  rather than redefine them. The application id used to be written out three times and the scheme
  twice, which were not copies of a string but copies of an agreement that has to hold with the app
  on the user's device: the plugin writes the `<queries>` entry, the doctor reads it back, and the
  flow probes it at runtime. A test now asserts the literal appears in exactly one source file.

- **The retry defaults carry their reasoning.** No value changed — three attempts, a multiplier of
  two, 500ms initial backoff, 20% jitter, an 8s ceiling, all matching the sibling SDKs — but
  nothing recorded what any of them was for, which is how the same five numbers drifted apart
  across the SDKs in the first place. Each is now explained where it is defined, including the one
  that looks redundant: `maxBackoffSeconds` never binds at these defaults, because three attempts
  means the longest wait is one second. It is there for a caller who raises `maxAttempts`. The set
  is also pinned as a whole in a test, so the next change to it has to be deliberate.

- **Token renewal is reactive only: the stored expiry no longer triggers a refresh.**
  `ensureAccessToken()` hands back the stored access token without consulting `expiresAt`, and the
  30-second expiry leeway that used to sit in front of it is gone. What renews a token is the server
  answering 401 — one single-flight refresh and a replay, at most once per request, exactly as
  before. All four Tracive SDKs are settling on this one strategy.

  What you will observe: a request now goes out carrying a token that a local clock would have
  called expired, and it is that request's 401 which triggers the refresh. So one extra round trip
  per token lifetime, and three HTTP calls instead of two on the first check after a token dies —
  the check, the token POST, the replayed check. It is single-flighted, so however many callers are
  waiting only one pays for it, and it is **not billed**: authentication precedes billing and a dead
  bearer token is refused before a credit is spent. No public API changed, and nothing an integrator
  wrote needs changing.

  The reason is that the reactive path is mandatory regardless. A token can be revoked server-side,
  and one can expire between the local check and the send, so a proactive check can never replace
  the 401 handling — only run in front of it. That makes it a second mechanism for one job, and the
  redundant one is the costly half: it wins first every time, so the mandatory path almost never ran
  against a real server. A cold start holding a grant that expired while the app was closed is the
  case the leeway always swallowed, and it now has a test of its own; it passed, so this is
  redundancy removed rather than a bug found.

  The leeway also depended on a clock this SDK does not own. A device running ten minutes fast reads
  every token as expired and refreshes on every single call — and against refresh-token rotation
  with server-side reuse detection, a stream of rotations is not merely wasteful, it is how a grant
  trips revocation and signs the user out. The number was undefended in any case: 30 seconds here
  against 60 in the Flutter SDK, with no rationale written in either.

  **`expiresAt` is unchanged and still populated** — returned by the exchange, persisted by both
  adapter token stores, readable on `TraciveTokens`. Only the automatic behaviour is gone. Use it
  for a session countdown, for your own re-authorization prompt, or to record how much life a grant
  had; `oauth.refreshTokens()` renews on your trigger and shares the same single-flight latch, so it
  coalesces with the request path rather than racing it into a double rotation.

  One neighbouring case was tightened rather than removed, because the expiry check had been
  covering part of it by accident. A stored grant whose **access token is blank** while its refresh
  token is intact — reachable through `adoptTokens()`, which stores whatever a confidential client's
  backend returned without validating it — now always refreshes instead of sending `Bearer ` to be
  refused. It used to do that only when an expiry happened to be set and in the past. A grant that
  is absent altogether still throws `invalidToken`, unchanged.

- **A blank `installUrl` is refused instead of being quietly defaulted.** The constructor now
  throws `TraciveConfigurationError` with code `blank_install_url`. Nothing silently substituted the
  built-in install link before either, but a blank value survived as far as the URL builder, which
  turned it into `?ref=…&utm_source=…` — neither the default nor the partner's value, and a
  schemeless string no OS will open. Its only symptom appeared for a user without the Tracive app,
  after a real `authorize()`, through an optional diagnostic: silent on the one path where the SDK
  has nothing else to offer. Every Tracive SDK refuses a blank install link under the same
  `blank_install_url` name, on the grounds that substituting a default for a partner's explicit
  value is the worse failure. Only blank is refused — a non-blank URL is still used exactly as
  given.

- **An empty crypto address and an empty username platform now name the field that was empty**:
  `empty_address` and `empty_platform`, replacing the shared `empty_value` both used to throw. Two
  different caller mistakes were indistinguishable, so neither could be turned into a message that
  said which field to fix. `empty_value` survives and now means exactly one thing — an empty
  e-mail. The two new tokens are part of the shared cross-SDK contract, and the suite asserts them
  as literal strings so a rename fails the build.

- The public `TraciveClient.mode` is a redacted copy in proxy mode. The credentials still reach
  the wire; only what a serialiser can see has changed.
- `TraciveClock.sleep` takes an optional `AbortSignal`. Widening, not breaking: an implementation
  that ignores it still satisfies the interface.
- The shared grammar fixture moves to v3: NFC applies to bank codes too, and a vector pins it.
  34 vectors now.
- `npm run hygiene` reads a tracked term list and proves every rule can still fire before it
  scans. It could not fail in CI before. `npm run verify` and CI also run a runtime-dependency
  audit.

## [0.1.0]

First implementation. Not published to npm yet, and the Tracive API is not live yet.

### Added

- `TraciveQuery` with factories for the five identifier types the Tracive API indexes — phone,
  e-mail, bank account, IBAN, crypto address and social handle — each folding its input into the
  exact key the server indexes and rejecting anything that could not match.
- `TraciveClient` with the four `Source` routing modes, per-tier caching, retry that refuses to run
  without an idempotency key, and single-flight token refresh on a 401.
- `TraciveOAuth`: OAuth 2.0 with PKCE (S256 only), app-to-app authorization through the Tracive app,
  a pending record persisted before the browser hop so the flow survives process death, and
  cold-start link handling with duplicate suppression and a one-slot result buffer.
- A cache that is a billing feature: `InMemoryCheckCache` by default, `PersistentCheckCache` over
  any four-method `CheckCacheStore`, and per-record AES-256-GCM with the cache key bound into the
  additional authenticated data.
- Optional adapter subpaths for Expo (`expo-secure-store`, `expo-sqlite`, `expo-crypto`) and for
  bare React Native (`react-native-keychain`, `@op-engineering/op-sqlite`).
- `npx tracive-doctor`, a build-time checker for the host-app configuration that the SDK cannot
  supply and cannot verify at runtime, and an Expo config plugin that writes the same configuration
  during prebuild.
- Redacting `toJSON` and `toString` on every credential-bearing value, because JavaScript leaks
  through serialisation unless you opt out.
- The shared cross-SDK grammar fixture, pinned by sha256 and driving its vectors, rejections and
  record-key guard cases as executable tests.

### Notes

- ESM only. There is no CommonJS build.
- No native code, no autolinking, no podspec.
- There is no API key in this surface, in either mode.

# Security

## Reporting a vulnerability

Please report security issues privately through
[GitHub Security Advisories](https://github.com/pleistocent/tracive-sdk-react-native/security/advisories/new)
rather than opening a public issue. We will acknowledge receipt and keep you updated on the fix.

---

## Cryptography in this package

Two primitives, both from [`@noble`](https://paulmillr.com/noble/), both pure JavaScript with zero
transitive dependencies:

- **SHA-256** (`@noble/hashes`) — turns a folded lookup key into a cache key, and derives the PKCE
  code challenge from the verifier.
- **AES-256-GCM** (`@noble/ciphers`) — encrypts each cached record.

### Audit provenance, stated precisely

Do not describe the 2.x releases as independently audited. They are not.

| Package          | Independent audit                                                      | Version in this SDK                                                 |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@noble/hashes`  | Cure53, January 2022, **at v1.0.0**, funded by the Ethereum Foundation | 2.x — **self-audited by the maintainer, not independently audited** |
| `@noble/ciphers` | Cure53, September 2024, **at v1.0.0**, funded by OpenSats              | 2.x — **self-audited by the maintainer, not independently audited** |

The choice of pure JavaScript over a native binding is deliberate: a reviewing security team has no
Podfile entry, no Gradle module, no vendored OpenSSL and no prebuilt binary to vet. If your own
review reaches a different conclusion, the cryptography sits behind the `CacheCipher` port and you
can inject your own implementation without forking anything.

### Timing-leak disclosure

**Pure-JavaScript AES uses lookup tables and therefore leaks memory-access timings.** `@noble`'s own
documentation says so, and this SDK does not claim otherwise.

The mitigating argument, stated with its caveat attached rather than instead of it: an attacker who
can measure this process's cache timing is already executing inside the app's sandbox, where both
the plaintext (a risk tier and a few counts, all of which the user already knows) and the AES data
key itself are reachable by considerably easier means. We consider that acceptable for this payload.
We do **not** consider it acceptable for anything else, and this cipher is used for nothing else.

If your threat model includes a local side-channel adversary, inject a native `CacheCipher` — for
example one backed by a hardware-accelerated implementation — or disable the persistent cache
entirely with `CachePolicy.disabled`.

---

## What is stored, and where

| Item                             | Where                                                | Protection                                                                                                     |
| -------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| OAuth access and refresh tokens  | Platform secure storage via the `TokenStore` port    | iOS Keychain / Android Keystore-wrapped. **Never** AsyncStorage or MMKV.                                       |
| The pending PKCE record          | Same secure storage, via `PendingAuthorizationStore` | Written before the authorize URL is opened; cleared as soon as the flow terminates; aged out after 10 minutes. |
| The cache data key               | Same secure storage, via `CacheKeyStore`             | 32 random bytes, base64url-encoded because both platform stores are string-only.                               |
| Cached check results             | A SQL table via the `CheckCacheStore` port           | Each row is an AES-256-GCM envelope. The store never sees plaintext.                                           |
| The raw identifier being checked | **Nowhere**                                          | It is hashed into a 64-character cache key before anything is persisted, and it is never logged.               |

On iOS both the tokens and the cache data key use
`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. `AfterFirstUnlock` lets a background refresh or
a share-extension check read the cache while the phone is locked; `ThisDeviceOnly` keeps the items
out of device backups, so a restored backup cannot carry a live grant onto another handset.

### Row-level encryption rather than whole-database encryption

Each record is sealed with additional authenticated data of the form
`tracive.cache.v<schemaVersion>|<cacheKeyHex>`. Encrypting the database file stops the file being
read but does not stop a row being _moved_; binding the AAD to the row's own cache key makes a
row-swap fail closed as well, so a record cannot be replayed as the answer to a different
identifier. It also keeps the SQL adapter entirely crypto-free, which keeps an encrypted-SQLite
compile flag out of every integrator's build.

An unreadable record — data key rotated by an app reinstall, a keystore reset, a restore onto
another device, or tampering — causes the row to be **deleted and reported as a cache miss**. A
rotated key degrades into "the cache is cold", never into "every check now throws".

---

## Credential leakage through serialisation

JavaScript objects serialise by default, so a single `console.log` or crash-reporter breadcrumb
would otherwise print a live authorization code. The sibling SDKs for Kotlin and Swift had to opt
_in_ to leaking; JavaScript leaks unless you opt _out_.

Every credential-bearing value in this SDK therefore carries both a redacting `toJSON` and a
redacting `toString`, and a test suite asserts that no secret substring survives either path:

- `AuthResult` of type `codeReceived` — the code and verifier redact, the redirect URI does not
- `TraciveTokens` — both tokens redact; the token type and granted scopes do not
- `TraciveQuery` — the folded key holds the raw identifier and always redacts
- `CheckCacheKey` — always `CheckCacheKey(<redacted>)`
- `ProfileInfo` — the subject identifier and name redact
- `HttpRequest` / `HttpResponse` — header **names** and body **size** only
- `ProxyConfiguration` — authorization header names only, never values

---

## Randomness

`TraciveRandom` resolves `globalThis.crypto.getRandomValues` and **throws
`TraciveConfigurationError('csprng_unavailable')` when it is absent**. It never falls back to
`Math.random()`. A silent fallback would produce predictable PKCE verifiers and predictable GCM
nonces while every test still passed, which is precisely the failure mode this design refuses.

Retry jitter deliberately does **not** go through this port: it is a scheduling nicety, not a
security primitive, and a missing polyfill must not break retrying.

## Unicode normalization

Lookup keys are folded with `String.prototype.normalize('NFC')` behind a one-time self-check. A
JavaScript engine built without a real Unicode backend can implement `normalize` as an empty
function that returns its input unchanged and raises no error; under such a build every e-mail and
username key would fold wrong, miss, and still be billed. The guard converts that silent wrong
answer into `TraciveConfigurationError('nfc_unavailable')`. It throws; it never warns and continues.

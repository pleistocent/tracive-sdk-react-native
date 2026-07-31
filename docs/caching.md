# Caching

**A cache hit costs zero credits; every uncached repeat is a charge.** Read the rest of this page
with that in mind — the cache is a billing feature that happens to also be faster.

## The default is in-memory, and you should change it

`TraciveClient` defaults to `InMemoryCheckCache`, so repeat checks within a session are free with
zero native code. That is the right default for an install that must work the moment it is added,
and the wrong end state for a shipping app: a HIGH-tier verdict is cached for **30 days**, and
losing it to a process restart means re-billing the same lookup for 30 days.

A constructor must not silently open a database file and a keystore entry, so opening a persistent
cache is one explicit line:

```ts
import { openExpoCheckCache } from '@tracive/sdk-react-native/expo';
const cache = await openExpoCheckCache();

// or, bare React Native:
import { openBareCheckCache } from '@tracive/sdk-react-native/bare';
const cache = await openBareCheckCache();

const client = new TraciveClient({ mode, cache });
```

Neither ever throws. If the store cannot be opened the result is a `NoOpCheckCache` with
`lastStoreError` populated: a cache that cannot open degrades to a cold cache, never to a broken
SDK.

**Watch `cache.lastStoreError` in your telemetry.** A cache that has quietly stopped working looks
exactly like a cache that is simply cold — except for the bill.

## Bring your own store

The SQL seam is four methods. Writing one against a database your app already has is an afternoon,
and it is a first-class path, not a fallback:

```ts
interface CheckCacheStore {
  get(keyHex: string): Promise<CachedRow | undefined>;
  put(row: CachedRow): Promise<void>;
  delete(keyHex: string): Promise<void>;
  deleteWhere(criteria: {
    expiredBeforeMs?: number;
    all?: boolean;
    keepNewest?: number;
  }): Promise<number>;
  count?(): Promise<number>; // optional; only CheckCache.count() needs it
}
```

Everything crossing it is opaque: a hex digest, an encrypted blob and two integer timestamps. Your
store never sees an identifier, a risk tier or a report count.

```ts
const cache = await PersistentCheckCache.open({
  store: yourStore,
  keyStore: yourSecureKeyStore,
  policy: CachePolicy.create({ maxEntries: 5000 }),
});
```

This matters commercially as well as architecturally: the bare adapter's SQL driver unpacks to
roughly 360 MB, which will itself become a vetting question at a bank. Bringing your own store
removes that dependency entirely.

## TTLs

| Risk tier  | Default TTL |
| ---------- | ----------- |
| `HIGH`     | 30 days     |
| `ELEVATED` | 7 days      |
| `CAUTION`  | 24 hours    |
| `NONE`     | 1 hour      |

A `cacheTtlSeconds` on the response **overrides** the per-tier default while
`honorsServerTtlOverride` is on. That is the fleet-wide invalidation lever — leave it on.

A negative or zero effective TTL clamps to zero and the entry is never stored: "immediately stale"
is the only safe reading of a nonsense value, because the alternative arithmetic makes an entry
eternally fresh.

`fetchedAt` is stamped from the same clock that measures freshness, so a device with a skewed system
time cannot produce an entry that is fresh against one clock and stale against another.

## What is never cached

`topChronologies`, `comments`, `billing` and `checkId` are dropped before anything is written, and
`origin` is rewritten to `'CACHE'` so a caller can always tell a replay from a fresh answer.

The first two are free-text reports about third parties and do not belong in a partner app's local
database. `billing` describes one transaction and would be a lie if replayed. `checkId` identifies a
check that a cache hit did not perform.

Only `detail: 'minimal'` results are cached. If a future version ever caches full detail, the cache
key must become `(query, detail, locale)` — a minimal result must never satisfy a full request.

## Encryption

Each row is an AES-256-GCM envelope: `version byte || 96-bit nonce || ciphertext || 128-bit tag`,
with additional authenticated data of `tracive.cache.v<schemaVersion>|<cacheKeyHex>`.

Binding the AAD to the row's own cache key means a record cannot be replayed as the answer to a
different identifier: a moved row fails to open rather than producing a plausible verdict about the
wrong person. Bumping `schemaVersion` invalidates every existing record by construction.

The cache key itself is `SHA-256(searchQueryIndex)` as 64 lowercase hex characters. The raw
identifier is never persisted and never logged. The digest is **not** information-theoretically
secret — the E.164 input space is small enough to enumerate — which is exactly why the row payload
is encrypted rather than relying on the key being opaque.

**Divergence worth knowing about:** the nonce here is random, where the Kotlin SDK uses a durable
counter. The counter exists there only because Kotlin's common source set has no CSPRNG; React
Native has one as soon as the polyfill PKCE already requires is present, so a random nonce is
available and removes the counter-rewind hazard — a restored backup replaying an old counter value —
entirely.

An unreadable payload means the data key changed (app reinstall, keystore reset, restore onto
another device) or the record was tampered with. The row is **deleted and reported as a miss**, so a
rotated key degrades into "the cache is cold" rather than "every check now throws".

See [SECURITY.md](../SECURITY.md) for the timing-leak disclosure that comes with pure-JavaScript
AES, and for why whole-database encryption was rejected in favour of this.

## Storage faults are not misses

The distinction is load-bearing, and `source` decides who sees it:

- `CACHE_FIRST` treats a fault as a miss and goes to the server. You pay a credit; nothing is wrong.
- `CACHE` lets the fault **surface as itself**. Answering "no reports found" when the truth is "the
  disk is broken" would be a fabricated clean verdict, which is the single worst thing a fraud SDK
  can do.
- A failed cache **write** never fails a check that already succeeded. It costs one credit next
  time, and nothing more.

# Caching

**A cache hit costs zero credits; every uncached repeat is a charge.** Read the rest of this page
with that in mind — the cache is a billing feature that happens to also be faster.

Overlapping checks are covered too, and not by the cache: a check that is already in flight is not
sent a second time. Two `checkScammer` calls for the same identifier, at the same detail level and
locale, that overlap in time collapse into one billable request and both receive its result. That
covers the double-tapped button and the list screen that renders the same identifier twice — the
cache alone cannot, because its write happens after both requests have already gone out.

One case is deliberately excluded: a call that passes an `AbortSignal` runs on its own. Sharing it
would mean one caller's abort cancelling another caller's check.

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
    keepLongestLived?: number;
  }): Promise<number>;
  count?(): Promise<number>; // optional; only CheckCache.count() needs it
}
```

`keepLongestLived: n` keeps the `n` rows with the most life left and deletes the rest — order by
`expires_at_ms` descending, breaking a tie with `fetched_at_ms` descending. Both shipped adapters
build that statement from `DELETE_WHERE_SQL`, which is exported for yours to use as well.

Everything crossing it is opaque: a hex digest, an encrypted blob and two integer timestamps. Your
store never sees an identifier, a risk tier or a report count.

```ts
const cache = await PersistentCheckCache.open({
  store: yourStore,
  keyStore: yourSecureKeyStore,
  policy: CachePolicy.create({ maxEntries: 20_000 }), // 5000 by default
  // Only on a runtime with no global `crypto`. The same port `TraciveClient` takes; the cache
  // needs it for the per-record GCM nonce, and `openExpoCheckCache`/`openBareCheckCache` accept
  // it too.
  random: yourRandom,
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

A negative or zero effective TTL clamps to zero, and the entry is not stored — "immediately stale"
is the only safe reading of a nonsense value, because the alternative arithmetic makes an entry
eternally fresh. It also **deletes whatever was already held under that key**, which is the point
rather than housekeeping: a zero TTL is the only way the server can withdraw an answer that has
already reached the device. Skipping the write alone would honour the instruction for the new
result and ignore it for the stored one, so a `HIGH` verdict the server has since corrected would
keep being served for the rest of its thirty days.

`fetchedAt` is stamped from the same clock that measures freshness, so a device with a skewed system
time cannot produce an entry that is fresh against one clock and stale against another.

## How many entries are kept

`maxEntries` defaults to **5000**, the same figure the Flutter SDK uses, and the cap is enforced on
every write and by `prune()`. Expiry alone does not bound the database: a HIGH verdict is held for
thirty days, so without a cap an encrypted store on a user's phone gains a row for every identifier
ever checked and loses one only to time.

Eviction drops the entries **closest to expiry**, not the least recently used and not the oldest.
Those rows have the least value left — a one-hour `NONE` verdict goes before a thirty-day `HIGH`
one, which is also the more expensive of the two to have to buy again. LRU would mean a write on
every cache hit, which turns the cheap path into the expensive one. The Swift and Flutter SDKs evict
in the same order.

Raise the number if 5000 rows is too few for your app. There is no way to switch the cap off through
`CachePolicy.create()` — an `undefined` override means "not overridden" — and that is deliberate.

## What is never cached

`topChronologies`, `comments`, `billing` and `checkId` are dropped before anything is written, and
`origin` is rewritten to `'CACHE'` so a caller can always tell a replay from a fresh answer.

The first two are free-text reports about third parties and do not belong in a partner app's local
database. `billing` describes one transaction and would be a lie if replayed. `checkId` identifies a
check that a cache hit did not perform.

**Only `detail: 'minimal'` results are cached, and the rule is enforced on both sides.** A single
`cacheApplies` flag — `detail === 'minimal'`, decided once per check — gates the `CACHE` read, the
`CACHE_FIRST` read, every write and the `SERVER_FIRST` fallback, so the read side and the write side
cannot drift apart.

Reading a stored row for a full-detail check would return `topChronologies` and `comments` as
`undefined`, which is indistinguishable from "the server answered in full and there is nothing on
file" — a wrong fraud answer rather than a stale one, and a silent one. Writing one would be worse
still: the projection keeps `tags` and `disclaimer` in the language the `full` request asked for,
under a key that carries no locale, and the next `minimal` check sends no locale and would read that
text straight back.

So a full-detail check is never served from the cache, never warms it, and never degrades to a
cached row when the network fails. `full` then `minimal` on one identifier costs two credits rather
than one, and a full-detail check offline fails instead of returning a partial answer that looks
complete. If a future version ever caches full detail, the cache key must become
`(query, detail, locale)` first — a minimal result must never satisfy a full request. The Kotlin,
Swift and Flutter SDKs carry the identical gate.

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
  can do. At `detail: 'full'` there is no fault to surface, because the read never happens: that
  combination is a `cacheMiss` before the store is consulted.
- A failed cache **write** never fails a check that already succeeded. It costs one credit next
  time, and nothing more.

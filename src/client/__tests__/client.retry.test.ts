import { describe, expect, it } from '@jest/globals';

import {
  checkResponseBody,
  FakeClock,
  FakeTransport,
  jsonResponse,
} from '../../__tests__/support/fakes';
import { NoOpCheckCache } from '../../cache/CheckCache';
import { TraciveMode } from '../../model/TraciveMode';
import { InMemoryTokenStore } from '../../oauth/TokenStore';
import { TraciveQuery } from '../../query/TraciveQuery';
import { TraciveError } from '../../model/TraciveError';
import { backoffSecondsFor, RetryPolicy } from '../RetryPolicy';
import { systemClock, type TraciveClock } from '../TraciveClock';
import { TraciveClient } from '../TraciveClient';

const QUERY = TraciveQuery.phone('+6281234567891');

function build(options?: {
  transport?: FakeTransport;
  retryPolicy?: RetryPolicy;
  clock?: TraciveClock;
}): {
  client: TraciveClient;
  transport: FakeTransport;
  clock: FakeClock;
} {
  const transport = options?.transport ?? new FakeTransport();
  // Always built, so the handle handed back is a FakeClock and `clock.sleeps` stays readable.
  // An injected clock replaces it inside the client only.
  const clock = new FakeClock();
  const client = new TraciveClient({
    mode: TraciveMode.oauth({
      clientId: 'partner-app',
      redirectUri: 'https://your.app/oauth/callback',
      partnerUserId: 'partner-user-1',
    }),
    transport,
    clock: options?.clock ?? clock,
    cache: new NoOpCheckCache(),
    tokenStore: new InMemoryTokenStore({
      accessToken: 'live-token',
      refreshToken: 'refresh',
      tokenType: 'Bearer',
      scopes: [],
    }),
    retryPolicy: options?.retryPolicy ?? RetryPolicy.create({ jitter: 0 }),
  });
  return { client, transport, clock };
}

describe('a check without an idempotency key', () => {
  it('is NOT retried after a 5xx', async () => {
    // The SDK cannot tell whether the first attempt was already charged, and a blind retry risks
    // a double charge. Refusing is the whole point, not a limitation to work around.
    const transport = new FakeTransport().always(jsonResponse(503, { code: 'server_error' }));
    const { client } = build({ transport });
    await expect(client.checkScammer(QUERY, { source: 'SERVER' })).rejects.toMatchObject({
      kind: 'server',
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('is NOT retried after a 429', async () => {
    const transport = new FakeTransport().always(jsonResponse(429, { code: 'rate_limited' }));
    const { client } = build({ transport });
    await expect(client.checkScammer(QUERY, { source: 'SERVER' })).rejects.toMatchObject({
      kind: 'rateLimited',
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('is NOT retried after a transport failure', async () => {
    const transport = new FakeTransport().always(new Error('timeout'));
    const { client } = build({ transport });
    await expect(client.checkScammer(QUERY, { source: 'SERVER' })).rejects.toMatchObject({
      kind: 'network',
    });
    expect(transport.requests).toHaveLength(1);
  });
});

/**
 * The SDK re-sends the identical POST after a 401 refresh. Without a key on it the two attempts
 * are indistinguishable to the server, so anything billed before or during authorisation is billed
 * twice and the caller has no way to detect it. The old reasoning — "a 401 is rejected before
 * billing" — is an assumption about the server's ordering that nothing on the client can verify;
 * generating a key means no assumption is needed.
 */
describe('the key the SDK generates when the caller supplies none', () => {
  const KEY_SHAPE = /^sdk-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('is on every check, marked as the SDK’s own', async () => {
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await client.checkScammer(QUERY, { source: 'SERVER' });

    expect(transport.lastRequest?.headers['idempotency-key']).toMatch(KEY_SHAPE);
  });

  it('is carried unchanged into the replay after a 401 refresh', async () => {
    // The point of the whole exercise: the replay and the original must collapse server-side.
    const transport = new FakeTransport()
      .enqueue(jsonResponse(401, { code: 'expired_token' }))
      .enqueue(jsonResponse(200, { access_token: 'fresh', token_type: 'Bearer' }))
      .enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await client.checkScammer(QUERY, { source: 'SERVER' });

    const checks = transport.requests.filter((request) => request.url.includes('/scammer-checks'));
    expect(checks).toHaveLength(2);
    expect(checks[0]?.headers['idempotency-key']).toMatch(KEY_SHAPE);
    expect(checks[1]?.headers['idempotency-key']).toBe(checks[0]?.headers['idempotency-key']);
  });

  it('is different for each deliberate re-check of the same identifier', async () => {
    // Deriving the key from the query would collapse two checks the caller asked for separately
    // into one answer and one charge, silently.
    const transport = new FakeTransport().always(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    await client.checkScammer(QUERY, { source: 'SERVER' });
    await client.checkScammer(QUERY, { source: 'SERVER' });

    const keys = transport.requests.map((request) => request.headers['idempotency-key']);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('does not buy a retry budget the caller did not ask for', async () => {
    // Only the caller's own key does that: it is the only one that survives a process restart and
    // a new client instance, which is what a retry budget actually needs.
    const transport = new FakeTransport().always(jsonResponse(503, { code: 'server_error' }));
    const { client } = build({ transport });

    await expect(client.checkScammer(QUERY, { source: 'SERVER' })).rejects.toMatchObject({
      kind: 'server',
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('replaces an empty string, which is not a key', async () => {
    const transport = new FakeTransport().always(jsonResponse(503, { code: 'server_error' }));
    const { client } = build({ transport });

    await expect(
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: '' }),
    ).rejects.toMatchObject({ kind: 'server' });

    // Sent as-is it would have been an unusable header AND a retry budget backed by nothing.
    expect(transport.lastRequest?.headers['idempotency-key']).toMatch(KEY_SHAPE);
    expect(transport.requests).toHaveLength(1);
  });

  it('replaces a whitespace-only key, which is not a key either', async () => {
    // Same rule as the empty string, one step further out. Sent as given it would be a header the
    // server cannot deduplicate on, backed by a retry budget nothing earned.
    const transport = new FakeTransport().always(jsonResponse(503, { code: 'server_error' }));
    const { client } = build({ transport });

    await expect(
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: '   ' }),
    ).rejects.toMatchObject({ kind: 'server' });

    expect(transport.lastRequest?.headers['idempotency-key']).toMatch(KEY_SHAPE);
    expect(transport.requests).toHaveLength(1);
  });
});

describe('a check WITH an idempotency key', () => {
  it('retries a 5xx and reuses the same key on every attempt', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(503, {}))
      .enqueue(jsonResponse(503, {}))
      .enqueue(jsonResponse(200, checkResponseBody()));
    const { client } = build({ transport });

    const result = await client.checkScammer(QUERY, {
      source: 'SERVER',
      idempotencyKey: 'idem-1',
    });
    expect(result.riskTier).toBe('HIGH');
    expect(transport.requests).toHaveLength(3);
    // Reusing the key is what lets the server deduplicate; a fresh key per attempt would bill
    // each one separately.
    for (const request of transport.requests) {
      expect(request.headers['idempotency-key']).toBe('idem-1');
    }
  });

  it('stops after maxAttempts', async () => {
    const transport = new FakeTransport().always(jsonResponse(503, {}));
    const { client } = build({ transport });
    await expect(
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'idem-2' }),
    ).rejects.toMatchObject({ kind: 'server' });
    expect(transport.requests).toHaveLength(3);
  });

  it('is disabled entirely by maxAttempts: 1', async () => {
    const transport = new FakeTransport().always(jsonResponse(503, {}));
    const { client } = build({ transport, retryPolicy: RetryPolicy.disabled });
    await expect(
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'idem-3' }),
    ).rejects.toBeDefined();
    expect(transport.requests).toHaveLength(1);
  });

  it('does not retry a 4xx', async () => {
    const transport = new FakeTransport().always(jsonResponse(400, { code: 'invalid_request' }));
    const { client } = build({ transport });
    await expect(
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'idem-4' }),
    ).rejects.toMatchObject({ kind: 'invalidRequest' });
    expect(transport.requests).toHaveLength(1);
  });
});

/**
 * A retry budget is granted by the CALLER's key and by nothing else, because that key is the only
 * one that survives a process restart and a new client instance. The single-flight latch used to
 * key on the identifier, the detail level and the locale alone, so a caller who supplied a key
 * could be handed a flight started by a caller who had not — and inherit that flight's answer,
 * including the refusal to retry. The budget was lost to whoever happened to arrive first, with
 * nothing said about it.
 */
describe('a keyed check that overlaps a keyless one', () => {
  it('keeps its own retry budget instead of inheriting the keyless refusal', async () => {
    const transport = new FakeTransport().always(jsonResponse(503, { code: 'server_error' }));
    const { client } = build({ transport });

    await Promise.allSettled([
      client.checkScammer(QUERY, { source: 'SERVER' }),
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'txn-e' }),
    ]);

    // Counted on the recorded requests rather than on either caller's error, because both callers
    // fail either way and only the request log distinguishes a retried check from a shared one.
    const keyed = transport.requests.filter(
      (request) => request.headers['idempotency-key'] === 'txn-e',
    );
    expect(keyed).toHaveLength(3);
    // And the keyless caller still gets exactly one attempt, which is the rule it asked for.
    expect(transport.requests).toHaveLength(4);
  });
});

describe('GET requests', () => {
  it('are always retryable, because they have no side effects', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(503, {}))
      .enqueue(jsonResponse(200, { subscriptionCredits: 1, tier: 'free' }));
    const { client } = build({ transport });
    expect((await client.credits()).subscriptionCredits).toBe(1);
    expect(transport.requests).toHaveLength(2);
  });
});

/**
 * A 429 is surfaced on the first response, even on a request that is otherwise retryable. A spent
 * daily quota answers with a `Retry-After` that runs to the next UTC midnight — up to a day — and
 * sleeping on it inside one call held the caller for that long and then sent the request again
 * into the same refusal.
 */
describe('a 429', () => {
  const DAILY_QUOTA = jsonResponse(
    429,
    { code: 'daily_quota_exceeded', message: 'Daily quota exceeded.' },
    { 'retry-after': '43200' },
  );

  it('is not retried on credits(), which is otherwise always retryable', async () => {
    const transport = new FakeTransport().always(DAILY_QUOTA);
    const { client, clock } = build({ transport });

    await expect(client.credits()).rejects.toMatchObject({
      kind: 'rateLimited',
      retryAfterSeconds: 43_200,
      isDailyQuotaExceeded: true,
    });
    expect(transport.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('is not retried on a check that carries the caller’s idempotency key', async () => {
    const transport = new FakeTransport().always(DAILY_QUOTA);
    const { client, clock } = build({ transport });

    await expect(
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'idem-429' }),
    ).rejects.toMatchObject({ kind: 'rateLimited', retryAfterSeconds: 43_200 });
    expect(transport.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it('is not retried when it is an ordinary rate_limited either', async () => {
    const transport = new FakeTransport().always(
      jsonResponse(429, { code: 'rate_limited' }, { 'retry-after': '1' }),
    );
    const { client, clock } = build({ transport });

    await expect(client.profile()).rejects.toMatchObject({
      kind: 'rateLimited',
      retryAfterSeconds: 1,
    });
    expect(transport.requests).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });
});

describe('Retry-After', () => {
  it('beats the computed backoff on a 5xx, in the seconds form', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(503, { code: 'server_error' }, { 'retry-after': '4' }))
      .enqueue(jsonResponse(200, { subscriptionCredits: 1, tier: 'free' }));
    const { client, clock } = build({ transport });
    await client.credits();
    expect(clock.sleeps).toEqual([4]);
  });

  it('beats the computed backoff even when longer than maxBackoffSeconds', async () => {
    // A server asking for 60 seconds means 60 seconds; clamping would send the stampede back.
    const transport = new FakeTransport()
      .enqueue(jsonResponse(503, {}, { 'retry-after': '60' }))
      .enqueue(jsonResponse(200, { subscriptionCredits: 1, tier: 'free' }));
    const { client, clock } = build({ transport });
    await client.credits();
    expect(clock.sleeps).toEqual([60]);
    expect(60).toBeGreaterThan(RetryPolicy.default.maxBackoffSeconds);
  });

  it('accepts the HTTP-date form, relative to the injected clock', async () => {
    const clockNow = new FakeClock().nowMs();
    const httpDate = new Date(clockNow + 30_000).toUTCString();
    const transport = new FakeTransport()
      .enqueue(jsonResponse(503, {}, { 'retry-after': httpDate }))
      .enqueue(jsonResponse(200, { subscriptionCredits: 1, tier: 'free' }));
    const { client, clock } = build({ transport });
    await client.credits();
    expect(clock.sleeps[0]).toBeCloseTo(30, 0);
  });

  it('is ignored when the policy says so', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(503, {}, { 'retry-after': '42' }))
      .enqueue(jsonResponse(200, { subscriptionCredits: 1, tier: 'free' }));
    const { client, clock } = build({
      transport,
      retryPolicy: RetryPolicy.create({ jitter: 0, respectsRetryAfter: false }),
    });
    await client.credits();
    expect(clock.sleeps).toEqual([0.5]);
  });
});

/**
 * Pinned as a set, not one at a time, and pinned to the values every Tracive SDK uses. These
 * numbers drifted apart across the SDKs once already, because nothing recorded what any of them
 * was for; `RetryPolicy.ts` now carries the reasoning for each, and this is what stops the next
 * change from being made quietly on one platform.
 */
describe('the default retry policy', () => {
  it('is the shared set', () => {
    expect(RetryPolicy.default).toEqual({
      maxAttempts: 3,
      initialBackoffSeconds: 0.5,
      multiplier: 2,
      maxBackoffSeconds: 8,
      jitter: 0.2,
      respectsRetryAfter: true,
    });
  });

  it('never reaches its own ceiling at those values', () => {
    // Three attempts means two waits, of 0.5s and 1s. `maxBackoffSeconds` is there for a caller
    // who raises `maxAttempts`, and the schedule below is what it would then cap.
    const noJitter = RetryPolicy.create({ jitter: 0 });
    const waits = [2, RetryPolicy.default.maxAttempts].map((attempt) =>
      backoffSecondsFor(noJitter, attempt, undefined, 0.5),
    );
    expect(waits).toEqual([0.5, 1]);
    for (const wait of waits) expect(wait).toBeLessThan(RetryPolicy.default.maxBackoffSeconds);
  });
});

describe('the backoff schedule', () => {
  it('is deterministic and exponential when jitter is zero', () => {
    const policy = RetryPolicy.create({ jitter: 0 });
    expect(backoffSecondsFor(policy, 2, undefined, 0.5)).toBe(0.5);
    expect(backoffSecondsFor(policy, 3, undefined, 0.5)).toBe(1);
    expect(backoffSecondsFor(policy, 4, undefined, 0.5)).toBe(2);
    expect(backoffSecondsFor(policy, 9, undefined, 0.5)).toBe(8); // capped
  });

  it('spreads symmetrically around the computed delay when jitter is on', () => {
    const policy = RetryPolicy.create({ jitter: 0.2 });
    expect(backoffSecondsFor(policy, 2, undefined, 0)).toBeCloseTo(0.4);
    expect(backoffSecondsFor(policy, 2, undefined, 0.5)).toBeCloseTo(0.5);
    expect(backoffSecondsFor(policy, 2, undefined, 1)).toBeCloseTo(0.6);
  });

  it('clamps jitter into 0..1', () => {
    expect(RetryPolicy.create({ jitter: 5 }).jitter).toBe(1);
    expect(RetryPolicy.create({ jitter: -5 }).jitter).toBe(0);
  });

  it('never sleeps for a negative time', () => {
    expect(backoffSecondsFor(RetryPolicy.default, 2, -10, 0)).toBe(0);
  });
});

/**
 * A check costs a credit, so a request sent after the caller walked away is money spent on an
 * answer nobody will read. `signal` used to reach `fetch` and nothing else: the retry loop never
 * re-read it and the backoff sleep had no cancellation path at all.
 */
describe('an aborted call', () => {
  it('does not send a second billable request once the caller has aborted', async () => {
    const transport = new FakeTransport().always(
      jsonResponse(503, { code: 'server_error' }, { 'retry-after': '5' }),
    );
    const controller = new AbortController();
    const clock = new FakeClock();
    // Abort while the backoff is in progress — the window this bug lived in.
    clock.onSleep = () => {
      controller.abort();
    };
    const { client } = build({ transport, clock });

    await expect(
      client.checkScammer(QUERY, {
        source: 'SERVER',
        idempotencyKey: 'idem-1',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TraciveError);

    expect(transport.requests).toHaveLength(1);
  });

  it('stops even when the injected clock ignores the signal entirely', async () => {
    // A caller may supply their own clock, and an older one will not know about the second
    // parameter. The loop must therefore re-check the signal itself rather than trusting sleep.
    const deafClock: TraciveClock = {
      nowMs: () => 1_700_000_000_000,
      sleep: () => Promise.resolve(),
    };
    const transport = new FakeTransport().always(jsonResponse(503, { code: 'server_error' }));
    const controller = new AbortController();
    const { client } = build({ transport, clock: deafClock });
    controller.abort();

    await expect(
      client.checkScammer(QUERY, {
        source: 'SERVER',
        idempotencyKey: 'idem-2',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(TraciveError);

    expect(transport.requests).toHaveLength(0);
  });

  it('cuts a long Retry-After sleep short instead of hanging the caller', async () => {
    // `Retry-After: 3600` is honoured on purpose — clamping it would send the stampede back —
    // so the only way out of an hour-long wait is the abort signal.
    const controller = new AbortController();
    const startedAt = Date.now();
    const sleeping = systemClock.sleep(3600, controller.signal);
    controller.abort();
    await expect(sleeping).rejects.toBeInstanceOf(TraciveError);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('rejects immediately when the signal was already aborted before the sleep began', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(systemClock.sleep(3600, controller.signal)).rejects.toBeInstanceOf(TraciveError);
  });
});

/**
 * `backoffSecondsFor` deliberately does not clamp `Retry-After` — a server asking for a long
 * break means it, and clamping would send the stampede straight back. `setTimeout` does clamp,
 * silently and in the opposite direction: any delay over 2147483647 ms is coerced to a 32-bit
 * signed integer and fires on the NEXT TICK. A month-long break became a hot retry loop.
 */
describe('a Retry-After longer than a 32-bit millisecond count', () => {
  it('does not collapse a 30-day wait into an immediate retry', async () => {
    const controller = new AbortController();
    let resolved = false;
    const sleeping = systemClock.sleep(30 * 86_400, controller.signal).then(
      () => {
        resolved = true;
      },
      () => undefined,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(resolved).toBe(false);

    // Abort so the pending timer does not hold the test process open for a month.
    controller.abort();
    await sleeping;
  });

  it('still resolves a short wait normally', async () => {
    const startedAt = Date.now();
    await systemClock.sleep(0.02);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
  });
});

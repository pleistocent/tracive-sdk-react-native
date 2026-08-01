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

  it('does not retry a 4xx that is not a 429', async () => {
    const transport = new FakeTransport().always(jsonResponse(400, { code: 'invalid_request' }));
    const { client } = build({ transport });
    await expect(
      client.checkScammer(QUERY, { source: 'SERVER', idempotencyKey: 'idem-4' }),
    ).rejects.toMatchObject({ kind: 'invalidRequest' });
    expect(transport.requests).toHaveLength(1);
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

describe('Retry-After', () => {
  it('beats the computed backoff, in the seconds form', async () => {
    const transport = new FakeTransport()
      .enqueue(jsonResponse(429, { code: 'rate_limited' }, { 'retry-after': '42' }))
      .enqueue(jsonResponse(200, { subscriptionCredits: 1, tier: 'free' }));
    const { client, clock } = build({ transport });
    await client.credits();
    expect(clock.sleeps).toEqual([42]);
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

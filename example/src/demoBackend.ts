/**
 * A fake Tracive backend, in-process.
 *
 * WHY THIS EXISTS. Injecting it as the client's `transport` is what lets this example run on a
 * first clone with no credentials, no host to reach and no account to bill — and what makes it
 * deterministic enough for CI, where depending on an environment being up is how a suite starts
 * failing for reasons that have nothing to do with the code.
 *
 * It is also the honest way to show the SDK's headline testability property. `HttpTransport` is a
 * one-method interface precisely so a fake is short enough to read — this file is the fake a host
 * app would write for its own tests, and the same trick works in yours.
 *
 * Nothing here claims to be the real API's behaviour. It answers the shapes in the check and error
 * contracts and is deliberately crude about everything else. The sibling Flutter and Swift SDKs
 * ship the same fake for the same reason.
 */
import type { HttpRequest, HttpResponse, HttpTransport } from '@tracive/sdk-react-native';

export interface DemoBackendOptions {
  /** Makes the loading state visible. */
  readonly latencyMs?: number;
}

function json(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

function decodeObject(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class DemoBackend implements HttpTransport {
  readonly #latencyMs: number;

  /**
   * How many calls have actually reached this fake. The example puts it on screen, so a cache hit
   * is visibly NOT a call — which is the only way to tell a real cache hit from a re-render.
   */
  callCount = 0;

  /** The `Idempotency-Key` of the most recent check, so the screen can show one was sent. */
  lastIdempotencyKey: string | undefined;

  /**
   * How many access tokens this fake has issued. It starts at zero and stays there until a 401
   * forces a refresh: the grant the example plants at startup is written straight to the secure
   * store and never passes through here.
   */
  tokenSerial = 0;

  /** Armed by the screen: the next check answers 401 once, so the refresh path runs for real. */
  expireNextAccessToken = false;

  constructor(options?: DemoBackendOptions) {
    this.#latencyMs = options?.latencyMs ?? 400;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    await new Promise((resolve) => setTimeout(resolve, this.#latencyMs));
    this.callCount += 1;

    const path = request.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
    if (path.endsWith('/oauth/token')) return this.#token();
    if (path.endsWith('/oauth/revoke')) return json(200, {});
    if (path.endsWith('/scammer-checks')) return this.#check(request);
    if (path.endsWith('/credits')) return this.#credits();
    if (path.endsWith('/profile')) return this.#profile();

    return json(404, {
      error: { code: 'invalid_request', message: `The demo backend has no route for ${path}` },
    });
  }

  // -------------------------------------------------------------------------------------------

  #check(request: HttpRequest): HttpResponse {
    if (this.expireNextAccessToken) {
      this.expireNextAccessToken = false;
      // The SDK refreshes on any non-terminal 401, replays this POST with the new bearer, and
      // reuses the same Idempotency-Key so the server could collapse the two attempts.
      return json(401, {
        error: { code: 'expired_token', message: 'Simulated expired access token' },
      });
    }

    this.lastIdempotencyKey = request.headers['idempotency-key'];
    const body = decodeObject(request.body);
    const key = typeof body.query === 'string' ? body.query : '';
    const wantsFull = body.detail === 'full';

    // A stable pseudo-random bucket, so the same identifier always gets the same verdict and
    // different identifiers get different ones. Arbitrary on purpose: it is a demo, not a model.
    let sum = 7;
    for (let i = 0; i < key.length; i += 1) sum += key.charCodeAt(i);
    const bucket = key === '' ? 0 : sum % 10;
    const [tier, reports] =
      bucket <= 1
        ? (['HIGH', 27] as const)
        : bucket <= 3
          ? (['ELEVATED', 9] as const)
          : bucket <= 5
            ? (['CAUTION', 3] as const)
            : (['NONE', 0] as const);
    const credible = Math.round(reports * 0.7);

    return json(200, {
      checkId: `chk_demo_${bucket}_${this.callCount}`,
      found: tier !== 'NONE',
      riskTier: tier,
      reportTotal: reports,
      credibleReports: credible,
      ambiguousReports: reports - credible,
      ...(reports > 0
        ? { firstReportOn: '2025-11-02T04:15:00Z', lastReportOn: '2026-07-14T09:30:00Z' }
        : {}),
      fraudAmount: reports > 0 ? { IDR: reports * 1500000 } : {},
      tags: reports > 0 ? ['investment', 'social_engineering'] : [],
      relatedScammerCount: reports > 0 ? 4 : 0,
      ...(wantsFull
        ? {
            topChronologies: [
              {
                chronology:
                  'Promised 30% monthly returns, then stopped replying once the transfer cleared.',
                riskLevel: 3,
                incidentDate: '2026-06-01',
              },
            ],
            comments: [
              {
                date: '2026-06-02',
                text: 'Took my deposit and blocked me.',
                fromCredibleReport: true,
              },
            ],
          }
        : {}),
      billing: { creditSource: 'USER', unitsCharged: 1 },
      disclaimer:
        'These are user-submitted reports, not adjudicated findings. Verify independently ' +
        'before acting on them.',
      // A field this build has never heard of. It must be ignored rather than fatal — that
      // requirement, exercised.
      somethingFutureVersionAdded: { x: 1 },
    });
  }

  #credits(): HttpResponse {
    return json(200, {
      subscriptionCredits: 42,
      tier: 'PRO',
      nextResetAt: '2026-10-01T00:00:00Z',
    });
  }

  #profile(): HttpResponse {
    return json(200, {
      sub: 'usr_demo_0001',
      name: 'Demo User',
      country: 'IDN',
      tier: 'PRO',
      memberSince: '2025-03-11T00:00:00Z',
    });
  }

  #token(): HttpResponse {
    this.tokenSerial += 1;
    return json(200, {
      access_token: `demo-access-token-${this.tokenSerial}`,
      refresh_token: `demo-refresh-token-${this.tokenSerial}`,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'scammer.check',
    });
  }
}

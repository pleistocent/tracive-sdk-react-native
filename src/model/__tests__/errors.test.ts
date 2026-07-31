import { describe, expect, it } from '@jest/globals';

import {
  isTraciveError,
  parseRetryAfterSeconds,
  TraciveError,
  traciveErrorFrom,
  type TraciveErrorKind,
} from '../TraciveError';

describe('status/code to kind mapping', () => {
  it.each<[number, string, TraciveErrorKind]>([
    [400, 'invalid_request', 'invalidRequest'],
    [400, 'unsupported_input_type', 'unsupportedInputType'],
    [400, 'unsupported_credit_source', 'unsupportedCreditSource'],
    [401, 'invalid_token', 'invalidToken'],
    [401, 'expired_token', 'expiredToken'],
    [401, 'grant_revoked', 'grantRevoked'],
    [401, 'invalid_api_key', 'invalidApiKey'],
    [402, 'insufficient_user_credits', 'insufficientCredits'],
    [402, 'insufficient_credits', 'insufficientCredits'],
    [402, 'insufficient_partner_balance', 'insufficientCredits'],
    [403, 'missing_scope', 'missingScope'],
    [403, 'detail_not_permitted', 'detailNotPermitted'],
    [403, 'credential_mismatch', 'credentialMismatch'],
    [403, 'partner_suspended', 'partnerSuspended'],
    [409, 'idempotency_conflict', 'idempotencyConflict'],
    [429, 'rate_limited', 'rateLimited'],
  ])('maps (%i, %s) to %s', (status, code, kind) => {
    const error = traciveErrorFrom({ status, code });
    expect(error.kind).toBe(kind);
    expect(error.serverCode).toBe(code);
  });

  it('records which insufficient-credits variant fired', () => {
    expect(traciveErrorFrom({ status: 402, code: 'insufficient_partner_balance' }).which).toBe(
      'insufficient_partner_balance',
    );
  });
});

describe('unrecognised codes', () => {
  it('falls back by status and always carries the raw code through', () => {
    const server = traciveErrorFrom({ status: 500, code: 'something_new' });
    expect(server.kind).toBe('server');
    expect(server.serverCode).toBe('something_new');

    const unknown = traciveErrorFrom({ status: 418, code: 'i_am_a_teapot' });
    expect(unknown.kind).toBe('unknown');
    expect(unknown.serverCode).toBe('i_am_a_teapot');

    const throttled = traciveErrorFrom({ status: 429, code: 'slow_down_please' });
    expect(throttled.kind).toBe('rateLimited');
    expect(throttled.serverCode).toBe('slow_down_please');
  });

  it('never crashes on a missing code', () => {
    expect(traciveErrorFrom({ status: 503 }).kind).toBe('server');
    expect(traciveErrorFrom({ status: 418 }).serverCode).toBeUndefined();
  });

  it('keeps the check id so it can be quoted in a support ticket', () => {
    expect(traciveErrorFrom({ status: 500, checkId: 'chk_9' }).info?.checkId).toBe('chk_9');
  });
});

describe('isTransient', () => {
  it('is true only for network, rateLimited and 5xx server errors', () => {
    expect(new TraciveError({ kind: 'network' }).isTransient).toBe(true);
    expect(traciveErrorFrom({ status: 429, code: 'rate_limited' }).isTransient).toBe(true);
    expect(traciveErrorFrom({ status: 503 }).isTransient).toBe(true);

    expect(traciveErrorFrom({ status: 402, code: 'insufficient_credits' }).isTransient).toBe(false);
    expect(traciveErrorFrom({ status: 403, code: 'missing_scope' }).isTransient).toBe(false);
    expect(traciveErrorFrom({ status: 401, code: 'grant_revoked' }).isTransient).toBe(false);
    expect(traciveErrorFrom({ status: 400, code: 'invalid_request' }).isTransient).toBe(false);
  });
});

describe('Retry-After parsing', () => {
  const now = Date.parse('2026-10-21T07:00:00Z');

  it('accepts a seconds value', () => {
    expect(parseRetryAfterSeconds('120', now)).toBe(120);
  });

  it('accepts an HTTP-date and converts it to a delay', () => {
    expect(parseRetryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT', now)).toBe(28 * 60);
  });

  it('clamps a past date to zero', () => {
    expect(parseRetryAfterSeconds('Wed, 21 Oct 2026 06:00:00 GMT', now)).toBe(0);
  });

  it('returns undefined for anything else', () => {
    expect(parseRetryAfterSeconds(undefined, now)).toBeUndefined();
    expect(parseRetryAfterSeconds('', now)).toBeUndefined();
    expect(parseRetryAfterSeconds('soon', now)).toBeUndefined();
  });
});

describe('isTraciveError', () => {
  it('recognises its own instances and nothing else', () => {
    expect(isTraciveError(new TraciveError({ kind: 'unknown' }))).toBe(true);
    expect(isTraciveError(new Error('nope'))).toBe(false);
    expect(isTraciveError(undefined)).toBe(false);
  });

  it('survives being thrown and caught', () => {
    try {
      throw new TraciveError({ kind: 'network', message: 'offline' });
    } catch (error) {
      expect(isTraciveError(error)).toBe(true);
      expect((error as TraciveError).name).toBe('TraciveError');
      expect((error as Error).message).toBe('offline');
    }
  });
});

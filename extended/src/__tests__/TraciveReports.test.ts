import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  InMemoryTokenStore,
  ReportFormTarget,
  TraciveClient,
  TraciveEnvironment,
  TraciveError,
  TraciveMode,
  TraciveOAuth,
  type HttpRequest,
  type HttpResponse,
  type TraciveErrorKind,
} from '@pleistocent/tracive-sdk-react-native';

import { AppRegistry } from 'react-native';

import { fakeNative, REQUIREMENTS } from './fakeNative';
import { ReportDraft, type PreparedEvidence } from '../ReportDraft';
import { TraciveReports } from '../TraciveReports';
import { REPORT_ERROR_CODES, TraciveReportException } from '../TraciveReportException';
import type { ReportAccessToken } from '../ReportModels';

jest.mock('../specs/NativeTraciveReports', () => ({
  __esModule: true,
  default: require('./fakeNative').fakeNative,
}));

const NO_HANG_MS = 2_000;

// Registered once, on the first native core of the run, so it has to be caught from the start.
const HEADLESS_TASKS: string[] = [];
const registerTask = AppRegistry.registerHeadlessTask.bind(AppRegistry);
AppRegistry.registerHeadlessTask = (key, provider) => {
  HEADLESS_TASKS.push(key);
  registerTask(key, provider);
};

function reportsWith(accessToken: ReportAccessToken = async () => 'token-1'): TraciveReports {
  return new TraciveReports({ environment: TraciveEnvironment.sandbox, accessToken });
}

async function handleOf(reports: TraciveReports): Promise<number> {
  return reports.nativeHandle();
}

function draftWith(evidence: readonly PreparedEvidence[]): ReportDraft {
  return new ReportDraft({
    identifiers: ['BANK_IDN_BCA_1'],
    title: 'Title',
    chronology: 'c'.repeat(50),
    incidentDate: '2026-11-05',
    evidence,
    acceptedTerms: REQUIREMENTS.terms,
  });
}

async function preparedDraft(reports: TraciveReports): Promise<ReportDraft> {
  return draftWith([await reports.prepare({ uri: 'file:///r.png', mimeType: 'image/png' })]);
}

function failure(code: string, message: string, userInfo?: object): Error {
  return Object.assign(new Error(message), { code, userInfo });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Fails rather than leaving a promise that waits on itself to the runner's timeout. */
function settles<T>(work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('It hung.')), NO_HANG_MS).unref();
    }),
  ]);
}

beforeEach(() => fakeNative.reset());

describe('construction', () => {
  it('points the native core at the environment and its Tracive build', async () => {
    await handleOf(reportsWith());
    expect(fakeNative.named('create')[0]).toEqual([
      'create',
      'https://api-sandbox.tracive.id/v1',
      'tracivesandbox',
    ]);
  });

  it('takes the Tracive build from an explicit target', async () => {
    const reports = new TraciveReports({
      environment: TraciveEnvironment.sandbox,
      accessToken: async () => 't',
      target: ReportFormTarget.production,
    });
    await handleOf(reports);
    expect(fakeNative.named('create')[0]?.[2]).toBe('tracive');
  });

  it('refuses a client without OAuth', () => {
    const client = new TraciveClient({
      mode: TraciveMode.proxy({ baseUrl: 'https://partner.example/v1' }),
      environment: TraciveEnvironment.sandbox,
    });
    expect(() => new TraciveReports({ client })).toThrow(TypeError);
  });

  it('shares one native core across calls', async () => {
    const reports = reportsWith();
    await reports.requirements();
    await reports.status('r');
    expect(fakeNative.named('create')).toHaveLength(1);
  });

  it('creates the native core again after a failed create', async () => {
    fakeNative.answers.create = () => Promise.reject(new Error('no'));
    const reports = reportsWith();
    await expect(reports.requirements()).rejects.toBeDefined();
    fakeNative.answers = {};
    await expect(reports.requirements()).resolves.toEqual(REQUIREMENTS);
  });
});

describe('tokens', () => {
  it('registers the task Android runs to keep timers going under a screen', async () => {
    await handleOf(reportsWith());
    expect(HEADLESS_TASKS).toContain('TraciveReports.keepTimers');
  });

  it('answers native, and stale reaches the callback', async () => {
    const seen: (string | null)[] = [];
    const reports = reportsWith(async (stale) => {
      seen.push(stale);
      return stale === null ? 'first' : 'second';
    });
    const handle = await handleOf(reports);
    expect(await fakeNative.askToken(handle, null)).toEqual({ token: 'first' });
    expect(await fakeNative.askToken(handle, 'first')).toEqual({ token: 'second' });
    expect(seen).toEqual([null, 'first']);
  });

  it('joins concurrent asks on one running callback, and answers each', async () => {
    const running = deferred<string>();
    let asked = 0;
    const reports = reportsWith(() => {
      asked++;
      return running.promise;
    });
    const handle = await handleOf(reports);
    const asks = [1, 2, 3].map(() => fakeNative.askToken(handle, 'stale'));
    await flush();
    running.resolve('fresh');
    const answers = await Promise.all(asks);
    expect(asked).toBe(1);
    expect(answers).toEqual([{ token: 'fresh' }, { token: 'fresh' }, { token: 'fresh' }]);
    expect(fakeNative.named('answerToken')).toHaveLength(3);
  });

  it('settles a flight, instead of leaving it waiting on itself', async () => {
    const reports = reportsWith(async () => 'token');
    const handle = await handleOf(reports);
    expect(await settles(fakeNative.askToken(handle, null))).toEqual({ token: 'token' });
    expect(await settles(fakeNative.askToken(handle, 'stale'))).toEqual({ token: 'token' });
  });

  it('settles a failed flight the same way', async () => {
    const reports = reportsWith(async () => {
      throw new Error('no');
    });
    const handle = await handleOf(reports);
    const { failure: refused } = await settles(fakeNative.askToken(handle, null));
    expect(refused?.code).toBe('SERVER');
  });

  it('asks again once a flight has ended', async () => {
    let asked = 0;
    const reports = reportsWith(async () => `token-${++asked}`);
    const handle = await handleOf(reports);
    await fakeNative.askToken(handle, null);
    expect(await fakeNative.askToken(handle, null)).toEqual({ token: 'token-2' });
  });

  it('keeps a first-call flight apart from a refresh', async () => {
    const seen: (string | null)[] = [];
    const running = deferred<string>();
    const reports = reportsWith((stale) => {
      seen.push(stale);
      return running.promise;
    });
    const handle = await handleOf(reports);
    const asks = [fakeNative.askToken(handle, null), fakeNative.askToken(handle, 'stale')];
    await flush();
    running.resolve('t');
    await Promise.all(asks);
    expect(seen).toEqual([null, 'stale']);
  });

  describe('through a real client', () => {
    const TOKEN_URL = '/oauth/token';

    function clientWith(send: (request: HttpRequest) => Promise<HttpResponse>) {
      const mode = {
        clientId: 'client',
        redirectUri: 'https://partner.example/cb',
        partnerUserId: 'user-1',
      };
      const tokenStore = new InMemoryTokenStore();
      const transport = { send };
      const oauth = new TraciveOAuth({
        mode,
        environment: TraciveEnvironment.sandbox,
        tokenStore,
        transport,
      });
      const client = new TraciveClient({
        mode: TraciveMode.oauth(mode),
        environment: TraciveEnvironment.sandbox,
        oauth,
        transport,
      });
      return { client, oauth, tokenStore };
    }

    const grant = {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      tokenType: 'Bearer',
      scopes: ['report.create'],
    };

    it('reaches single-flight refresh once however many native calls ask', async () => {
      const held = deferred<HttpResponse>();
      const sent: HttpRequest[] = [];
      const { client, oauth } = clientWith((request) => {
        sent.push(request);
        return held.promise;
      });
      await oauth.adoptTokens(grant);
      const reports = new TraciveReports({ client });
      const handle = await handleOf(reports);

      const asks = [1, 2, 3, 4].map(() => fakeNative.askToken(handle, 'old-access'));
      await flush();
      held.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ access_token: 'new', refresh_token: 'r2', token_type: 'Bearer' }),
      });
      const answers = await Promise.all(asks);

      expect(sent.filter((request) => request.url.endsWith(TOKEN_URL))).toHaveLength(1);
      expect(answers.every((answer) => answer.token === 'new')).toBe(true);
    });

    it('hands over the stored token on a first ask, with no network', async () => {
      const send = jest.fn<(request: HttpRequest) => Promise<HttpResponse>>();
      const { client, oauth } = clientWith(send);
      await oauth.adoptTokens(grant);
      const handle = await handleOf(new TraciveReports({ client }));
      expect(await fakeNative.askToken(handle, null)).toEqual({ token: 'old-access' });
      expect(send).not.toHaveBeenCalled();
    });

    it('turns no grant into needs-consent', async () => {
      const { client } = clientWith(async () => {
        throw new Error('no call expected');
      });
      const handle = await handleOf(new TraciveReports({ client }));
      const { failure: refused } = await fakeNative.askToken(handle, null);
      expect(refused?.code).toBe('NEEDS_CONSENT');
    });

    it('turns a revoked grant into needs-consent', async () => {
      const { client, oauth } = clientWith(async () => ({
        status: 400,
        headers: {},
        body: JSON.stringify({ error: 'invalid_grant' }),
      }));
      await oauth.adoptTokens(grant);
      const handle = await handleOf(new TraciveReports({ client }));
      const { failure: refused } = await fakeNative.askToken(handle, 'old-access');
      expect(refused?.code).toBe('NEEDS_CONSENT');
      expect(refused?.httpStatus).toBe(400);
    });
  });

  it.each<TraciveErrorKind>(['invalidToken', 'expiredToken', 'grantRevoked', 'missingScope'])(
    '%s becomes needs-consent on the native side',
    async (kind) => {
      const reports = reportsWith(async () => {
        throw new TraciveError({ kind, status: 401, message: 'the server said secret-text' });
      });
      const { failure: refused } = await fakeNative.askToken(await handleOf(reports), null);
      expect(refused?.code).toBe('NEEDS_CONSENT');
      expect(refused?.httpStatus).toBe(401);
      expect(refused?.message).not.toContain('secret-text');
    },
  );

  it('keeps a partner callback’s own needs-consent', async () => {
    const reports = reportsWith(async () => {
      throw new TraciveReportException('NEEDS_CONSENT', 'No grant here.');
    });
    const { failure: refused } = await fakeNative.askToken(await handleOf(reports), null);
    expect(refused).toEqual({ code: 'NEEDS_CONSENT', message: 'No grant here.' });
  });

  it('keeps a network failure a network failure', async () => {
    const reports = reportsWith(async () => {
      throw new TraciveError({ kind: 'network', message: 'dns' });
    });
    const { failure: refused } = await fakeNative.askToken(await handleOf(reports), null);
    expect(refused?.code).toBe('NETWORK');
  });

  it('carries retry-after from a rate-limited refresh', async () => {
    const reports = reportsWith(async () => {
      throw new TraciveError({ kind: 'rateLimited', status: 429, retryAfterSeconds: 7 });
    });
    const { failure: refused } = await fakeNative.askToken(await handleOf(reports), null);
    expect(refused).toMatchObject({ code: 'SERVER', httpStatus: 429, retryAfterSeconds: 7 });
  });

  it('makes a failing callback a server failure, with no text of its own', async () => {
    const reports = reportsWith(async () => {
      throw new Error('token=abc123');
    });
    const { failure: refused } = await fakeNative.askToken(await handleOf(reports), null);
    expect(refused).toEqual({ code: 'SERVER', message: 'The token call failed.' });
  });

  it('survives a callback that throws synchronously', async () => {
    const reports = reportsWith(() => {
      throw new Error('sync');
    });
    const { failure: refused } = await fakeNative.askToken(await handleOf(reports), null);
    expect(refused?.code).toBe('SERVER');
  });

  it.each([[undefined], [''], ['   '], [42]])('refuses a token of %j', async (token) => {
    const reports = reportsWith((async () => token) as unknown as ReportAccessToken);
    const { failure: refused } = await fakeNative.askToken(await handleOf(reports), null);
    expect(refused?.code).toBe('SERVER');
    expect(fakeNative.named('answerToken')).toHaveLength(0);
  });

  it('answers needs-consent for a core nothing owns any more', async () => {
    const reports = reportsWith();
    const handle = await handleOf(reports);
    await reports.dispose();
    const { failure: refused } = await fakeNative.askToken(handle, null);
    expect(refused?.code).toBe('NEEDS_CONSENT');
  });

  describe('a callback that never answers', () => {
    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('times out as NETWORK, and the next ask reaches the callback again', async () => {
      let asked = 0;
      const reports = reportsWith(() => {
        asked++;
        return asked === 1 ? new Promise<string>(() => {}) : Promise.resolve('fresh');
      });
      const handle = await handleOf(reports);

      const hung = fakeNative.askToken(handle, null);
      await flush();
      jest.advanceTimersByTime(29_999);
      await flush();
      expect(fakeNative.named('failToken')).toHaveLength(0);

      jest.advanceTimersByTime(1);
      const { failure: refused } = await hung;
      expect(refused?.code).toBe('NETWORK');

      expect(await fakeNative.askToken(handle, null)).toEqual({ token: 'fresh' });
      expect(asked).toBe(2);
    });
  });
});

describe('errors', () => {
  it.each(REPORT_ERROR_CODES)('%s maps to its code', async (code) => {
    fakeNative.answers.status = () =>
      Promise.reject(failure(code, 'From native.', { httpStatus: 429, retryAfterSeconds: 3600 }));
    const error = await reportsWith()
      .status('r')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TraciveReportException);
    expect(error).toMatchObject({
      code,
      message: 'From native.',
      httpStatus: 429,
      retryAfterSeconds: 3600,
    });
  });

  it('makes an unknown code a server failure, and drops its text', async () => {
    fakeNative.answers.status = () => Promise.reject(failure('E_NEW', 'user@example.com'));
    await expect(reportsWith().status('r')).rejects.toMatchObject({
      code: 'SERVER',
      message: 'The call failed.',
    });
  });

  it('leaves retry-after unset when native sent none', async () => {
    fakeNative.answers.status = () => Promise.reject(failure('NETWORK', 'Offline.'));
    const error = (await reportsWith()
      .status('r')
      .catch((caught: unknown) => caught)) as TraciveReportException;
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.httpStatus).toBeUndefined();
  });

  it('rejects needs-consent from a plain call', async () => {
    fakeNative.answers.requirements = () =>
      Promise.reject(failure('NEEDS_CONSENT', 'Authorize.', { httpStatus: 403 }));
    await expect(reportsWith().requirements()).rejects.toMatchObject({
      code: 'NEEDS_CONSENT',
      httpStatus: 403,
    });
  });
});

describe('submit', () => {
  it('sends the draft and its key', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    const evidence = draft.evidence[0] as PreparedEvidence;
    expect(await reports.submit(draft)).toEqual({
      type: 'submitted',
      reportId: 'report-1',
      status: 'SUBMITTED',
    });
    const [, , , wire] = fakeNative.named('submit')[0] as [string, number, number, any];
    expect(wire).toEqual({
      key: draft.idempotencyKey,
      identifiers: ['BANK_IDN_BCA_1'],
      title: 'Title',
      chronology: 'c'.repeat(50),
      incidentDate: '2026-11-05',
      evidence: [evidence.handle],
      terms: REQUIREMENTS.terms,
    });
  });

  it('gives every draft its own key', async () => {
    const reports = reportsWith();
    const evidence = await reports.prepare({ uri: 'file:///r.png', mimeType: 'image/png' });
    expect(draftWith([evidence]).idempotencyKey).not.toBe(draftWith([evidence]).idempotencyKey);
  });

  it('makes one native call for a double tap', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    const [first, second] = await Promise.all([reports.submit(draft), reports.submit(draft)]);
    expect(second).toBe(first);
    expect(fakeNative.named('submit')).toHaveLength(1);
  });

  it('retries with the same key and evidence after a failure', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    fakeNative.answers.submit = () => Promise.reject(failure('NETWORK', 'Offline.'));
    const failed = await reports.submit(draft);
    expect(failed).toMatchObject({ type: 'failed', error: { code: 'NETWORK' } });
    expect(fakeNative.named('releaseEvidence')).toHaveLength(0);

    delete fakeNative.answers.submit;
    expect((await reports.submit(draft)).type).toBe('submitted');
    const [first, second] = fakeNative.named('submit').map((call) => call[3]);
    expect(second.key).toBe(first.key);
    expect(second.evidence).toEqual(first.evidence);
  });

  it('settles, instead of leaving a submission waiting on itself', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    expect((await settles(reports.submit(draft))).type).toBe('submitted');
  });

  it('answers a filed draft without native', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    const filed = await reports.submit(draft);
    expect(await reports.submit(draft)).toBe(filed);
    expect(fakeNative.named('submit')).toHaveLength(1);
  });

  it('keeps the evidence on needs-consent', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    fakeNative.answers.submit = async () => ({ outcome: 'needsConsent' });
    expect(await reports.submit(draft)).toEqual({ type: 'needsConsent' });
    expect(draft.evidence[0]?.isReleased).toBe(false);
  });

  it('answers needs-consent for a rejected one too', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    fakeNative.answers.submit = () => Promise.reject(failure('NEEDS_CONSENT', 'Authorize.'));
    expect(await reports.submit(draft)).toEqual({ type: 'needsConsent' });
  });

  it('carries retry-after in a failed result', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    fakeNative.answers.submit = () =>
      Promise.reject(
        failure('DAILY_LIMIT_REACHED', 'Cap.', { httpStatus: 429, retryAfterSeconds: 3600 }),
      );
    expect(await reports.submit(draft)).toMatchObject({
      type: 'failed',
      error: { code: 'DAILY_LIMIT_REACHED', retryAfterSeconds: 3600 },
    });
  });

  it('sends progress to its own call only', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    const held = deferred<object>();
    fakeNative.answers.submit = () => held.promise;
    const fractions: number[] = [];
    const running = reports.submit(draft, { onProgress: (fraction) => fractions.push(fraction) });
    await flush();
    const call = fakeNative.named('submit')[0]?.[2] as number;

    fakeNative.emitProgress(call, 0.25);
    fakeNative.emitProgress(call + 1000, 0.5);
    fakeNative.emitProgress(call, 1);
    held.resolve({ outcome: 'submitted', reportId: 'r', status: 'SUBMITTED' });
    await running;
    fakeNative.emitProgress(call, 0.75);

    expect(fractions).toEqual([0.25, 1]);
  });

  it('cancels the native job on abort, and the draft can resend', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    const held = deferred<object>();
    fakeNative.answers.submit = () => held.promise;
    fakeNative.answers.onCancel = () => held.reject(failure('CANCELLED', 'Cancelled.'));
    const controller = new AbortController();

    const running = reports.submit(draft, { signal: controller.signal });
    await flush();
    const [, reportsHandle, call] = fakeNative.named('submit')[0] as [string, number, number];
    controller.abort();

    expect(fakeNative.named('cancel')[0]).toEqual(['cancel', reportsHandle, call]);
    expect(await running).toMatchObject({ type: 'failed', error: { code: 'CANCELLED' } });

    delete fakeNative.answers.submit;
    expect((await reports.submit(draft)).type).toBe('submitted');
  });

  it('asks native nothing for a signal already aborted', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    const controller = new AbortController();
    controller.abort();
    expect(await reports.submit(draft, { signal: controller.signal })).toMatchObject({
      type: 'failed',
      error: { code: 'CANCELLED' },
    });
    expect(fakeNative.named('submit')).toHaveLength(0);
  });

  it('cancels a plain call too', async () => {
    const reports = reportsWith();
    const held = deferred<object>();
    fakeNative.answers.requirements = () => held.promise;
    fakeNative.answers.onCancel = () => held.reject(failure('CANCELLED', 'Cancelled.'));
    const controller = new AbortController();
    const running = reports.requirements({ signal: controller.signal });
    await flush();
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('evidence', () => {
  it('sends a file URI as a URI, with no bytes', async () => {
    await reportsWith().prepare({ uri: 'file:///big.png', mimeType: 'image/png' });
    expect(fakeNative.named('prepare')[0]?.[3]).toEqual({
      mimeType: 'image/png',
      uri: 'file:///big.png',
    });
  });

  it('falls back to base64 for bytes', async () => {
    const bytes = new Uint8Array([104, 105, 33]);
    await reportsWith().prepare({ bytes, mimeType: 'image/png' });
    expect(fakeNative.named('prepare')[0]?.[3]).toEqual({ mimeType: 'image/png', base64: 'aGkh' });
  });

  it('takes base64 as it is', async () => {
    await reportsWith().prepare({ base64: 'aGkh', mimeType: 'image/png' });
    expect(fakeNative.named('prepare')[0]?.[3]).toEqual({ mimeType: 'image/png', base64: 'aGkh' });
  });

  it('reads the prepared file back', async () => {
    fakeNative.answers.prepare = async () => ({
      evidence: 7,
      mimeType: 'image/avif',
      byteCount: 1234,
    });
    const evidence = await reportsWith().prepare({ uri: 'f', mimeType: 'image/png' });
    expect(evidence).toMatchObject({ handle: 7, mimeType: 'image/avif', byteCount: 1234 });
  });

  it('releases the handles of a filed report', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    const evidence = draft.evidence[0] as PreparedEvidence;
    const handle = await handleOf(reports);
    await reports.submit(draft);
    expect(fakeNative.named('releaseEvidence')).toEqual([
      ['releaseEvidence', handle, evidence.handle],
    ]);
    expect(evidence.isReleased).toBe(true);
  });

  it('releases once, however often it is asked', async () => {
    const reports = reportsWith();
    const evidence = await reports.prepare({ uri: 'f', mimeType: 'image/png' });
    evidence.release();
    evidence.release();
    expect(fakeNative.named('releaseEvidence')).toHaveLength(1);
  });

  it('refuses a draft whose evidence was released, without asking native', async () => {
    const reports = reportsWith();
    const draft = await preparedDraft(reports);
    draft.evidence[0]?.release();
    expect(await reports.submit(draft)).toMatchObject({
      type: 'failed',
      error: { code: 'ATTACHMENT_INVALID' },
    });
    expect(fakeNative.named('submit')).toHaveLength(0);
  });

  it('drops everything on dispose, without a release call per file', async () => {
    const reports = reportsWith();
    const evidence = await reports.prepare({ uri: 'f', mimeType: 'image/png' });
    await reports.dispose();
    expect(evidence.isReleased).toBe(true);
    expect(fakeNative.named('dispose')).toHaveLength(1);
    expect(fakeNative.named('releaseEvidence')).toHaveLength(0);
  });

  it('refuses calls after dispose', async () => {
    const reports = reportsWith();
    await reports.requirements();
    await reports.dispose();
    await reports.dispose();
    expect(fakeNative.named('dispose')).toHaveLength(1);
    await expect(reports.requirements()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('never creates a native core just to dispose', async () => {
    await reportsWith().dispose();
    expect(fakeNative.named('create')).toHaveLength(0);
  });
});

it('reads a status', async () => {
  const reports = reportsWith();
  const handle = await handleOf(reports);
  fakeNative.answers.status = async () => 'NEED_REVISION';
  expect(await reports.status('report 1')).toBe('NEED_REVISION');
  expect(fakeNative.named('status')[0]?.[1]).toBe(handle);
  expect(fakeNative.named('status')[0]?.[3]).toBe('report 1');
});

it('opens a report in Tracive', async () => {
  const reports = reportsWith();
  fakeNative.answers.openInTracive = async () => false;
  expect(await reports.openInTracive('r')).toBe(false);
});

import {
  ReportFormTarget,
  TraciveEnvironment,
  type TraciveClient,
} from '@pleistocent/tracive-sdk-react-native';

import { reportBridge } from './ReportBridge';
import { PreparedEvidence, type ReportDraft } from './ReportDraft';
import type {
  ReportAccessToken,
  ReportFile,
  ReportRequirements,
  ReportStatus,
  SubmitResult,
} from './ReportModels';
import { reportExceptionFrom, TraciveReportException } from './TraciveReportException';

/** Longer than a refresh that retries, shorter than the limit the native core keeps for itself. */
export const TOKEN_TIMEOUT_MS = 30_000;

export interface TraciveReportsClientOptions {
  /** Uses the grant this client already holds, and its single-flight refresh. */
  readonly client: TraciveClient;
  /** The Tracive build `openInTracive` opens. Omit it to follow the client's environment. */
  readonly target?: ReportFormTarget | undefined;
}

export interface TraciveReportsTokenOptions {
  readonly environment: TraciveEnvironment;
  /**
   * For a partner that keeps tokens on its own backend. Receives the token the server just
   * refused, or null on a first call.
   *
   * Keep refresh in one place: a refresh token rotates and a reused one revokes the grant, so
   * refresh only when `stale` asks for it. Throw a `TraciveReportException` with `NEEDS_CONSENT`
   * when there is no grant.
   */
  readonly accessToken: ReportAccessToken;
  /** The Tracive build `openInTracive` opens. Omit it to follow `environment`. */
  readonly target?: ReportFormTarget | undefined;
}

export type TraciveReportsOptions = TraciveReportsClientOptions | TraciveReportsTokenOptions;

export interface ReportCallOptions {
  /** Aborting it cancels the native call, which rejects with `CANCELLED`. */
  readonly signal?: AbortSignal | undefined;
}

export interface SubmitOptions {
  /** The share of evidence uploaded, from 0 to 1. */
  readonly onProgress?: ((fraction: number) => void) | undefined;
  /** Aborting it stops the upload. `submit` answers `failed` with `CANCELLED`. */
  readonly signal?: AbortSignal | undefined;
}

function clientTokens(client: TraciveClient): ReportAccessToken {
  const { oauth } = client;
  if (oauth === undefined) throw new TypeError('TraciveReports needs a client in OAuth mode.');
  return async (stale) => {
    if (stale === null) return oauth.ensureAccessToken();
    const tokens = await oauth.refreshTokens({ staleAccessToken: stale });
    return tokens.accessToken;
  };
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TraciveReportException('NETWORK', 'The token call did not answer.'));
    }, TOKEN_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Lets a user report a scammer without leaving your app.
 *
 * ```ts
 * const reports = new TraciveReports({ client: traciveClient });
 * const requirements = await reports.requirements();
 * const evidence = await reports.prepare({ uri, mimeType: 'image/png' });
 * const draft = ReportDraft.forQuery(query, {
 *   title,
 *   chronology,
 *   incidentDate,
 *   evidence: [evidence],
 *   acceptedTerms: requirements.terms,
 * });
 * const result = await reports.submit(draft, { onProgress });
 * ```
 *
 * The user needs a Tracive account and a grant with `TraciveReportScopes.create`. Without one,
 * calls answer `NEEDS_CONSENT` or `{ type: 'needsConsent' }`: run your authorize flow with the
 * scope added, and call again.
 *
 * Evidence goes straight from the device to Tracive when `submit` runs. It never passes through
 * your servers or through JavaScript again.
 *
 * Call {@link dispose} when you are done: the native core holds an HTTP client and the prepared
 * evidence.
 */
export class TraciveReports {
  readonly #baseUrl: string;
  readonly #appUrlScheme: string;
  readonly #accessToken: ReportAccessToken;

  #native: Promise<number> | undefined;
  #disposed = false;

  readonly #tokenFlights = new Map<string | null, Promise<string>>();
  readonly #evidence = new Set<PreparedEvidence>();
  readonly #submitting = new Map<string, Promise<SubmitResult>>();
  readonly #filed = new Map<string, SubmitResult>();

  /** @throws {TypeError} for a client without OAuth. */
  constructor(options: TraciveReportsOptions) {
    const environment = 'client' in options ? options.client.environment : options.environment;
    this.#baseUrl = TraciveEnvironment.baseUrl(environment);
    this.#appUrlScheme = (options.target ?? ReportFormTarget.forEnvironment(environment)).scheme;
    this.#accessToken = 'client' in options ? clientTokens(options.client) : options.accessToken;
  }

  /** What a report must satisfy right now, and the terms the user accepts by submitting. */
  async requirements(options?: ReportCallOptions): Promise<ReportRequirements> {
    const handle = await this.nativeHandle();
    const reply = await reportBridge.call(handle, options, (native, call) =>
      native.requirements(handle, call),
    );
    return reply as ReportRequirements;
  }

  /**
   * Compresses one piece of evidence: to AVIF, under 200 KB, 1024 px on the shortest side, with
   * metadata dropped. A PDF under 1 MiB passes through.
   *
   * The file crosses to the native side here, once, and stays there until the evidence is released.
   */
  async prepare(file: ReportFile, options?: ReportCallOptions): Promise<PreparedEvidence> {
    const handle = await this.nativeHandle();
    const source = reportBridge.fileWire(file);
    const reply = (await reportBridge.call(handle, options, (native, call) =>
      native.prepare(handle, call, source),
    )) as { evidence: number; mimeType: string; byteCount: number };
    const evidence = new PreparedEvidence(
      reply.evidence,
      reply.mimeType,
      reply.byteCount,
      (released) => {
        this.#evidence.delete(released);
        reportBridge.native.releaseEvidence(handle, released.handle);
      },
    );
    this.#evidence.add(evidence);
    return evidence;
  }

  /**
   * Uploads the evidence and files the report. Failures are in the answer, not thrown.
   *
   * Call again with the same draft after a failure: finished uploads are skipped and the report is
   * created once. A call for a draft already filed, or still running, answers the same result. The
   * draft's evidence is released when the report is filed.
   */
  submit(draft: ReportDraft, options?: SubmitOptions): Promise<SubmitResult> {
    const key = draft.idempotencyKey;
    const filed = this.#filed.get(key);
    if (filed !== undefined) return Promise.resolve(filed);
    const running = this.#submitting.get(key);
    if (running !== undefined) return running;
    const submission = this.#submit(draft, options).finally(() => {
      this.#submitting.delete(key);
    });
    this.#submitting.set(key, submission);
    return submission;
  }

  /** One report's status. Needs `TraciveReportScopes.read`. Reports answer for 30 days. */
  async status(reportId: string, options?: ReportCallOptions): Promise<ReportStatus> {
    const handle = await this.nativeHandle();
    const status = await reportBridge.call(handle, options, (native, call) =>
      native.status(handle, call, reportId),
    );
    return status as ReportStatus;
  }

  /** Opens the report in the Tracive app, where a revision is made. False without the app. */
  async openInTracive(reportId: string): Promise<boolean> {
    const handle = await this.nativeHandle();
    return reportBridge.call(handle, undefined, (native) => native.openInTracive(handle, reportId));
  }

  /** Releases the native core, cancelling whatever it was doing, and all prepared evidence. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#evidence.forEach((evidence) => evidence.markReleased());
    this.#evidence.clear();
    await this.#native?.then(
      (handle) => reportBridge.dispose(handle),
      () => undefined,
    );
  }

  /** @internal The handle the screens present on. */
  nativeHandle(): Promise<number> {
    if (this.#disposed) {
      return Promise.reject(
        new TraciveReportException('CANCELLED', 'This TraciveReports was disposed.'),
      );
    }
    if (this.#native === undefined) {
      const created = reportBridge.create(this.#baseUrl, this.#appUrlScheme, this.#token);
      created.catch(() => {
        this.#native = undefined;
      });
      this.#native = created;
    }
    return this.#native;
  }

  async #submit(draft: ReportDraft, options: SubmitOptions | undefined): Promise<SubmitResult> {
    const key = draft.idempotencyKey;
    try {
      if (draft.evidence.some((evidence) => evidence.isReleased)) {
        throw new TraciveReportException('ATTACHMENT_INVALID', 'The evidence was released.');
      }
      const handle = await this.nativeHandle();
      const reply = (await reportBridge.call(handle, options, (native, call) =>
        native.submit(handle, call, {
          key,
          identifiers: [...draft.identifiers],
          title: draft.title,
          chronology: draft.chronology,
          ...(draft.comment === undefined ? {} : { comment: draft.comment }),
          incidentDate: draft.incidentDate,
          evidence: draft.evidence.map((evidence) => evidence.handle),
          terms: draft.acceptedTerms.map(({ id, version, url }) => ({ id, version, url })),
          ...(draft.language === undefined ? {} : { language: draft.language }),
        }),
      )) as { outcome: string; reportId?: string; status?: ReportStatus };
      if (reply.outcome === 'needsConsent') return { type: 'needsConsent' };
      const filed: SubmitResult = {
        type: 'submitted',
        reportId: reply.reportId as string,
        status: reply.status as ReportStatus,
      };
      this.#filed.set(key, filed);
      draft.evidence.forEach((evidence) => evidence.release());
      return filed;
    } catch (failure) {
      const error = reportExceptionFrom(failure);
      return error.code === 'NEEDS_CONSENT' ? { type: 'needsConsent' } : { type: 'failed', error };
    }
  }

  // Native calls that hit a 401 together all ask at once. Joining them here keeps a partner's
  // callback, which has no single-flight of its own, from spending a rotating token twice.
  #token: ReportAccessToken = (stale) => {
    const running = this.#tokenFlights.get(stale);
    if (running !== undefined) return running;
    const asked = new Promise<string>((resolve) => resolve(this.#accessToken(stale)));
    // A block body on purpose: `finally` waits for a promise its callback returns, so handing back
    // the flight would make it wait on itself and hang every token request.
    const flight = withTimeout(asked).finally(() => {
      this.#tokenFlights.delete(stale);
    });
    this.#tokenFlights.set(stale, flight);
    return flight;
  };
}

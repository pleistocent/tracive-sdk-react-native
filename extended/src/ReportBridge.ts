import { AppRegistry, NativeEventEmitter } from 'react-native';
import { isTraciveError } from '@pleistocent/tracive-sdk-react-native';

import { base64Encode } from './base64';
import type { ReportAccessToken, ReportFile } from './ReportModels';
import NativeTraciveReports, { type Spec } from './specs/NativeTraciveReports';
import { reportExceptionFrom, TraciveReportException } from './TraciveReportException';

const TOKEN_EVENT = 'TraciveReports.accessToken';
const PROGRESS_EVENT = 'TraciveReports.progress';
const KEEP_TIMERS_TASK = 'TraciveReports.keepTimers';

const MISSING_NATIVE_MODULE_MESSAGE =
  'This build does not contain the native module of the Tracive report SDK ' +
  '(@pleistocent/tracive-sdk-extended-react-native). Rebuild the app after installing or ' +
  'upgrading the package: `npx expo run:android` / `npx expo run:ios` (a development build; Expo ' +
  'Go cannot load it), or a Gradle build and `pod install` in a bare React Native app.';

const NO_GRANT_MESSAGE =
  'This user has not granted the report permission. Authorize, then call again.';
const TOKEN_FAILED_MESSAGE = 'The token call failed.';

function requireNative(): Spec {
  if (NativeTraciveReports == null) throw new Error(MISSING_NATIVE_MODULE_MESSAGE);
  return NativeTraciveReports;
}

/** What a failed `accessToken` means to the native core. Base's text is not passed on. */
function tokenFailure(failure: unknown): TraciveReportException {
  if (failure instanceof TraciveReportException) return failure;
  if (!isTraciveError(failure)) return new TraciveReportException('SERVER', TOKEN_FAILED_MESSAGE);
  switch (failure.kind) {
    case 'invalidToken':
    case 'expiredToken':
    case 'grantRevoked':
    case 'missingScope':
      return new TraciveReportException('NEEDS_CONSENT', NO_GRANT_MESSAGE, {
        httpStatus: failure.status,
      });
    case 'network':
      return new TraciveReportException('NETWORK', 'The Tracive API could not be reached.');
    default:
      return new TraciveReportException('SERVER', TOKEN_FAILED_MESSAGE, {
        httpStatus: failure.status,
        retryAfterSeconds: failure.retryAfterSeconds,
      });
  }
}

function fileWire(file: ReportFile): Record<string, string> {
  const { mimeType } = file;
  if ('uri' in file) return { mimeType, uri: file.uri };
  if ('base64' in file) return { mimeType, base64: file.base64 };
  return { mimeType, base64: base64Encode(file.bytes) };
}

export interface CallOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((fraction: number) => void) | undefined;
}

/** The one native module, and the routing of what it sends back. */
class ReportBridge {
  readonly #tokens = new Map<number, ReportAccessToken>();
  readonly #progress = new Map<number, (fraction: number) => void>();
  #nextCall = 1;
  #listening = false;

  get native(): Spec {
    return requireNative();
  }

  /** Creates a native core and answers its handle. */
  async create(baseUrl: string, appUrlScheme: string, tokens: ReportAccessToken): Promise<number> {
    const native = requireNative();
    this.#listen(native);
    const handle = await native.create(baseUrl, appUrlScheme);
    this.#tokens.set(handle, tokens);
    return handle;
  }

  async dispose(handle: number): Promise<void> {
    this.#tokens.delete(handle);
    await requireNative().dispose(handle);
  }

  /** Runs one native call under `signal`, with a rejection as a `TraciveReportException`. */
  async call<T>(
    reports: number,
    options: CallOptions | undefined,
    invoke: (native: Spec, call: number) => Promise<T>,
  ): Promise<T> {
    const native = requireNative();
    const signal = options?.signal;
    if (signal?.aborted === true) {
      throw new TraciveReportException('CANCELLED', 'The call was cancelled.');
    }
    const call = this.#nextCall++;
    const onAbort = () => native.cancel(reports, call);
    signal?.addEventListener('abort', onAbort);
    if (options?.onProgress !== undefined) this.#progress.set(call, options.onProgress);
    try {
      return await invoke(native, call);
    } catch (failure) {
      throw reportExceptionFrom(failure);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#progress.delete(call);
    }
  }

  fileWire(file: ReportFile): Record<string, string> {
    return fileWire(file);
  }

  #listen(native: Spec): void {
    if (this.#listening) return;
    this.#listening = true;
    // Android ends this task itself. While it runs, timers go on under a Tracive screen, which a
    // token refresh needs: `fetch` resolves on a timer.
    AppRegistry.registerHeadlessTask(KEEP_TIMERS_TASK, () => () => new Promise<void>(() => {}));
    const events = new NativeEventEmitter(native);
    events.addListener(TOKEN_EVENT, (event) => {
      void this.#answerToken(native, event as unknown as TokenRequest);
    });
    events.addListener(PROGRESS_EVENT, (event) => {
      const { call, fraction } = event as unknown as ProgressEvent;
      this.#progress.get(call)?.(fraction);
    });
  }

  async #answerToken(native: Spec, { request, reports, stale }: TokenRequest): Promise<void> {
    try {
      const tokens = this.#tokens.get(reports);
      if (tokens === undefined) throw new TraciveReportException('NEEDS_CONSENT', NO_GRANT_MESSAGE);
      const token: unknown = await tokens(stale);
      if (typeof token !== 'string' || token.trim() === '') {
        throw new TraciveReportException('SERVER', TOKEN_FAILED_MESSAGE);
      }
      native.answerToken(request, token);
    } catch (failure) {
      const { code, message, httpStatus, retryAfterSeconds } = tokenFailure(failure);
      native.failToken(request, {
        code,
        message,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      });
    }
  }
}

interface TokenRequest {
  readonly request: number;
  readonly reports: number;
  readonly stale: string | null;
}

interface ProgressEvent {
  readonly call: number;
  readonly fraction: number;
}

export const reportBridge = new ReportBridge();

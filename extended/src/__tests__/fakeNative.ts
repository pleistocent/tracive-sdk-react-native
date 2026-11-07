import { DeviceEventEmitter } from 'react-native';

import type { Spec } from '../specs/NativeTraciveReports';

type Call = readonly [string, ...any[]];

export interface TokenAnswer {
  readonly token?: string;
  readonly failure?: {
    code: string;
    message: string;
    httpStatus?: number;
    retryAfterSeconds?: number;
  };
}

export const REQUIREMENTS = {
  enabled: true,
  remainingToday: 2,
  limits: {
    titleMaxLength: 50,
    chronologyMinLength: 50,
    chronologyMaxLength: 2000,
    commentMaxLength: 150,
    maxIdentifiers: 10,
    attachmentsPerIdentifier: 5,
    extraAttachmentsWithPhone: 5,
    maxAttachmentBytes: 1048575,
    attachmentTypes: ['image/avif'],
  },
  terms: [{ id: 'TERMS_OF_SERVICE', version: 'v1.1', url: 'https://tracive.id/terms' }],
};

/** Stands in for both native halves, behind the real `NativeEventEmitter`. */
export class FakeNative implements Spec {
  calls: Call[] = [];
  answers: Record<string, (...args: any[]) => unknown> = {};
  #nextHandle = 1;
  #nextRequest = 1;
  #tokenAnswers = new Map<number, (answer: TokenAnswer) => void>();

  reset(): void {
    this.calls = [];
    this.answers = {};
  }

  named(method: string): Call[] {
    return this.calls.filter((call) => call[0] === method);
  }

  /** What the native core does when it needs a token, and how JavaScript answered. */
  askToken(reports: number, stale: string | null): Promise<TokenAnswer> {
    const request = this.#nextRequest++;
    return new Promise((resolve) => {
      this.#tokenAnswers.set(request, resolve);
      DeviceEventEmitter.emit('TraciveReports.accessToken', { request, reports, stale });
    });
  }

  emitProgress(call: number, fraction: number): void {
    DeviceEventEmitter.emit('TraciveReports.progress', { call, fraction });
  }

  async #answer(method: string, args: unknown[], fallback?: unknown): Promise<any> {
    this.calls.push([method, ...args]);
    const answer = this.answers[method];
    return answer === undefined ? fallback : answer(...args);
  }

  create(baseUrl: string, appUrlScheme: string): Promise<number> {
    return this.#answer('create', [baseUrl, appUrlScheme], this.#nextHandle++);
  }

  dispose(reports: number): Promise<void> {
    return this.#answer('dispose', [reports]);
  }

  idempotencyKey(): string {
    this.calls.push(['idempotencyKey']);
    return `key-${this.calls.length}`;
  }

  requirements(reports: number, call: number): Promise<Object> {
    return this.#answer('requirements', [reports, call], REQUIREMENTS);
  }

  prepare(reports: number, call: number, source: Object): Promise<Object> {
    return this.#answer('prepare', [reports, call, source], {
      evidence: this.calls.length + 100,
      mimeType: 'image/avif',
      byteCount: 42,
    });
  }

  releaseEvidence(reports: number, evidence: number): void {
    this.calls.push(['releaseEvidence', reports, evidence]);
  }

  submit(reports: number, call: number, draft: Object): Promise<Object> {
    return this.#answer('submit', [reports, call, draft], {
      outcome: 'submitted',
      reportId: 'report-1',
      status: 'SUBMITTED',
    });
  }

  status(reports: number, call: number, reportId: string): Promise<string> {
    return this.#answer('status', [reports, call, reportId], 'IN_REVIEW');
  }

  cancel(reports: number, call: number): void {
    this.calls.push(['cancel', reports, call]);
    this.answers.onCancel?.(reports, call);
  }

  openInTracive(reports: number, reportId: string): Promise<boolean> {
    return this.#answer('openInTracive', [reports, reportId], true);
  }

  presentForm(reports: number, request: Object): Promise<Object> {
    return this.#answer('presentForm', [reports, request], { type: 'cancelled' });
  }

  presentStatus(reports: number, request: Object): Promise<string> {
    return this.#answer('presentStatus', [reports, request], 'closed');
  }

  answerToken(request: number, token: string): void {
    this.calls.push(['answerToken', request, token]);
    this.#tokenAnswers.get(request)?.({ token });
  }

  failToken(request: number, failure: Object): void {
    this.calls.push(['failToken', request, failure]);
    this.#tokenAnswers.get(request)?.({ failure: failure as TokenAnswer['failure'] & object });
  }

  addListener(): void {}

  removeListeners(): void {}
}

export const fakeNative = new FakeNative();

import { TurboModuleRegistry, type TurboModule } from 'react-native';

/**
 * The native core behind `TraciveReports`. Codegen reads this file, so its shape is the contract
 * with `android/` and `ios/`.
 *
 * `reports` is the handle `create` answered. `call` is an id JavaScript picks, so a call can be
 * cancelled before native has answered anything.
 */
export interface Spec extends TurboModule {
  create(baseUrl: string, appUrlScheme: string): Promise<number>;
  dispose(reports: number): Promise<void>;

  idempotencyKey(): string;

  requirements(reports: number, call: number): Promise<Object>;
  /** `source` is `{ mimeType, uri }` or `{ mimeType, base64 }`. */
  prepare(reports: number, call: number, source: Object): Promise<Object>;
  releaseEvidence(reports: number, evidence: number): void;
  submit(reports: number, call: number, draft: Object): Promise<Object>;
  status(reports: number, call: number, reportId: string): Promise<string>;
  cancel(reports: number, call: number): void;
  openInTracive(reports: number, reportId: string): Promise<boolean>;

  presentForm(reports: number, request: Object): Promise<Object>;
  presentStatus(reports: number, request: Object): Promise<string>;

  /** Answers the `TraciveReports.accessToken` event with this `request`. */
  answerToken(request: number, token: string): void;
  failToken(request: number, failure: Object): void;

  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.get<Spec>('TraciveExtendedReports');

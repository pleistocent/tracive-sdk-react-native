/**
 * Nothing in this SDK fails silently. A diagnostic is the channel for conditions that are not
 * worth throwing over but that a partner must be able to see in their own telemetry — most of
 * them are host-app configuration problems whose user-visible symptom is indistinguishable from
 * "nobody wanted the feature".
 */
export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly severity: 'warning' | 'error';
  readonly hint?: string;
}

export type DiagnosticSink = (diagnostic: Diagnostic) => void;

declare const __DEV__: boolean | undefined;

/**
 * Diagnostics always reach the caller's own sink. They additionally `console.warn` in a
 * development build, where somebody is actually watching a terminal.
 */
export function emitDiagnostic(sink: DiagnosticSink | undefined, diagnostic: Diagnostic): void {
  const isDev = typeof __DEV__ !== 'undefined' && __DEV__ === true;
  if (isDev) {
    const hint = diagnostic.hint === undefined ? '' : `\n  hint: ${diagnostic.hint}`;
    // eslint-disable-next-line no-console
    console.warn(`[tracive:${diagnostic.code}] ${diagnostic.message}${hint}`);
  }
  sink?.(diagnostic);
}

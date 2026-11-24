/**
 * The QRIS owner's reply to the reports, reviewed by Tracive. Show it below the warning exactly as
 * written, and never translate it.
 */
export interface RightOfReply {
  readonly text: string;
  /** The language `text` is written in, e.g. `id`. */
  readonly language: string;
}

/** Read from the wire or the cache. `undefined` when there is no `text`. */
export function decodeRightOfReply(value: unknown): RightOfReply | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.text !== 'string') return undefined;
  // Kept without a language rather than dropped: the reply belongs beside the warning it answers.
  return {
    text: record.text,
    language: typeof record.language === 'string' ? record.language : '',
  };
}

/**
 * A file handed to the Tracive report form: a receipt screenshot or a PDF.
 *
 * The factories do not validate. `openReportForm` checks the type, the bytes and the sizes, and
 * answers `failed` with the attachment's index, so one place reports every problem in the order
 * the other three SDKs report it.
 */
export interface ReportAttachment {
  readonly bytes: Uint8Array;
  /** As given; `image/jpg` and any letter case are normalised when the package is built. */
  readonly mimeType: string;
}

function redacted(attachment: ReportAttachment): ReportAttachment {
  const describe = () =>
    `ReportAttachment(mimeType: ${attachment.mimeType}, bytes: <${attachment.bytes.length} redacted>)`;
  return Object.defineProperties(attachment, {
    toJSON: {
      value: () => ({ mimeType: attachment.mimeType, size: attachment.bytes.length }),
      enumerable: false,
    },
    toString: { value: describe, enumerable: false },
  });
}

export const ReportAttachment: {
  /** `image/jpeg` (or `image/jpg`), `image/png`, `image/webp`, `image/heic`, `image/heif`, `image/bmp`. */
  image(bytes: Uint8Array, mimeType: string): ReportAttachment;
  /** Strictly under 1 MiB; the Tracive app refuses anything larger. */
  pdf(bytes: Uint8Array): ReportAttachment;
} = {
  image(bytes: Uint8Array, mimeType: string): ReportAttachment {
    return redacted({ bytes, mimeType });
  },
  pdf(bytes: Uint8Array): ReportAttachment {
    return redacted({ bytes, mimeType: 'application/pdf' });
  },
};

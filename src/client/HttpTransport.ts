import { TraciveError } from '../model/TraciveError';

export type HttpMethod = 'GET' | 'POST';

export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * The one seam through which every byte of network traffic leaves this SDK. Inject a fake and
 * the whole client is testable without a socket.
 *
 * Implementations must throw ONLY for a transport-level failure — offline, DNS, TLS, timeout,
 * abort — and must return the response for EVERY HTTP status including 4xx and 5xx. Interpreting
 * a status is the client's job, and a transport that throws on a 402 would turn a billing answer
 * into a network error.
 */
export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/**
 * Request and response objects are redacted on serialisation: header NAMES and a body SIZE, never
 * a header value and never a body. An `Authorization: Bearer` header printed into a crash report
 * is a live credential.
 */
export function describeRequest(request: HttpRequest): {
  method: HttpMethod;
  url: string;
  headerNames: string[];
  bodyBytes: number;
} {
  return {
    method: request.method,
    url: request.url,
    headerNames: Object.keys(request.headers),
    bodyBytes: request.body === undefined ? 0 : request.body.length,
  };
}

export function redactedRequest(request: HttpRequest): HttpRequest {
  return Object.defineProperties(
    { ...request },
    {
      toJSON: { value: () => describeRequest(request), enumerable: false },
      toString: {
        value: () =>
          `HttpRequest(${request.method} ${request.url}, headers: ${Object.keys(
            request.headers,
          ).join(',')}, body: ${request.body === undefined ? 0 : request.body.length} bytes)`,
        enumerable: false,
      },
    },
  );
}

export function redactedResponse(response: HttpResponse): HttpResponse {
  return Object.defineProperties(
    { ...response },
    {
      toJSON: {
        value: () => ({
          status: response.status,
          headerNames: Object.keys(response.headers),
          bodyBytes: response.body.length,
        }),
        enumerable: false,
      },
      toString: {
        value: () =>
          `HttpResponse(status: ${response.status}, body: ${response.body.length} bytes)`,
        enumerable: false,
      },
    },
  );
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  headers.forEach((value, name) => {
    out[name.toLowerCase()] = value;
  });
  return { ...out };
}

export class FetchHttpTransport implements HttpTransport {
  readonly #fetch: typeof fetch;

  constructor(options?: { fetch?: typeof fetch }) {
    const injected = options?.fetch;
    const global = (globalThis as { fetch?: typeof fetch }).fetch;
    const resolved = injected ?? global;
    if (resolved === undefined) {
      throw new TraciveError({
        kind: 'configuration',
        message:
          'No global fetch is available and none was injected. Pass `transport` explicitly, or ' +
          'a `fetch` implementation, when constructing the client.',
      });
    }
    this.#fetch = resolved;
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    try {
      const response = await this.#fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
      // Redacted on the way out, so that a partner who wraps or logs this transport's return
      // value cannot print a `set-cookie`, a token response body or a subject id.
      return redactedResponse({
        status: response.status,
        headers: normalizeHeaders(response.headers),
        body: await response.text(),
      });
    } catch (cause) {
      // Offline, DNS, TLS, timeout and abort all land here. An aborted request is a network
      // error as far as a caller is concerned: the work stopped and nothing was learned.
      throw new TraciveError({
        kind: 'network',
        message: cause instanceof Error ? cause.message : 'The request could not be sent.',
        cause,
      });
    }
  }
}

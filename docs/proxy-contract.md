# Proxy mode (phase 2)

> **Not available yet.** Proxy mode is present in the public surface so that enabling it later is
> not a breaking change. The gateway contract below has not been exercised against a real
> deployment.

In phase 1 the SDK talks to the Tracive API directly, holding a user's OAuth grant. In phase 2 a
partner may instead route checks through their own backend:

```ts
const client = new TraciveClient({
  mode: TraciveMode.proxy({
    baseUrl: 'https://gateway.your.app/tracive',
    authHeaders: { 'x-gateway-key': yourGatewayCredential },
  }),
});
```

## What changes

- `client.oauth` is `undefined`, and `authorize()` / `handleCallback()` / `signOut()` throw. In
  proxy mode the credentials belong to your backend, not to the device.
- `client.isAuthorized()` resolves `false`, because there is no on-device grant to report on.
- Requests go to `<baseUrl>` with the same path suffixes (`/scammer-checks`, `/credits`,
  `/profile`), carrying whatever `authHeaders` you supplied and no `Authorization` header of the
  SDK's own.

## What does not change

- The lookup-key grammar. Your gateway must forward `searchQueryIndex` untouched: it is already
  folded to the exact key the server indexes, and re-folding or re-normalising it server-side would
  split one entity across several keys.
- The cache, the record-key guard, the retry rules and the error mapping.
- **There is still no API key parameter.** `authHeaders` is whatever _your own_ gateway expects
  between your app and your backend; the SDK neither defines nor interprets it. Once it is inside
  the SDK it is redacted to header names on every serialisation path — `client.mode` and the
  `HttpRequest` handed to your `HttpTransport` both print header names and never values — so it
  cannot reach a crash report through the SDK. The object literal you built and passed in is still
  yours: if you also hold a reference to it, redact or discard it on your side.

## Notes for whoever builds the gateway

- Forward the `Idempotency-Key` header unchanged. It is what lets a retry avoid a double charge, and
  a gateway that drops or regenerates it converts a safe retry into a second bill.
- Return the upstream status and error code verbatim. The SDK maps `(status, code)` to an error
  kind and carries an unrecognised code through untouched; rewriting a 402 into a 500 turns a
  billing answer into something `SERVER_FIRST` will happily mask with a cached verdict.
- Preserve `Retry-After`. On a 429 it is what `retryAfterSeconds` carries to the caller (the SDK
  never retries a 429 itself); on a 5xx it beats the SDK's computed backoff, including when it is
  longer than the configured maximum.

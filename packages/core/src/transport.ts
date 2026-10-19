import { createTransport, type BaseTransportOptions, type Transport } from "@sentry/core";

export function makeFetchTransport(options: BaseTransportOptions): Transport {
  return createTransport(options, async (request) => {
    const response = await fetch(options.url, {
      method: "POST",
      body: request.body,
      headers: options.headers,
    });
    return {
      statusCode: response.status,
      headers: {
        "x-sentry-rate-limits": response.headers.get("X-Sentry-Rate-Limits"),
        "retry-after": response.headers.get("Retry-After"),
      },
    };
  });
}

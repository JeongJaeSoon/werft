import { REQUEST_BODY_MAX_BYTES } from "@werft-ai/contracts";
import type { AmbiguousPathGuard } from "./ambiguous-path.ts";
import type { ApiRouter } from "./app.ts";

export const DEFAULT_INTERNAL_API_PORT = 3200;

/** INTERNAL_API_PORT, where /internal is served; 0 asks the OS for one. */
export function internalApiPortFromEnv(
  env: Record<string, string | undefined>,
): number {
  const raw = env.INTERNAL_API_PORT;
  if (raw === undefined || raw === "") return DEFAULT_INTERNAL_API_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port > 65_535) {
    throw new Error(`INTERNAL_API_PORT ${raw} is not a port`);
  }
  return port;
}

/**
 * One listener for one app. The public app and the internal app each get
 * their own, so a path the public listener routes can never be an /internal
 * route, however Bun rewrites it first.
 */
export function serveApiApp(
  app: ApiRouter,
  options: {
    listener: string;
    port: number;
    guard: AmbiguousPathGuard;
    hostname?: string;
  },
) {
  return Bun.serve({
    port: options.port,
    ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    // Bun's own cap (default 128 MiB) applies before any handler runs and
    // answers without the API's error envelope, so it sits above the contract
    // limit: the app produces the documented 413 up to twice the limit, and
    // only a grossly oversized upload is cut at the transport.
    maxRequestBodySize: REQUEST_BODY_MAX_BYTES * 2,
    fetch: options.guard.front(
      options.listener,
      (
        request: Request,
        server: {
          timeout(r: Request, seconds: number): void;
          requestIP(r: Request): { address: string } | null;
        },
      ): Response | Promise<Response> => {
        const peer = server.requestIP(request)?.address;
        return app.fetch(request, {
          setIdleTimeout: (seconds: number) => server.timeout(request, seconds),
          ...(peer === undefined ? {} : { clientAddress: peer }),
        });
      },
    ),
  });
}

// Test support for the samples: a fake /v1 on a loopback port and a run of
// a sample CLI against it, the way a user runs it.

export interface Seen {
  method: string;
  path: string;
  url: URL;
  headers: Headers;
  body: unknown;
  signal: AbortSignal;
}

export type Route = (request: Seen) => Response | Promise<Response>;

export const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => Response.json(body, { status, headers });

export const apiError = (status: number, code: string, details?: unknown) =>
  json(
    {
      error: {
        code,
        message: `${code} from the fake API`,
        request_id: "req_fake",
        retryable: false,
        ...(details === undefined ? {} : { details }),
      },
    },
    status,
  );

/** An SSE frame as the API sends it. */
export function frame(
  id: string,
  event: string,
  turnId: string | null,
  data: unknown,
): string {
  const envelope = {
    schema_version: 1,
    session_id: "fake-session",
    occurred_at: "2026-10-29T00:00:00.000Z",
    turn_id: turnId,
    attempt_id: null,
    data,
  };
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

/** An event stream that stays open, as a live one does, until the client leaves. */
export function sse(frames: string[], request: Seen): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(frames.join("")));
      request.signal.addEventListener("abort", () => controller.close(), {
        once: true,
      });
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

export async function runSample(
  script: string,
  route: Route,
  env: Record<string, string> = {},
) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      const entry: Seen = {
        method: request.method,
        path: url.pathname,
        url,
        headers: request.headers,
        body: text ? JSON.parse(text) : undefined,
        signal: request.signal,
      };
      seen.push(entry);
      return route(entry);
    },
  });
  try {
    const child = Bun.spawn([process.execPath, script], {
      env: {
        PATH: process.env.PATH ?? "",
        WERFT_BASE_URL: server.url.href,
        WERFT_API_KEY: "sample-agent-key",
        WERFT_AGENT_RELEASE_ID: "sha256:sample-release",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit, seen };
  } finally {
    await server.stop(true);
  }
}

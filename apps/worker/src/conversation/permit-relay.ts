import { randomBytes } from "node:crypto";

/** Only the call the relay makes, so a test double need not be a whole fetch. */
export type RelayFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

// What the engine's request carries that is the relay's to set, or the
// upstream's own to work out.
const DROPPED_HEADERS = [
  "authorization",
  "x-api-key",
  "host",
  "content-length",
];

/**
 * Where a topic session's engine sends its provider requests: a listener on
 * this host's loopback that puts the permit of the turn running now in place
 * of the key the engine was started with, and passes the request on to the
 * egress proxy's credential route. An engine holds its session's key only,
 * never a permit, and the key carries nothing while no turn of its topic
 * runs: an idle engine's request is refused here, before the proxy refuses
 * the ended permit.
 */
export class PermitRelay {
  private readonly permits = new Map<string, string | null>();
  private readonly sizes = new Map<string, number>();
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly call: RelayFetch;

  constructor(
    /** The credential route the permits are good for. */
    private readonly upstream: string,
    options: { fetch?: RelayFetch } = {},
  ) {
    this.call =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // A provider call may stream for as long as its turn runs.
      idleTimeout: 0,
      fetch: (request) => this.relay(request),
    });
  }

  /** The base URL an engine is started on. */
  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  /** A new session's key: it carries nothing until a turn holds a permit on it. */
  open(): string {
    const key = randomBytes(32).toString("hex");
    this.permits.set(key, null);
    return key;
  }

  /** The permit the session's requests carry while its turn runs. */
  hold(key: string, permit: string): void {
    if (!this.permits.has(key)) throw new Error("No such session key");
    this.permits.set(key, permit);
  }

  /** The turn ended: the session's requests carry nothing until the next. */
  release(key: string): void {
    if (this.permits.has(key)) this.permits.set(key, null);
  }

  close(key: string): void {
    this.permits.delete(key);
    this.sizes.delete(key);
  }

  /** The body of the session's last request passed on, in bytes: what the next one grows from. */
  requestBytes(key: string): number {
    return this.sizes.get(key) ?? 0;
  }

  stop(): void {
    this.server.stop(true);
  }

  private async relay(request: Request): Promise<Response> {
    const key =
      request.headers.get("x-api-key") ??
      /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const permit = key === undefined ? undefined : this.permits.get(key);
    if (permit === undefined || permit === null) {
      await request.body?.cancel();
      // In the provider's own shape, so the engine ends its turn on it.
      return Response.json(
        {
          type: "error",
          error: {
            type: "authentication_error",
            message: "no turn holds this session",
          },
        },
        { status: 401 },
      );
    }
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const name of DROPPED_HEADERS) headers.delete(name);
    headers.set("x-api-key", permit);
    // Read whole: the permit bounds a request's size, which the session is kept under.
    const body = await request.arrayBuffer();
    if (key !== undefined) this.sizes.set(key, body.byteLength);
    const response = await this.call(
      `${this.upstream.replace(/\/$/, "")}${url.pathname}${url.search}`,
      {
        method: request.method,
        headers,
        body: body.byteLength === 0 ? null : body,
        signal: request.signal,
      },
    );
    // fetch hands the body back decoded, so its encoding and length go.
    const answer = new Headers(response.headers);
    answer.delete("content-encoding");
    answer.delete("content-length");
    return new Response(response.body, {
      status: response.status,
      headers: answer,
    });
  }
}

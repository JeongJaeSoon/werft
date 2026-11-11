import {
  type AppServerTransport,
  type ExitInfo,
  RpcError,
  type RpcId,
  type ServerTraffic,
} from "../transport.ts";

type Handler = (params: Record<string, unknown>) => unknown;

/**
 * An in-memory stand-in for `codex app-server`: it answers the client's
 * requests from handlers, records them, and lets a test speak as the server
 * (notifications, and requests the client must decide).
 */
export class FakeAppServer implements AppServerTransport {
  readonly requests: Array<{
    method: string;
    params: Record<string, unknown>;
  }> = [];
  readonly notifications: string[] = [];
  readonly closed: Promise<ExitInfo>;
  private settle!: (info: ExitInfo) => void;
  private traffic: ServerTraffic | undefined;
  private nextServerId = 100;
  private readonly handlers = new Map<string, Handler>();

  /**
   * `mcp` names the servers the engine reports starting after `thread/start`,
   * and how each ends: `ready` (the default) or `failed`, or `never` to leave
   * it for the test to emit.
   */
  constructor(
    threadId = "thread-1",
    mcp: Record<string, "ready" | "failed" | "never"> = {},
  ) {
    this.closed = new Promise((resolve) => {
      this.settle = resolve;
    });
    this.on("initialize", () => ({ userAgent: "fake" }));
    const startServers = () => {
      for (const [name, end] of Object.entries(mcp)) {
        this.emit("mcpServer/startupStatus/updated", {
          name,
          status: "starting",
          threadId: null,
        });
        if (end === "never") continue;
        setTimeout(() => {
          this.emit("mcpServer/startupStatus/updated", {
            name,
            status: end,
            threadId: null,
            ...(end === "failed" ? { error: "connection refused" } : {}),
          });
        }, 0);
      }
    };
    this.on("thread/start", () => {
      startServers();
      return { thread: { id: threadId } };
    });
    this.on("thread/resume", (params) => {
      startServers();
      return { thread: { id: params.threadId } };
    });
    this.on("thread/read", () => ({ thread: { id: threadId } }));
    this.on("turn/start", () => ({ turn: { id: "turn-1" } }));
    this.on("turn/interrupt", () => ({}));
  }

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const record = (params ?? {}) as Record<string, unknown>;
    this.requests.push({ method, params: record });
    const handler = this.handlers.get(method);
    if (handler === undefined) {
      return Promise.reject(new RpcError(`${method}: not handled by the fake`));
    }
    return Promise.resolve(handler(record));
  }

  notify(method: string): void {
    this.notifications.push(method);
  }

  listen(traffic: ServerTraffic): void {
    this.traffic = traffic;
  }

  close(): Promise<void> {
    this.exit({ code: 0, signal: null, stderr: "" });
    return this.closed.then(() => undefined);
  }

  exit(info: ExitInfo): void {
    this.settle(info);
  }

  /** The server tells the client something. */
  emit(method: string, params: Record<string, unknown>): void {
    this.traffic?.notification(method, params);
  }

  /** The server asks the client to decide; resolves with the client's reply or rejects with its refusal. */
  ask(
    method: string,
    params: Record<string, unknown>,
    id: RpcId = this.nextServerId++,
  ): Promise<unknown> {
    if (this.traffic === undefined) throw new Error("Nobody is listening");
    return this.traffic.request(id, method, params);
  }

  started(method: string): Record<string, unknown> | undefined {
    return this.requests.find((r) => r.method === method)?.params;
  }
}

/**
 * The JSON-RPC conversation with a Codex app-server, behind a port so the run
 * is tested against an in-memory peer and the real process differs only in
 * where the lines come from. The wire is JSON lines without a `jsonrpc`
 * field (what `codex app-server` speaks on stdio).
 */

export type RpcId = number | string;

export type ExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The tail of the process's stderr, for the error that names why it ended. */
  stderr: string;
};

/** A refusal to answer a server request, or the server's refusal of ours. */
export class RpcError extends Error {
  override readonly name = "RpcError";
  constructor(
    message: string,
    readonly code = -32000,
  ) {
    super(message);
  }
}

/** What the app-server sends on its own: notifications and requests for a decision. */
export interface ServerTraffic {
  notification(method: string, params: Record<string, unknown>): void;
  /** Resolves with the result, or throws `RpcError` to refuse. */
  request(
    id: RpcId,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface AppServerTransport {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  listen(traffic: ServerTraffic): void;
  /** Settles when the peer is gone, whoever ended it. */
  readonly closed: Promise<ExitInfo>;
  close(): Promise<void>;
}

/** Where a `JsonlTransport` writes; the reading side calls `receive`. */
export interface Wire {
  write(line: string): void;
  /** Ends the conversation; `closed` settles once the peer is gone. */
  end(): void;
}

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class JsonlTransport implements AppServerTransport {
  readonly closed: Promise<ExitInfo>;
  private settle!: (info: ExitInfo) => void;
  private ended: ExitInfo | undefined;
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private traffic: ServerTraffic | undefined;
  private readonly early: string[] = [];

  constructor(private readonly wire: Wire) {
    this.closed = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  listen(traffic: ServerTraffic): void {
    this.traffic = traffic;
    for (const line of this.early.splice(0)) this.receive(line);
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.ended !== undefined) {
      return Promise.reject(new Error(this.endedMessage(this.ended)));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.wire.write(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.ended !== undefined) return;
    this.wire.write(
      JSON.stringify(params === undefined ? { method } : { method, params }),
    );
  }

  /** One line the peer wrote. */
  receive(line: string): void {
    if (line.trim() === "") return;
    let message: Record<string, unknown>;
    try {
      message = record(JSON.parse(line));
    } catch {
      return;
    }
    const { id, method } = message;
    const isId = typeof id === "number" || typeof id === "string";
    if (typeof method === "string") {
      if (this.traffic === undefined) {
        this.early.push(line);
        return;
      }
      const params = record(message.params);
      if (!isId) {
        this.traffic.notification(method, params);
        return;
      }
      void this.traffic.request(id, method, params).then(
        (result) => this.wire.write(JSON.stringify({ id, result })),
        (error: unknown) =>
          this.wire.write(
            JSON.stringify({
              id,
              error: {
                code: error instanceof RpcError ? error.code : -32603,
                message: error instanceof Error ? error.message : String(error),
              },
            }),
          ),
      );
      return;
    }
    if (!isId) return;
    const waiting = this.pending.get(id);
    if (waiting === undefined) return;
    this.pending.delete(id);
    const failure = record(message.error);
    if ("error" in message) {
      waiting.reject(
        new RpcError(
          typeof failure.message === "string"
            ? `${waiting.method}: ${failure.message}`
            : `${waiting.method} failed`,
          typeof failure.code === "number" ? failure.code : undefined,
        ),
      );
    } else {
      waiting.resolve(message.result);
    }
  }

  /** The peer is gone: every request in flight fails with why. */
  peerExited(info: ExitInfo): void {
    if (this.ended !== undefined) return;
    this.ended = info;
    for (const [, waiting] of this.pending) {
      waiting.reject(new Error(this.endedMessage(info)));
    }
    this.pending.clear();
    this.settle(info);
  }

  async close(): Promise<void> {
    if (this.ended === undefined) this.wire.end();
    await this.closed;
  }

  private endedMessage(info: ExitInfo): string {
    const how =
      info.signal !== null
        ? `signal ${info.signal}`
        : `code ${String(info.code)}`;
    const tail = info.stderr.trim();
    return `The Codex app-server ended (${how})${tail === "" ? "" : `: ${tail}`}`;
  }
}

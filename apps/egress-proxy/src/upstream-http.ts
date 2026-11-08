import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/**
 * One HTTP/1.1 exchange with a credential route's upstream, over a socket
 * this code opened to the address the policy judged.
 *
 * Dialled by address, the certificate still has to be checked against the
 * catalog's name before request bytes are written. `node:tls` verifies the
 * explicit `servername` during the handshake and provides that ordering.
 *
 * Deliberately minimal: one request per connection (`connection: close`),
 * the request body sent with a length — whole, or streamed at a length
 * known up front (the object store route's uploads) — no
 * `Expect: 100-continue`, no pooling.
 */

/** A response head bigger than this is refused. */
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_CHUNK_LINE_BYTES = 4 * 1024;
/** How much of the request body is handed to the socket at a time. */
const WRITE_SLICE_BYTES = 64 * 1024;
/** What the response body buffers before the socket is paused. */
const BODY_HIGH_WATER_BYTES = 256 * 1024;

/**
 * Errors from a dial that never wrote a request byte. Only these are safe to
 * retry for a POST: the upstream cannot have seen the request.
 */
const BEFORE_REQUEST = new WeakSet<Error>();
const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** True for a connection-stage failure that sent nothing. */
export function failedBeforeRequest(error: unknown): boolean {
  if (!(error instanceof Error) || !BEFORE_REQUEST.has(error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && CONNECT_CODES.has(code);
}

export type UpstreamTarget = {
  /** The judged address, dialled as is. */
  address: string;
  port: number;
  /** Fail with ETIMEDOUT when the connection is not up by then. */
  connectTimeoutMs?: number;
  /** For https: the name the certificate must carry, and extra roots. */
  tls: { serverName: string; ca?: string } | null;
};

/**
 * Whole bytes, or a stream that must deliver exactly `length` bytes: more
 * or fewer fails the exchange rather than sending a body that disagrees
 * with the length it was announced (and, for S3, signed) with.
 */
export type UpstreamBody =
  | Uint8Array
  | { stream: ReadableStream<Uint8Array>; length: number }
  | null;

export type UpstreamCall = {
  method: string;
  /** Path and query, as the request line carries them. */
  target: string;
  /** Host included; framing headers are set here. */
  headers: Array<[string, string]>;
  body: UpstreamBody;
  signal: AbortSignal;
};

/**
 * Resolves once the response head is in, with the body streaming; rejects
 * when the connection, the handshake or the head fails, which is before any
 * of the response reached the caller.
 */
export function upstreamExchange(
  target: UpstreamTarget,
  call: UpstreamCall,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket: Socket;
    let body: ReadableStreamDefaultController<Uint8Array> | null = null;
    let decoder: BodyDecoder | null = null;
    let head: Buffer = Buffer.alloc(0);
    let written = false;
    let connectTimer: ReturnType<typeof setTimeout> | null = null;

    const fail = (error: Error) => {
      socket?.destroy();
      if (connectTimer !== null) clearTimeout(connectTimer);
      if (!settled) {
        settled = true;
        if (!written) BEFORE_REQUEST.add(error);
        reject(error);
        return;
      }
      if (decoder !== null && !decoder.finished) decoder.fail(error);
    };
    const onAbort = () => {
      const reason = call.signal.reason;
      fail(reason instanceof Error ? reason : new Error("exchange aborted"));
    };
    if (call.signal.aborted) {
      reject(new Error("exchange aborted"));
      return;
    }
    call.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => call.signal.removeEventListener("abort", onAbort);

    const sink: BodySink = {
      push(chunk) {
        body?.enqueue(new Uint8Array(chunk));
        if ((body?.desiredSize ?? 1) <= 0) socket.pause();
      },
      done() {
        cleanup();
        body?.close();
        socket.destroy();
      },
      fail(error) {
        cleanup();
        body?.error(error);
        socket.destroy();
      },
    };

    const onHead = (buffered: Buffer) => {
      head = head.byteLength ? Buffer.concat([head, buffered]) : buffered;
      for (;;) {
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) {
          if (head.byteLength > MAX_HEAD_BYTES) {
            fail(new Error("upstream response head exceeded 64 KiB"));
          }
          return;
        }
        if (end + 4 > MAX_HEAD_BYTES) {
          fail(new Error("upstream response head exceeded 64 KiB"));
          return;
        }
        const parsed = parseHead(head.subarray(0, end).toString("latin1"));
        const rest = head.subarray(end + 4);
        if (parsed === null) {
          fail(new Error("upstream sent a malformed response head"));
          return;
        }
        // An interim response (no `Expect` was sent, so an unasked 1xx) is
        // skipped; the next head is the real one.
        if (parsed.status < 200) {
          head = rest;
          continue;
        }
        settled = true;
        const bodiless =
          call.method === "HEAD" ||
          parsed.status === 204 ||
          parsed.status === 304;
        const stream = bodiless
          ? null
          : new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  body = controller;
                },
                pull() {
                  socket.resume();
                },
                cancel() {
                  cleanup();
                  socket.destroy();
                },
              },
              {
                highWaterMark: BODY_HIGH_WATER_BYTES,
                size: (chunk) => chunk?.byteLength ?? 0,
              },
            );
        let response: Response;
        try {
          response = new Response(stream, {
            status: parsed.status,
            headers: parsed.headers,
          });
        } catch (error) {
          settled = false;
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        socket.off("data", onHead);
        if (bodiless) {
          cleanup();
          socket.destroy();
        } else {
          decoder = decoderFor(parsed.headers, sink);
          socket.on("data", (chunk: Buffer) => decoder?.write(chunk));
          if (rest.byteLength > 0) decoder.write(rest);
        }
        resolve(response);
        return;
      }
    };

    const send = () => {
      if (connectTimer !== null) clearTimeout(connectTimer);
      written = true;
      const lines = [`${call.method} ${call.target} HTTP/1.1`];
      for (const [name, value] of call.headers) {
        const lower = name.toLowerCase();
        if (
          lower === "connection" ||
          lower === "content-length" ||
          lower === "transfer-encoding"
        ) {
          continue;
        }
        lines.push(`${name}: ${value}`);
      }
      lines.push("connection: close");
      const { body } = call;
      const length =
        body === null
          ? 0
          : body instanceof Uint8Array
            ? body.byteLength
            : body.length;
      if (length > 0 || call.method === "POST" || call.method === "PUT") {
        lines.push(`content-length: ${length}`);
      }
      socket.write(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
      if (body instanceof Uint8Array) {
        if (length > 0) void writeBody(body);
      } else if (body !== null) {
        streamBody(body.stream, body.length).catch((error: unknown) =>
          fail(error instanceof Error ? error : new Error(String(error))),
        );
      }
    };

    const drained = () =>
      new Promise<void>((resume) => {
        const go = () => {
          socket.off("drain", go);
          socket.off("close", go);
          resume();
        };
        socket.once("drain", go);
        socket.once("close", go);
      });

    // Slice by slice, each after the last drained: an upstream that stops
    // reading holds one slice in the socket, not the whole body.
    const writeBody = async (bytes: Uint8Array) => {
      for (let at = 0; at < bytes.byteLength; at += WRITE_SLICE_BYTES) {
        if (socket.destroyed) return;
        const slice = bytes.subarray(at, at + WRITE_SLICE_BYTES);
        if (!socket.write(slice)) await drained();
      }
    };

    // Chunk by chunk as the client sends it, each after the last drained,
    // and never a byte past `length`.
    const streamBody = async (
      stream: ReadableStream<Uint8Array>,
      length: number,
    ) => {
      const reader = stream.getReader();
      const stop = () => {
        reader.cancel(call.signal.reason).catch(() => {});
      };
      call.signal.addEventListener("abort", stop, { once: true });
      try {
        let sent = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          sent += next.value.byteLength;
          if (sent > length) {
            throw new Error("request body is longer than its length");
          }
          if (socket.destroyed) return;
          if (!socket.write(next.value)) await drained();
        }
        if (sent !== length) {
          throw new Error("request body is shorter than its length");
        }
      } finally {
        call.signal.removeEventListener("abort", stop);
      }
    };

    if (target.tls === null) {
      socket = netConnect({ host: target.address, port: target.port });
      socket.once("connect", send);
    } else {
      socket = tlsConnect({
        host: target.address,
        port: target.port,
        servername: target.tls.serverName,
        rejectUnauthorized: true,
        ALPNProtocols: ["http/1.1"],
        ...(target.tls.ca === undefined ? {} : { ca: target.tls.ca }),
      });
      // Fires only once the certificate verified for `servername`.
      socket.once("secureConnect", send);
    }
    if (target.connectTimeoutMs !== undefined) {
      connectTimer = setTimeout(() => {
        fail(
          Object.assign(new Error("upstream connect timed out"), {
            code: "ETIMEDOUT",
          }),
        );
      }, target.connectTimeoutMs);
    }
    socket.on("data", onHead);
    socket.on("error", (error) => fail(error));
    socket.on("end", () => {
      if (!settled) fail(new Error("upstream closed before its response"));
      else decoder?.end();
    });
    socket.on("close", () => {
      if (!settled) fail(new Error("upstream closed before its response"));
      else if (decoder !== null && !decoder.finished) decoder.end();
    });
  });
}

type Head = { status: number; headers: Headers };

function parseHead(text: string): Head | null {
  const [statusLine, ...fields] = text.split("\r\n");
  const match = /^HTTP\/1\.[01] (\d{3})(?: .*)?$/.exec(statusLine ?? "");
  if (match === null) return null;
  const headers = new Headers();
  try {
    for (const field of fields) {
      const colon = field.indexOf(":");
      if (colon <= 0) return null;
      headers.append(
        field.slice(0, colon).trim(),
        field.slice(colon + 1).trim(),
      );
    }
  } catch {
    return null;
  }
  return { status: Number(match[1]), headers };
}

type BodySink = {
  push(chunk: Buffer): void;
  done(): void;
  fail(error: Error): void;
};

type BodyDecoder = {
  readonly finished: boolean;
  write(chunk: Buffer): void;
  /** The connection ended. */
  end(): void;
  fail(error: Error): void;
};

function decoderFor(headers: Headers, sink: BodySink): BodyDecoder {
  const encoding = headers.get("transfer-encoding");
  if (encoding !== null) {
    const codings = encoding
      .split(",")
      .map((part) => part.trim().toLowerCase());
    if (codings.length !== 1 || codings[0] !== "chunked") {
      return failedDecoder(
        new Error(`upstream sent transfer-encoding ${encoding}`),
        sink,
      );
    }
    return chunkedDecoder(sink);
  }
  const length = headers.get("content-length");
  if (length !== null) {
    if (!/^\d{1,15}$/.test(length.trim())) {
      return failedDecoder(
        new Error(`upstream sent content-length ${length}`),
        sink,
      );
    }
    return lengthDecoder(Number(length.trim()), sink);
  }
  return closeDecoder(sink);
}

function guarded(sink: BodySink): {
  sink: BodySink;
  readonly finished: boolean;
} {
  let finished = false;
  return {
    get finished() {
      return finished;
    },
    sink: {
      push: (chunk) => {
        if (!finished) sink.push(chunk);
      },
      done: () => {
        if (finished) return;
        finished = true;
        sink.done();
      },
      fail: (error) => {
        if (finished) return;
        finished = true;
        sink.fail(error);
      },
    },
  };
}

function failedDecoder(error: Error, sink: BodySink): BodyDecoder {
  const state = guarded(sink);
  queueMicrotask(() => state.sink.fail(error));
  return {
    get finished() {
      return state.finished;
    },
    write() {},
    end() {},
    fail: (reason) => state.sink.fail(reason),
  };
}

function lengthDecoder(length: number, sink: BodySink): BodyDecoder {
  const state = guarded(sink);
  let remaining = length;
  if (remaining === 0) queueMicrotask(() => state.sink.done());
  return {
    get finished() {
      return state.finished;
    },
    write(chunk) {
      if (state.finished) return;
      const take = chunk.subarray(0, remaining);
      remaining -= take.byteLength;
      if (take.byteLength > 0) state.sink.push(take);
      if (remaining === 0) state.sink.done();
    },
    end() {
      state.sink.fail(new Error("upstream body ended before its length"));
    },
    fail: (error) => state.sink.fail(error),
  };
}

function closeDecoder(sink: BodySink): BodyDecoder {
  const state = guarded(sink);
  return {
    get finished() {
      return state.finished;
    },
    write: (chunk) => state.sink.push(chunk),
    end: () => state.sink.done(),
    fail: (error) => state.sink.fail(error),
  };
}

function chunkedDecoder(sink: BodySink): BodyDecoder {
  const state = guarded(sink);
  let phase: "size" | "data" | "data-end" | "trailer" = "size";
  let line: Buffer = Buffer.alloc(0);
  let remaining = 0;
  let trailerBytes = 0;
  const malformed = (message: string) =>
    state.sink.fail(
      new Error(`upstream sent a malformed chunked body: ${message}`),
    );
  return {
    get finished() {
      return state.finished;
    },
    write(chunk) {
      let at = 0;
      while (!state.finished && at < chunk.byteLength) {
        if (phase === "data") {
          const take = chunk.subarray(at, at + remaining);
          remaining -= take.byteLength;
          at += take.byteLength;
          state.sink.push(take);
          if (remaining === 0) phase = "data-end";
          continue;
        }
        const newline = chunk.indexOf(10, at);
        const piece = chunk.subarray(
          at,
          newline < 0 ? chunk.byteLength : newline + 1,
        );
        at += piece.byteLength;
        line = line.byteLength ? Buffer.concat([line, piece]) : piece;
        const cap = phase === "trailer" ? MAX_HEAD_BYTES : MAX_CHUNK_LINE_BYTES;
        if (line.byteLength > cap) return malformed("line too long");
        if (newline < 0) continue;
        if (line.byteLength < 2 || line[line.byteLength - 2] !== 13) {
          return malformed("line not ended by CRLF");
        }
        const text = line.subarray(0, -2).toString("latin1");
        line = Buffer.alloc(0);
        if (phase === "data-end") {
          if (text !== "") return malformed("chunk data overran its size");
          phase = "size";
        } else if (phase === "size") {
          const size = text.split(";")[0]?.trim() ?? "";
          if (!/^[0-9a-fA-F]{1,12}$/.test(size)) {
            return malformed(`bad chunk size ${JSON.stringify(size)}`);
          }
          remaining = Number.parseInt(size, 16);
          phase = remaining === 0 ? "trailer" : "data";
        } else {
          trailerBytes += text.length + 2;
          if (trailerBytes > MAX_HEAD_BYTES)
            return malformed("trailer too long");
          if (text === "") state.sink.done();
        }
      }
    },
    end() {
      state.sink.fail(new Error("upstream body ended inside a chunked body"));
    },
    fail: (error) => state.sink.fail(error),
  };
}

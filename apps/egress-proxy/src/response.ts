/**
 * The answer to a forwarded (absolute-form) exchange: its heads stripped of
 * the upstream's hop-by-hop fields, and its body counted so the proxy knows
 * when the exchange is over.
 *
 * The proxy forwards exactly one request per upstream connection. It asks
 * the upstream to close (`rewrite` in request.ts), but an upstream may not:
 * Bun.serve keeps a connection open after any answer its handler produced
 * asynchronously, and says nothing in the head. Piping the client's next
 * request down that socket is how a worker's S3 list after its gateway
 * claim once landed on the API. So `complete` tells the proxy the moment
 * the answer is over, and the proxy ends the upstream then.
 *
 * The client side is the proxy's choice, made when the final head goes
 * through (`keepOpen`): either the head says `connection: close` and the
 * proxy ends the client connection after the answer, or it says nothing and
 * the proxy reads the client's next request as a new one. Telling Bun to
 * close is not enough on its own: its fetch and node:http pool the socket
 * anyway and send the next request before they see the FIN, and on that
 * EOF they fail the request instead of sending it again. The request side —
 * nothing past the one request reaches the upstream — is `createBodyFramer`
 * in request.ts.
 */

import {
  type BodyFramer,
  createBodyFramer,
  headEnd,
  parseField,
  type RequestBody,
} from "./request.ts";

/** Hop-by-hop headers of the upstream's hop, none of which reach the client. */
const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
]);

const CRLF = new Uint8Array([13, 10]);
const CLOSE = new TextEncoder().encode("connection: close\r\n\r\n");
const NOTHING = new Uint8Array(0);

export type ResponseRewriter = {
  /** Bytes for the client, possibly none yet; an error ends the exchange. */
  push(chunk: Uint8Array): { bytes: Uint8Array } | { error: string };
  /** The final head has gone through; the rest is body. */
  readonly done: boolean;
  /**
   * The whole answer has gone through. Stays false for a body delimited by
   * the upstream closing, which only that close ends.
   */
  readonly complete: boolean;
  /** Something has been handed to the client (a head, interim or final). */
  readonly started: boolean;
  /**
   * The final head told the client the connection closes, which binds the
   * proxy to close it (RFC 9112 §9.6). True until that head is written.
   */
  readonly closes: boolean;
};

/**
 * `maxHeadBytes` bounds every head the answer starts with together, interim
 * ones included, so an upstream cannot keep the client busy with 1xx heads.
 * `headOnly` is a HEAD request's answer, which has no body whatever its
 * Content-Length says. `keepOpen` is asked once, at the final head, whether
 * the proxy means to read another request from the client; an answer whose
 * body only the upstream's close ends, or an HTTP/1.0 one, always closes.
 */
export function createResponseRewriter(
  maxHeadBytes: number,
  {
    headOnly,
    keepOpen = () => false,
  }: { headOnly: boolean; keepOpen?: () => boolean },
): ResponseRewriter {
  let buffer: Uint8Array = NOTHING;
  /** Head bytes already handed on: the interim heads before this one. */
  let consumed = 0;
  let done = false;
  let started = false;
  let closes = true;
  /** Null until the final head, and for a close-delimited body. */
  let body: BodyFramer | null = null;
  /** Anything past the body is the upstream's, and nobody's to receive. */
  const bodyBytes = (bytes: Uint8Array): Uint8Array | { error: string } => {
    if (body === null) return bytes;
    const taken = body.take(bytes);
    return "error" in taken
      ? { error: `response ${taken.error}` }
      : taken.forward;
  };
  return {
    get closes() {
      return closes;
    },
    get complete() {
      return body?.complete ?? false;
    },
    get done() {
      return done;
    },
    get started() {
      return started;
    },
    push(chunk) {
      if (done) {
        const bytes = bodyBytes(chunk);
        return bytes instanceof Uint8Array ? { bytes } : bytes;
      }
      // Only what is returned reaches the client: heads assembled in a push
      // that then fails never do, and must not count as started.
      const handOver = (out: Uint8Array[]) => {
        if (out.length > 0) started = true;
        return { bytes: join(out) };
      };
      buffer = concat(buffer, chunk);
      const out: Uint8Array[] = [];
      for (;;) {
        const end = headEnd(buffer);
        const size = consumed + (end < 0 ? buffer.byteLength : end - 4);
        if (size > maxHeadBytes) {
          return {
            error: `response head is larger than ${maxHeadBytes} bytes`,
          };
        }
        if (end < 0) return handOver(out);
        const lines = splitLines(buffer.subarray(0, end - 4));
        const status = statusOf(lines[0] ?? NOTHING);
        if (status === null) return { error: "malformed response status line" };
        // The request's Upgrade never reaches the upstream, so a switch is
        // an answer to something nobody asked for.
        if (status === 101) return { error: "unexpected 101 response" };
        const kept = withoutHopFields(lines);
        if (typeof kept === "string") return { error: kept };
        consumed += end;
        buffer = buffer.slice(end);
        if (status < 200) {
          out.push(kept, CRLF);
          continue;
        }
        const framing = framingOf(lines, status, headOnly);
        if (typeof framing === "string") return { error: framing };
        body = framing.kind === "close" ? null : createBodyFramer(framing);
        const rest = bodyBytes(buffer);
        if (!(rest instanceof Uint8Array)) return rest;
        // The status line passes as the upstream wrote it, and HTTP/1.0
        // without `keep-alive` — which the proxy strips — means close.
        closes =
          body === null ||
          !ascii(lines[0] ?? NOTHING).startsWith("HTTP/1.1 ") ||
          !keepOpen();
        out.push(kept, closes ? CLOSE : CRLF, rest);
        buffer = NOTHING;
        done = true;
        return handOver(out);
      }
    },
  };
}

/**
 * Where the answer's body ends (RFC 9112 §6.3): nowhere for a HEAD answer,
 * a 204 or a 304; at the last chunk; after Content-Length bytes; or, with
 * neither, when the upstream closes. Both framings at once, or a length
 * that is not plain digits, are two readings of that point and refused.
 */
function framingOf(
  lines: Uint8Array[],
  status: number,
  headOnly: boolean,
): RequestBody | { kind: "close" } | string {
  if (headOnly || status === 204 || status === 304) {
    return { bytes: 0, kind: "length" };
  }
  const fields = lines.slice(1).map((line) => fieldOf(line));
  const lengths = fields.filter((field) => field?.name === "content-length");
  const codings = fields.filter((field) => field?.name === "transfer-encoding");
  if (codings.length > 0 && lengths.length > 0) {
    return "response has both transfer-encoding and content-length";
  }
  if (codings.length > 0) {
    const last = codings
      .flatMap((field) => field?.value.split(",") ?? [])
      .at(-1)
      ?.trim()
      .toLowerCase();
    return last === "chunked" ? { kind: "chunked" } : { kind: "close" };
  }
  const values = new Set(lengths.map((field) => field?.value));
  if (values.size === 0) return { kind: "close" };
  const [length] = values;
  const bytes = Number(length);
  return values.size === 1 &&
    length !== undefined &&
    /^\d+$/.test(length) &&
    Number.isSafeInteger(bytes)
    ? { bytes, kind: "length" }
    : "malformed response content-length";
}

/**
 * The head's own lines, each with its CRLF, minus every hop-by-hop field and
 * every field the upstream's Connection names. Lines are kept as bytes: a
 * field value may carry obs-text no text decoding round-trips. A Connection
 * that names the framing is refused rather than obeyed: dropping those
 * fields while piping the body as framed would hand the client a body it
 * cannot delimit.
 */
function withoutHopFields(lines: Uint8Array[]): Uint8Array | string {
  const named = new Set<string>();
  for (const line of lines.slice(1)) {
    const field = fieldOf(line);
    if (field?.name !== "connection") continue;
    for (const token of field.value.split(",")) {
      const name = token.trim().toLowerCase();
      if (name === "content-length" || name === "transfer-encoding") {
        return `response Connection names ${name}`;
      }
      if (name !== "") named.add(name);
    }
  }
  const kept: Uint8Array[] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      const name = fieldOf(line)?.name;
      if (name === undefined) return "malformed response header field";
      if (HOP_BY_HOP.has(name) || named.has(name)) continue;
    }
    kept.push(line, CRLF);
  }
  return join(kept);
}

/** The reason phrase reaches the client as it is, so it may not hide a line. */
function statusOf(line: Uint8Array): number | null {
  const match = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [\t\x20-\x7e\x80-\xff]*)?$/.exec(
    ascii(line),
  );
  return match === null ? null : Number(match[1]);
}

/**
 * Name lower-cased and value trimmed; undefined for anything that is not a
 * header field — no colon, a name that is not a token, or an obs-fold
 * continuation, none of which a client should be left to interpret.
 */
function fieldOf(
  line: Uint8Array,
): { name: string; value: string } | undefined {
  return parseField(ascii(line));
}

function splitLines(head: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = [];
  let start = 0;
  for (let i = 1; i < head.byteLength; i += 1) {
    if (head[i] === 10 && head[i - 1] === 13) {
      lines.push(head.subarray(start, i - 1));
      start = i + 1;
    }
  }
  lines.push(head.subarray(start));
  return lines;
}

/** Byte-for-byte: only ever compared against ASCII names and tokens. */
function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  return join([left, right]);
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

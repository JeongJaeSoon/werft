import { describe, expect, test } from "bun:test";
import { createBodyFramer, parseRequestHead } from "./request.ts";

function head(...lines: string[]): string {
  return lines.join("\r\n");
}

describe("parseRequestHead", () => {
  test("CONNECT carries the authority", () => {
    expect(
      parseRequestHead(
        head("CONNECT api.example.com:443 HTTP/1.1", "host: api.example.com"),
      ),
    ).toEqual({ host: "api.example.com", kind: "connect", port: 443 });
  });

  test("a CONNECT without a port is refused", () => {
    expect(
      parseRequestHead(head("CONNECT api.example.com HTTP/1.1")),
    ).toMatchObject({ kind: "invalid", status: 400 });
  });

  test("absolute-form is rewritten to origin-form with a fresh Host", () => {
    const parsed = parseRequestHead(
      head(
        "POST http://gateway.test:3000/v1/claim?x=1 HTTP/1.1",
        "Host: proxy-was-told-something-else",
        "Content-Length: 4",
        "Proxy-Connection: keep-alive",
        "Connection: keep-alive",
        "User-Agent: worker",
      ),
    );
    expect(parsed).toMatchObject({
      host: "gateway.test",
      kind: "forward",
      port: 3000,
    });
    if (parsed.kind !== "forward") throw new Error("expected a forward");
    expect(parsed.head).toBe(
      head(
        "POST /v1/claim?x=1 HTTP/1.1",
        "host: gateway.test:3000",
        "content-length: 4",
        "user-agent: worker",
        "connection: close",
        "",
        "",
      ),
    );
  });

  test("an absolute URL with no port defaults to 80", () => {
    expect(parseRequestHead(head("GET http://a.test/ HTTP/1.1"))).toMatchObject(
      { host: "a.test", port: 80 },
    );
  });

  test("https absolute-form is refused; that is what CONNECT is for", () => {
    expect(
      parseRequestHead(head("GET https://a.test/ HTTP/1.1")),
    ).toMatchObject({ kind: "invalid", status: 400 });
  });

  test("only /healthz is answered in origin-form", () => {
    expect(parseRequestHead(head("GET /healthz HTTP/1.1"))).toEqual({
      kind: "health",
    });
    expect(parseRequestHead(head("GET /other HTTP/1.1"))).toMatchObject({
      kind: "invalid",
      status: 400,
    });
  });

  test("conflicting or duplicated body framing is refused", () => {
    expect(
      parseRequestHead(
        head(
          "POST http://a.test/ HTTP/1.1",
          "Content-Length: 4",
          "Content-Length: 5",
        ),
      ),
    ).toMatchObject({ kind: "invalid", status: 400 });
    expect(
      parseRequestHead(
        head(
          "POST http://a.test/ HTTP/1.1",
          "Content-Length: 4",
          "Transfer-Encoding: chunked",
        ),
      ),
    ).toMatchObject({ kind: "invalid", status: 400 });
  });

  test("an obs-folded header is refused rather than re-joined", () => {
    expect(
      parseRequestHead(
        head("GET http://a.test/ HTTP/1.1", "X-Thing: one", "  two"),
      ),
    ).toMatchObject({ kind: "invalid", status: 400 });
  });

  test("a non-HTTP/1 request line is refused", () => {
    expect(parseRequestHead(head("GET http://a.test/ HTTP/2"))).toMatchObject({
      kind: "invalid",
      status: 505,
    });
    expect(parseRequestHead(head("nonsense"))).toMatchObject({
      kind: "invalid",
      status: 400,
    });
  });

  test("only an HTTP/1.1 client that says keep-alive, and never close, keeps the connection", () => {
    const keepAlive = (version: string, ...lines: string[]) => {
      const parsed = parseRequestHead(
        head(`GET http://a.test/ ${version}`, ...lines),
      );
      if (parsed.kind !== "forward") throw new Error("expected a forward");
      return parsed.keepAlive;
    };
    expect(keepAlive("HTTP/1.1", "Connection: keep-alive")).toBe(true);
    expect(keepAlive("HTTP/1.1", "Connection: Upgrade, Keep-Alive")).toBe(true);
    // Bun's fetch and node:http send both.
    expect(
      keepAlive(
        "HTTP/1.1",
        "Proxy-Connection: Keep-Alive",
        "Connection: keep-alive",
      ),
    ).toBe(true);
    // HTTP/1.1 defaults to persistent, but curl and git honour close.
    expect(keepAlive("HTTP/1.1")).toBe(false);
    expect(keepAlive("HTTP/1.0", "Connection: keep-alive")).toBe(false);
    expect(keepAlive("HTTP/1.1", "Connection: keep-alive, close")).toBe(false);
    expect(
      keepAlive("HTTP/1.1", "Connection: keep-alive", "Connection: CLOSE"),
    ).toBe(false);
    expect(
      keepAlive(
        "HTTP/1.1",
        "Connection: keep-alive",
        "Proxy-Connection: close",
      ),
    ).toBe(false);
  });

  test("a field that could hide another line from a peer reading LF as an end of line is refused", () => {
    for (const field of [
      // Bare LF: a lenient upstream sees a Transfer-Encoding we never framed by.
      "X-Test: value\nTransfer-Encoding: chunked",
      "X-Test: value\rTransfer-Encoding: chunked",
      "X-Test: nul\u0000",
      // Whitespace before the colon (RFC 9112 §5.1).
      "Content-Length : 4",
      "Bad Name: x",
    ]) {
      expect(
        parseRequestHead(
          head("POST http://a.test/ HTTP/1.1", field, "Content-Length: 4"),
        ),
      ).toMatchObject({ kind: "invalid", status: 400 });
    }
    // The method is forwarded as it came, so it has to be a token.
    expect(
      parseRequestHead(
        head("GET\nTransfer-Encoding:chunked http://a.test/ HTTP/1.1"),
      ),
    ).toMatchObject({ kind: "invalid", status: 400 });
    // Tabs and obs-text are field content, not lines.
    expect(
      parseRequestHead(
        head("GET http://a.test/ HTTP/1.1", "X-Test: a\tb", "X-Name: café"),
      ),
    ).toMatchObject({ kind: "forward" });
  });
});

describe("request body framing", () => {
  const bodyOf = (...lines: string[]) =>
    parseRequestHead(head("POST http://a.test/ HTTP/1.1", ...lines));

  test("the head says where the body ends, and no framing means no body", () => {
    expect(bodyOf("Content-Length: 12")).toMatchObject({
      body: { bytes: 12, kind: "length" },
    });
    expect(bodyOf("Transfer-Encoding: Chunked")).toMatchObject({
      body: { kind: "chunked" },
    });
    expect(bodyOf()).toMatchObject({ body: { bytes: 0, kind: "length" } });
  });

  test.each([
    ["Content-Length: +4", 400],
    ["Content-Length: 4, 4", 400],
    ["Content-Length: 99999999999999999999", 400],
    ["Transfer-Encoding: gzip, chunked", 501],
  ])("%s is refused", (line, status) => {
    expect(bodyOf(line)).toMatchObject({ kind: "invalid", status });
  });

  test("a length body forwards its bytes and drops what follows", () => {
    const framer = createBodyFramer({ bytes: 5, kind: "length" });
    expect(take(framer, "hel")).toEqual({ dropped: 0, forward: "hel" });
    expect(take(framer, "loGET http://b.test/")).toEqual({
      dropped: 18,
      forward: "lo",
    });
    expect(take(framer, "more")).toEqual({ dropped: 4, forward: "" });
  });

  test("a chunked body ends after its trailer, however the bytes are cut", () => {
    const body = "5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nx-sum: 1\r\n\r\n";
    const next = "GET http://b.test/ HTTP/1.1\r\n\r\n";
    for (let cut = 1; cut < body.length + next.length; cut += 1) {
      const framer = createBodyFramer({ kind: "chunked" });
      const all = body + next;
      const first = take(framer, all.slice(0, cut));
      const second = take(framer, all.slice(cut));
      expect(first.forward + second.forward).toBe(body);
      expect(first.dropped + second.dropped).toBe(next.length);
    }
  });

  test.each([
    ["zz\r\n", "malformed chunk size"],
    ["2\r\nabXY", "chunk data not followed by CRLF"],
    [`${"1".repeat(5000)}`, "chunk line is too long"],
    [`0\r\n${"x-pad: a\r\n".repeat(2000)}`, "chunked trailer is too large"],
    // The next request dressed as a trailer.
    ["0\r\nGET /secret HTTP/1.1\r\n", "malformed chunked trailer field"],
    ["0\r\nx-sum: 1\r\n  folded\r\n", "malformed chunked trailer field"],
  ])("a malformed chunked body is an error: %#", (bytes, error) => {
    const framer = createBodyFramer({ kind: "chunked" });
    expect(framer.take(new TextEncoder().encode(bytes as string))).toEqual({
      error: error as string,
    });
  });
});

function take(
  framer: ReturnType<typeof createBodyFramer>,
  text: string,
): { dropped: number; forward: string } {
  const result = framer.take(new TextEncoder().encode(text));
  if ("error" in result) throw new Error(result.error);
  return {
    dropped: result.dropped,
    forward: new TextDecoder().decode(result.forward),
  };
}

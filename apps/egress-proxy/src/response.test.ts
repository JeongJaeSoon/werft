import { describe, expect, test } from "bun:test";
import { createResponseRewriter } from "./response.ts";

const MAX = 1024;

function rewrite(...chunks: Array<string | Uint8Array>): string {
  const rewriter = createResponseRewriter(MAX, { headOnly: false });
  let out = "";
  for (const chunk of chunks) {
    const result = rewriter.push(
      typeof chunk === "string" ? latin1(chunk) : chunk,
    );
    if ("error" in result) return `error: ${result.error}`;
    out += String.fromCharCode(...result.bytes);
  }
  return out;
}

function latin1(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

describe("response head rewriter", () => {
  test("the final head says close and loses every hop-by-hop field", () => {
    expect(
      rewrite(
        "HTTP/1.1 200 OK\r\nConnection: keep-alive, X-Hop\r\nKeep-Alive: timeout=5\r\n" +
          "Proxy-Connection: keep-alive\r\nx-hop: 1\r\nContent-Length: 2\r\n\r\nok",
      ),
    ).toBe(
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nconnection: close\r\n\r\nok",
    );
  });

  test("the answer is the same however the upstream cut it", () => {
    const whole =
      "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\nConnection: keep-alive\r\n\r\n";
    const expected = rewrite(whole);
    for (let cut = 1; cut < whole.length; cut += 1) {
      expect(rewrite(whole.slice(0, cut), whole.slice(cut))).toBe(expected);
    }
    expect(expected).toBe(
      "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n",
    );
  });

  test("an interim head keeps its fields but not its hop-by-hop ones", () => {
    expect(
      rewrite(
        "HTTP/1.1 103 Early Hints\r\nLink: </a.css>\r\nConnection: keep-alive\r\n\r\n",
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
      ),
    ).toBe(
      "HTTP/1.1 103 Early Hints\r\nLink: </a.css>\r\n\r\n" +
        "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nconnection: close\r\n\r\n",
    );
  });

  test("field values keep bytes no text decoding would round-trip", () => {
    const obs = new Uint8Array([0x80, 0x9f, 0xff]);
    const head = latin1("HTTP/1.1 200 OK\r\nX-Raw: ");
    const tail = latin1("\r\n\r\n");
    const out = rewrite(new Uint8Array([...head, ...obs, ...tail]));
    expect(out).toContain(
      `X-Raw: ${String.fromCharCode(0x80, 0x9f, 0xff)}\r\n`,
    );
  });

  test("the body after the head passes as it is", () => {
    const rewriter = createResponseRewriter(MAX, { headOnly: false });
    rewriter.push(latin1("HTTP/1.1 200 OK\r\n\r\n"));
    expect(rewriter.done).toBe(true);
    const body = latin1("HTTP/1.1 500 not a head\r\n\r\n");
    expect(rewriter.push(body)).toEqual({ bytes: body });
  });

  test("heads that never reached the client do not count as started", () => {
    const rewriter = createResponseRewriter(MAX, { headOnly: false });
    const result = rewriter.push(
      latin1("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nBad\r\n\r\n"),
    );
    expect(result).toEqual({ error: "malformed response header field" });
    expect(rewriter.started).toBe(false);
    const sent = createResponseRewriter(MAX, { headOnly: false });
    sent.push(latin1("HTTP/1.1 100 Continue\r\n\r\n"));
    expect(sent.started).toBe(true);
  });

  test.each([
    ["garbage\r\n\r\n", "malformed response status line"],
    [
      "HTTP/1.1 200 OK\r\nBadHeader\r\n\r\nbody",
      "malformed response header field",
    ],
    ["HTTP/1.1 200 OK\r\nBad Name: x\r\n\r\n", "malformed response header"],
    [
      "HTTP/1.1 200 OK\r\nX: a\r\n  folded\r\n\r\n",
      "malformed response header",
    ],
    ["HTTP/1.1 101 Switching Protocols\r\n\r\n", "unexpected 101 response"],
    [
      "HTTP/1.1 200 OK\r\nConnection: content-length\r\nContent-Length: 2\r\n\r\n",
      "response Connection names content-length",
    ],
    [`HTTP/1.1 200 OK\r\nx: ${"a".repeat(MAX)}`, "response head is larger"],
    [
      "HTTP/1.1 100 Continue\r\n\r\n".repeat(MAX / 16),
      "response head is larger",
    ],
  ])("%# is refused", (answer, error) => {
    expect(rewrite(answer)).toStartWith(`error: ${error}`);
  });

  test.each([
    // A client reading LF as an end of line would see a second length and
    // take the next origin's answer, on a kept connection, for this body.
    [
      "HTTP/1.1 200 OK\r\nX-Test: a\nContent-Length: 99\r\nContent-Length: 0\r\n\r\n",
      "malformed response header field",
    ],
    [
      "HTTP/1.1 200 OK\r\nX-Test: a\rContent-Length: 99\r\nContent-Length: 0\r\n\r\n",
      "malformed response header field",
    ],
    [
      "HTTP/1.1 200 OK\nContent-Length: 99\r\nContent-Length: 0\r\n\r\n",
      "malformed response status line",
    ],
    [
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: a\nY: b\r\n\r\n",
      "response malformed chunked trailer field",
    ],
  ])("a line hidden inside another is refused: %#", (answer, error) => {
    expect(rewrite(answer)).toStartWith(`error: ${error}`);
  });

  describe("keeping the client connection", () => {
    const kept = (answer: string, headOnly = false) => {
      const rewriter = createResponseRewriter(MAX, {
        headOnly,
        keepOpen: () => true,
      });
      const result = rewriter.push(latin1(answer));
      if ("error" in result) throw new Error(result.error);
      return {
        closes: rewriter.closes,
        out: String.fromCharCode(...result.bytes),
      };
    };

    test("a framed answer the proxy keeps the connection for says nothing about closing", () => {
      expect(
        kept(
          "HTTP/1.1 401 Unauthorized\r\nConnection: keep-alive\r\nKeep-Alive: timeout=5\r\nContent-Length: 2\r\n\r\nno",
        ),
      ).toEqual({
        closes: false,
        out: "HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\nno",
      });
      expect(
        kept("HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n", true).closes,
      ).toBe(false);
      expect(kept("HTTP/1.1 204 No Content\r\n\r\n").closes).toBe(false);
      expect(
        kept("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n").closes,
      ).toBe(false);
    });

    test("only the final head is asked, and an interim one never closes", () => {
      let asked = 0;
      const rewriter = createResponseRewriter(MAX, {
        headOnly: false,
        keepOpen: () => {
          asked += 1;
          return true;
        },
      });
      rewriter.push(latin1("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Ea"));
      expect(asked).toBe(0);
      expect(rewriter.closes).toBe(true);
      rewriter.push(
        latin1("rly Hints\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"),
      );
      expect(asked).toBe(1);
      expect(rewriter.closes).toBe(false);
    });

    test.each([
      // Only the upstream's close ends it, so the client's has to follow.
      ["a body with no framing", "HTTP/1.1 200 OK\r\n\r\nall"],
      // HTTP/1.0 without the keep-alive the proxy strips means close.
      ["an HTTP/1.0 answer", "HTTP/1.0 200 OK\r\nContent-Length: 0\r\n\r\n"],
    ])("%s still closes", (_name, answer) => {
      const { closes, out } = kept(answer as string);
      expect(closes).toBe(true);
      expect(out).toContain("\r\nconnection: close\r\n\r\n");
    });

    test("a proxy that will not keep the connection says close", () => {
      const rewriter = createResponseRewriter(MAX, {
        headOnly: false,
        keepOpen: () => false,
      });
      const result = rewriter.push(
        latin1("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"),
      );
      expect(result).toEqual({
        bytes: latin1(
          "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nconnection: close\r\n\r\n",
        ),
      });
      expect(rewriter.closes).toBe(true);
    });
  });

  describe("the end of the answer", () => {
    const answer = (headOnly = false) =>
      createResponseRewriter(MAX, { headOnly });
    const text = (result: ReturnType<ReturnType<typeof answer>["push"]>) =>
      "error" in result
        ? `error: ${result.error}`
        : String.fromCharCode(...result.bytes);

    test("a Content-Length body ends at its length, and the upstream's extra bytes go nowhere", () => {
      const rewriter = answer();
      expect(
        text(
          rewriter.push(
            latin1("HTTP/1.1 404 Not Found\r\nContent-Length: 4\r\n\r\nno"),
          ),
        ),
      ).toEndWith("\r\n\r\nno");
      expect(rewriter.complete).toBe(false);
      expect(text(rewriter.push(latin1("peHTTP/1.1 200 OK\r\n\r\n")))).toBe(
        "pe",
      );
      expect(rewriter.complete).toBe(true);
    });

    test("a chunked body ends after its last chunk", () => {
      const rewriter = answer();
      rewriter.push(
        latin1(
          "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nok\r\n",
        ),
      );
      expect(rewriter.complete).toBe(false);
      expect(text(rewriter.push(latin1("0\r\n\r\n")))).toBe("0\r\n\r\n");
      expect(rewriter.complete).toBe(true);
    });

    test.each([
      ["a HEAD answer", "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n", true],
      ["a 204", "HTTP/1.1 204 No Content\r\n\r\n", false],
      [
        "a 304",
        "HTTP/1.1 304 Not Modified\r\nContent-Length: 10\r\n\r\n",
        false,
      ],
      ["an empty body", "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n", false],
    ])("%s is complete at its head", (_name, head, headOnly) => {
      const rewriter = answer(headOnly as boolean);
      rewriter.push(latin1(head as string));
      expect(rewriter.complete).toBe(true);
    });

    test("a body with no framing lasts until the upstream closes", () => {
      const rewriter = answer();
      rewriter.push(latin1("HTTP/1.1 200 OK\r\n\r\nall of it"));
      expect(rewriter.done).toBe(true);
      expect(rewriter.complete).toBe(false);
    });

    test.each([
      [
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n",
        "both",
      ],
      [
        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n",
        "content-length",
      ],
      ["HTTP/1.1 200 OK\r\nContent-Length: -1\r\n\r\n", "content-length"],
      [
        "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n",
        "malformed chunk size",
      ],
    ])("an answer whose end has two readings is refused: %#", (head, error) => {
      expect(text(answer().push(latin1(head as string)))).toContain(
        error as string,
      );
    });
  });
});

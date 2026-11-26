import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import {
  failedBeforeRequest,
  upstreamExchange,
  wroteNothing,
} from "./upstream-http.ts";

/** A server that answers every connection with the bytes it is given. */
function raw(
  answer: (socket: Socket, request: string) => void,
): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((socket) => {
    let seen = "";
    socket.on("data", (chunk) => {
      seen += chunk.toString("latin1");
      const end = seen.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = /content-length: (\d+)/i.exec(seen)?.[1];
      if (seen.length < end + 4 + Number(length ?? 0)) return;
      requests.push(seen);
      answer(socket, seen);
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        requests,
      });
    });
  });
}

// Read by hand: `expect(response.text()).rejects` crashes Bun 1.3.11's test
// runner (segfault) when the body stream errors.
async function failureOf(response: Response): Promise<string> {
  try {
    await response.text();
    return "no failure";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function call(port: number, init: { method?: string; body?: string } = {}) {
  return upstreamExchange(
    { address: "127.0.0.1", port, tls: null },
    {
      method: init.method ?? "POST",
      target: "/v1/messages?beta=true",
      headers: [
        ["host", "upstream.test"],
        ["content-length", "999"],
        ["x-api-key", "k"],
      ],
      body: init.body === undefined ? null : Buffer.from(init.body),
      signal: AbortSignal.timeout(5_000),
    },
  );
}

describe("upstreamExchange", () => {
  test("writes one framed request and reads a sized body", async () => {
    const up = await raw((socket) =>
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 5\r\nx-a: 1\r\n\r\nhello"),
    );
    const response = await call(up.port, { body: "{}" });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-a")).toBe("1");
    expect(await response.text()).toBe("hello");
    const [request] = up.requests;
    expect(request).toStartWith("POST /v1/messages?beta=true HTTP/1.1\r\n");
    // Its own framing, not the caller's stale length.
    expect(request).toContain("content-length: 2\r\n");
    expect(request).not.toContain("999");
    expect(request).toContain("connection: close\r\n");
    expect(request).toEndWith("\r\n\r\n{}");
  });

  test("a body larger than one write slice arrives whole and in order", async () => {
    const up = await raw((socket) =>
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"),
    );
    const large = Array.from({ length: 300_000 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    ).join("");
    const response = await call(up.port, { body: large });
    expect(await response.text()).toBe("ok");
    const [request] = up.requests;
    expect(request).toContain(`content-length: ${large.length}\r\n`);
    expect(request?.endsWith(`\r\n\r\n${large}`)).toBe(true);
  });

  test("decodes a chunked body across writes and skips an interim head", async () => {
    const up = await raw((socket) => {
      socket.write("HTTP/1.1 100 Continue\r\n\r\n");
      socket.write("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n3\r");
      setTimeout(() => socket.end("\nabc\r\n2;x=y\r\nde\r\n0\r\n\r\n"), 10);
    });
    const response = await call(up.port);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("abcde");
  });

  test("reads to the close when there is neither length nor chunking", async () => {
    const up = await raw((socket) =>
      socket.end("HTTP/1.1 200 OK\r\n\r\nuntil the end"),
    );
    expect(await (await call(up.port)).text()).toBe("until the end");
  });

  test("a body cut short errors the stream, not ends it", async () => {
    const up = await raw((socket) =>
      socket.end("HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nshort"),
    );
    expect(await failureOf(await call(up.port))).toContain(
      "ended before its length",
    );
    const chunked = await raw((socket) =>
      socket.end("HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\nzz\r\n"),
    );
    expect(await failureOf(await call(chunked.port))).toContain(
      "malformed chunked body",
    );
  });

  test("a streamed body that fails once the upstream has answered leaves the answer whole", async () => {
    const server = createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhel");
        setTimeout(() => socket.end("lo"), 300);
      });
      socket.on("error", () => {});
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        setTimeout(() => controller.error(new Error("body stalled")), 100);
      },
    });
    const response = await upstreamExchange(
      { address: "127.0.0.1", port, tls: null },
      {
        method: "PUT",
        target: "/bucket/key",
        headers: [["host", "upstream.test"]],
        body: { stream, length: 10 },
        signal: AbortSignal.timeout(5_000),
      },
    );
    expect(response.status).toBe(200);
    // Read by hand, as in `failureOf`: the text, or what failed it.
    const text = await response.text().catch((error: Error) => error.message);
    expect(text).toBe("hello");
  });

  test("a head that is malformed, unbounded or never comes is refused", async () => {
    const junk = await raw((socket) => socket.end("SMTP ready\r\n\r\n"));
    await expect(call(junk.port)).rejects.toThrow("malformed response head");
    const huge = await raw((socket) =>
      socket.end(`HTTP/1.1 200 OK\r\nx: ${"a".repeat(70 * 1024)}\r\n\r\n`),
    );
    await expect(call(huge.port)).rejects.toThrow("exceeded 64 KiB");
    const silent = await raw((socket) => socket.end());
    await expect(call(silent.port)).rejects.toThrow("closed before");
  });

  test("an abort mid-body ends the stream with the reason", async () => {
    const up = await raw((socket) =>
      socket.write(
        "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n1\r\na\r\n",
      ),
    );
    const controller = new AbortController();
    const response = await upstreamExchange(
      { address: "127.0.0.1", port: up.port, tls: null },
      {
        method: "GET",
        target: "/",
        headers: [["host", "upstream.test"]],
        body: null,
        signal: controller.signal,
      },
    );
    const reader = response.body?.getReader();
    expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("a");
    controller.abort(new Error("grant ended"));
    await expect(reader?.read()).rejects.toThrow("grant ended");
  });
});

describe("what a failed exchange had written", () => {
  function cancelled(
    port: number,
    tls: { serverName: string } | null,
    signal: AbortSignal,
  ): Promise<unknown> {
    return upstreamExchange(
      { address: "127.0.0.1", port, tls },
      {
        method: "POST",
        target: "/v1/messages",
        headers: [["host", "upstream.test"]],
        body: Buffer.from("{}"),
        signal,
      },
    ).catch((error: unknown) => error);
  }

  test("a call cancelled before it came in wrote nothing, and is no reason to dial again", async () => {
    const error = await cancelled(9, null, AbortSignal.abort());
    expect(wroteNothing(error)).toBe(true);
    expect(failedBeforeRequest(error)).toBe(false);
  });

  test("a call cancelled during the TLS handshake wrote nothing", async () => {
    // Takes the connection and never answers the client's hello.
    const sockets: Socket[] = [];
    const stalled = createServer((socket) => sockets.push(socket));
    servers.push(stalled);
    const port = await new Promise<number>((resolve) =>
      stalled.listen(0, "127.0.0.1", () => {
        const address = stalled.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      }),
    );
    const cut = new AbortController();
    const failing = cancelled(
      port,
      { serverName: "upstream.test" },
      cut.signal,
    );
    while (sockets.length === 0) await Bun.sleep(10);
    cut.abort(new Error("cut in the handshake"));
    const error = await failing;
    for (const socket of sockets) socket.destroy();
    expect(wroteNothing(error)).toBe(true);
    expect(failedBeforeRequest(error)).toBe(false);
  });

  test("a call cancelled once its request was written may have been billed", async () => {
    const up = await raw(() => {});
    const cut = new AbortController();
    const failing = cancelled(up.port, null, cut.signal);
    while (up.requests.length === 0) await Bun.sleep(10);
    cut.abort(new Error("cut after the request"));
    expect(wroteNothing(await failing)).toBe(false);
  });
});

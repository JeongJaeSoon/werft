import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  clientHello,
  EXTENSION_ENCRYPTED_CLIENT_HELLO,
} from "@werft-ai/testkit/tls-client-hello";
import type { TCPSocketListener } from "bun";
import { createProxyLogger } from "./logger.ts";
import type { EgressResolver } from "./policy.ts";
import {
  type EgressProxyServer,
  startEgressProxy,
  systemResolver,
} from "./proxy.ts";

/**
 * The proxy against real sockets, with only DNS faked: the policy has to
 * believe `gateway.test` is 127.0.0.1 for a loopback upstream to stand in
 * for the daemon host.
 */
const BIG = "a".repeat(8 * 1024 * 1024);

type EchoState = { pending: Uint8Array | null };

function echoDrain(socket: {
  data: EchoState;
  write(data: Uint8Array): number;
}): void {
  while (socket.data.pending !== null) {
    const written = Math.max(0, socket.write(socket.data.pending));
    if (written >= socket.data.pending.byteLength) {
      socket.data.pending = null;
      return;
    }
    if (written === 0) return;
    socket.data.pending = socket.data.pending.subarray(written);
  }
}

describe("egress proxy", () => {
  let upstream: Bun.Server<undefined>;
  let upstreamPort = 0;
  let other: Bun.Server<undefined>;
  let scripted: TCPSocketListener<{ answered: boolean }>;
  /** Everything `scripted.test` was sent, across connections. */
  let scriptedHeard = "";
  /** Connections to `scripted.test` that have closed. */
  let scriptedClosed = 0;
  let echo: TCPSocketListener<EchoState>;
  /** Every byte the sink upstream ever received, across connections. */
  let sunk = 0;
  let sink: TCPSocketListener<undefined>;
  let proxy: EgressProxyServer;
  const silent = createProxyLogger("error", () => undefined);

  const resolve: EgressResolver = async (host) => {
    switch (host) {
      case "gateway.test":
      case "other.test":
      case "scripted.test":
      case "tunnel.test":
      case "sink.test":
      // The OS resolver answers an address literal with itself.
      case "127.0.0.1":
        return ["127.0.0.1"];
      case "metadata.test":
        return ["169.254.169.254"];
      case "empty.test":
        return [];
      case "public.test":
        // Allowlisted as public, but answers with a private address.
        return ["10.0.0.7"];
      default:
        throw new Error(`no such host ${host}`);
    }
  };

  beforeAll(async () => {
    upstream = Bun.serve({
      fetch: async (request) => {
        const url = new URL(request.url);
        // A body far past a socket's write buffer, so the proxy has to queue
        // and drain rather than write it all in one go.
        if (url.pathname === "/large") return new Response(BIG);
        // Answered after a timer, as the API answers after its database: Bun
        // then leaves the connection open despite the `connection: close`.
        if (url.pathname === "/claim") await Bun.sleep(10);
        if (url.pathname === "/missing") {
          await Bun.sleep(10);
          return new Response("missing", { status: 404 });
        }
        if (url.pathname === "/unauthorized" || url.pathname === "/forbidden") {
          await request.text();
          await Bun.sleep(1);
          return new Response("no", {
            status: url.pathname === "/forbidden" ? 403 : 401,
          });
        }
        if (url.pathname === "/slow") await Bun.sleep(300);
        return new Response(`upstream ${url.pathname} ${await request.text()}`);
      },
      hostname: "127.0.0.1",
      port: 0,
    });
    upstreamPort = upstream.port ?? 0;
    // A second origin, so a request that lands on the first one shows.
    other = Bun.serve({
      fetch: async (request) =>
        new Response(`other ${new URL(request.url).pathname}`),
      hostname: "127.0.0.1",
      port: 0,
    });
    // Answers every request head with the response its path names, cut into
    // separate writes so the proxy has to put a head back together.
    scripted = Bun.listen<{ answered: boolean }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        close() {
          scriptedClosed += 1;
        },
        open(socket) {
          socket.data = { answered: false };
        },
        data(socket, chunk) {
          const head = new TextDecoder().decode(chunk);
          scriptedHeard += head;
          // One answer per connection; later chunks are a body, or bytes
          // that should never have arrived.
          if (socket.data.answered) return;
          socket.data.answered = true;
          const path = head.split(" ")[1] ?? "";
          const parts = SCRIPTS[path];
          if (parts === undefined) {
            socket.end();
            return;
          }
          void (async () => {
            for (const part of parts) {
              if (part === END) {
                socket.end();
                return;
              }
              if (part === PAUSE) {
                await Bun.sleep(150);
                continue;
              }
              socket.write(part);
              await Bun.sleep(5);
            }
          })();
        },
      },
    });
    // An echo server that respects backpressure; one that does not would
    // drop bytes under load and make the proxy look like the culprit.
    echo = Bun.listen<EchoState>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          socket.data.pending = socket.data.pending
            ? concatBytes(socket.data.pending, chunk)
            : chunk;
          echoDrain(socket);
        },
        drain(socket) {
          echoDrain(socket);
        },
        open(socket) {
          socket.data = { pending: null };
        },
      },
    });
    // Counts what arrives so a test can show that nothing did.
    sink = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(_socket, chunk) {
          sunk += chunk.byteLength;
        },
      },
    });
    proxy = await startEgressProxy({
      logger: silent,
      policy: {
        allow: [{ host: "public.test", port: 443 }],
        allowPrivate: [
          { host: "gateway.test", port: upstreamPort },
          { host: "other.test", port: other.port ?? 0 },
          { host: "scripted.test", port: scripted.port },
          { host: "tunnel.test", port: echo.port },
          { host: "sink.test", port: sink.port },
          { host: "127.0.0.1", port: echo.port },
          { host: "metadata.test", port: 80 },
          { host: "gone.test", port: 80 },
          { host: "empty.test", port: 80 },
        ],
      },
      port: 0,
      resolve,
    });
  });

  afterAll(async () => {
    proxy.stop();
    echo.stop(true);
    sink.stop(true);
    scripted.stop(true);
    await other.stop(true);
    await upstream.stop(true);
  });

  // . Bun.serve ignores the `connection: close` the proxy forwards
  // whenever its handler answers after an await, so the upstream stays open;
  // a client that reads the response as keep-alive then sends its next
  // request — to any origin — down the same socket, and the proxy used to
  // pipe it to the first upstream. The worker's S3 list after its gateway
  // claim reached the API and failed as an XML parse error.
  /** Runs `testing/pooled-client.ts` against the proxy; one line per request. */
  function pooledClient(...requests: string[]): Promise<string[]> {
    return pooledClientVia(proxy.port, ...requests);
  }

  async function pooledClientVia(
    port: number,
    ...requests: string[]
  ): Promise<string[]> {
    const via = `http://127.0.0.1:${port}`;
    const client = Bun.spawn(
      [
        process.execPath,
        new URL("./testing/pooled-client.ts", import.meta.url).pathname,
        ...requests,
      ],
      {
        env: { ...process.env, HTTP_PROXY: via, http_proxy: via },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(client.stdout).text(),
      new Response(client.stderr).text(),
      client.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    return out.trim().split("\n");
  }

  test("a client's pooled proxy connection never carries its next request to the last upstream", async () => {
    expect(
      await pooledClient(
        "fetch",
        "POST",
        `http://gateway.test:${upstreamPort}/claim`,
        "http",
        "GET",
        `http://other.test:${other.port}/list`,
      ),
    ).toEqual(["200 upstream /claim x", "200 other /list"]);
  });

  // Bun's node:http keeps a connection after a non-2xx answer even when the
  // head says close: the transcript mirror's PUT after a 404 GET came down
  // the same socket, was discarded, and waited for an answer that never
  // came. The proxy now ends the connection when the answer is complete.
  test("a request sent on a connection after a 404 still gets its own answer", async () => {
    expect(
      await pooledClient(
        "http",
        "GET",
        `http://gateway.test:${upstreamPort}/missing`,
        "http",
        "PUT",
        `http://other.test:${other.port}/part`,
        "http",
        "GET",
        `http://gateway.test:${upstreamPort}/missing`,
        "http",
        "PUT",
        `http://other.test:${other.port}/part`,
      ),
    ).toEqual([
      "404 missing",
      "200 other /part",
      "404 missing",
      "200 other /part",
    ]);
  });

  test("a forwarded response tells the client the connection closes", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      request(
        `GET http://scripted.test:${scripted.port}/keep-alive HTTP/1.1`,
        "host: scripted.test",
      ),
    );
    const response = await talk.waitFor("\r\n\r\nok");
    const head = response.slice(0, response.indexOf("\r\n\r\n")).toLowerCase();
    expect(head).toStartWith("http/1.1 200 ok\r\n");
    expect(head).toContain("\r\nconnection: close");
    expect(head).not.toContain("keep-alive");
    // A header the upstream's own Connection named is hop-by-hop too.
    expect(head).not.toContain("x-hop");
    expect(head).toContain("\r\nx-end-to-end: kept");
    talk.close();
  });

  test("an interim 100 passes as it is and the final head is the one rewritten", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      request(
        `POST http://scripted.test:${scripted.port}/continue HTTP/1.1`,
        "expect: 100-continue",
        "content-length: 0",
      ),
    );
    const response = await talk.waitFor("\r\n\r\ndone");
    expect(response).toStartWith(
      "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\n",
    );
    const final = response.slice(response.indexOf("HTTP/1.1 201"));
    expect(final.slice(0, final.indexOf("\r\n\r\n"))).toContain(
      "\r\nconnection: close",
    );
    talk.close();
  });

  test("an upstream that closes inside its response head is a 502, not a torn head", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      request(`GET http://scripted.test:${scripted.port}/torn HTTP/1.1`),
    );
    const response = await talk.waitFor("502");
    expect(response).toStartWith("HTTP/1.1 502 Bad Gateway\r\n");
    expect(response).not.toContain("content-le\r\n");
    expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
  });

  test("nothing a client sends past its request reaches the upstream", async () => {
    const closed = scriptedClosed;
    const talk = await connect(proxy.port);
    // One write: the second request rides in the same segment as the first.
    talk.send(
      request(
        `POST http://scripted.test:${scripted.port}/keep-alive HTTP/1.1`,
        "content-length: 5",
      ) +
        "hello" +
        request(
          `GET http://other.test:${other.port}/stolen HTTP/1.1`,
          "authorization: meant-for-other",
        ),
    );
    await talk.waitFor("\r\n\r\nok");
    // The answer is complete, so the proxy ends both sides itself; by the
    // upstream's close everything it was ever going to be sent has arrived.
    expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
    expect(await waitFor(() => scriptedClosed > closed, 2_000)).toBe(true);
    expect(scriptedHeard).toContain("POST /keep-alive HTTP/1.1");
    expect(scriptedHeard).toContain("hello");
    expect(scriptedHeard).not.toContain("stolen");
    expect(scriptedHeard).not.toContain("meant-for-other");
  });

  test("bytes past a request do not count against the early-byte cap", async () => {
    // A lookup slow enough that everything arrives while still connecting.
    const slow = await startEgressProxy({
      logger: silent,
      maxBufferedBytes: 1024,
      policy: {
        allow: [],
        allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
      },
      port: 0,
      resolve: async (host) => {
        await Bun.sleep(100);
        return resolve(host);
      },
    });
    try {
      const talk = await connect(slow.port);
      talk.send(
        request(`GET http://gateway.test:${upstreamPort}/early HTTP/1.1`) +
          "x".repeat(8 * 1024),
      );
      expect(await talk.waitFor("upstream /early")).toContain("HTTP/1.1 200");
      talk.close();
    } finally {
      slow.stop();
    }
  });

  test("a chunked body is forwarded whole and ends where its framing says", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      request(
        `POST http://gateway.test:${upstreamPort}/chunked HTTP/1.1`,
        "transfer-encoding: chunked",
      ),
    );
    talk.send("5\r\nhello\r\n");
    await Bun.sleep(20);
    talk.send(
      "6\r\n world\r\n0\r\n\r\nGET http://other.test/ HTTP/1.1\r\n\r\n",
    );
    const response = await talk.waitFor("upstream /chunked hello world");
    expect(response).toContain("connection: close");
    expect(response).not.toContain("other /");
    talk.close();
  });

  test("an oversized response head is a 502 instead of being buffered", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      request(`GET http://scripted.test:${scripted.port}/huge-head HTTP/1.1`),
    );
    expect(await talk.waitFor("502")).toContain("response head");
    expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
  });

  // Bun's fetch pools the proxy connection whatever the head says and sends
  // its next request before it sees the FIN; on that EOF it fails the
  // request instead of sending it again. So a client that asks to keep the
  // connection gets it kept: one request at a time, each read and judged as
  // if it came on a fresh connection, and each on a fresh upstream.
  describe("a kept client connection", () => {
    const kept = (line: string, ...fields: string[]) =>
      request(line, "connection: keep-alive", ...fields);
    const headOf = (text: string) =>
      text.slice(0, text.indexOf("\r\n\r\n")).toLowerCase();

    test("each request reaches its own upstream and is judged afresh", async () => {
      const talk = await connect(proxy.port);
      talk.send(
        `${kept(
          `POST http://gateway.test:${upstreamPort}/claim HTTP/1.1`,
          "content-length: 2",
        )}hi`,
      );
      expect(headOf(await talk.waitFor("upstream /claim hi"))).not.toContain(
        "connection: close",
      );
      // The next head may arrive in pieces.
      const next = kept(`GET http://other.test:${other.port}/next HTTP/1.1`);
      talk.send(next.slice(0, 20));
      await Bun.sleep(20);
      talk.send(next.slice(20));
      await talk.waitFor("other /next");
      expect(talk.isClosed()).toBe(false);
      // A destination the policy refuses is refused on a kept connection too.
      talk.send(kept("GET http://metadata.test/latest/meta-data/ HTTP/1.1"));
      expect(await talk.waitFor("403")).toContain("link_local");
      expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
    });

    test.each([
      ["both framings", "content-length: 5", "transfer-encoding: chunked"],
      ["two lengths", "content-length: 5", "content-length: 6"],
      ["the same length twice", "content-length: 5", "content-length: 5"],
    ])(
      "a next request with %s is refused and reaches nobody",
      async (_name, one, two) => {
        const talk = await connect(proxy.port);
        talk.send(kept(`GET http://other.test:${other.port}/first HTTP/1.1`));
        await talk.waitFor("other /first");
        talk.send(
          `${kept(
            `POST http://scripted.test:${scripted.port}/two-readings HTTP/1.1`,
            one as string,
            two as string,
          )}hello`,
        );
        expect(await talk.waitFor("400 Bad Request")).toContain(
          "content-length",
        );
        expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
        expect(scriptedHeard).not.toContain("/two-readings");
      },
    );

    test("bytes past the body close the connection and reach nobody", async () => {
      const closed = scriptedClosed;
      const talk = await connect(proxy.port);
      // One write: the next request rides in the same segment as the body.
      talk.send(
        `${kept(
          `POST http://scripted.test:${scripted.port}/keep-alive HTTP/1.1`,
          "content-length: 5",
        )}hello${kept(
          `GET http://scripted.test:${scripted.port}/stolen-leftover HTTP/1.1`,
          "authorization: meant-for-the-next",
        )}`,
      );
      expect(headOf(await talk.waitFor("\r\n\r\nok"))).toContain(
        "\r\nconnection: close",
      );
      expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
      expect(await waitFor(() => scriptedClosed > closed, 2_000)).toBe(true);
      expect(scriptedHeard).toContain("hello");
      expect(scriptedHeard).not.toContain("stolen-leftover");
      expect(scriptedHeard).not.toContain("meant-for-the-next");
    });

    test("a request sent before the answer came is discarded, and the connection closes", async () => {
      const talk = await connect(proxy.port);
      talk.send(
        kept(`GET http://scripted.test:${scripted.port}/slow-ok HTTP/1.1`),
      );
      expect(
        await waitFor(() => scriptedHeard.includes("GET /slow-ok "), 2_000),
      ).toBe(true);
      talk.send(
        kept(`GET http://scripted.test:${scripted.port}/stolen-early HTTP/1.1`),
      );
      expect(headOf(await talk.waitFor("\r\n\r\nok"))).toContain(
        "\r\nconnection: close",
      );
      expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
      expect(scriptedHeard).not.toContain("stolen-early");
    });

    test("a request sent after a kept head but before its body ended is discarded", async () => {
      const talk = await connect(proxy.port);
      talk.send(
        kept(`GET http://scripted.test:${scripted.port}/slow-body HTTP/1.1`),
      );
      // The head promised to keep the connection; the client spoke too soon.
      expect(headOf(await talk.waitFor("\r\n\r\nok"))).not.toContain(
        "connection: close",
      );
      talk.send(
        kept(
          `GET http://scripted.test:${scripted.port}/stolen-mid-body HTTP/1.1`,
        ),
      );
      await talk.waitFor("\r\n\r\nokok");
      expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
      expect(scriptedHeard).not.toContain("stolen-mid-body");
    });

    test.each([
      ["closes inside its head", "/torn", "502 Bad Gateway"],
      ["closes inside its body", "/short", "\r\n\r\nabc"],
    ])(
      "a connection whose upstream %s is not kept",
      async (_name, path, seen) => {
        const talk = await connect(proxy.port);
        talk.send(
          kept(`GET http://scripted.test:${scripted.port}${path} HTTP/1.1`),
        );
        await talk.waitFor(seen as string);
        expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
      },
    );

    test.each([
      ["has no framing", "/eof", "all of it"],
      ["is HTTP/1.0", "/http10", "\r\n\r\nok"],
    ])(
      "a connection whose answer %s is not kept",
      async (_name, path, seen) => {
        const talk = await connect(proxy.port);
        talk.send(
          kept(`GET http://scripted.test:${scripted.port}${path} HTTP/1.1`),
        );
        expect(headOf(await talk.waitFor(seen as string))).toContain(
          "\r\nconnection: close",
        );
        expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
      },
    );

    test("an answer that comes before the upload is over is not kept", async () => {
      const talk = await connect(proxy.port);
      talk.send(
        `${kept(
          `POST http://scripted.test:${scripted.port}/early-401 HTTP/1.1`,
          "content-length: 100",
        )}${"x".repeat(10)}`,
      );
      expect(headOf(await talk.waitFor("\r\n\r\nno"))).toContain(
        "\r\nconnection: close",
      );
      expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
    });

    test("an upstream that writes on after its answer never reaches the next one", async () => {
      const talk = await connect(proxy.port);
      talk.send(
        kept(`GET http://scripted.test:${scripted.port}/late-forged HTTP/1.1`),
      );
      await talk.waitFor("\r\n\r\nok");
      // The forged answer is written 150ms in, while this one takes 300ms.
      talk.send(kept(`GET http://gateway.test:${upstreamPort}/slow HTTP/1.1`));
      expect(await talk.waitFor("upstream /slow ", 3_000)).not.toContain(
        "forged",
      );
      talk.close();
    });

    test.each([
      ["HEAD", "/head-forged"],
      ["GET", "/no-content-forged"],
    ])(
      "bytes behind a %s answer with no body never reach the next origin",
      async (method, path) => {
        const talk = await connect(proxy.port);
        talk.send(
          kept(
            `${method} http://scripted.test:${scripted.port}${path} HTTP/1.1`,
          ),
        );
        await talk.waitFor("\r\n\r\n");
        // Past the 5ms the script waits before its forged answer.
        await Bun.sleep(50);
        talk.send(kept(`GET http://other.test:${other.port}/after HTTP/1.1`));
        expect(await talk.waitFor("other /after")).not.toContain("forged");
        talk.close();
      },
    );

    test("a CONNECT on a kept connection goes through the same tunnel gate", async () => {
      const talk = await connect(proxy.port);
      talk.send(kept(`GET http://other.test:${other.port}/first HTTP/1.1`));
      await talk.waitFor("other /first");
      talk.send(request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`));
      await talk.waitFor("200 Connection Established");
      talk.sendBytes(clientHello({ serverNames: ["tunnel.test"] }));
      talk.send("ping-after-a-forward");
      await talk.waitFor("ping-after-a-forward");
      talk.close();

      const before = sunk;
      const evil = await connect(proxy.port);
      evil.send(kept(`GET http://other.test:${other.port}/first HTTP/1.1`));
      await evil.waitFor("other /first");
      evil.send(request(`CONNECT sink.test:${sink.port} HTTP/1.1`));
      await evil.waitFor("200 Connection Established");
      evil.sendBytes(clientHello({ serverNames: ["evil.test"] }));
      expect(await waitFor(() => evil.isClosed(), 5_000)).toBe(true);
      expect(sunk).toBe(before);
    });

    test("an answer the upstream sent before it was asked is not kept", async () => {
      // Speaks first, so its whole answer is held until the dial reports
      // back and is delivered while the dispatch is still writing the
      // request: reusing the connection there would leave that request to
      // be written into the next exchange's queue.
      const eager = Bun.listen<undefined>({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data() {},
          open(socket) {
            socket.write("HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\neager");
          },
        },
      });
      const held = await startEgressProxy({
        connect: async (options) => {
          const socket = await Bun.connect(options);
          await Bun.sleep(50);
          return socket;
        },
        logger: silent,
        policy: {
          allow: [],
          allowPrivate: [
            { host: "eager.test", port: eager.port },
            { host: "scripted.test", port: scripted.port },
          ],
        },
        port: 0,
        resolve: async (host) =>
          host === "eager.test" ? ["127.0.0.1"] : resolve(host),
      });
      try {
        const talk = await connect(held.port);
        talk.send(
          kept(`GET http://eager.test:${eager.port}/eager-ask HTTP/1.1`),
        );
        expect(headOf(await talk.waitFor("\r\n\r\neager"))).toContain(
          "\r\nconnection: close",
        );
        expect(await waitFor(() => talk.isClosed(), 2_000)).toBe(true);
      } finally {
        held.stop();
        eager.stop(true);
      }
    });

    test("a connection is kept only once a large answer has drained", async () => {
      const talk = await connect(proxy.port);
      talk.send(kept(`GET http://gateway.test:${upstreamPort}/large HTTP/1.1`));
      await talk.waitForBody(BIG.length);
      talk.send(
        kept(`GET http://other.test:${other.port}/after-large HTTP/1.1`),
      );
      const deadline = Date.now() + 5_000;
      while (!talk.tail().includes("other /after-large")) {
        if (talk.isClosed() || Date.now() > deadline) {
          throw new Error(
            `no second answer; ended ${JSON.stringify(talk.tail().slice(-200))}`,
          );
        }
        await Bun.sleep(10);
      }
      talk.close();
    });

    test("an idle kept connection is closed without a 408", async () => {
      const quick = await startEgressProxy({
        headTimeoutMs: 200,
        logger: silent,
        policy: {
          allow: [],
          allowPrivate: [{ host: "other.test", port: other.port ?? 0 }],
        },
        port: 0,
        resolve,
      });
      try {
        const idle = await connect(quick.port);
        idle.send(kept(`GET http://other.test:${other.port}/idle HTTP/1.1`));
        await idle.waitFor("other /idle");
        expect(await waitFor(() => idle.isClosed(), 2_000)).toBe(true);
        expect(idle.text()).not.toContain("408");
        // A head left half-sent is still answered.
        const halfway = await connect(quick.port);
        halfway.send(kept(`GET http://other.test:${other.port}/idle HTTP/1.1`));
        await halfway.waitFor("other /idle");
        halfway.send("GET http://other.test");
        expect(await halfway.waitFor("408")).toContain("timed out");
      } finally {
        quick.stop();
      }
    });

    test("a kept connection holds the one slot it was given", async () => {
      const capped = await startEgressProxy({
        logger: silent,
        maxConnectionsPerClient: 1,
        policy: {
          allow: [],
          allowPrivate: [{ host: "other.test", port: other.port ?? 0 }],
        },
        port: 0,
        resolve,
      });
      try {
        const talk = await connect(capped.port);
        for (const path of ["/one", "/two", "/three"]) {
          talk.send(
            kept(`GET http://other.test:${other.port}${path} HTTP/1.1`),
          );
          await talk.waitFor(`other ${path}`);
        }
        const second = await connect(capped.port);
        expect(await second.waitFor("503")).toContain("too many connections");
        talk.close();
      } finally {
        capped.stop();
      }
    });

    test("Bun's fetch gets every answer after non-2xx ones, on one connection", async () => {
      // One connection per client: a fetch that opened another while the
      // first was kept would be refused with a 503.
      const single = await startEgressProxy({
        logger: silent,
        maxConnectionsPerClient: 1,
        policy: {
          allow: [],
          allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
        },
        port: 0,
        resolve,
      });
      const post = (path: string) => [
        "fetch",
        "POST",
        `http://gateway.test:${upstreamPort}${path}`,
      ];
      try {
        // Linux lost about one run in nine of these to the old close.
        for (let run = 0; run < 10; run += 1) {
          expect(
            await pooledClientVia(
              single.port,
              ...post("/unauthorized"),
              ...post("/unauthorized"),
              ...post("/forbidden"),
              ...post("/unauthorized"),
            ),
          ).toEqual(["401 no", "401 no", "403 no", "401 no"]);
        }
      } finally {
        single.stop();
      }
    }, 30_000);
  });

  test("an allowlisted absolute-form request reaches the upstream", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      request(
        `POST http://gateway.test:${upstreamPort}/v1/turns HTTP/1.1`,
        "content-length: 5",
      ) + "hello",
    );
    const response = await talk.waitFor("upstream");
    expect(response).toContain("HTTP/1.1 200");
    expect(response).toContain("upstream /v1/turns hello");
    talk.close();
  });

  test("a host outside the allowlist gets 403 and no connection", async () => {
    const talk = await connect(proxy.port);
    talk.send(request("GET http://evil.test/ HTTP/1.1"));
    expect(await talk.waitFor("403")).toContain("not allowlisted");
    talk.close();
  });

  test("an allowlisted port is not an allowlist for every port", async () => {
    const talk = await connect(proxy.port);
    talk.send(request(`GET http://gateway.test:1/ HTTP/1.1`));
    expect(await talk.waitFor("403")).toContain("not allowlisted");
    talk.close();
  });

  test("a public entry resolving to a private address is refused", async () => {
    const talk = await connect(proxy.port);
    talk.send(request("CONNECT public.test:443 HTTP/1.1"));
    expect(await talk.waitFor("403")).toContain("10.0.0.7 is private");
    talk.close();
  });

  test("an allowlisted host that does not resolve gets 502, not 403", async () => {
    // A gateway container that is restarting drops out of Docker's DNS for a
    // few seconds; the worker has to read that as retryable.
    for (const head of [
      "GET http://gone.test/ HTTP/1.1",
      "CONNECT gone.test:80 HTTP/1.1",
      "GET http://empty.test/ HTTP/1.1",
    ]) {
      const talk = await connect(proxy.port);
      talk.send(request(head));
      const response = await talk.waitFor("does not resolve");
      expect(response).toStartWith("HTTP/1.1 502");
      talk.close();
    }
  });

  test("link-local is refused even though the host is allowlisted", async () => {
    const talk = await connect(proxy.port);
    talk.send(request("GET http://metadata.test/latest/meta-data/ HTTP/1.1"));
    expect(await talk.waitFor("403")).toContain("link_local");
    talk.close();
  });

  test("CONNECT tunnels bytes once the ClientHello names the authority", async () => {
    const talk = await connect(proxy.port);
    talk.send(request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`));
    expect(await talk.waitFor("200 Connection Established")).toContain(
      "HTTP/1.1 200",
    );
    const hello = clientHello({ serverNames: ["tunnel.test"] });
    talk.sendBytes(hello);
    // The echo returns the hello itself, so the tunnel is open both ways.
    await talk.waitForBytes(HEAD_200.length + hello.byteLength);
    talk.send("ping-through-the-tunnel");
    expect(await talk.waitFor("ping-through-the-tunnel")).toContain(
      "ping-through-the-tunnel",
    );
    talk.close();
  });

  test("bytes pipelined behind CONNECT go through the same gate", async () => {
    const hello = clientHello({ serverNames: ["tunnel.test"] });
    const talk = await connect(proxy.port);
    talk.sendBytes(
      concatBytes(
        new TextEncoder().encode(
          request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`),
        ),
        concatBytes(hello, new TextEncoder().encode("early-bytes")),
      ),
    );
    expect(await talk.waitFor("early-bytes")).toContain(
      "200 Connection Established",
    );
    talk.close();

    // The same pipelining with the wrong name is the same refusal.
    const before = sunk;
    const evil = await connect(proxy.port);
    evil.sendBytes(
      concatBytes(
        new TextEncoder().encode(
          request(`CONNECT sink.test:${sink.port} HTTP/1.1`),
        ),
        clientHello({ serverNames: ["evil.test"] }),
      ),
    );
    expect(await waitFor(() => evil.isClosed(), 5_000)).toBe(true);
    expect(sunk).toBe(before);
  });

  test("a ClientHello for another name closes the tunnel before any byte crosses", async () => {
    const before = sunk;
    const warnings: string[] = [];
    const proxyWithLog = await startEgressProxy({
      logger: createProxyLogger("warn", (line) => warnings.push(line)),
      policy: {
        allow: [],
        allowPrivate: [{ host: "sink.test", port: sink.port }],
      },
      port: 0,
      resolve,
    });
    try {
      const talk = await connect(proxyWithLog.port);
      talk.send(request(`CONNECT sink.test:${sink.port} HTTP/1.1`));
      await talk.waitFor("200 Connection Established");
      talk.sendBytes(clientHello({ serverNames: ["evil.test"] }));
      expect(await waitFor(() => talk.isClosed(), 5_000)).toBe(true);
      expect(sunk).toBe(before);
      expect(warnings.join("\n")).toContain("evil.test");
    } finally {
      proxyWithLog.stop();
    }
  });

  test("the server name is compared after the same normalisation as the authority", async () => {
    const talk = await connect(proxy.port);
    talk.send(request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`));
    await talk.waitFor("200 Connection Established");
    const hello = clientHello({ serverNames: ["Tunnel.TEST"] });
    talk.sendBytes(hello);
    await talk.waitForBytes(HEAD_200.length + hello.byteLength);
    talk.close();
  });

  test.each([
    ["no server name", clientHello()],
    [
      "encrypted_client_hello",
      clientHello({
        extensions: [
          {
            data: Uint8Array.from([1]),
            type: EXTENSION_ENCRYPTED_CLIENT_HELLO,
          },
        ],
        serverNames: ["sink.test"],
      }),
    ],
    [
      "a first record that is not a handshake",
      new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n"),
    ],
    [
      "a ClientHello that never completes within 16 KiB",
      // A record header promising more than the cap, followed by filler.
      concatBytes(
        Uint8Array.from([22, 3, 1, 0x3f, 0xff, 1, 0x00, 0x3f, 0xfb]),
        new Uint8Array(17 * 1024),
      ),
    ],
  ])("a tunnel whose first bytes are %s is dropped", async (_label, bytes) => {
    const before = sunk;
    const talk = await connect(proxy.port);
    talk.send(request(`CONNECT sink.test:${sink.port} HTTP/1.1`));
    await talk.waitFor("200 Connection Established");
    talk.sendBytes(bytes);
    expect(await waitFor(() => talk.isClosed(), 5_000)).toBe(true);
    expect(sunk).toBe(before);
  });

  test("a ClientHello dripped one byte at a time still passes, and the cap still holds", async () => {
    const talk = await connect(proxy.port);
    talk.send(request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`));
    await talk.waitFor("200 Connection Established");
    const hello = clientHello({ serverNames: ["tunnel.test"] });
    for (let at = 0; at < hello.byteLength; at += 1) {
      talk.sendBytes(hello.subarray(at, at + 1));
    }
    await talk.waitForBytes(HEAD_200.length + hello.byteLength);
    talk.close();

    // The same drip of a record that never completes is cut at the cap, so
    // the per-byte work is bounded by 16 KiB and not by the client's patience.
    const before = sunk;
    const drip = await connect(proxy.port);
    drip.send(request(`CONNECT sink.test:${sink.port} HTTP/1.1`));
    await drip.waitFor("200 Connection Established");
    const never = concatBytes(
      Uint8Array.from([22, 3, 1, 0x3f, 0xff, 1, 0x00, 0x3f, 0xfb]),
      new Uint8Array(17 * 1024),
    );
    const startedAt = Date.now();
    for (let at = 0; at < never.byteLength && !drip.isClosed(); at += 64) {
      drip.sendBytes(never.subarray(at, at + 64));
    }
    expect(await waitFor(() => drip.isClosed(), 5_000)).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(sunk).toBe(before);
  }, 20_000);

  test("early data coalesced behind a small ClientHello does not trip the cap", async () => {
    // TLS 1.3 0-RTT, or simply a fast client, can put application records
    // in the same segment as the hello. The cap is on the hello, not on the
    // segment, so all of it goes through once the hello passes.
    const talk = await connect(proxy.port);
    talk.send(request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`));
    await talk.waitFor("200 Connection Established");
    const hello = clientHello({ serverNames: ["tunnel.test"] });
    const trailing = new Uint8Array(20 * 1024).fill(0x17);
    talk.sendBytes(concatBytes(hello, trailing));
    const received = await talk.waitForBytes(
      HEAD_200.length + hello.byteLength + trailing.byteLength,
      10_000,
    );
    expect(received).toBe(
      HEAD_200.length + hello.byteLength + trailing.byteLength,
    );
    talk.close();
  }, 20_000);

  test("a ClientHello split across records and segments still passes", async () => {
    const talk = await connect(proxy.port);
    talk.send(request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`));
    await talk.waitFor("200 Connection Established");
    const hello = clientHello({ recordSize: 9, serverNames: ["tunnel.test"] });
    for (let at = 0; at < hello.byteLength; at += 5) {
      talk.sendBytes(hello.subarray(at, at + 5));
      await Bun.sleep(2);
    }
    await talk.waitForBytes(HEAD_200.length + hello.byteLength);
    talk.close();
  });

  test("a CONNECT to an address literal takes a hello without a name and not one with", async () => {
    const talk = await connect(proxy.port);
    talk.send(request(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1`));
    await talk.waitFor("200 Connection Established");
    const hello = clientHello();
    talk.sendBytes(hello);
    await talk.waitForBytes(HEAD_200.length + hello.byteLength);
    talk.close();

    const named = await connect(proxy.port);
    named.send(request(`CONNECT 127.0.0.1:${echo.port} HTTP/1.1`));
    await named.waitFor("200 Connection Established");
    named.sendBytes(clientHello({ serverNames: ["127.0.0.1"] }));
    expect(await waitFor(() => named.isClosed(), 5_000)).toBe(true);
  });

  test("a client that takes the tunnel and never speaks is dropped", async () => {
    const strict = await startEgressProxy({
      handshakeTimeoutMs: 200,
      logger: silent,
      policy: {
        allow: [],
        allowPrivate: [{ host: "sink.test", port: sink.port }],
      },
      port: 0,
      resolve,
    });
    try {
      const talk = await connect(strict.port);
      talk.send(request(`CONNECT sink.test:${sink.port} HTTP/1.1`));
      await talk.waitFor("200 Connection Established");
      expect(await waitFor(() => talk.isClosed(), 5_000)).toBe(true);
    } finally {
      strict.stop();
    }
  });

  test("origin-form is only answered for /healthz", async () => {
    const health = await connect(proxy.port);
    health.send(request("GET /healthz HTTP/1.1"));
    expect(await health.waitFor("ok")).toContain("HTTP/1.1 200");
    health.close();

    const other = await connect(proxy.port);
    other.send(request("GET / HTTP/1.1"));
    expect(await other.waitFor("400")).toContain("absolute-form");
    other.close();
  });

  test("a client that outruns the upstream handshake is dropped", async () => {
    // The connecting window is bounded in time, not in bytes, unless the
    // proxy bounds it; a slow resolver makes that window observable.
    const slow = await startEgressProxy({
      logger: silent,
      maxBufferedBytes: 64,
      policy: {
        allow: [],
        allowPrivate: [{ host: "tunnel.test", port: echo.port }],
      },
      port: 0,
      resolve: async (host) => {
        await Bun.sleep(300);
        return resolve(host);
      },
    });
    try {
      const talk = await connect(slow.port);
      talk.send(
        `${request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`)}${"x".repeat(200)}`,
      );
      await Bun.sleep(800);
      expect(talk.text()).not.toContain("200 Connection Established");
      expect(talk.isClosed()).toBe(true);
    } finally {
      slow.stop();
    }
  }, 10_000);

  test("a response far larger than a socket buffer arrives whole", async () => {
    // With the drain handlers wired to the wrong queues this stalls, and
    // with an eager close on upstream end it truncates.
    const talk = await connect(proxy.port);
    talk.send(
      request(`GET http://gateway.test:${upstreamPort}/large HTTP/1.1`),
    );
    const received = await talk.waitForBody(BIG.length, 30_000);
    expect(received).toBeGreaterThanOrEqual(BIG.length);
    talk.close();
  }, 60_000);

  test("a client slower than the upstream still gets every byte", async () => {
    // Burning 30ms inside every data callback makes this client slower than
    // a loopback upstream by far more than the cap below. The proxy used to
    // answer that by dropping the connection half way down, which reaches a
    // worker as a truncated file rather than as an error it can retry.
    //
    // The stall deadline stays at its default. Shortening it here to also
    // exercise the no-progress rearm put this test one scheduling hiccup
    // away from failing, and it did: `closed after 7704008 bytes` on the
    // arm64 runner. A test added to remove a flake must not be one.
    const tight = await startEgressProxy({
      logger: silent,
      maxBufferedBytes: 64 * 1024,
      policy: {
        allow: [],
        allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
      },
      port: 0,
      resolve,
    });
    try {
      const talk = await connect(tight.port, 30);
      talk.send(
        request(`GET http://gateway.test:${upstreamPort}/large HTTP/1.1`),
      );
      const received = await talk.waitForBody(BIG.length, 60_000);
      expect(received).toBeGreaterThanOrEqual(BIG.length);
      talk.close();
    } finally {
      tight.stop();
    }
  }, 120_000);

  test("a client that stops reading is dropped once its queue goes stale", async () => {
    // The other half of the same rule: pausing the upstream is the answer to
    // a slow client, and this deadline is the answer to one that never reads
    // again. Nothing else reaps a connection past its request head, so
    // without it a worker could hold a slot and its buffer for good.
    const warnings: string[] = [];
    const stallMs = 300;
    const strict = await startEgressProxy({
      logger: createProxyLogger("warn", (line) => warnings.push(line)),
      maxBufferedBytes: 64 * 1024,
      policy: {
        allow: [],
        allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
      },
      port: 0,
      resolve,
      stallTimeoutMs: stallMs,
    });
    try {
      const startedAt = Date.now();
      const talk = await connect(strict.port);
      talk.send(
        request(`GET http://gateway.test:${upstreamPort}/large HTTP/1.1`),
      );
      talk.stopReading();
      // A paused socket never reads the FIN either, so the close only shows
      // up once it starts reading again — which is why the proxy's own
      // account of giving up is what this waits on.
      const dropped = await waitFor(
        () => warnings.some((line) => line.includes("client fell behind")),
        10_000,
      );
      expect(dropped).toBe(true);
      // The old behaviour dropped the moment the cap was crossed, in tens of
      // milliseconds. Waiting out the deadline is what tells the two apart.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(stallMs);
      talk.resumeReading();
      expect(await waitFor(() => talk.isClosed(), 10_000)).toBe(true);
      expect(talk.byteCount()).toBeLessThan(BIG.length);
    } finally {
      strict.stop();
    }
  }, 30_000);

  test("a large upload through a tunnel comes back whole", async () => {
    const talk = await connect(proxy.port);
    talk.send(request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`));
    await talk.waitFor("200 Connection Established");
    const hello = clientHello({ serverNames: ["tunnel.test"] });
    talk.sendBytes(hello);
    const handshake = await talk.waitForBytes(
      HEAD_200.length + hello.byteLength,
    );
    const payload = "b".repeat(2 * 1024 * 1024);
    talk.send(payload);
    const received = await talk.waitForBytes(
      handshake + payload.length,
      30_000,
    );
    expect(received - handshake).toBeGreaterThanOrEqual(payload.length);
    talk.close();
  }, 60_000);

  test("an oversized head is refused even when it arrives all at once", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      `GET http://gateway.test/ HTTP/1.1\r\nx-pad: ${"a".repeat(20_000)}\r\n\r\n`,
    );
    expect(await talk.waitFor("431")).toContain("too large");
    talk.close();
  });

  test("idle clients cannot hold the connection budget for good", async () => {
    const small = await startEgressProxy({
      headTimeoutMs: 300,
      logger: silent,
      maxConnections: 2,
      policy: {
        allow: [],
        allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
      },
      port: 0,
      resolve,
    });
    try {
      const idle = [await connect(small.port), await connect(small.port)];
      const refused = await connect(small.port);
      expect(await refused.waitFor("503")).toContain("connection limit");
      refused.close();

      // The head deadline hands the slots back without anyone intervening.
      for (const one of idle) {
        expect(await one.waitFor("408")).toContain("timed out");
      }
      const after = await connect(small.port);
      after.send(
        request(`GET http://gateway.test:${upstreamPort}/ok HTTP/1.1`),
      );
      expect(await after.waitFor("upstream /ok")).toContain("HTTP/1.1 200");
      after.close();
      for (const one of idle) one.close();
    } finally {
      small.stop();
    }
  }, 30_000);

  test("one client cannot take more than its share of connections", async () => {
    const capped = await startEgressProxy({
      headTimeoutMs: 10_000,
      logger: silent,
      maxConnections: 64,
      maxConnectionsPerClient: 1,
      policy: { allow: [], allowPrivate: [] },
      port: 0,
      resolve,
    });
    try {
      const first = await connect(capped.port);
      const second = await connect(capped.port);
      expect(await second.waitFor("503")).toContain("this client");
      first.close();
      second.close();
    } finally {
      capped.stop();
    }
  }, 20_000);

  test("a client that leaves mid-connect keeps its slot until that settles", async () => {
    let letResolve: (() => void) | undefined;
    const gate = new Promise<void>((done) => {
      letResolve = done;
    });
    let resolving = 0;
    const slow = await startEgressProxy({
      headTimeoutMs: 20_000,
      logger: silent,
      maxConnections: 64,
      maxConnectionsPerClient: 1,
      policy: {
        allow: [],
        allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
      },
      port: 0,
      resolve: async () => {
        resolving += 1;
        await gate;
        return ["127.0.0.1"];
      },
    });
    try {
      const first = await connect(slow.port);
      first.send(
        request(`GET http://gateway.test:${upstreamPort}/slow HTTP/1.1`),
      );
      while (resolving === 0) await Bun.sleep(5);

      // Gone from the client's side, but the outbound attempt it started is
      // still alive, so the slot it is spending must not come back yet.
      first.close();
      await Bun.sleep(50);
      const second = await connect(slow.port);
      expect(await second.waitFor("503")).toContain("this client");
      second.close();

      letResolve?.();
      const after = await connect(slow.port);
      after.send(
        request(`GET http://gateway.test:${upstreamPort}/ok HTTP/1.1`),
      );
      expect(await after.waitFor("upstream /ok")).toContain("HTTP/1.1 200");
      after.close();
    } finally {
      letResolve?.();
      slow.stop();
    }
  }, 30_000);

  test("a name lookup that never answers still gives the slot back", async () => {
    const stuck = await startEgressProxy({
      dispatchTimeoutMs: 300,
      headTimeoutMs: 20_000,
      logger: silent,
      maxConnections: 64,
      maxConnectionsPerClient: 1,
      policy: {
        allow: [],
        allowPrivate: [{ host: "gateway.test", port: upstreamPort }],
      },
      port: 0,
      // The OS resolver can hang; nothing in this process can cancel it.
      resolve: () => new Promise<string[]>(() => undefined),
    });
    try {
      const first = await connect(stuck.port);
      first.send(
        request(`GET http://gateway.test:${upstreamPort}/hang HTTP/1.1`),
      );
      expect(await first.waitFor("504")).toContain("timed out");
      first.close();
      await Bun.sleep(50);

      // The slot is back although the lookup never answered: a second
      // request gets its own dispatch instead of the per-client 503.
      const second = await connect(stuck.port);
      second.send(
        request(`GET http://gateway.test:${upstreamPort}/hang HTTP/1.1`),
      );
      expect(await second.waitFor("504")).toContain("timed out");
      second.close();
    } finally {
      stuck.stop();
    }
  }, 20_000);

  test("an attempt that opens after we gave up does not kill the live tunnel", async () => {
    // Address A is dialled first and answers too late; by then B carries the
    // tunnel, so A's teardown must not reach the client.
    let first = true;
    const late = await startEgressProxy({
      connectTimeoutMs: 200,
      // The dial itself is the seam: A connects for real but reports back
      // after the deadline, which is what a slow path looks like from here.
      connect: async (opts) => {
        // Decided before the connect: a first dial slower than the deadline
        // would otherwise leave the second one delayed too.
        const delayed = first;
        first = false;
        const socket = await Bun.connect(opts);
        if (delayed) await Bun.sleep(600);
        return socket;
      },
      logger: silent,
      policy: {
        allow: [],
        allowPrivate: [{ host: "tunnel.test", port: echo.port }],
      },
      port: 0,
      resolve: async () => ["127.0.0.1", "127.0.0.1"],
    });
    try {
      const talk = await connect(late.port);
      talk.send(request(`CONNECT tunnel.test:${echo.port} HTTP/1.1`));
      expect(
        await talk.waitFor("200 Connection Established", 10_000),
      ).toContain("200");
      talk.sendBytes(clientHello({ serverNames: ["tunnel.test"] }));
      talk.send("before");
      expect(await talk.waitFor("before", 10_000)).toContain("before");

      // Past the abandoned attempt's own arrival, the tunnel is still there.
      await Bun.sleep(800);
      talk.send("after");
      expect(await talk.waitFor("after", 10_000)).toContain("after");
      talk.close();
    } finally {
      late.stop();
    }
  }, 30_000);

  test("bytes from an attempt we gave up on never reach the client", async () => {
    // A server-first upstream speaks the moment it accepts. Attempt A is
    // dialled first and reports back too late: its banner arrives while the
    // attempt is still pending, and once B carries the tunnel that banner
    // (and any pause or stall it caused) must stay with A.
    let banners = 0;
    // A's banner is far past any socket buffer, so with the client not
    // reading it can only be queued, which is what used to arm the stall
    // timer; B's fits in the kernel buffer and never queues at all.
    const banner = (n: number): string =>
      `server-first-banner-${n}`.repeat(n === 1 ? 64 * 1024 : 8);
    const talker = Bun.listen<EchoState>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, chunk) {
          socket.data.pending = socket.data.pending
            ? concatBytes(socket.data.pending, chunk)
            : chunk;
          echoDrain(socket);
        },
        drain(socket) {
          echoDrain(socket);
        },
        open(socket) {
          banners += 1;
          // Queued like the echo, so a banner past the socket buffer is
          // delivered whole instead of cut at the first partial write.
          socket.data = {
            pending: new TextEncoder().encode(banner(banners)),
          };
          echoDrain(socket);
        },
      },
    });
    let first = true;
    const stallMs = 300;
    const late = await startEgressProxy({
      connectTimeoutMs: 200,
      connect: async (opts) => {
        // Decided before the connect: a first dial slower than the deadline
        // would otherwise leave the second one delayed too.
        const delayed = first;
        first = false;
        const socket = await Bun.connect(opts);
        if (delayed) await Bun.sleep(600);
        return socket;
      },
      logger: silent,
      // Smaller than one banner, so the pending attempt crosses the cap the
      // way a stall would; that must not arm the connection's timer.
      maxBufferedBytes: 64,
      policy: {
        allow: [],
        allowPrivate: [{ host: "tunnel.test", port: talker.port }],
      },
      port: 0,
      resolve: async () => ["127.0.0.1", "127.0.0.1"],
      stallTimeoutMs: stallMs,
    });
    try {
      const talk = await connect(late.port);
      talk.send(request(`CONNECT tunnel.test:${talker.port} HTTP/1.1`));
      // Not reading while A arrives, is abandoned, and the stall deadline
      // passes: a timer A armed against this connection would fire here.
      talk.stopReading();
      await Bun.sleep(800 + stallMs);
      talk.resumeReading();
      expect(
        await talk.waitFor("200 Connection Established", 10_000),
      ).toStartWith("HTTP/1.1 200 Connection Established");
      // The winner's banner is what the client gets, and only after the 200.
      const seen = await talk.waitFor(banner(2), 10_000);
      expect(seen.indexOf("200 Connection Established")).toBeLessThan(
        seen.indexOf(banner(2)),
      );
      talk.sendBytes(clientHello({ serverNames: ["tunnel.test"] }));
      talk.send("before");
      expect(await talk.waitFor("before", 10_000)).toContain("before");
      talk.send("after");
      expect(await talk.waitFor("after", 10_000)).toContain("after");
      // Not one fragment of A: the sentinel is short enough that a partial
      // leak could not hide behind the client's transcript cap.
      expect(talk.text()).not.toContain("server-first-banner-1");
      expect(talk.isClosed()).toBe(false);
      talk.close();
    } finally {
      late.stop();
      talker.stop(true);
    }
  }, 30_000);

  test("a dead address does not fail a destination with a live one", async () => {
    const failover = await startEgressProxy({
      connectTimeoutMs: 2_000,
      logger: silent,
      policy: {
        allow: [],
        allowPrivate: [{ host: "dual.test", port: upstreamPort }],
      },
      port: 0,
      // 127.0.0.2 is loopback with nothing listening; both addresses pass
      // the same policy, so the second must still be tried.
      resolve: async () => ["127.0.0.2", "127.0.0.1"],
    });
    try {
      const talk = await connect(failover.port);
      talk.send(
        request(`GET http://dual.test:${upstreamPort}/failover HTTP/1.1`),
      );
      expect(await talk.waitFor("upstream /failover", 15_000)).toContain(
        "HTTP/1.1 200",
      );
      talk.close();
    } finally {
      failover.stop();
    }
  }, 30_000);

  test("an oversized request head is refused instead of buffered", async () => {
    const talk = await connect(proxy.port);
    talk.send(
      `GET http://gateway.test/ HTTP/1.1\r\nx-pad: ${"a".repeat(20_000)}\r\n`,
    );
    expect(await talk.waitFor("431")).toContain("too large");
    talk.close();
  });
});

const HEAD_200 = "HTTP/1.1 200 Connection Established\r\n\r\n";

const END = Symbol("end");
/** Waits long enough for a client to act in the middle of an answer. */
const PAUSE = Symbol("pause");
/** What `scripted.test` writes for each path, one write per element. */
const SCRIPTS: Record<string, Array<string | typeof END | typeof PAUSE>> = {
  "/continue": [
    "HTTP/1.1 100 Continue\r\n\r\n",
    "HTTP/1.1 201 Created\r\ncontent-length: 4\r\n\r\ndone",
  ],
  // A body-less answer whose upstream sends a forged answer behind it.
  "/head-forged": [
    "HTTP/1.1 200 OK\r\ncontent-length: 6\r\n\r\n",
    "HTTP/1.1 200 OK\r\ncontent-length: 6\r\n\r\nforged",
  ],
  "/no-content-forged": [
    "HTTP/1.1 204 No Content\r\n\r\n",
    "HTTP/1.1 200 OK\r\ncontent-length: 6\r\n\r\nforged",
  ],
  // Keeps writing after its answer is complete, while the client's next
  // exchange is in flight.
  "/late-forged": [
    "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok",
    PAUSE,
    "HTTP/1.1 200 OK\r\ncontent-length: 6\r\n\r\nforged",
    END,
  ],
  "/slow-ok": [PAUSE, "HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"],
  "/slow-body": ["HTTP/1.1 200 OK\r\ncontent-length: 4\r\n\r\nok", PAUSE, "ok"],
  // Answers before the upload is over, as an auth failure does.
  "/early-401": ["HTTP/1.1 401 Unauthorized\r\ncontent-length: 2\r\n\r\nno"],
  "/eof": ["HTTP/1.1 200 OK\r\n\r\nall of it", END],
  "/http10": ["HTTP/1.0 200 OK\r\ncontent-length: 2\r\n\r\nok"],
  "/short": ["HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc", END],
  "/huge-head": [
    `HTTP/1.1 200 OK\r\nx-pad: ${"a".repeat(20_000)}`,
    "\r\ncontent-length: 2\r\n\r\nok",
  ],
  // Stays open after the body, as Bun.serve does after an async answer.
  "/keep-alive": [
    "HTTP/1.1 200 OK\r\nConnection: keep-alive, X-Hop\r\n",
    "Keep-Alive: timeout=5\r\nX-Hop: 1\r\nX-End-To-End: kept\r\n",
    "content-length: 2\r\n\r\nok",
  ],
  "/torn": ["HTTP/1.1 200 OK\r\ncontent-le", END],
};

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.byteLength + right.byteLength);
  out.set(left, 0);
  out.set(right, left.byteLength);
  return out;
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await Bun.sleep(20);
  }
  return false;
}

function request(...lines: string[]): string {
  return `${lines.join("\r\n")}\r\n\r\n`;
}

type Conversation = {
  byteCount(): number;
  close(): void;
  isClosed(): boolean;
  send(text: string): void;
  sendBytes(bytes: Uint8Array): void;
  waitForBody(count: number, timeoutMs?: number): Promise<number>;
  /** Stop draining without closing — a client the proxy has to give up on. */
  stopReading(): void;
  resumeReading(): void;
  /** The last bytes received, kept however long the transfer was. */
  tail(): string;
  text(): string;
  waitFor(needle: string, timeoutMs?: number): Promise<string>;
  waitForBytes(count: number, timeoutMs?: number): Promise<number>;
};

/**
 * `slowReadMs` burns CPU inside the data handler so the client stops
 * draining its socket: that is what forces the proxy into a partial write
 * and makes the drain path run at all.
 */
async function connect(port: number, slowReadMs = 0): Promise<Conversation> {
  let received = "";
  let last = "";
  let bytes = 0;
  let headerBytes: number | null = null;
  let closed = false;
  // The client has to respect backpressure too, or a megabyte-scale send
  // silently truncates and the test blames the proxy.
  let outbox: Uint8Array | null = null;
  const drainOutbox = (target: { write(data: Uint8Array): number }): void => {
    while (outbox !== null) {
      const written = Math.max(0, target.write(outbox));
      if (written >= outbox.byteLength) {
        outbox = null;
        return;
      }
      if (written === 0) return;
      outbox = outbox.subarray(written);
    }
  };
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      close() {
        closed = true;
      },
      drain(peer) {
        drainOutbox(peer);
      },
      data(_socket, chunk) {
        if (slowReadMs > 0) {
          const until = Bun.nanoseconds() + slowReadMs * 1_000_000;
          while (Bun.nanoseconds() < until) {
            // spin
          }
        }
        bytes += chunk.byteLength;
        const decoded = new TextDecoder().decode(chunk);
        // A megabyte-scale transfer is measured, not accumulated.
        if (received.length < 64 * 1024) received += decoded;
        last = (last + decoded).slice(-4096);
        if (headerBytes === null) {
          const end = received.indexOf("\r\n\r\n");
          if (end >= 0) headerBytes = end + 4;
        }
      },
    },
  });
  const sendBytes = (encoded: Uint8Array): void => {
    outbox = outbox === null ? encoded : concatBytes(outbox, encoded);
    drainOutbox(socket);
  };
  return {
    byteCount(): number {
      return bytes;
    },
    close(): void {
      socket.end();
    },
    isClosed(): boolean {
      return closed;
    },
    send(text: string): void {
      sendBytes(new TextEncoder().encode(text));
    },
    sendBytes,
    stopReading(): void {
      // Untyped in bun-types; see the note on `reader` in proxy.ts.
      (socket as unknown as { pause(): boolean }).pause();
    },
    resumeReading(): void {
      (socket as unknown as { resume(): boolean }).resume();
    },
    tail(): string {
      return last;
    },
    text(): string {
      return received;
    },
    // Counting the response head as payload would let a transfer that is
    // short by exactly the head still satisfy `>= BIG.length`.
    async waitForBody(count: number, timeoutMs = 20_000): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (headerBytes !== null && bytes - headerBytes >= count) {
          return bytes - headerBytes;
        }
        if (closed) {
          throw new Error(`closed after ${bytes} bytes, head ${headerBytes}`);
        }
        await Bun.sleep(10);
      }
      throw new Error(
        `timed out after ${bytes} bytes; wanted ${count} of body`,
      );
    },
    async waitForBytes(count: number, timeoutMs = 20_000): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (bytes >= count) return bytes;
        // A short read and a truncated transfer are different failures, and
        // returning the byte count for both once read as "slow" what was a
        // connection the proxy had closed.
        if (closed) throw new Error(`closed after ${bytes} of ${count} bytes`);
        await Bun.sleep(10);
      }
      throw new Error(`timed out after ${bytes} of ${count} bytes`);
    },
    async waitFor(needle: string, timeoutMs = 5_000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (received.includes(needle)) return received;
        await Bun.sleep(10);
      }
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}; saw ${JSON.stringify(received)}`,
      );
    },
  };
}

describe("the system resolver", () => {
  test("asks libc on every call, so a restarted upstream is followed", async () => {
    const answers = ["10.0.0.7", "10.0.0.9"];
    const lookup = spyOn(Bun.dns, "lookup").mockImplementation(
      async () =>
        [{ address: answers.shift() ?? "", family: 4, ttl: 600 }] as never,
    );
    try {
      expect(await systemResolver("localstack")).toEqual(["10.0.0.7"]);
      // The first answer came with a TTL of 600s and still was not kept.
      expect(await systemResolver("localstack")).toEqual(["10.0.0.9"]);
      expect(lookup.mock.calls).toEqual([
        ["localstack", { backend: "libc" }],
        ["localstack", { backend: "libc" }],
      ]);
    } finally {
      lookup.mockRestore();
    }
  });
});

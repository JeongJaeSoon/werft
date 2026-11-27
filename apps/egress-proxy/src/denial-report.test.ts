import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TCPSocketListener } from "bun";
import {
  createDenialReporter,
  type EgressDenial,
  reportTokenOf,
} from "./denial-report.ts";
import type { ProxyLogger } from "./logger.ts";
import type { EgressResolver } from "./policy.ts";
import { type EgressProxyServer, startEgressProxy } from "./proxy.ts";

const TOKEN = "wed_attempt-marker";
const basic = (user: string, password: string) =>
  `Basic ${btoa(`${user}:${password}`)}`;

function recordingLogger() {
  const lines: Array<[string, Record<string, unknown>]> = [];
  const log = (message: string, fields: Record<string, unknown> = {}) => {
    lines.push([message, fields]);
  };
  const logger: ProxyLogger = { debug: log, error: log, info: log, warn: log };
  return { lines, logger };
}

/** Sends one request head and reads until the proxy closes or answers. */
async function exchange(port: number, head: string): Promise<string> {
  let text = "";
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        text += new TextDecoder().decode(chunk);
        if (text.includes("\r\n\r\n")) done();
      },
      close() {
        done();
      },
    },
  });
  socket.write(`${head}\r\n\r\n`);
  await Promise.race([finished, Bun.sleep(5_000)]);
  socket.end();
  return text;
}

describe("reportTokenOf", () => {
  test("reads the password of Basic credentials", () => {
    expect(reportTokenOf(basic("werft", TOKEN))).toBe(TOKEN);
    expect(reportTokenOf(`basic  ${btoa(`x:${TOKEN}`)}`)).toBe(TOKEN);
  });

  test("anything else is no token", () => {
    for (const field of [
      undefined,
      "",
      `Bearer ${TOKEN}`,
      "Basic not*base64",
      `Basic ${btoa("no-colon")}`,
      basic("werft", ""),
      basic("werft", "x".repeat(513)),
      basic("werft", "%E0%A4%A"),
    ]) {
      expect(reportTokenOf(field)).toBeUndefined();
    }
  });
});

describe("the forward port reports what it refused", () => {
  let echo: TCPSocketListener<undefined>;
  let proxy: EgressProxyServer;
  let throwing: EgressProxyServer;
  const reported: EgressDenial[] = [];
  const resolve: EgressResolver = async (host) =>
    host === "private.test" ? ["10.0.0.7"] : ["127.0.0.1"];

  beforeAll(async () => {
    echo = Bun.listen<undefined>({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const policy = {
      allow: [{ host: "private.test", port: 443 }],
      allowPrivate: [{ host: "open.test", port: echo.port }],
    };
    const silent = recordingLogger().logger;
    proxy = await startEgressProxy({
      logger: silent,
      policy,
      port: 0,
      resolve,
      reportDenial: (denial) => reported.push(denial),
    });
    throwing = await startEgressProxy({
      logger: silent,
      policy,
      port: 0,
      resolve,
      reportDenial: () => {
        throw new Error("reporter broke");
      },
    });
  });

  afterAll(() => {
    proxy.stop();
    throwing.stop();
    echo.stop(true);
  });

  test("a refused tunnel names its host and port, and is reported once with its token", async () => {
    reported.length = 0;
    const answer = await exchange(
      proxy.port,
      `CONNECT blocked.test:443 HTTP/1.1\r\nproxy-authorization: ${basic("werft", TOKEN)}`,
    );
    expect(answer).toStartWith("HTTP/1.1 403");
    expect(answer).toContain(
      "egress denied: destination is not allowlisted (blocked.test:443)",
    );
    expect(reported).toEqual([
      { token: TOKEN, host: "blocked.test", port: 443 },
    ]);
  });

  test("a refused absolute-form request reports its host and port only", async () => {
    reported.length = 0;
    const answer = await exchange(
      proxy.port,
      `GET http://Blocked.test/private/path?key=hidden HTTP/1.1\r\nhost: blocked.test\r\nproxy-authorization: ${basic("werft", TOKEN)}`,
    );
    expect(answer).toStartWith("HTTP/1.1 403");
    expect(answer).toContain("(blocked.test:80)");
    expect(answer).not.toContain("private/path");
    expect(answer).not.toContain("hidden");
    expect(reported).toEqual([
      { token: TOKEN, host: "blocked.test", port: 80 },
    ]);
    expect(JSON.stringify(reported)).not.toContain("hidden");
  });

  test("a refusal without a token is answered the same and reported to nobody", async () => {
    reported.length = 0;
    for (const extra of ["", `\r\nproxy-authorization: Bearer ${TOKEN}`]) {
      const answer = await exchange(
        proxy.port,
        `CONNECT blocked.test:443 HTTP/1.1${extra}`,
      );
      expect(answer).toContain("destination is not allowlisted");
    }
    expect(reported).toEqual([]);
  });

  test("two Proxy-Authorization fields are no one's token", async () => {
    reported.length = 0;
    await exchange(
      proxy.port,
      `CONNECT blocked.test:443 HTTP/1.1\r\nproxy-authorization: ${basic("werft", TOKEN)}\r\nproxy-authorization: ${basic("werft", "other")}`,
    );
    expect(reported).toEqual([]);
  });

  test("an allowed tunnel is not reported", async () => {
    reported.length = 0;
    const answer = await exchange(
      proxy.port,
      `CONNECT open.test:${echo.port} HTTP/1.1\r\nproxy-authorization: ${basic("werft", TOKEN)}`,
    );
    expect(answer).toStartWith("HTTP/1.1 200");
    expect(reported).toEqual([]);
  });

  test("a refusal the allowlist does not decide is not reported", async () => {
    reported.length = 0;
    const answer = await exchange(
      proxy.port,
      `CONNECT private.test:443 HTTP/1.1\r\nproxy-authorization: ${basic("werft", TOKEN)}`,
    );
    expect(answer).toStartWith("HTTP/1.1 403");
    expect(answer).toContain("10.0.0.7 is private");
    expect(reported).toEqual([]);
  });

  test("a malformed tunnel authority is neither echoed nor reported", async () => {
    reported.length = 0;
    const answer = await exchange(
      proxy.port,
      `CONNECT user:pw@blocked.test/p:443 HTTP/1.1\r\nproxy-authorization: ${basic("werft", "marker")}`,
    );
    expect(answer).toStartWith("HTTP/1.1 403");
    expect(answer).toContain("destination is not allowlisted");
    expect(answer).not.toContain("pw@");
    expect(reported).toEqual([]);
  });

  test("an IPv6 literal is named in brackets", async () => {
    reported.length = 0;
    const answer = await exchange(
      proxy.port,
      `CONNECT [2001:db8::1]:443 HTTP/1.1\r\nproxy-authorization: ${basic("werft", "marker")}`,
    );
    expect(answer).toContain("([2001:db8::1]:443)");
    expect(reported).toEqual([
      { token: "marker", host: "2001:db8::1", port: 443 },
    ]);
  });

  test("a reporter that throws does not stop the refusal", async () => {
    const answer = await exchange(
      throwing.port,
      `CONNECT blocked.test:443 HTTP/1.1\r\nproxy-authorization: ${basic("werft", TOKEN)}`,
    );
    expect(answer).toStartWith("HTTP/1.1 403");
  });
});

describe("createDenialReporter", () => {
  test("posts the report to the authorizer's denial path with its bearer", async () => {
    const received: Array<{
      path: string;
      auth: string | null;
      body: unknown;
    }> = [];
    const authorizer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        received.push({
          path: new URL(request.url).pathname,
          auth: request.headers.get("authorization"),
          body: await request.json(),
        });
        return new Response(null, { status: 204 });
      },
    });
    try {
      const { lines, logger } = recordingLogger();
      const report = createDenialReporter({
        authorizerUrl: `http://127.0.0.1:${authorizer.port}/`,
        token: "service-bearer",
        logger,
      });
      report({ token: TOKEN, host: "blocked.test", port: 443 });
      const until = Date.now() + 5_000;
      while (received.length === 0 && Date.now() < until) await Bun.sleep(10);
      expect(received).toEqual([
        {
          path: "/egress-denials",
          auth: "Bearer service-bearer",
          body: { token: TOKEN, host: "blocked.test", port: 443 },
        },
      ]);
      expect(lines).toEqual([]);
    } finally {
      authorizer.stop(true);
    }
  });

  test("a report that fails or finds too many ahead is dropped, and the token is not logged", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const authorizer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await held;
        return new Response("no", { status: 503 });
      },
    });
    try {
      const { lines, logger } = recordingLogger();
      const report = createDenialReporter({
        authorizerUrl: `http://127.0.0.1:${authorizer.port}`,
        token: "service-bearer",
        logger,
        maxInFlight: 1,
      });
      report({ token: TOKEN, host: "first.test", port: 443 });
      report({ token: TOKEN, host: "second.test", port: 443 });
      expect(lines).toEqual([
        [
          "Egress denial report dropped",
          { host: "second.test", port: 443, reason: "too many in flight" },
        ],
      ]);
      release();
      const until = Date.now() + 5_000;
      while (lines.length < 2 && Date.now() < until) await Bun.sleep(10);
      expect(lines[1]).toEqual([
        "Egress denial report refused",
        { host: "first.test", port: 443, status: 503 },
      ]);
      expect(JSON.stringify(lines)).not.toContain(TOKEN);
    } finally {
      authorizer.stop(true);
    }
  });
});

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bodyReservation,
  type CredentialProxyServer,
  type EgressGrant,
  isPushAdvertisement,
  mcpCallOf,
  parseGrant,
  responseHeaders,
  routeOf,
  secretGuard,
  secretsOf,
  startCredentialProxy,
  tokenOf,
  upstreamRequestHeaders,
} from "./credential.ts";
import { createProxyLogger } from "./logger.ts";
import type { EgressPolicy } from "./policy.ts";

const AUTHORIZER_TOKEN = "authorizer-token-for-tests-0123456789";
const WORKER_TOKEN = "wep_worker-egress-token";
const PROVIDER_KEY = "sk-provider-key-kept-from-the-worker";
const silent = createProxyLogger("error", () => {});

describe("routeOf", () => {
  test("routes the Messages API and git's read half, nothing else", () => {
    expect(routeOf("POST", "/provider/v1/messages", "")).toEqual({
      purpose: "provider",
      path: "/v1/messages",
      search: "",
    });
    expect(
      routeOf("POST", "/provider/v1/messages", "?beta=true"),
    ).toMatchObject({ purpose: "provider", search: "?beta=true" });
    expect(
      routeOf("POST", "/provider/v1/messages/count_tokens", ""),
    ).toMatchObject({ path: "/v1/messages/count_tokens" });
    expect(
      routeOf("GET", "/repository/info/refs", "?service=git-upload-pack"),
    ).toEqual({
      purpose: "repository",
      path: "/info/refs",
      search: "?service=git-upload-pack",
    });
    expect(routeOf("POST", "/repository/git-upload-pack", "")).toMatchObject({
      path: "/git-upload-pack",
    });
    for (const [method, path, search] of [
      ["GET", "/provider/v1/messages", ""],
      ["POST", "/provider/v1/models", ""],
      ["POST", "/provider/v1/messages/batches", ""],
      ["POST", "/provider/v1/messages", "?beta=true&x=1"],
      ["POST", "/provider/v1/messages/", ""],
      ["POST", "/provider/../v1/messages", ""],
      ["GET", "/repository/info/refs", "?service=git-receive-pack"],
      ["POST", "/repository/git-receive-pack", ""],
      ["POST", "/repository/git-upload-pack", "?x=1"],
      ["GET", "/", ""],
    ] as const) {
      expect(routeOf(method, path, search)).toBeNull();
    }
  });

  test("routes /v1/responses as a provider call with no query, and no sibling of it", () => {
    expect(routeOf("POST", "/provider/v1/responses", "")).toEqual({
      purpose: "provider",
      path: "/v1/responses",
      search: "",
    });
    for (const [method, path, search] of [
      ["GET", "/provider/v1/responses", ""],
      ["POST", "/provider/v1/responses", "?beta=true"],
      ["POST", "/provider/v1/responses", "?x=1"],
      ["POST", "/provider/v1/responses/", ""],
      ["POST", "/provider/v1/responses/resp_1", ""],
      ["POST", "/provider/v1/responses/compact", ""],
      ["POST", "/provider/v1/chat/completions", ""],
      ["POST", "/provider/v1/../v1/responses", ""],
      ["POST", "/v1/responses", ""],
    ] as const) {
      expect(routeOf(method, path, search)).toBeNull();
    }
  });

  test("routes the judge's one operation, nothing beside it", () => {
    expect(routeOf("POST", "/decisions/v1/decisions", "")).toEqual({
      purpose: "judgment",
      path: "/v1/decisions",
      search: "",
    });
    for (const [method, path, search] of [
      ["GET", "/decisions/v1/decisions", ""],
      ["POST", "/decisions/v1/decisions", "?x=1"],
      ["POST", "/decisions/v1/decisions/", ""],
      ["POST", "/decisions/v1/responses", ""],
      ["POST", "/decisions/v1/messages", ""],
      ["POST", "/provider/v1/decisions", ""],
    ] as const) {
      expect(routeOf(method, path, search)).toBeNull();
    }
  });

  test("routes another repository's read half by the one path segment naming it", () => {
    expect(
      routeOf("GET", "/repository/docs/info/refs", "?service=git-upload-pack"),
    ).toEqual({
      purpose: "repository",
      repository: "docs",
      path: "/info/refs",
      search: "?service=git-upload-pack",
    });
    expect(
      routeOf("POST", "/repository/my.repo_2/git-upload-pack", ""),
    ).toMatchObject({ repository: "my.repo_2", path: "/git-upload-pack" });
    for (const [method, path, search] of [
      ["GET", "/repository/docs/info/refs", "?service=git-receive-pack"],
      ["POST", "/repository/docs/git-receive-pack", ""],
      ["POST", "/repository/docs/git-upload-pack", "?x=1"],
      ["GET", "/repository/docs/git-upload-pack", ""],
      ["POST", "/repository/a/b/git-upload-pack", ""],
      ["POST", "/repository/../git-upload-pack", ""],
      ["POST", "/repository/.hidden/git-upload-pack", ""],
      ["POST", "/repository/%2e%2e/git-upload-pack", ""],
    ] as const) {
      expect(routeOf(method, path, search)).toBeNull();
    }
  });

  test("knows a push's advertisement on every repository route, nothing else", () => {
    for (const path of [
      "/repository/info/refs",
      "/repository/docs/info/refs",
      "/repository/docs/.git/info/refs",
    ]) {
      expect(
        isPushAdvertisement("GET", path, "?service=git-receive-pack"),
      ).toBe(true);
    }
    for (const [method, path, search] of [
      ["GET", "/repository/info/refs", "?service=git-upload-pack"],
      ["POST", "/repository/info/refs", "?service=git-receive-pack"],
      ["GET", "/repository/info/refs", "?service=git-receive-pack&x=1"],
      ["POST", "/repository/git-receive-pack", ""],
      ["POST", "/repository/docs/.git/git-receive-pack", ""],
      ["GET", "/repository/a/b/info/refs", "?service=git-receive-pack"],
      ["GET", "/repository/../info/refs", "?service=git-receive-pack"],
      ["GET", "/provider/info/refs", "?service=git-receive-pack"],
    ] as const) {
      expect(isPushAdvertisement(method, path, search)).toBe(false);
    }
  });

  test("routes one remote MCP server's URL for the streamable HTTP methods", () => {
    for (const method of ["POST", "GET", "DELETE"]) {
      expect(routeOf(method, "/mcp/fake", "")).toEqual({
        purpose: "mcp",
        server: "fake",
        path: "",
        search: "",
      });
    }
    expect(routeOf("POST", "/mcp/my_srv-2", "")).toMatchObject({
      server: "my_srv-2",
    });
    for (const [method, path, search] of [
      ["PUT", "/mcp/fake", ""],
      ["POST", "/mcp/fake", "?x=1"],
      ["POST", "/mcp/fake/", ""],
      ["POST", "/mcp/fake/tools", ""],
      ["POST", "/mcp/", ""],
      ["POST", "/mcp/Fake", ""],
      ["POST", "/mcp/a__b", ""],
      ["POST", "/mcp/../provider", ""],
    ] as const) {
      expect(routeOf(method, path, search)).toBeNull();
    }
  });
});

describe("mcpCallOf", () => {
  const of = (body: string) => mcpCallOf(new TextEncoder().encode(body));
  test("names the method and a tools/call's tool, and sends one canonical copy", () => {
    expect(of('{"jsonrpc":"2.0","id":1,"method":"initialize"}')?.call).toEqual({
      method: "initialize",
      tool: null,
    });
    const call = of(
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoami","name":"other"}}',
    );
    expect(call?.call).toEqual({ method: "tools/call", tool: "other" });
    expect(new TextDecoder().decode(call?.body)).toBe(
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"other"}}',
    );
    expect(of('{"jsonrpc":"2.0","id":3,"result":{}}')?.call).toEqual({
      method: null,
      tool: null,
    });
  });

  test("refuses a batch, a lookalike key and anything that is not one message", () => {
    for (const body of [
      '[{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x"}}]',
      '{"method":"tools/list","Method":"tools/call"}',
      '{"method":"tools/call","params":{"name":"x","NAME":"y"}}',
      '{"method":"tools/call","params":{}}',
      '{"method":"tools/call"}',
      '{"method":1}',
      '{"method":""}',
      "null",
      "not json",
    ]) {
      expect(of(body)).toBeNull();
    }
    expect(mcpCallOf(new Uint8Array([0x7b, 0xff, 0x7d]))).toBeNull();
  });
});

describe("bodyReservation", () => {
  const headers = (entries: Record<string, string>) => new Headers(entries);
  test("reserves the declared length, or the cap for a chunked body", () => {
    expect(bodyReservation(headers({}), "repository")).toEqual({ bytes: 0 });
    expect(
      bodyReservation(headers({ "content-length": "13" }), "provider"),
    ).toEqual({ bytes: 13 });
    expect(
      bodyReservation(headers({ "transfer-encoding": "chunked" }), "provider"),
    ).toEqual({ bytes: 32 * 1024 * 1024 });
  });

  test("refuses what could never fit, and an object body with no length", () => {
    expect(
      bodyReservation(
        headers({ "content-length": String(32 * 1024 * 1024 + 1) }),
        "provider",
      ),
    ).toEqual({ refused: 413 });
    expect(
      bodyReservation(
        headers({ "content-length": String(32 * 1024 * 1024 + 1) }),
        "object_store",
      ),
    ).toEqual({ bytes: 32 * 1024 * 1024 + 1 });
    expect(
      bodyReservation(
        headers({ "transfer-encoding": "chunked" }),
        "object_store",
      ),
    ).toEqual({ refused: 411 });
  });
});

describe("tokenOf", () => {
  test("takes exactly one carrier", () => {
    const h = (init: Record<string, string>) => new Headers(init);
    expect(tokenOf(h({ "x-api-key": "t1" }), "provider")).toBe("t1");
    expect(tokenOf(h({ authorization: "Bearer t2" }), "provider")).toBe("t2");
    expect(tokenOf(h({ authorization: "Bearer t3" }), "repository")).toBe("t3");
    // git has no x-api-key; a repository call carries a bearer or nothing.
    expect(tokenOf(h({ "x-api-key": "t1" }), "repository")).toBeNull();
    expect(
      tokenOf(h({ "x-api-key": "t", authorization: "Bearer t" }), "provider"),
    ).toBeNull();
    expect(
      tokenOf(h({ authorization: "Basic dTpw" }), "repository"),
    ).toBeNull();
    expect(tokenOf(h({ authorization: "Bearer " }), "provider")).toBeNull();
    expect(tokenOf(h({}), "provider")).toBeNull();
  });
});

describe("parseGrant", () => {
  const good = {
    session_id: "s",
    attempt_id: "a",
    upstream: { url: "https://api.test", headers: [["X-Api-Key", "k"]] },
  };

  test("accepts the authorizer's shape and lowercases header names", () => {
    expect(parseGrant(good)).toEqual({
      sessionId: "s",
      attemptId: "a",
      judgmentId: null,
      upstream: new URL("https://api.test"),
      headers: [["x-api-key", "k"]],
      target: null,
      builtin: false,
    });
    // The object store route's signed request line comes back verbatim.
    expect(
      parseGrant({
        ...good,
        upstream: { ...good.upstream, target: "/b/sessions/s1/x?versionId=v" },
      })?.target,
    ).toBe("/b/sessions/s1/x?versionId=v");
    for (const target of ["b/x", "/b/x y", "/b/x\r\nhost: evil", 7]) {
      expect(
        parseGrant({ ...good, upstream: { ...good.upstream, target } }),
      ).toBeNull();
    }
  });

  test("a judgment grant names its judgment and no session; one naming both is refused", () => {
    const judgment = { judgment_id: "j", upstream: good.upstream };
    expect(parseGrant(judgment)).toMatchObject({
      sessionId: null,
      attemptId: null,
      judgmentId: "j",
      headers: [["x-api-key", "k"]],
    });
    for (const bad of [
      { ...judgment, session_id: "s" },
      { ...judgment, attempt_id: "a" },
      { ...good, judgment_id: "j" },
      { ...judgment, judgment_id: 7 },
      { session_id: "s", upstream: good.upstream },
    ]) {
      expect(parseGrant(bad)).toBeNull();
    }
  });

  test("refuses anything it would have to guess about", () => {
    for (const bad of [
      null,
      "x",
      { ...good, session_id: 1 },
      { ...good, upstream: { ...good.upstream, url: "ftp://api.test" } },
      { ...good, upstream: { ...good.upstream, url: "https://u:p@api.test" } },
      { ...good, upstream: { ...good.upstream, url: "https://api.test/?q" } },
      { ...good, upstream: { ...good.upstream, url: "not a url" } },
      { ...good, upstream: { ...good.upstream, headers: [["bad name", "v"]] } },
      {
        ...good,
        upstream: { ...good.upstream, headers: [["x-api-key", "a\r\nb: c"]] },
      },
      { ...good, upstream: { ...good.upstream, headers: [["x"]] } },
      { ...good, upstream: { ...good.upstream, headers: {} } },
    ]) {
      expect(parseGrant(bad)).toBeNull();
    }
  });

  test("an MCP path is the authorizer's own server; no other path is", () => {
    const authorizer = new URL("http://api:3100/authorize");
    const builtin = { ...good, upstream: { url: "/mcp/github", headers: [] } };
    expect(parseGrant(builtin, authorizer)).toMatchObject({
      upstream: new URL("http://api:3100/mcp/github"),
      builtin: true,
    });
    expect(parseGrant(builtin)).toBeNull();
    const absolute = {
      ...good,
      upstream: { url: "http://api:3100/mcp/github", headers: [] },
    };
    expect(parseGrant(absolute, authorizer)?.builtin).toBe(false);
    for (const url of ["/authorize", "//evil.test/mcp/github", "/mcp/a/b"]) {
      expect(
        parseGrant({ ...good, upstream: { url, headers: [] } }, authorizer),
      ).toBeNull();
    }
  });
});

describe("upstreamRequestHeaders", () => {
  test("drops the worker's token, hop headers and what Connection names", () => {
    const grant = parseGrant({
      session_id: "s",
      attempt_id: "a",
      upstream: {
        url: "https://api.test/base",
        headers: [["x-api-key", PROVIDER_KEY]],
      },
    }) as EgressGrant;
    const out = upstreamRequestHeaders(
      new Headers({
        authorization: `Bearer ${WORKER_TOKEN}`,
        connection: "keep-alive, x-secret-hop",
        "x-secret-hop": "1",
        "accept-encoding": "gzip",
        "anthropic-version": "2023-06-01",
        cookie: "a=b",
        host: "proxy.internal",
        "proxy-authorization": "Basic x",
      }),
      grant,
    );
    expect(Object.fromEntries(out)).toEqual({
      "accept-encoding": "identity",
      "anthropic-version": "2023-06-01",
      host: "api.test",
      "x-api-key": PROVIDER_KEY,
    });
  });
});

describe("secretGuard", () => {
  async function through(chunks: string[], values: string[]) {
    const matched: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    }).pipeThrough(secretGuard(values, () => matched.push("match")));
    const reader = stream.getReader();
    let out = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        out += new TextDecoder().decode(next.value);
      }
      return { out, broken: false, matched };
    } catch {
      return { out, broken: true, matched };
    }
  }

  test("passes a clean body through whole, across chunk boundaries", async () => {
    expect(await through(["abc", "def", "ghi"], ["value-12345678"])).toEqual({
      out: "abcdefghi",
      broken: false,
      matched: [],
    });
  });

  test("breaks before any byte of a value, even one split over chunks", async () => {
    const result = await through(
      ["head value-1", "2345678 tail"],
      ["value-12345678"],
    );
    expect(result.broken).toBe(true);
    expect(result.matched).toEqual(["match"]);
    expect(result.out).not.toContain("value-1");
  });

  test("does not look for values too short to tell from chance", async () => {
    expect((await through(["pass word"], ["pass"])).broken).toBe(false);
  });
});

describe("responseHeaders", () => {
  test("drops a header whose value or name echoes a value", () => {
    const out = responseHeaders(
      new Headers({
        "content-type": "application/json",
        "x-echo": `key=${PROVIDER_KEY}`,
        [`x-${PROVIDER_KEY}`]: "1",
      }),
      [PROVIDER_KEY],
    );
    expect(Object.fromEntries(out)).toEqual({
      "content-type": "application/json",
    });
  });
});

describe("secretsOf", () => {
  test("covers the header value, its token and a basic password", () => {
    const basic = Buffer.from("reader:repo-password").toString("base64");
    const grant = parseGrant({
      session_id: "s",
      attempt_id: "a",
      upstream: {
        url: "https://git.test",
        headers: [["authorization", `Basic ${basic}`]],
      },
    }) as EgressGrant;
    expect(secretsOf(grant)).toEqual(
      expect.arrayContaining([
        `Basic ${basic}`,
        basic,
        "reader:repo-password",
        "repo-password",
      ]),
    );
  });
});

type UsageReport = {
  exchange_id: string;
  session_id: string;
  attempt_id: string;
  judgment_id?: string;
  usage: Record<string, unknown>;
};

async function until(done: () => boolean, ms = 3_000): Promise<void> {
  const by = performance.now() + ms;
  while (!done()) {
    if (performance.now() > by) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

function sseBody(events: Array<Record<string, unknown>>): string {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

type Seen = { url: string; headers: Record<string, string>; body: string };

describe("startCredentialProxy", () => {
  let directory: string;
  let certificate: { cert: string; key: string };
  const servers: Array<{ stop(force?: boolean): void }> = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "credential-proxy-"));
    certificate = await mintCertificate(directory, "upstream.test");
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  function upstream(
    handle: (request: Request, seen: Seen[]) => Response | Promise<Response>,
    tls?: { cert: string; key: string },
  ): { port: number; seen: Seen[] } {
    const seen: Seen[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      ...(tls === undefined ? {} : { tls }),
      async fetch(request) {
        const body = await request.text();
        seen.push({
          url: request.url,
          headers: Object.fromEntries(request.headers),
          body,
        });
        return handle(request, seen);
      },
    });
    servers.push(server);
    return { port: server.port ?? 0, seen };
  }

  function authorizer(
    answer: (body: { token: string; purpose: string }) => Response,
    usageAnswer: () => Response = () => Response.json({}),
  ): {
    url: string;
    asked: Array<{ token: string; purpose: string; path?: string }>;
    reported: UsageReport[];
  } {
    const asked: Array<{ token: string; purpose: string; path?: string }> = [];
    const reported: UsageReport[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (
          request.headers.get("authorization") !== `Bearer ${AUTHORIZER_TOKEN}`
        ) {
          return new Response("no", { status: 401 });
        }
        if (new URL(request.url).pathname === "/usage") {
          reported.push((await request.json()) as UsageReport);
          return usageAnswer();
        }
        const body = (await request.json()) as {
          token: string;
          purpose: string;
        };
        asked.push(body);
        return answer(body);
      },
    });
    servers.push(server);
    return { url: `http://127.0.0.1:${server.port}`, asked, reported };
  }

  function granting(url: string, headers: Array<[string, string]>) {
    return (body: { token: string }) =>
      body.token === WORKER_TOKEN
        ? Response.json({
            session_id: "sess-1",
            attempt_id: "att-1",
            upstream: { url, headers },
          })
        : new Response("unknown", { status: 401 });
  }

  function proxy(
    authorizerUrl: string,
    upstreamPort: number,
    options: Partial<Parameters<typeof startCredentialProxy>[0]> = {},
  ): CredentialProxyServer {
    const policy: EgressPolicy = {
      allow: [],
      allowPrivate: [{ host: "upstream.test", port: upstreamPort }],
    };
    const server = startCredentialProxy({
      authorizer: { url: authorizerUrl, token: AUTHORIZER_TOKEN },
      hostname: "127.0.0.1",
      logger: silent,
      policy,
      port: 0,
      resolve: async (host) => (host === "upstream.test" ? ["127.0.0.1"] : []),
      ...options,
    });
    servers.push(server);
    return server;
  }

  function messages(
    port: number,
    init: {
      headers?: Record<string, string>;
      body?: string;
      path?: string;
    } = {},
  ) {
    return fetch(
      `http://127.0.0.1:${port}${init.path ?? "/provider/v1/messages?beta=true"}`,
      {
        method: "POST",
        headers: init.headers ?? { "x-api-key": WORKER_TOKEN },
        body: init.body ?? '{"model":"m"}',
      },
    );
  }

  test("injects the provider key and passes the exchange through", async () => {
    const up = upstream(() => Response.json({ id: "msg_1" }));
    const withPort = authorizer(
      granting(`http://upstream.test:${up.port}/base`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(withPort.url, up.port);
    const response = await messages(server.port, {
      headers: {
        "x-api-key": WORKER_TOKEN,
        "anthropic-version": "2023-06-01",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "msg_1" });
    expect(withPort.asked).toEqual([
      { token: WORKER_TOKEN, purpose: "provider" },
    ]);
    const [seen] = up.seen;
    expect(new URL(seen?.url ?? "").pathname).toBe("/base/v1/messages");
    expect(new URL(seen?.url ?? "").search).toBe("?beta=true");
    expect(seen?.headers["x-api-key"]).toBe(PROVIDER_KEY);
    expect(seen?.headers.host).toBe(`upstream.test:${up.port}`);
    expect(seen?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen?.body).toBe('{"model":"m"}');
    expect(JSON.stringify(seen)).not.toContain(WORKER_TOKEN);
  });

  test("streams a response body as it arrives", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const up = upstream(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("event: one\n\n"));
              await gate;
              controller.enqueue(new TextEncoder().encode("event: two\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const response = await messages(server.port);
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("event: one\n\n");
    release();
    let rest = "";
    for (;;) {
      const next = await reader?.read();
      if (next === undefined || next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toBe("event: two\n\n");
  });

  describe("the Responses route", () => {
    const OPENAI_KEY = "sk-openai-key-kept-from-the-worker";
    const bearerKey = (up: { port: number }) =>
      granting(`http://upstream.test:${up.port}`, [
        ["authorization", `Bearer ${OPENAI_KEY}`],
      ]);
    const responses = (
      port: number,
      init: { headers?: Record<string, string>; body?: string } = {},
    ) =>
      fetch(`http://127.0.0.1:${port}/provider/v1/responses`, {
        method: "POST",
        headers: init.headers ?? { authorization: `Bearer ${WORKER_TOKEN}` },
        body: init.body ?? '{"model":"gpt-5.5","stream":false}',
      });

    test("injects the key as a bearer in place of the worker's credentials, and names the path to the authorizer", async () => {
      const up = upstream(() => Response.json({ id: "resp_1" }));
      const auth = authorizer(bearerKey(up));
      const server = proxy(auth.url, up.port);
      const response = await responses(server.port, {
        headers: {
          authorization: `Bearer ${WORKER_TOKEN}`,
          "openai-organization": "org-of-another-tenant",
          "openai-project": "proj-of-another-tenant",
          "openai-beta": "responses=v1",
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: "resp_1" });
      expect(auth.asked).toEqual([
        { token: WORKER_TOKEN, purpose: "provider", path: "/v1/responses" },
      ]);
      const [seen] = up.seen;
      expect(new URL(seen?.url ?? "").pathname).toBe("/v1/responses");
      expect(seen?.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
      expect(seen?.headers["openai-organization"]).toBeUndefined();
      expect(seen?.headers["openai-project"]).toBeUndefined();
      expect(seen?.headers["openai-beta"]).toBe("responses=v1");
      expect(JSON.stringify(seen)).not.toContain(WORKER_TOKEN);
    });

    test("a background response is refused before the authorizer or the upstream is asked", async () => {
      const up = upstream(() => Response.json({ id: "resp_1" }));
      const auth = authorizer(bearerKey(up));
      const server = proxy(auth.url, up.port);
      const refused = await responses(server.port, {
        body: '{"model":"gpt-5.5","background":true,"store":true}',
      });
      expect(refused.status).toBe(400);
      expect(auth.asked).toEqual([]);
      expect(up.seen).toEqual([]);
      // Only `true` is background: an explicit false is an ordinary call.
      const plain = await responses(server.port, {
        body: '{"model":"gpt-5.5","background":false}',
      });
      expect(plain.status).toBe(200);
    });

    test("a file or image the request only names is refused, one it carries is not", async () => {
      const up = upstream(() => Response.json({ id: "resp_1" }));
      const auth = authorizer(bearerKey(up));
      const server = proxy(auth.url, up.port);
      const message = (...content: unknown[]) =>
        JSON.stringify({
          model: "gpt-5.5",
          input: [{ role: "user", content }],
        });
      for (const body of [
        message({ type: "input_file", file_url: "https://x.test/a.pdf" }),
        message({ type: "input_file", file_id: "file_1" }),
        message({ type: "input_image", image_url: "https://x.test/a.png" }),
        message({ type: "input_image", file_id: "file_2" }),
        // A tool result carries its parts in `output`, not `content`.
        JSON.stringify({
          model: "gpt-5.5",
          input: [
            {
              type: "function_call_output",
              call_id: "call_1",
              output: [
                { type: "input_image", image_url: "https://x.test/b.png" },
              ],
            },
          ],
        }),
      ]) {
        expect((await responses(server.port, { body })).status).toBe(400);
      }
      expect(auth.asked).toEqual([]);
      expect(up.seen).toEqual([]);
      const carried = await responses(server.port, {
        body: message(
          { type: "input_text", text: "hi" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_file", filename: "a.txt", file_data: "AAAA" },
        ),
      });
      expect(carried.status).toBe(200);
    });

    test("a request that continues a stored response or conversation is refused, a null one is not", async () => {
      const up = upstream(() => Response.json({ id: "resp_1" }));
      const auth = authorizer(bearerKey(up));
      const server = proxy(auth.url, up.port);
      for (const body of [
        '{"model":"gpt-5.5","previous_response_id":"resp_0"}',
        '{"model":"gpt-5.5","conversation":"conv_1"}',
        '{"model":"gpt-5.5","conversation":{"id":"conv_1"}}',
      ]) {
        const refused = await responses(server.port, { body });
        expect(refused.status).toBe(400);
      }
      expect(auth.asked).toEqual([]);
      expect(up.seen).toEqual([]);
      const plain = await responses(server.port, {
        body: '{"model":"gpt-5.5","previous_response_id":null,"conversation":null}',
      });
      expect(plain.status).toBe(200);
    });

    test("a remote part inside a tool result is refused, wherever the result nests it", async () => {
      const up = upstream(() => Response.json({ id: "resp_1" }));
      const auth = authorizer(bearerKey(up));
      const server = proxy(auth.url, up.port);
      const statuses: number[] = [];
      const result = (type: string, output: unknown) =>
        JSON.stringify({
          model: "gpt-5.5",
          input: [{ type, call_id: "call_1", output }],
        });
      for (const body of [
        result("function_call_output", [
          { type: "input_file", file_id: "file_1" },
        ]),
        result("function_call_output", [
          { type: "input_file", file_url: "https://x.test/a.pdf" },
        ]),
        result("custom_tool_call_output", [
          { type: "input_file", file_url: "https://x.test/a.pdf" },
        ]),
        // A computer-use screenshot is an object, typed neither input_file
        // nor input_image.
        result("computer_call_output", {
          type: "computer_screenshot",
          image_url: "https://x.test/shot.png",
        }),
        result("computer_call_output", {
          type: "computer_screenshot",
          file_id: "file_3",
        }),
        // Deeper than any honest client nests parts.
        result("function_call_output", [
          [[[[[[{ type: "input_file", file_id: "file_4" }]]]]]],
        ]),
        // A stored item the request only points at.
        JSON.stringify({
          model: "gpt-5.5",
          input: [{ type: "item_reference", id: "msg_1" }],
        }),
      ]) {
        statuses.push((await responses(server.port, { body })).status);
      }
      expect(statuses).toEqual(statuses.map(() => 400));
      expect(auth.asked).toEqual([]);
      expect(up.seen).toEqual([]);
      const carried = await responses(server.port, {
        body: result("function_call_output", "plain text output"),
      });
      expect(carried.status).toBe(200);
    });

    test("a stored prompt template and a tool that makes the upstream fetch are refused, a local tool is not", async () => {
      const up = upstream(() => Response.json({ id: "resp_1" }));
      const auth = authorizer(bearerKey(up));
      const server = proxy(auth.url, up.port);
      const statuses: number[] = [];
      const withTools = (...tools: unknown[]) =>
        JSON.stringify({ model: "gpt-5.5", tools });
      for (const body of [
        '{"model":"gpt-5.5","prompt":{"id":"pmpt_1"}}',
        withTools({
          type: "mcp",
          server_label: "x",
          server_url: "https://evil.test/mcp",
        }),
        withTools({ type: "mcp", server_label: "x", connector_id: "c_1" }),
        withTools({ type: "file_search", vector_store_ids: ["vs_1"] }),
        withTools({ type: "web_search" }),
        withTools({ type: "web_search_preview" }),
        withTools({ type: "code_interpreter", container: "cntr_1" }),
        withTools({ type: "image_generation" }),
        withTools({ type: "shell", environment: { type: "container_auto" } }),
        // Tools registered by an input item are declared all the same.
        JSON.stringify({
          model: "gpt-5.5",
          input: [
            {
              type: "tool_search_output",
              tools: [{ type: "mcp", server_url: "https://evil.test/mcp" }],
            },
          ],
        }),
        JSON.stringify({
          model: "gpt-5.5",
          input: [
            {
              type: "additional_tools",
              tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }],
            },
          ],
        }),
        JSON.stringify({
          model: "gpt-5.5",
          input: [{ type: "image_generation_call", id: "ig_1" }],
        }),
      ]) {
        statuses.push((await responses(server.port, { body })).status);
      }
      expect(statuses).toEqual(statuses.map(() => 400));
      expect(auth.asked).toEqual([]);
      expect(up.seen).toEqual([]);
      // The tools a codex turn declares run on the worker, not upstream.
      const local = await responses(server.port, {
        body: JSON.stringify({
          model: "gpt-5.5",
          prompt: null,
          tool_choice: "auto",
          tools: [
            { type: "function", name: "shell", parameters: {} },
            { type: "local_shell" },
            { type: "shell", environment: { type: "local" } },
            { type: "custom", name: "apply_patch", format: { type: "text" } },
          ],
        }),
      });
      expect(local.status).toBe(200);
    });

    test("a Messages call still asks without a path, so an authorizer of the earlier release answers it", async () => {
      const up = upstream(() => Response.json({ id: "msg_1" }));
      const auth = authorizer(
        granting(`http://upstream.test:${up.port}`, [
          ["x-api-key", PROVIDER_KEY],
        ]),
      );
      const server = proxy(auth.url, up.port);
      expect((await messages(server.port)).status).toBe(200);
      expect(auth.asked).toEqual([
        { token: WORKER_TOKEN, purpose: "provider" },
      ]);
    });

    test("two credentials, a query and any other method are refused before the authorizer", async () => {
      const up = upstream(() => new Response("ok"));
      const auth = authorizer(bearerKey(up));
      const server = proxy(auth.url, up.port);
      expect(
        (
          await responses(server.port, {
            headers: {
              authorization: `Bearer ${WORKER_TOKEN}`,
              "x-api-key": WORKER_TOKEN,
            },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(
            `http://127.0.0.1:${server.port}/provider/v1/responses?beta=true`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${WORKER_TOKEN}` },
              body: "{}",
            },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(`http://127.0.0.1:${server.port}/provider/v1/responses`, {
            method: "GET",
            headers: { authorization: `Bearer ${WORKER_TOKEN}` },
          })
        ).status,
      ).toBe(404);
      expect(auth.asked).toEqual([]);
      expect(up.seen).toEqual([]);
    });

    test("the authorizer's refusal for another kind of session passes through, and nothing is forwarded", async () => {
      const up = upstream(() => new Response("ok"));
      const auth = authorizer(
        () =>
          new Response("not served", {
            status: 403,
          }),
      );
      const server = proxy(auth.url, up.port);
      expect((await responses(server.port)).status).toBe(403);
      expect(up.seen).toEqual([]);
    });

    test("a spent budget is named in the Responses error shape", async () => {
      const up = upstream(() => new Response("ok"));
      const server = proxy(
        authorizer(() =>
          Response.json(
            { code: "BUDGET_EXCEEDED", message: "limit reached" },
            { status: 403 },
          ),
        ).url,
        up.port,
      );
      const refused = await responses(server.port);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({
        error: {
          type: "permission_error",
          code: "BUDGET_EXCEEDED",
          message:
            "BUDGET_EXCEEDED: the session has reached its cost or token limit",
        },
      });
      expect(up.seen).toEqual([]);
    });

    test("meters a JSON answer, cached input split out, under the grant's ids", async () => {
      const up = upstream(() =>
        Response.json({
          id: "resp_1",
          model: "gpt-5.5-2026-04-23",
          usage: {
            input_tokens: 1000,
            output_tokens: 80,
            input_tokens_details: { cached_tokens: 600 },
          },
        }),
      );
      const auth = authorizer(bearerKey(up));
      const server = proxy(auth.url, up.port);
      await (await responses(server.port)).json();
      await until(() => auth.reported.length === 1);
      expect(auth.reported[0]).toMatchObject({
        session_id: "sess-1",
        attempt_id: "att-1",
        usage: {
          model: "gpt-5.5-2026-04-23",
          input_tokens: 400,
          output_tokens: 80,
          cache_read_input_tokens: 600,
          estimated: false,
        },
      });
    });

    test("meters a streamed answer from response.completed, and marks a cut stream estimated", async () => {
      const full = upstream(
        () =>
          new Response(
            sseBody([
              { type: "response.created", response: { model: "gpt-5.5" } },
              { type: "response.output_text.delta", delta: "hello" },
              {
                type: "response.completed",
                response: {
                  model: "gpt-5.5",
                  usage: { input_tokens: 70, output_tokens: 9 },
                },
              },
            ]),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const fullAuth = authorizer(bearerKey(full));
      await (await responses(proxy(fullAuth.url, full.port).port)).text();
      await until(() => fullAuth.reported.length === 1);
      expect(fullAuth.reported[0]?.usage).toMatchObject({
        model: "gpt-5.5",
        input_tokens: 70,
        output_tokens: 9,
        estimated: false,
      });

      const cut = upstream(
        () =>
          new Response(
            sseBody([
              { type: "response.created", response: { model: "gpt-5.5" } },
              { type: "response.output_text.delta", delta: "x".repeat(200) },
            ]),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const cutAuth = authorizer(bearerKey(cut));
      await (await responses(proxy(cutAuth.url, cut.port).port)).text();
      await until(() => cutAuth.reported.length === 1);
      // The request set no output cap, so the cut is charged the allowance
      // rather than the 200 characters it delivered.
      expect(cutAuth.reported[0]?.usage).toMatchObject({
        output_tokens: 32_768,
        estimated: true,
      });
    });

    test("a call made with the engine's token by a tool is metered like the engine's own", async () => {
      // The route cannot tell who holds the token: every answer is read, so a
      // tool calling /v1/responses directly spends the session's budget too.
      const up = upstream(() =>
        Response.json({
          model: "gpt-5.5",
          usage: { input_tokens: 5, output_tokens: 6 },
        }),
      );
      const auth = authorizer(bearerKey(up));
      const server = proxy(auth.url, up.port);
      for (let call = 0; call < 2; call++) {
        await (await responses(server.port)).json();
      }
      await until(() => auth.reported.length === 2);
      expect(
        new Set(auth.reported.map((report) => report.exchange_id)).size,
      ).toBe(2);
    });
  });

  describe("usage metering", () => {
    const provider = (up: { port: number }) =>
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]);

    test("reports a JSON answer's usage with the grant's ids", async () => {
      const up = upstream(() =>
        Response.json({
          type: "message",
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation: {
              ephemeral_5m_input_tokens: 1,
              ephemeral_1h_input_tokens: 2,
            },
          },
        }),
      );
      const auth = authorizer(provider(up));
      const server = proxy(auth.url, up.port);
      const response = await messages(server.port);
      expect(response.status).toBe(200);
      await response.json();
      await until(() => auth.reported.length === 1);
      const [report] = auth.reported;
      expect(report?.exchange_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(report).toMatchObject({
        session_id: "sess-1",
        attempt_id: "att-1",
        usage: {
          model: "claude-sonnet-4-5",
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 3,
          cache_creation_1h_input_tokens: 2,
          cache_read_input_tokens: 4,
        },
      });
    });

    test("reports a streamed answer's message_start input and last message_delta output", async () => {
      const up = upstream(
        () =>
          new Response(
            sseBody([
              {
                type: "message_start",
                message: {
                  model: "claude-sonnet-4-5",
                  usage: { input_tokens: 50, output_tokens: 1 },
                },
              },
              { type: "message_delta", usage: { output_tokens: 7 } },
              { type: "message_delta", usage: { output_tokens: 30 } },
              { type: "message_stop" },
            ]),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const auth = authorizer(provider(up));
      const server = proxy(auth.url, up.port);
      await (await messages(server.port)).text();
      await until(() => auth.reported.length === 1);
      expect(auth.reported[0]?.usage).toMatchObject({
        model: "claude-sonnet-4-5",
        input_tokens: 50,
        output_tokens: 30,
      });
    });

    test("a worker that hangs up mid-stream is still charged for what was started", async () => {
      const up = upstream(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    sseBody([
                      {
                        type: "message_start",
                        message: { model: "m", usage: { input_tokens: 9 } },
                      },
                    ]),
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const auth = authorizer(provider(up));
      const server = proxy(auth.url, up.port);
      const held = await rawRequest(
        server.port,
        `POST /provider/v1/messages HTTP/1.1\r\nhost: proxy\r\nx-api-key: ${WORKER_TOKEN}\r\ncontent-length: 2`,
        "{}",
      );
      expect(await held.answered()).toContain("message_start");
      held.socket.end();
      await until(() => auth.reported.length === 1);
      expect(auth.reported[0]?.usage).toMatchObject({
        model: "m",
        input_tokens: 9,
      });
    });

    test("count_tokens and an error answer report nothing; a success without usage is charged from its request", async () => {
      const up = upstream((request) =>
        new URL(request.url).pathname.endsWith("/count_tokens")
          ? Response.json({ input_tokens: 12 })
          : request.headers.get("x-case") === "error"
            ? Response.json(
                { type: "error", usage: { input_tokens: 1 } },
                { status: 400 },
              )
            : Response.json({ id: "msg_1" }),
      );
      const auth = authorizer(provider(up));
      const server = proxy(auth.url, up.port);
      await (
        await messages(server.port, {
          path: "/provider/v1/messages/count_tokens",
        })
      ).text();
      await (
        await messages(server.port, {
          headers: { "x-api-key": WORKER_TOKEN, "x-case": "error" },
        })
      ).text();
      await Bun.sleep(100);
      expect(auth.reported).toEqual([]);
      const body = '{"model":"claude-sonnet-4-5","max_tokens":64}';
      await (await messages(server.port, { body })).text();
      await until(() => auth.reported.length === 1);
      expect(auth.reported[0]?.usage).toMatchObject({
        model: "claude-sonnet-4-5",
        input_tokens: body.length,
        output_tokens: 64,
        estimated: true,
      });
    });

    test("reports a fast answer's speed and its server tool counts; a request that asked for fast but got no usable answer is reported fast", async () => {
      const tools = {
        web_search_requests: 3,
        web_fetch_requests: 1,
        code_execution_requests: 2,
      };
      const up = upstream((request) =>
        request.headers.get("x-case") === "cut"
          ? Response.json({ id: "msg_1" })
          : new Response(
              sseBody([
                {
                  type: "message_start",
                  message: {
                    model: "claude-opus-5",
                    usage: { input_tokens: 50, speed: "fast" },
                  },
                },
                {
                  type: "message_delta",
                  usage: { output_tokens: 30, server_tool_use: tools },
                },
                { type: "message_stop" },
              ]),
              { headers: { "content-type": "text/event-stream" } },
            ),
      );
      const auth = authorizer(provider(up));
      const server = proxy(auth.url, up.port);
      await (await messages(server.port)).text();
      await until(() => auth.reported.length === 1);
      expect(auth.reported[0]?.usage).toMatchObject({
        model: "claude-opus-5",
        speed: "fast",
        ...tools,
        estimated: false,
      });

      const body = '{"model":"claude-opus-5","max_tokens":8,"speed":"fast"}';
      await (
        await messages(server.port, {
          body,
          headers: { "x-api-key": WORKER_TOKEN, "x-case": "cut" },
        })
      ).text();
      await until(() => auth.reported.length === 2);
      expect(auth.reported[1]?.usage).toMatchObject({
        model: "claude-opus-5",
        speed: "fast",
        web_search_requests: 0,
        estimated: true,
      });
    });

    test("a report the authorizer could not take is sent again under the same id; a refused one is not", async () => {
      const up = upstream(() =>
        Response.json({ model: "m", usage: { input_tokens: 1 } }),
      );
      const answers = [503, 200];
      const auth = authorizer(
        provider(up),
        () => new Response(null, { status: answers.shift() ?? 400 }),
      );
      const server = proxy(auth.url, up.port, {
        usageReportBackoffMs: [10, 10],
      });
      await (await messages(server.port)).text();
      await until(() => auth.reported.length === 2);
      expect(auth.reported[1]?.exchange_id).toBe(auth.reported[0]?.exchange_id);

      await (await messages(server.port)).text();
      await until(() => auth.reported.length === 3);
      await Bun.sleep(100);
      expect(auth.reported).toHaveLength(3);
    });

    test("a session whose report was given up on is refused as a spent budget from then on", async () => {
      const up = upstream(() =>
        Response.json({ model: "m", usage: { input_tokens: 1 } }),
      );
      const auth = authorizer(
        provider(up),
        () => new Response(null, { status: 503 }),
      );
      const server = proxy(auth.url, up.port, {
        usageReportBackoffMs: [10],
      });
      await (await messages(server.port)).text();
      // The first try and its one retry are both refused: the report is lost.
      await until(() => auth.reported.length === 2);
      await Bun.sleep(100);
      const seenBefore = up.seen.length;

      const refused = await messages(server.port);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toContain("BUDGET_EXCEEDED:");
      expect(up.seen).toHaveLength(seenBefore);
    });
  });

  test("the authorizer's refusal reaches the worker, and nothing is sent upstream", async () => {
    const up = upstream(() => new Response("ok"));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    expect(
      (await messages(server.port, { headers: { "x-api-key": "wep_other" } }))
        .status,
    ).toBe(401);
    expect((await messages(server.port, { headers: {} })).status).toBe(401);
    expect(up.seen).toEqual([]);
  });

  test("an authorizer that is down, errs or answers junk fails closed", async () => {
    const up = upstream(() => new Response("ok"));
    for (const answer of [
      () => new Response("boom", { status: 500 }),
      () => Response.json({ session_id: "s" }),
      () => new Response("not json"),
    ]) {
      const auth = authorizer(answer);
      const server = proxy(auth.url, up.port);
      expect((await messages(server.port)).status).toBe(503);
    }
    const nowhere = proxy("http://127.0.0.1:1", up.port);
    expect((await messages(nowhere.port)).status).toBe(503);
    expect(up.seen).toEqual([]);
  });

  test("the authorizer's 409 and 403 pass through", async () => {
    const up = upstream(() => new Response("ok"));
    for (const status of [403, 409]) {
      const auth = authorizer(() => new Response("x", { status }));
      const server = proxy(auth.url, up.port);
      expect((await messages(server.port)).status).toBe(status);
    }
  });

  test("a spent budget is named to the engine in the Messages error shape, and no other 403 is", async () => {
    const up = upstream(() => new Response("ok"));
    const spent = proxy(
      authorizer(() =>
        Response.json(
          { code: "BUDGET_EXCEEDED", message: "limit reached" },
          { status: 403 },
        ),
      ).url,
      up.port,
    );
    const refused = await messages(spent.port);
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(body.type).toBe("error");
    expect(body.error.message).toStartWith("BUDGET_EXCEEDED:");

    const forbidden = proxy(
      authorizer(() =>
        Response.json(
          { code: "FORBIDDEN", message: "BUDGET_EXCEEDED" },
          { status: 403 },
        ),
      ).url,
      up.port,
    );
    const other = await messages(forbidden.port);
    expect(other.status).toBe(403);
    expect(await other.text()).toBe("egress token refused\n");
    expect(up.seen).toEqual([]);
  });

  test("an unrouted operation never reaches the authorizer", async () => {
    const up = upstream(() => new Response("ok"));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    expect(
      (await messages(server.port, { path: "/provider/v1/models" })).status,
    ).toBe(404);
    expect(
      (
        await messages(server.port, {
          path: "/repository/git-receive-pack",
          headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        })
      ).status,
    ).toBe(404);
    expect(auth.asked).toEqual([]);
    expect(
      (await fetch(`http://127.0.0.1:${server.port}/healthz`)).status,
    ).toBe(200);
  });

  test("a push's advertisement gets the notice as one ERR packet, with no authorizer asked", async () => {
    const up = upstream(() => new Response("ok"));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["authorization", "Bearer upstream"],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const origin = `http://127.0.0.1:${server.port}`;
    const expected =
      "0106ERR git push does not reach GitHub here. Push and open pull requests with the platform's GitHub tools (mcp__github__request_push, mcp__github__open_pull_request). If this agent has no GitHub tools, an administrator turns GitHub on in the agent's GitHub tab.\n";
    for (const [path, headers] of [
      ["/repository/info/refs", {}],
      [
        "/repository/docs/.git/info/refs",
        { authorization: `Bearer ${WORKER_TOKEN}` },
      ],
    ] as const) {
      const response = await fetch(
        `${origin}${path}?service=git-receive-pack`,
        { headers },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/x-git-receive-pack-advertisement",
      );
      expect(await response.text()).toBe(expected);
    }
    const unknown = await fetch(`${origin}/repository/docs/info/lfs/locks`);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("no such credential route\n");
    expect(auth.asked).toEqual([]);
    expect(up.seen).toEqual([]);
  });

  test("an upstream outside the policy is refused even when the authorizer names it", async () => {
    const up = upstream(() => new Response("ok"));
    const auth = authorizer(
      granting(`http://elsewhere.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port, {
      resolve: async () => ["127.0.0.1"],
    });
    expect((await messages(server.port)).status).toBe(403);
    expect(up.seen).toEqual([]);
  });

  test("an allowlisted upstream that does not resolve gets 502, not 403", async () => {
    const up = upstream(() => new Response("ok"));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port, {
      resolve: async (host) => {
        throw new Error(`getaddrinfo ENOTFOUND ${host}`);
      },
    });
    expect((await messages(server.port)).status).toBe(502);
    expect(up.seen).toEqual([]);
  });

  test("a redirect is not followed and not relayed", async () => {
    const up = upstream(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "http://attacker.test/steal" },
        }),
    );
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const response = await messages(server.port);
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(up.seen).toHaveLength(1);
  });

  test("an error body that echoes the credential is withheld", async () => {
    const up = upstream(
      (request) =>
        new Response(
          `invalid key ${request.headers.get("x-api-key")}; set-cookie`,
          { status: 401, headers: { "set-cookie": "s=1" } },
        ),
    );
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const response = await messages(server.port);
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    const text = await response.text();
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).toContain("withheld");
  });

  describe("a provider upstream's 401/403", () => {
    const REFUSED = "Provider upstream refused the credential route";
    function refusals(lines: string[]) {
      return lines
        .map(
          (line) =>
            JSON.parse(line) as {
              level: string;
              message: string;
              fields: Record<string, unknown>;
            },
        )
        .filter((record) => record.message === REFUSED);
    }

    test("is logged at warn with the upstream's own words", async () => {
      const up = upstream(
        () =>
          new Response(`Invalid host header${"!".repeat(600)}`, {
            status: 403,
          }),
      );
      const auth = authorizer(
        granting(`http://upstream.test:${up.port}`, [
          ["x-api-key", PROVIDER_KEY],
        ]),
      );
      const lines: string[] = [];
      const server = proxy(auth.url, up.port, {
        logger: createProxyLogger("warn", (line) => lines.push(line)),
      });
      const response = await messages(server.port);
      expect(response.status).toBe(403);
      expect(await response.text()).toStartWith("Invalid host header");
      const [record, ...rest] = refusals(lines);
      expect(rest).toHaveLength(0);
      expect(record?.level).toBe("warn");
      expect(record?.fields).toMatchObject({
        purpose: "provider",
        path: "/v1/messages",
        host: "upstream.test",
        session_id: "sess-1",
        status: 403,
      });
      const excerpt = record?.fields.upstream_error as string;
      expect(excerpt).toStartWith("Invalid host header");
      expect(excerpt).toHaveLength(512);
      const all = lines.join("\n");
      expect(all).not.toContain(PROVIDER_KEY);
      expect(all).not.toContain(WORKER_TOKEN);
    });

    test("keeps out a body that echoes the credential", async () => {
      const up = upstream(
        (request) =>
          new Response(`invalid key ${request.headers.get("x-api-key")}`, {
            status: 401,
          }),
      );
      const auth = authorizer(
        granting(`http://upstream.test:${up.port}`, [
          ["x-api-key", PROVIDER_KEY],
        ]),
      );
      const lines: string[] = [];
      const server = proxy(auth.url, up.port, {
        logger: createProxyLogger("debug", (line) => lines.push(line)),
      });
      expect((await messages(server.port)).status).toBe(401);
      const [record] = refusals(lines);
      expect(record?.fields).toMatchObject({
        status: 401,
        upstream_error_withheld: true,
        upstream_error_withheld_reason: "secret_match",
      });
      expect(record?.fields).not.toHaveProperty("upstream_error");
      const all = lines.join("\n");
      expect(all).not.toContain(PROVIDER_KEY);
      expect(all).not.toContain("invalid key");
      expect(all).not.toContain(WORKER_TOKEN);
    });

    test("says why an excerpt was withheld", async () => {
      // A secret shape other than the grant's own key, which only the
      // logger's patterns would catch.
      const OTHER = "sk-another-key-the-upstream-printed";
      const cases: Array<[string, () => Response]> = [
        [
          "redacted_pattern",
          () => new Response(`rejected ${OTHER}`, { status: 401 }),
        ],
        [
          "encoded",
          () =>
            new Response("\x1f\x8b....", {
              status: 403,
              headers: { "content-encoding": "gzip" },
            }),
        ],
        [
          "too_large_or_unreadable",
          () => new Response("x".repeat(64 * 1024 + 1), { status: 403 }),
        ],
      ];
      let answer = cases[0]?.[1] ?? (() => new Response(null));
      const up = upstream(() => answer());
      const auth = authorizer(
        granting(`http://upstream.test:${up.port}`, [
          ["x-api-key", PROVIDER_KEY],
        ]),
      );
      const lines: string[] = [];
      const server = proxy(auth.url, up.port, {
        logger: createProxyLogger("warn", (line) => lines.push(line)),
      });
      for (const [reason, respond] of cases) {
        answer = respond;
        lines.length = 0;
        await (await messages(server.port)).text();
        const [record, ...rest] = refusals(lines);
        expect(rest).toHaveLength(0);
        expect(record?.fields).toMatchObject({
          upstream_error_withheld: true,
          upstream_error_withheld_reason: reason,
        });
        expect(record?.fields).not.toHaveProperty("upstream_error");
        expect(lines.join("\n")).not.toContain(OTHER);
      }
    });

    test("is not logged for the repository or object store routes", async () => {
      let status = 401;
      const up = upstream(() => new Response("denied", { status }));
      const auth = authorizer((body) =>
        body.token === WORKER_TOKEN
          ? Response.json({
              session_id: "s",
              attempt_id: "a",
              upstream: {
                url: `http://upstream.test:${up.port}/base`,
                headers: [["authorization", "Basic cmVhZGVyOnBhc3M="]],
                ...(body.purpose === "object_store"
                  ? { target: "/bucket/key" }
                  : {}),
              },
            })
          : new Response("no", { status: 401 }),
      );
      const lines: string[] = [];
      const server = proxy(auth.url, up.port, {
        logger: createProxyLogger("debug", (line) => lines.push(line)),
      });
      const requests: Array<[string, Record<string, string>]> = [
        [
          "/repository/info/refs?service=git-upload-pack",
          { authorization: `Bearer ${WORKER_TOKEN}` },
        ],
        [
          "/object-store/bucket/key",
          {
            authorization: `AWS4-HMAC-SHA256 Credential=${WORKER_TOKEN}/20261008/auto/s3/aws4_request, SignedHeaders=host, Signature=0`,
          },
        ],
      ];
      for (status of [401, 403]) {
        for (const [path, headers] of requests) {
          const response = await fetch(
            `http://127.0.0.1:${server.port}${path}`,
            {
              headers,
            },
          );
          expect(response.status).toBe(status);
          await response.text();
        }
      }
      expect(up.seen).toHaveLength(4);
      expect(refusals(lines)).toHaveLength(0);
    });

    test("is the only status logged that way", async () => {
      let status = 200;
      const up = upstream(() => Response.json({ type: "error" }, { status }));
      const auth = authorizer(
        granting(`http://upstream.test:${up.port}`, [
          ["x-api-key", PROVIDER_KEY],
        ]),
      );
      const lines: string[] = [];
      const server = proxy(auth.url, up.port, {
        logger: createProxyLogger("debug", (line) => lines.push(line)),
      });
      for (status of [200, 400, 404, 429, 500]) {
        expect((await messages(server.port)).status).toBe(status);
      }
      expect(refusals(lines)).toHaveLength(0);
    });
  });

  test("an ordinary error body is relayed, and an encoded one is not", async () => {
    let encoded = false;
    const up = upstream(() =>
      encoded
        ? new Response("\x1f\x8b....", {
            status: 400,
            headers: { "content-encoding": "gzip" },
          })
        : Response.json(
            { type: "error", error: { type: "invalid_request_error" } },
            { status: 400 },
          ),
    );
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const plain = await messages(server.port);
    expect(plain.status).toBe(400);
    expect(await plain.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error" },
    });
    encoded = true;
    const hidden = await messages(server.port);
    expect(hidden.status).toBe(400);
    expect(hidden.headers.get("content-encoding")).toBeNull();
    expect(await hidden.text()).toContain("withheld");
  });

  test("dials https by the judged address and checks the catalog's name", async () => {
    const up = upstream(() => Response.json({ ok: true }), certificate);
    const auth = authorizer(
      granting(`https://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    // Kept so a failed dial says why instead of just 502.
    const lines: string[] = [];
    const server = proxy(auth.url, up.port, {
      upstreamCa: certificate.cert,
      logger: createProxyLogger("warn", (line) => lines.push(line)),
    });
    const right = await messages(server.port);
    if (right.status !== 200) {
      throw new Error(`expected 200, got ${right.status}: ${lines.join("\n")}`);
    }
    expect(up.seen).toHaveLength(1);

    // Same address, a name the certificate does not carry: nothing is sent.
    const other = authorizer(
      granting(`https://other.test:${up.port}`, [["x-api-key", PROVIDER_KEY]]),
    );
    const wrong = proxy(other.url, up.port, {
      upstreamCa: certificate.cert,
      policy: {
        allow: [],
        allowPrivate: [{ host: "other.test", port: up.port }],
      },
      resolve: async () => ["127.0.0.1"],
    });
    expect((await messages(wrong.port)).status).toBe(502);
    expect(up.seen).toHaveLength(1);

    // And a certificate from no trusted root is refused too.
    const untrusted = proxy(auth.url, up.port);
    expect((await messages(untrusted.port)).status).toBe(502);
    expect(up.seen).toHaveLength(1);

    // An https upstream by address has no name to check: refused, unsent.
    const byAddress = authorizer(
      granting(`https://127.0.0.1:${up.port}`, [["x-api-key", PROVIDER_KEY]]),
    );
    const literal = proxy(byAddress.url, up.port, {
      upstreamCa: certificate.cert,
      policy: {
        allow: [],
        allowPrivate: [{ host: "127.0.0.1", port: up.port }],
      },
      resolve: async (host) => [host],
    });
    expect((await messages(literal.port)).status).toBe(502);
    expect(up.seen).toHaveLength(1);
  });

  test("routes git's read half with the repository credential", async () => {
    const basic = `Basic ${Buffer.from("reader:repo-pass").toString("base64")}`;
    const up = upstream(
      () =>
        new Response("001e# service=git-upload-pack\n0000", {
          headers: {
            "content-type": "application/x-git-upload-pack-advertisement",
          },
        }),
    );
    const auth = authorizer((body) =>
      body.purpose === "repository" && body.token === WORKER_TOKEN
        ? Response.json({
            session_id: "s",
            attempt_id: "a",
            upstream: {
              url: `http://upstream.test:${up.port}/agent/app.git`,
              headers: [["authorization", basic]],
            },
          })
        : new Response("no", { status: 401 }),
    );
    const server = proxy(auth.url, up.port);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/repository/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${WORKER_TOKEN}` } },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("git-upload-pack");
    expect(new URL(up.seen[0]?.url ?? "").pathname).toBe(
      "/agent/app.git/info/refs",
    );
    expect(up.seen[0]?.headers.authorization).toBe(basic);
  });

  test("asks the authorizer for the repository the path names", async () => {
    const up = upstream(
      () =>
        new Response("001e# service=git-upload-pack\n0000", {
          headers: {
            "content-type": "application/x-git-upload-pack-advertisement",
          },
        }),
    );
    const asked: unknown[] = [];
    const auth = authorizer((body) => {
      asked.push(body);
      return Response.json({
        session_id: "s",
        attempt_id: "a",
        upstream: {
          url: `http://upstream.test:${up.port}/acme/docs.git`,
          headers: [],
        },
      });
    });
    const lines: string[] = [];
    const server = proxy(auth.url, up.port, {
      logger: createProxyLogger("info", (line) => lines.push(line)),
    });
    const response = await fetch(
      `http://127.0.0.1:${server.port}/repository/docs/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${WORKER_TOKEN}` } },
    );
    expect(response.status).toBe(200);
    expect(asked).toEqual([
      { token: WORKER_TOKEN, purpose: "repository", repository_id: "docs" },
    ]);
    expect(new URL(up.seen[0]?.url ?? "").pathname).toBe(
      "/acme/docs.git/info/refs",
    );
    const routed = lines
      .map((line) => JSON.parse(line) as { message: string; fields: unknown })
      .find((entry) => entry.message === "Credential route");
    expect(routed?.fields).toMatchObject({
      purpose: "repository",
      repository_id: "docs",
      session_id: "s",
      attempt_id: "a",
      status: 200,
    });
  });

  test("a success that echoes the credential is cut off before the value", async () => {
    let mode: "header" | "body" | "split" | "encoded" = "header";
    const up = upstream((request) => {
      const echoed = request.headers.get("x-api-key") ?? "";
      if (mode === "header") {
        return Response.json(
          { id: "msg_1" },
          { headers: { "x-debug": echoed } },
        );
      }
      if (mode === "encoded") {
        return new Response("\x1f\x8b....", {
          headers: { "content-encoding": "gzip" },
        });
      }
      const text = `data: {"debug":"${echoed}"}\n\n`;
      const at = text.indexOf(echoed) + 5;
      return new Response(
        new ReadableStream({
          start(controller) {
            const bytes = new TextEncoder().encode(text);
            if (mode === "split") {
              // The value straddles two chunks.
              controller.enqueue(bytes.subarray(0, at));
              controller.enqueue(bytes.subarray(at));
            } else {
              controller.enqueue(bytes);
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);

    const header = await messages(server.port);
    expect(header.status).toBe(200);
    expect(header.headers.get("x-debug")).toBeNull();
    expect(await header.json()).toEqual({ id: "msg_1" });

    for (const shape of ["body", "split"] as const) {
      mode = shape;
      const response = await messages(server.port);
      expect(response.status).toBe(200);
      const received = await response.text().catch(() => "<broken>");
      expect(received).not.toContain(PROVIDER_KEY);
    }

    mode = "encoded";
    expect((await messages(server.port)).status).toBe(502);
  });

  test("a request body trickled past the deadline ends the exchange and frees its slot", async () => {
    const up = upstream(() => Response.json({ ok: true }));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    // Each exchange's deadline fires only when the test says so: a wall-clock
    // deadline also cut the healthy exchange short on a loaded runner.
    const deadlines: AbortController[] = [];
    const server = proxy(auth.url, up.port, {
      exchangeDeadline: () => {
        const deadline = new AbortController();
        deadlines.push(deadline);
        return deadline.signal;
      },
      maxExchangesPerClient: 1,
    });
    // Promises 100 bytes, sends 2, then goes quiet.
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: { data() {} },
    });
    socket.write(
      `POST /provider/v1/messages HTTP/1.1\r\nhost: proxy\r\nx-api-key: ${WORKER_TOKEN}\r\ncontent-length: 100\r\n\r\n{}`,
    );
    // The trickled exchange is admitted once its deadline starts.
    while (deadlines.length === 0) await Bun.sleep(5);
    const held = await messages(server.port);
    expect(held.status).toBe(503);
    await held.text();
    deadlines[0]?.abort(new DOMException("deadline", "TimeoutError"));
    // The slot frees as the aborted exchange unwinds; nothing here waits on
    // the clock, only on that event.
    let next = await messages(server.port);
    while (next.status === 503) {
      await next.text();
      await Bun.sleep(5);
      next = await messages(server.port);
    }
    expect(next.status).toBe(200);
    await next.text();
    // The trickled request never reached the upstream.
    expect(up.seen).toHaveLength(1);
    socket.end();
  });

  test("caps open exchanges per client, and frees the slot when one ends", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const up = upstream(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("a"));
              await gate;
              controller.close();
            },
          }),
        ),
    );
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port, { maxExchangesPerClient: 1 });
    const held = await messages(server.port);
    expect(held.status).toBe(200);
    expect((await messages(server.port)).status).toBe(503);
    release();
    await held.text();
    // The slot frees as the body ends; give the stream a tick to close.
    await Bun.sleep(20);
    const next = await messages(server.port);
    expect(next.status).toBe(200);
    await next.text();
  });

  /** A raw request whose body is sent only as far as `sent`. */
  async function rawRequest(port: number, head: string, sent = "") {
    let answer = "";
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data(_, bytes) {
          answer += new TextDecoder().decode(bytes);
        },
      },
    });
    socket.write(`${head}\r\n\r\n${sent}`);
    return {
      socket,
      answered: async () => {
        const started = performance.now();
        while (answer === "" && performance.now() - started < 5_000) {
          await Bun.sleep(10);
        }
        return answer;
      },
    };
  }

  test("a body over the route's cap is refused before the authorizer hears of it", async () => {
    const up = upstream(() => Response.json({ ok: true }));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const declared = await rawRequest(
      server.port,
      `POST /provider/v1/messages HTTP/1.1\r\nhost: proxy\r\nx-api-key: ${WORKER_TOKEN}\r\ncontent-length: ${32 * 1024 * 1024 + 1}`,
    );
    expect(await declared.answered()).toStartWith("HTTP/1.1 413");
    declared.socket.end();
    // Sent chunked, it is read only as far as the cap.
    const big = new Uint8Array(1024 * 1024);
    let chunks = 0;
    const chunked = await fetch(
      `http://127.0.0.1:${server.port}/provider/v1/messages`,
      {
        method: "POST",
        headers: { "x-api-key": WORKER_TOKEN },
        body: new ReadableStream({
          pull(controller) {
            chunks += 1;
            if (chunks > 40) controller.close();
            else controller.enqueue(big);
          },
        }),
      },
    );
    expect(chunked.status).toBe(413);
    expect(chunks).toBeLessThan(40);
    expect(up.seen).toEqual([]);
  });

  test("a chunked body goes upstream whole, with its length", async () => {
    const up = upstream(() => Response.json({ ok: true }));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port);
    const parts = ['{"model":', '"m"}'];
    const response = await fetch(
      `http://127.0.0.1:${server.port}/provider/v1/messages`,
      {
        method: "POST",
        headers: { "x-api-key": WORKER_TOKEN },
        body: new ReadableStream({
          pull(controller) {
            const part = parts.shift();
            if (part === undefined) controller.close();
            else controller.enqueue(new TextEncoder().encode(part));
          },
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(up.seen[0]?.body).toBe('{"model":"m"}');
    expect(up.seen[0]?.headers["content-length"]).toBe("13");
  });

  test("holds request bodies to one budget across exchanges, and frees it as each goes upstream", async () => {
    const up = upstream(() => Response.json({ ok: true }));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port, { maxBodyBytesInFlight: 100 });
    const body = `{"model":"${"m".repeat(68)}"}`;
    expect(body).toHaveLength(80);
    // Admitted with 80 bytes declared and 2 sent, so they stay reserved.
    const held = await rawRequest(
      server.port,
      `POST /provider/v1/messages HTTP/1.1\r\nhost: proxy\r\nx-api-key: ${WORKER_TOKEN}\r\ncontent-length: 80`,
      body.slice(0, 2),
    );
    await Bun.sleep(50);
    const over = await messages(server.port, {
      body: `{"model":"${"m".repeat(18)}"}`,
    });
    expect(over.status).toBe(503);
    expect(await over.text()).toBe("too many request bytes in flight\n");
    // Nothing of it reached the authorizer: only the held one was asked.
    expect(auth.asked).toHaveLength(1);
    held.socket.write(body.slice(2));
    expect(await held.answered()).toStartWith("HTTP/1.1 200");
    held.socket.end();
    // Its reservation goes with the exchange, once the answer has ended.
    await Bun.sleep(50);
    const next = await messages(server.port, {
      body: `{"model":"${"m".repeat(18)}"}`,
    });
    expect(next.status).toBe(200);
    expect(up.seen.map((seen) => seen.body.length)).toEqual([80, 30]);
  });

  test("an upstream that answers before the body is out keeps the reservation until the exchange ends", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Answers from the head and never reads the body.
    const early = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode("a"));
              await gate;
              controller.close();
            },
          }),
        ),
    });
    servers.push(early);
    const port = early.port ?? 0;
    const auth = authorizer(
      granting(`http://upstream.test:${port}`, [["x-api-key", PROVIDER_KEY]]),
    );
    const server = proxy(auth.url, port, { maxBodyBytesInFlight: 100 });
    const held = await messages(server.port, {
      body: `{"model":"${"m".repeat(68)}"}`,
    });
    expect(held.status).toBe(200);
    const over = await messages(server.port, {
      body: `{"model":"${"m".repeat(18)}"}`,
    });
    expect(over.status).toBe(503);
    release();
    await held.text();
    await Bun.sleep(50);
    const next = await messages(server.port);
    expect(next.status).toBe(200);
    await next.text();
  });

  describe("an exchange that never finishes still frees its slot", () => {
    // An upstream that sends one event and then holds the stream open, the
    // way a slow model call does while the worker is interrupted; or, once
    // `hold()` is called, holds its next call without even a head, the way
    // the soak's model held the call it interrupted.
    function holding() {
      const aborted: Promise<void>[] = [];
      let holdNext = false;
      const up = upstream(async (request) => {
        const hungUp = new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        aborted.push(hungUp);
        if (holdNext) {
          holdNext = false;
          await hungUp;
          return new Response("gone", { status: 500 });
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: one\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      let answer: "grant" | "gone" = "grant";
      const grant = granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]);
      const auth = authorizer((body) =>
        answer === "grant" ? grant(body) : new Response("x", { status: 409 }),
      );
      return {
        up,
        auth,
        hold: () => {
          holdNext = true;
        },
        /** The upstream saw the proxy hang up on the latest exchange. */
        hungUp: () => aborted.at(-1) ?? Promise.resolve(),
        end: () => {
          answer = "gone";
        },
        renew: () => {
          answer = "grant";
        },
      };
    }

    /** A worker's call, streaming unless the upstream holds its head. */
    async function opened(h: ReturnType<typeof holding>, port: number) {
      const worker = new AbortController();
      const seen = h.up.seen.length;
      const answered = fetch(`http://127.0.0.1:${port}/provider/v1/messages`, {
        method: "POST",
        headers: { "x-api-key": WORKER_TOKEN },
        body: '{"model":"m"}',
        signal: worker.signal,
      });
      let settled = false;
      answered.then(
        () => {
          settled = true;
        },
        () => {},
      );
      // Past the cap, a refusal comes back without reaching the upstream.
      while (h.up.seen.length === seen && !settled) await Bun.sleep(5);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const read = async () => {
        reader ??= (await answered).body?.getReader();
        return reader?.read();
      };
      return {
        hangUp: () => worker.abort(),
        streaming: async () => {
          expect((await answered).status).toBe(200);
          expect((await read())?.done).toBe(false);
        },
        /** Whatever the worker is still sent, to its end. */
        drain: async () => {
          try {
            while (!(await read())?.done) {}
          } catch {}
        },
      };
    }

    /** A call is let in, then hung up on and its slot given back. */
    async function admitted(h: ReturnType<typeof holding>, port: number) {
      const call = await opened(h, port);
      await call.streaming();
      call.hangUp();
      await h.hungUp();
    }

    function capped(h: ReturnType<typeof holding>, cap: number) {
      return proxy(h.auth.url, h.up.port, {
        maxExchanges: cap,
        regrantIntervalMs: 20,
      });
    }

    test("a grant cut frees the slot, whether or not the worker still reads", async () => {
      const h = holding();
      const server = capped(h, 1);
      // Mid-stream, the worker reading to the cut.
      const reading = await opened(h, server.port);
      await reading.streaming();
      h.end();
      await reading.drain();
      await h.hungUp();
      h.renew();
      await admitted(h, server.port);
      // Mid-stream, the worker already gone.
      const gone = await opened(h, server.port);
      await gone.streaming();
      gone.hangUp();
      h.end();
      await h.hungUp();
      await Bun.sleep(60);
      h.renew();
      await admitted(h, server.port);
      // Before the upstream's head, the worker reading the refusal.
      h.hold();
      const waiting = await opened(h, server.port);
      h.end();
      await waiting.drain();
      await h.hungUp();
      h.renew();
      await admitted(h, server.port);
    });

    // The soak's leak: the worker is interrupted while the model still holds
    // its call, so the proxy's 502 answers a connection already gone, and
    // Bun pulls such a body once and then neither reads nor cancels it.
    test("a worker that hangs up frees the slot, grant or not", async () => {
      const h = holding();
      const server = proxy(h.auth.url, h.up.port, {
        maxExchanges: 1,
        regrantIntervalMs: 60_000,
      });
      const streaming = await opened(h, server.port);
      await streaming.streaming();
      streaming.hangUp();
      await h.hungUp();
      await Bun.sleep(60);
      await admitted(h, server.port);
      h.hold();
      const waiting = await opened(h, server.port);
      waiting.hangUp();
      await h.hungUp();
      await Bun.sleep(60);
      await admitted(h, server.port);
    });

    test("a worker hanging up while the upstream name is resolving frees the slot", async () => {
      const h = holding();
      let lookups = 0;
      const server = proxy(h.auth.url, h.up.port, {
        maxExchanges: 1,
        // The first lookup never answers.
        resolve: (host) => {
          lookups += 1;
          return lookups === 1
            ? new Promise<string[]>(() => {})
            : Promise.resolve(host === "upstream.test" ? ["127.0.0.1"] : []);
        },
      });
      const worker = new AbortController();
      const stuck = fetch(
        `http://127.0.0.1:${server.port}/provider/v1/messages`,
        {
          method: "POST",
          headers: { "x-api-key": WORKER_TOKEN },
          body: '{"model":"m"}',
          signal: worker.signal,
        },
      ).catch(() => null);
      while (lookups === 0) await Bun.sleep(5);
      worker.abort();
      await stuck;
      await Bun.sleep(60);
      await admitted(h, server.port);
    });

    test("cut and hung-up exchanges never run the cap out", async () => {
      const h = holding();
      const server = capped(h, 2);
      const rounds = [
        { head: "sent", cut: true, hangUp: false },
        { head: "sent", cut: false, hangUp: true },
        { head: "sent", cut: true, hangUp: true },
        { head: "held", cut: true, hangUp: false },
        { head: "held", cut: false, hangUp: true },
        { head: "held", cut: true, hangUp: true },
      ] as const;
      for (const round of [...rounds, ...rounds]) {
        if (round.head === "held") h.hold();
        const call = await opened(h, server.port);
        if (round.head === "sent") await call.streaming();
        if (round.hangUp) call.hangUp();
        if (round.cut) h.end();
        if (!round.hangUp) await call.drain();
        await h.hungUp();
        await Bun.sleep(60);
        h.renew();
      }
      await admitted(h, server.port);
    });
  });

  test("an open exchange is cut once its grant ends, not when the authorizer blips", async () => {
    // The first exchange's gate opens; the later ones' never do.
    let release: () => void = () => {};
    const gates = [
      new Promise<void>((resolve) => {
        release = resolve;
      }),
      new Promise<void>(() => {}),
      new Promise<void>(() => {}),
    ];
    let upstreamAborted = false;
    const up = upstream(
      (request) =>
        new Response(
          new ReadableStream({
            async start(controller) {
              request.signal.addEventListener("abort", () => {
                upstreamAborted = true;
              });
              controller.enqueue(new TextEncoder().encode("a"));
              await gates.shift();
              controller.enqueue(new TextEncoder().encode("b"));
              controller.close();
            },
          }),
        ),
    );
    let answer: "grant" | "down" | "gone" = "grant";
    const grant = granting(`http://upstream.test:${up.port}`, [
      ["x-api-key", PROVIDER_KEY],
    ]);
    const auth = authorizer((body) =>
      answer === "grant"
        ? grant(body)
        : new Response("x", { status: answer === "down" ? 500 : 409 }),
    );
    const server = proxy(auth.url, up.port, {
      regrantIntervalMs: 20,
      regrantGraceMs: 60_000,
    });

    // The authorizer failing is not the grant ending: the stream goes on.
    const kept = await messages(server.port);
    const keptReader = kept.body?.getReader();
    expect(new TextDecoder().decode((await keptReader?.read())?.value)).toBe(
      "a",
    );
    answer = "down";
    const asked = auth.asked.length;
    while (auth.asked.length < asked + 3) await Bun.sleep(10);
    answer = "grant";
    release();
    expect(new TextDecoder().decode((await keptReader?.read())?.value)).toBe(
      "b",
    );
    expect((await keptReader?.read())?.done).toBe(true);

    // A refusal while the upstream is still streaming ends the exchange.
    const cut = await messages(server.port);
    const cutReader = cut.body?.getReader();
    expect((await cutReader?.read())?.done).toBe(false);
    answer = "gone";
    // Bun ends the relayed body rather than resetting the connection, so
    // the worker sees a cut-short stream (no `b`, never an SSE stop or a
    // pack's trailer) where the upstream would have waited forever.
    let rest = "";
    try {
      for (;;) {
        const next = await cutReader?.read();
        if (next === undefined || next.done) break;
        rest += new TextDecoder().decode(next.value);
      }
    } catch {}
    expect(rest).toBe("");
    await Bun.sleep(20);
    expect(upstreamAborted).toBe(true);

    // An authorizer that stays down past the grace ends it too.
    upstreamAborted = false;
    answer = "grant";
    const strict = proxy(auth.url, up.port, {
      regrantIntervalMs: 20,
      regrantGraceMs: 100,
    });
    const outage = await messages(strict.port);
    const outageReader = outage.body?.getReader();
    expect((await outageReader?.read())?.done).toBe(false);
    answer = "down";
    let after = "";
    try {
      for (;;) {
        const next = await outageReader?.read();
        if (next === undefined || next.done) break;
        after += new TextDecoder().decode(next.value);
      }
    } catch {}
    expect(after).toBe("");
    await Bun.sleep(20);
    expect(upstreamAborted).toBe(true);
  });

  test("a privately listed upstream that resolves publicly gets no login", async () => {
    const up = upstream(() => Response.json({ id: "msg_1" }));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    const server = proxy(auth.url, up.port, {
      resolve: async () => ["127.0.0.1", "8.8.8.8"],
    });
    const response = await messages(server.port);
    expect(response.status).toBe(403);
    expect(up.seen).toEqual([]);
  });

  describe("the judgment route", () => {
    const JUDGMENT_TOKEN = "wej_judgment-token";
    const JUDGE_KEY = "sk-judge-key-kept-from-everyone";
    const judgmentGrant = (url: string) =>
      Response.json({
        judgment_id: "judg-1",
        upstream: { url, headers: [["authorization", `Bearer ${JUDGE_KEY}`]] },
      });
    const decide = (
      port: number,
      token: string,
      path = "/decisions/v1/decisions",
    ) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: '{"model":"gpt-6-luna"}',
      });

    test("sends the judge's key, and reports the answer's usage under the judgment, never a session", async () => {
      const up = upstream(() =>
        Response.json({
          model: "gpt-6-luna",
          choice: "yes",
          usage: { input_tokens: 600, output_tokens: 0 },
        }),
      );
      const auth = authorizer((body) =>
        body.token === JUDGMENT_TOKEN && body.purpose === "judgment"
          ? judgmentGrant(`http://upstream.test:${up.port}`)
          : new Response("no", { status: 401 }),
      );
      const server = proxy(auth.url, up.port);
      const response = await decide(server.port, JUDGMENT_TOKEN);
      expect(response.status).toBe(200);
      await response.json();
      expect(auth.asked).toEqual([
        { token: JUDGMENT_TOKEN, purpose: "judgment" },
      ]);
      const [seen] = up.seen;
      expect(new URL(seen?.url ?? "").pathname).toBe("/v1/decisions");
      expect(seen?.headers.authorization).toBe(`Bearer ${JUDGE_KEY}`);
      expect(JSON.stringify(seen)).not.toContain(JUDGMENT_TOKEN);
      await until(() => auth.reported.length === 1);
      const [report] = auth.reported;
      expect(report).toMatchObject({
        judgment_id: "judg-1",
        usage: { model: "gpt-6-luna", input_tokens: 600, output_tokens: 0 },
      });
      expect(Object.keys(report ?? {}).sort()).toEqual([
        "exchange_id",
        "judgment_id",
        "usage",
      ]);
    });

    // What every proxy before judgment grants does with one: its grant
    // parser requires a session and an attempt.
    test("a judgment grant on a session route is refused and reaches nothing", async () => {
      const up = upstream(() => Response.json({ id: "msg_1" }));
      const auth = authorizer(() =>
        judgmentGrant(`http://upstream.test:${up.port}`),
      );
      const server = proxy(auth.url, up.port);
      const response = await messages(server.port);
      expect(response.status).toBe(503);
      await response.text();
      expect(up.seen).toEqual([]);
      expect(auth.reported).toEqual([]);
    });

    test("a session grant on the judgment route is refused and reaches nothing", async () => {
      const up = upstream(() => Response.json({ model: "gpt-6-luna" }));
      const auth = authorizer(
        granting(`http://upstream.test:${up.port}`, [
          ["authorization", `Bearer ${JUDGE_KEY}`],
        ]),
      );
      const server = proxy(auth.url, up.port);
      const response = await decide(server.port, WORKER_TOKEN);
      expect(response.status).toBe(503);
      await response.text();
      expect(up.seen).toEqual([]);
      expect(auth.reported).toEqual([]);
    });

    test("the judge's error answers are relayed and their bodies, which name the key's last characters, never logged", async () => {
      // ASSUMPTION (decisions-api.fixture.ts): OpenAI's usual error envelope.
      const suffix = JUDGE_KEY.slice(-4);
      for (const status of [401, 403, 429, 500]) {
        const up = upstream(() =>
          Response.json(
            {
              error: {
                message: `Incorrect API key provided: sk-...${suffix}.`,
                type: "invalid_request_error",
                code: "invalid_api_key",
              },
            },
            { status },
          ),
        );
        const auth = authorizer(() =>
          judgmentGrant(`http://upstream.test:${up.port}`),
        );
        const lines: string[] = [];
        const server = proxy(auth.url, up.port, {
          logger: createProxyLogger("debug", (line) => lines.push(line)),
        });
        const response = await decide(server.port, JUDGMENT_TOKEN);
        expect(response.status).toBe(status);
        await response.text();
        expect(lines.length).toBeGreaterThan(0);
        const logged = lines.join("\n");
        expect(logged).not.toContain(suffix);
        expect(logged).not.toContain("Incorrect API key");
        expect(auth.reported).toEqual([]);
      }
    });

    test("a judgment is charged at the request's model even when the answer names a dated one", async () => {
      const up = upstream(() =>
        Response.json({
          model: "gpt-6-luna-2026-11-01",
          answers: [{ type: "refusal", name: "achievement" }],
          usage: { input_tokens: 598 },
        }),
      );
      const auth = authorizer(() =>
        judgmentGrant(`http://upstream.test:${up.port}`),
      );
      const server = proxy(auth.url, up.port);
      const response = await decide(server.port, JUDGMENT_TOKEN);
      expect(response.status).toBe(200);
      await response.json();
      await until(() => auth.reported.length === 1);
      expect(auth.reported[0]?.usage).toMatchObject({
        model: "gpt-6-luna",
        input_tokens: 598,
        estimated: false,
      });
    });

    test("a documented Decisions answer, which names no model, is charged at the request's model as read", async () => {
      const up = upstream(() =>
        Response.json({
          answers: [
            {
              type: "choice",
              name: "achievement",
              choice: "yes",
              probabilities: [
                { value: "yes", probability: 0.94 },
                { value: "no", probability: 0.06 },
              ],
              confidence: 0.94,
            },
          ],
          usage: {
            input_tokens: 612,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
          },
        }),
      );
      const auth = authorizer(() =>
        judgmentGrant(`http://upstream.test:${up.port}`),
      );
      const server = proxy(auth.url, up.port);
      const response = await decide(server.port, JUDGMENT_TOKEN);
      expect(response.status).toBe(200);
      await response.json();
      await until(() => auth.reported.length === 1);
      expect(auth.reported[0]?.usage).toMatchObject({
        model: "gpt-6-luna",
        input_tokens: 612,
        output_tokens: 0,
        estimated: false,
      });
    });
  });

  describe("the remote MCP route", () => {
    const SERVICE_ACCOUNT = "sa-value-kept-from-the-worker";
    const call = (port: number, body: string, method = "POST") =>
      fetch(`http://127.0.0.1:${port}/mcp/fake`, {
        method,
        headers: {
          authorization: `Bearer ${WORKER_TOKEN}`,
          "content-type": "application/json",
          "mcp-session-id": "mcp-1",
        },
        ...(body === "" ? {} : { body }),
      });
    const TOOLS_CALL =
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami"}}';

    test("asks with the server and call, and sends the service account's bearer", async () => {
      const up = upstream(() =>
        Response.json(
          { jsonrpc: "2.0", id: 1, result: {} },
          { headers: { "mcp-session-id": "mcp-1" } },
        ),
      );
      const auth = authorizer(
        granting(`http://upstream.test:${up.port}/mcp`, [
          ["authorization", `Bearer ${SERVICE_ACCOUNT}`],
        ]),
      );
      const server = proxy(auth.url, up.port);
      const response = await call(server.port, TOOLS_CALL);
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBe("mcp-1");
      expect<unknown>(auth.asked).toEqual([
        {
          token: WORKER_TOKEN,
          purpose: "mcp",
          server: "fake",
          rpc: { method: "tools/call", tool: "whoami" },
        },
      ]);
      const [seen] = up.seen;
      expect(new URL(seen?.url ?? "").pathname).toBe("/mcp");
      expect(seen?.headers.authorization).toBe(`Bearer ${SERVICE_ACCOUNT}`);
      expect(seen?.headers["mcp-session-id"]).toBe("mcp-1");
      expect(seen?.body).toBe(TOOLS_CALL);
      expect(JSON.stringify(seen)).not.toContain(WORKER_TOKEN);

      expect((await call(server.port, "", "DELETE")).status).toBe(200);
      expect(auth.asked[1]).toMatchObject({
        server: "fake",
        rpc: { method: null, tool: null },
      });
      // Judged as no call, so a body riding along is refused unasked.
      const smuggled = await call(server.port, TOOLS_CALL, "DELETE");
      expect(smuggled.status).toBe(400);
      expect(auth.asked).toHaveLength(2);
      expect(up.seen).toHaveLength(2);
    });

    test("the built-in server is reached on the authorizer's listener, outside the allowlist", async () => {
      const GRANT = "signed-grant-for-one-exchange";
      const seen: Array<{ path: string; authorization: string | null }> = [];
      const api = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/authorize") {
            return Response.json({
              session_id: "sess-1",
              attempt_id: "att-1",
              upstream: {
                url: "/mcp/github",
                headers: [["authorization", `Bearer ${GRANT}`]],
              },
            });
          }
          seen.push({
            path,
            authorization: request.headers.get("authorization"),
          });
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            result: { tools: [] },
          });
        },
      });
      servers.push(api);
      const server = proxy(`http://127.0.0.1:${api.port}`, 1, {
        resolve: async (host) => (host === "127.0.0.1" ? ["127.0.0.1"] : []),
      });
      const response = await fetch(
        `http://127.0.0.1:${server.port}/mcp/github`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${WORKER_TOKEN}`,
            "content-type": "application/json",
          },
          body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        },
      );
      expect(response.status).toBe(200);
      expect(seen).toEqual([
        { path: "/mcp/github", authorization: `Bearer ${GRANT}` },
      ]);
      // Another route to the same host is still held to the allowlist.
      const provider = await messages(server.port);
      expect(provider.status).toBe(403);
    });

    describe("while the built-in server restarts", () => {
      const GRANT = "signed-grant-for-one-exchange";
      const TOOLS_LIST = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
      const grantAnswer = () =>
        Response.json({
          session_id: "sess-1",
          attempt_id: "att-1",
          upstream: {
            url: "/mcp/github",
            headers: [["authorization", `Bearer ${GRANT}`]],
          },
        });
      const listen = (port: number, hits: string[], onAuthorize: () => void) =>
        Bun.serve({
          hostname: "127.0.0.1",
          port,
          fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/authorize") {
              onAuthorize();
              return grantAnswer();
            }
            hits.push(path);
            return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
          },
        });
      // The lookup follows the grant and precedes the dial, so `firstLookup`
      // is the moment to take the server down.
      const viaProxy = (
        api: { port?: number | undefined },
        firstLookup = () => {},
      ) => {
        let looked = false;
        return proxy(`http://127.0.0.1:${api.port}`, 1, {
          resolve: async (host) => {
            if (!looked) {
              looked = true;
              firstLookup();
            }
            return host === "127.0.0.1" ? ["127.0.0.1"] : [];
          },
        });
      };
      const post = (port: number) =>
        fetch(`http://127.0.0.1:${port}/mcp/github`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${WORKER_TOKEN}`,
            "content-type": "application/json",
          },
          body: TOOLS_LIST,
        });

      test("a refused connection is dialled again and the call succeeds", async () => {
        const hits: string[] = [];
        let api = listen(0, hits, () => {});
        servers.push(api);
        const port = api.port ?? 0;
        const server = viaProxy(api, () => {
          // Down for the first dial and the retry after 200 ms, back for
          // the one after 600 ms.
          api.stop(true);
          setTimeout(() => {
            api = listen(port, hits, () => {});
            servers.push(api);
          }, 450);
        });
        const response = await post(server.port);
        expect(response.status).toBe(200);
        expect(hits).toEqual(["/mcp/github"]);
      });

      test("a connection that stays refused answers 503 with a retry hint", async () => {
        const hits: string[] = [];
        const api = listen(0, hits, () => {});
        servers.push(api);
        const started = Date.now();
        const response = await post(viaProxy(api, () => api.stop(true)).port);
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBe("5");
        expect(await response.text()).toContain("retry the tool call");
        expect(Date.now() - started).toBeLessThan(3_500);
        expect(hits).toEqual([]);
      });

      test("a retry whose lookup is refused does not fall back to the old address", async () => {
        const hits: string[] = [];
        let api = listen(0, hits, () => {});
        servers.push(api);
        const port = api.port ?? 0;
        let lookups = 0;
        const server = proxy(`http://127.0.0.1:${port}`, 1, {
          resolve: async () => {
            lookups++;
            if (lookups === 1) {
              api.stop(true);
              return ["127.0.0.1"];
            }
            // The name now points outside; a server is back on the old address.
            api = listen(port, hits, () => {});
            servers.push(api);
            return ["8.8.8.8"];
          },
        });
        const response = await post(server.port);
        expect(response.status).toBe(403);
        expect(hits).toEqual([]);
      });

      test("an error after the request was sent is not dialled again", async () => {
        let mcpCalls = 0;
        const raw = createServer((socket) => {
          let received = Buffer.alloc(0);
          socket.on("data", (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
            const end = received.indexOf("\r\n\r\n");
            if (end < 0) return;
            const head = received.subarray(0, end).toString("latin1");
            const length = Number(
              /content-length: (\d+)/i.exec(head)?.[1] ?? 0,
            );
            if (received.byteLength < end + 4 + length) return;
            if (head.startsWith("POST /authorize")) {
              const body = JSON.stringify({
                session_id: "sess-1",
                attempt_id: "att-1",
                upstream: { url: "/mcp/github", headers: [] },
              });
              socket.end(
                `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
              );
              return;
            }
            mcpCalls++;
            socket.destroy();
          });
        });
        await new Promise<void>((resolve) =>
          raw.listen(0, "127.0.0.1", resolve),
        );
        servers.push({ stop: () => raw.close() });
        const port = (raw.address() as { port: number }).port;
        const response = await post(viaProxy({ port }).port);
        expect(response.status).toBe(502);
        expect(await response.text()).toBe("upstream connection failed\n");
        expect(mcpCalls).toBe(1);
      });

      test("a catalog server that refuses the connection keeps its 502", async () => {
        const gone = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: () => new Response(),
        });
        const deadPort = gone.port ?? 0;
        gone.stop(true);
        const auth = authorizer(
          granting(`http://upstream.test:${deadPort}/mcp`, []),
        );
        const server = proxy(auth.url, deadPort);
        const started = Date.now();
        const response = await call(server.port, TOOLS_CALL);
        expect(response.status).toBe(502);
        expect(response.headers.get("retry-after")).toBeNull();
        // A retry would wait at least 200 ms and then 400 ms more.
        expect(Date.now() - started).toBeLessThan(1_000);
      });
    });

    test("a catalog URL on the authorizer's origin is still held to the allowlist", async () => {
      const seen: string[] = [];
      let origin = "";
      const api = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/authorize") {
            return Response.json({
              session_id: "sess-1",
              attempt_id: "att-1",
              upstream: {
                url: `${origin}/mcp/github`,
                headers: [],
              },
            });
          }
          seen.push(path);
          return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
        },
      });
      servers.push(api);
      origin = `http://127.0.0.1:${api.port}`;
      const server = proxy(`http://127.0.0.1:${api.port}`, 1, {
        resolve: async (host) => (host === "127.0.0.1" ? ["127.0.0.1"] : []),
      });
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp/fake`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${WORKER_TOKEN}`,
          "content-type": "application/json",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });
      expect(response.status).toBe(403);
      expect(seen).toEqual([]);
    });

    test("a refusal with a receipt names it; a batch never reaches the authorizer", async () => {
      const up = upstream(() => new Response("ok"));
      const receipt = "0a1b2c3d-0000-5000-8000-000000000001";
      const auth = authorizer(() =>
        Response.json(
          { code: "CREDENTIAL_UNBOUND", message: "x", receipt_id: receipt },
          { status: 403 },
        ),
      );
      const server = proxy(auth.url, up.port);
      const refused = await call(server.port, TOOLS_CALL);
      expect(refused.status).toBe(403);
      expect(await refused.text()).toBe(
        `egress denied: credential_unbound (receipt ${receipt})\n`,
      );
      const batch = await call(server.port, `[${TOOLS_CALL}]`);
      expect(batch.status).toBe(400);
      expect(auth.asked).toHaveLength(1);
      expect(up.seen).toEqual([]);
    });

    test("an upstream 401 reaches the worker as 403 with no challenge", async () => {
      const up = upstream(
        () =>
          new Response("bad credential", {
            status: 401,
            headers: { "www-authenticate": 'Bearer resource_metadata="x"' },
          }),
      );
      const auth = authorizer(
        granting(`http://upstream.test:${up.port}/mcp`, [
          ["authorization", `Bearer ${SERVICE_ACCOUNT}`],
        ]),
      );
      const server = proxy(auth.url, up.port);
      const response = await call(server.port, TOOLS_CALL);
      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toBeNull();
    });

    test("asks again as a regrant while the exchange is open", async () => {
      const gate = new Promise<void>(() => {});
      const up = upstream(
        () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
                await gate;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const auth = authorizer(
        granting(`http://upstream.test:${up.port}/mcp`, [
          ["authorization", `Bearer ${SERVICE_ACCOUNT}`],
        ]),
      );
      const server = proxy(auth.url, up.port, { regrantIntervalMs: 20 });
      const response = await call(server.port, TOOLS_CALL);
      await response.body?.getReader().read();
      await until(() => auth.asked.length >= 2);
      expect(auth.asked[0]).not.toHaveProperty("regrant");
      expect(auth.asked[1]).toMatchObject({
        regrant: true,
        rpc: { method: "tools/call", tool: "whoami" },
      });
      await response.body?.cancel().catch(() => {});
    });
  });
});

async function mintCertificate(
  directory: string,
  name: string,
): Promise<{ cert: string; key: string }> {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  const generate = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${name}`,
      "-addext",
      `subjectAltName=DNS:${name}`,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stderr: "pipe", stdout: "ignore" },
  );
  if ((await generate.exited) !== 0) {
    throw new Error(
      `openssl could not mint a test certificate:\n${await new Response(generate.stderr).text()}`,
    );
  }
  return {
    cert: await Bun.file(certPath).text(),
    key: await Bun.file(keyPath).text(),
  };
}

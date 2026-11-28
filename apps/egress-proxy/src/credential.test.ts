import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { egressProxyConfigFromEnv } from "./config.ts";
import {
  type Authorized,
  addressKeys,
  addressMemory,
  bodyReservation,
  type CredentialProxyServer,
  decidedWithin,
  type EgressGrant,
  hostKey,
  installationHosts,
  isPushAdvertisement,
  mcpCallOf,
  parseGrant,
  privateRefusal,
  registeredPrivate,
  responseHeaders,
  routeOf,
  secretGuard,
  secretsOf,
  startCredentialProxy,
  tokenOf,
  upstreamPolicy,
  upstreamRequestHeaders,
} from "./credential.ts";
import { createProxyLogger } from "./logger.ts";
import { classifyAddress, type EgressPolicy } from "./policy.ts";

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
      conversationCallId: null,
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

  test("reads a grant's request limits, and refuses limits it cannot read", () => {
    expect(
      parseGrant({
        ...good,
        request_limits: { path: "/v1/messages", model: "m", max_tokens: 64 },
      })?.requestLimits,
    ).toEqual({ path: "/v1/messages", model: "m", maxTokens: 64 });
    for (const request_limits of [
      null,
      {},
      { path: "/v1/other", model: "m", max_tokens: 64 },
      { path: "/v1/messages", model: "", max_tokens: 64 },
      { path: "/v1/messages", model: "m", max_tokens: 0 },
      { path: "/v1/messages", model: "m", max_tokens: 1.5 },
      { path: "/v1/messages", model: "m", max_tokens: "64" },
    ]) {
      expect(parseGrant({ ...good, request_limits }) === null).toBe(true);
    }
  });

  test("a conversation call's grant names its call, and is read only with a body cap", () => {
    const limits = {
      path: "/v1/messages",
      model: "m",
      max_tokens: 64,
      max_request_bytes: 4_096,
    };
    const called = {
      conversation_call_id: "c",
      upstream: good.upstream,
      request_limits: limits,
    };
    expect(parseGrant(called)).toMatchObject({
      sessionId: null,
      attemptId: null,
      judgmentId: null,
      conversationCallId: "c",
      requestLimits: {
        path: "/v1/messages",
        model: "m",
        maxTokens: 64,
        maxRequestBytes: 4_096,
      },
    });
    for (const bad of [
      { conversation_call_id: "c", upstream: good.upstream },
      {
        ...called,
        request_limits: { ...limits, max_request_bytes: undefined },
      },
      { ...called, request_limits: { ...limits, max_request_bytes: 0 } },
      { ...called, session_id: "s", attempt_id: "a" },
      { ...called, judgment_id: "j" },
    ]) {
      expect(parseGrant(bad)).toBeNull();
    }
    // A session's title grant with a cap is still the session's.
    expect(
      parseGrant({ ...good, request_limits: limits })?.requestLimits
        ?.maxRequestBytes,
    ).toBe(4_096);
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

describe("the registered-server mark", () => {
  // `null`: the authorizer sent no mark at all.
  const marked = (url: string, allow: unknown = "public_https") =>
    parseGrant(
      {
        session_id: "s",
        attempt_id: "a",
        upstream: { url, headers: [], ...(allow === null ? {} : { allow }) },
      },
      new URL("http://api:3100/authorize"),
    ) as EgressGrant;
  const operator: EgressPolicy = {
    allow: [{ host: "listed.test", port: 443 }],
    allowPrivate: [{ host: "upstream.test", port: 443 }],
  };

  test("parseGrant keeps the mark it knows and drops one it does not", () => {
    expect(marked("https://mcp.test/v2/mcp").allow).toBe("public_https");
    for (const allow of [null, "public", "PUBLIC_HTTPS", true, 1, {}]) {
      const grant = marked("https://mcp.test/v2/mcp", allow);
      expect(grant).not.toBeNull();
      expect("allow" in grant).toBe(false);
    }
  });

  test("a marked https MCP server gets a policy of its own host:port, public only", () => {
    expect(
      upstreamPolicy("mcp", marked("https://Mcp.Test/v2/mcp"), operator),
    ).toEqual({ allow: [{ host: "mcp.test", port: 443 }], allowPrivate: [] });
    // The registered port, not the scheme's, and not any other.
    expect(
      upstreamPolicy("mcp", marked("https://mcp.test:8443/mcp"), operator),
    ).toEqual({ allow: [{ host: "mcp.test", port: 8443 }], allowPrivate: [] });
    // A trailing dot is the same name to DNS, and to the policy.
    expect(
      upstreamPolicy("mcp", marked("https://mcp.test./mcp"), operator),
    ).toEqual({ allow: [{ host: "mcp.test", port: 443 }], allowPrivate: [] });
  });

  test("the mark is read on nothing else: the operator's list decides", () => {
    // No mark: an API from before the mark.
    expect(
      upstreamPolicy("mcp", marked("https://mcp.test/mcp", null), operator),
    ).toBe(operator);
    // Plain http.
    expect(upstreamPolicy("mcp", marked("http://mcp.test/mcp"), operator)).toBe(
      operator,
    );
    // The built-in server on the authorizer's listener, https or not.
    const builtin = marked("/mcp/github");
    expect(builtin.builtin).toBe(true);
    expect(upstreamPolicy("mcp", builtin, operator)).toBe(operator);
    const tls = parseGrant(
      {
        session_id: "s",
        attempt_id: "a",
        upstream: { url: "/mcp/github", headers: [], allow: "public_https" },
      },
      new URL("https://api.test/authorize"),
    ) as EgressGrant;
    expect(tls.builtin).toBe(true);
    expect(tls.upstream.protocol).toBe("https:");
    expect(upstreamPolicy("mcp", tls, operator)).toBe(operator);
    // Every other route.
    for (const purpose of [
      "provider",
      "repository",
      "packages",
      "object_store",
      "judgment",
    ] as const) {
      expect(
        upstreamPolicy(purpose, marked("https://mcp.test/mcp"), operator),
      ).toBe(operator);
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

describe("the registered-private mark", () => {
  const authorizerUrl = new URL("http://api:3100/authorize");
  const grant = (upstream: Record<string, unknown>) =>
    parseGrant(
      {
        session_id: "s",
        attempt_id: "a",
        upstream: { headers: [], ...upstream },
      },
      authorizerUrl,
    );
  const marked = (url: string, deny: unknown = []) =>
    grant({ url, allow: "private", deny }) as EgressGrant;
  const operator: EgressPolicy = {
    allow: [{ host: "listed.test", port: 443 }],
    allowPrivate: [{ host: "inside.test", port: 4000 }],
  };
  const ROUTES = ["mcp", "provider", "judgment"] as const;

  test("hostKey reads a host as an upstream URL naming it is read", () => {
    const keys: Array<[string, string | null]> = [
      ["DB.", "db"],
      ["api_internal", "api_internal"],
      ["10.0.0.5", "10.0.0.5"],
      ["2130706433", "127.0.0.1"],
      ["0x7f.1", "127.0.0.1"],
      ["010.0.0.5", "8.0.0.5"],
      ["[FD00::1]", "fd00::1"],
      ["fd00:0:0:0:0:0:0:1", "fd00::1"],
      // IPv4-mapped is the IPv4 address a socket takes it to.
      ["::ffff:10.0.0.5", "10.0.0.5"],
      ["[::FFFF:A00:5]", "10.0.0.5"],
      // Not a host alone.
      ["", null],
      [".", null],
      ["db:5432", null],
      ["[fd00::1]:80", null],
      ["db/path", null],
      ["user@db", null],
      ["a b", null],
      ["fe80::1%eth0", null],
      ["1.2.3.4.5", null],
    ];
    for (const [host, key] of keys)
      expect([host, hostKey(host)]).toEqual([host, key]);
  });

  test("parseGrant keeps the mark with its deny list, each host in one spelling", () => {
    const parsed = marked("http://model.internal:4000/v1", [
      "DB.",
      "[FD00:0:0:0:0:0:0:1]",
      "10.0.0.7",
      "2130706433",
    ]);
    expect(parsed.allow).toBe("private");
    expect(parsed.deny).toEqual(["db", "fd00::1", "10.0.0.7", "127.0.0.1"]);
    expect(marked("http://model.internal:4000/v1").deny).toEqual([]);
    const most = Array.from({ length: 256 }, (_, index) => `h${index}`);
    expect(marked("http://model.internal:4000/v1", most).deny).toHaveLength(
      256,
    );
  });

  test("a private mark without a deny list the proxy can read is no grant", () => {
    const unreadable: unknown[] = [
      null,
      "db",
      {},
      [1],
      [""],
      [["db"]],
      ["db:5432"],
      ["db/path"],
      ["fe80::1%eth0"],
      ["db", "a b"],
      Array.from({ length: 257 }, (_, index) => `h${index}`),
    ];
    for (const deny of unreadable) {
      expect(
        grant({ url: "http://model.internal:4000/v1", allow: "private", deny }),
      ).toBeNull();
    }
    expect(
      grant({ url: "http://model.internal:4000/v1", allow: "private" }),
    ).toBeNull();
    // On every route, the built-in server and the routes that do not read
    // the mark included: a grant is read before its route is known.
    expect(grant({ url: "/mcp/github", allow: "private" })).toBeNull();
  });

  test("without the private mark a deny list is not read", () => {
    // An API from before the mark sends neither; one that sent only the
    // list would get what it gets today.
    for (const allow of [
      undefined,
      "public_https",
      "PRIVATE",
      "private_http",
      true,
    ]) {
      const parsed = grant({
        url: "http://inside.test:4000/v1",
        deny: ["db:5432"],
        ...(allow === undefined ? {} : { allow }),
      }) as EgressGrant;
      expect(parsed).not.toBeNull();
      expect("deny" in parsed).toBe(false);
      for (const purpose of ROUTES) {
        expect(registeredPrivate(purpose, parsed)).toBe(false);
        expect(upstreamPolicy(purpose, parsed, operator)).toBe(operator);
      }
    }
  });

  test("a marked model endpoint or MCP server gets a policy of its own host:port, private only", () => {
    for (const purpose of ROUTES) {
      const named = marked("http://Model.Internal.:4000/v1");
      expect(registeredPrivate(purpose, named)).toBe(true);
      expect(upstreamPolicy(purpose, named, operator)).toEqual({
        allow: [],
        allowPrivate: [{ host: "model.internal", port: 4000 }],
      });
    }
    // The scheme's port when the grant names none; plain http and https alike.
    expect(
      upstreamPolicy("provider", marked("http://10.0.0.5/v1"), operator),
    ).toEqual({ allow: [], allowPrivate: [{ host: "10.0.0.5", port: 80 }] });
    expect(
      upstreamPolicy("mcp", marked("https://mcp.internal/mcp"), operator),
    ).toEqual({
      allow: [],
      allowPrivate: [{ host: "mcp.internal", port: 443 }],
    });
    // An operator-listed host is taken off the operator's list all the same.
    expect(
      upstreamPolicy("provider", marked("http://inside.test:4000"), operator),
    ).toEqual({
      allow: [],
      allowPrivate: [{ host: "inside.test", port: 4000 }],
    });
  });

  test("the private mark is read on no other route, nor on the built-in server", () => {
    for (const purpose of ["repository", "packages", "object_store"] as const) {
      const other = marked("http://git.internal:3000/repo");
      expect(registeredPrivate(purpose, other)).toBe(false);
      expect(upstreamPolicy(purpose, other, operator)).toBe(operator);
    }
    const builtin = marked("/mcp/github");
    expect(builtin.builtin).toBe(true);
    expect(registeredPrivate("mcp", builtin)).toBe(false);
    expect(upstreamPolicy("mcp", builtin, operator)).toBe(operator);
  });

  test("privateRefusal passes an address that is private as written, and no other", () => {
    const none = new Set<string>();
    for (const address of [
      "10.0.0.5",
      "172.16.0.1",
      "192.168.1.20",
      "100.64.0.1",
      "fd12:3456::1",
      "fd12:3456::1%eth0",
    ]) {
      expect([address, privateRefusal(address, none)]).toEqual([address, null]);
    }
    const kinds: Array<[string, string]> = [
      ["127.0.0.1", "loopback"],
      ["127.255.255.254", "loopback"],
      ["::1", "loopback"],
      ["::ffff:127.0.0.1", "loopback"],
      ["93.184.216.34", "public"],
      ["2606:4700:4700::1111", "public"],
      ["169.254.169.254", "metadata"],
      ["100.100.100.200", "metadata"],
      ["fd00:ec2::254", "metadata"],
      ["fd12:3456::a9fe:a9fe", "metadata"],
      ["::ffff:169.254.169.254", "metadata"],
      ["169.254.10.10", "link_local"],
      ["fe80::1", "link_local"],
      ["0.0.0.0", "unspecified"],
      ["224.0.0.251", "multicast"],
      ["240.0.0.1", "reserved"],
      ["model.internal", "null"],
    ];
    for (const [address, kind] of kinds) {
      expect(privateRefusal(address, none)).toBe(
        `${address} is ${kind}, not private`,
      );
    }
    // A private IPv4 address inside IPv6 is not the address the admin saw.
    for (const address of [
      "::ffff:10.0.0.5",
      "::ffff:a00:5",
      "64:ff9b::a00:5",
    ]) {
      expect(privateRefusal(address, none)).toBe(
        `${address} carries an IPv4 address, and is not private as written`,
      );
    }
  });

  test("privateRefusal refuses the installation's own address in any spelling", () => {
    const own = new Set(["10.0.0.7", "fd00::7"]);
    for (const address of [
      "10.0.0.7",
      "fd00::7",
      "fd00:0:0:0:0:0:0:7",
      "FD00::7",
      "fd00::7%eth0",
    ]) {
      expect(privateRefusal(address, own)).toBe(
        `${address} is the installation's own`,
      );
    }
    expect(privateRefusal("10.0.0.8", own)).toBeNull();
  });

  test("installationHosts holds the grant's hosts, the authorizer and the addresses given, each in one spelling", () => {
    const hosts = installationHosts(["db", "10.0.0.7"], "api", [
      "172.20.0.4",
      "fd00:0:0:0:0:0:0:4",
      "fe80::1%eth0",
      "::ffff:172.20.0.3",
      "not-an-address",
    ]);
    expect([...hosts].sort()).toEqual(
      [
        "db",
        "10.0.0.7",
        "api",
        "172.20.0.4",
        "fd00::4",
        "fe80::1",
        "172.20.0.3",
      ].sort(),
    );
    // An authorizer that answers on an IPv4-mapped address is the IPv4
    // address an upstream would be dialled at, and the other way round.
    expect(privateRefusal("172.20.0.3", hosts)).toBe(
      "172.20.0.3 is the installation's own",
    );
    expect(privateRefusal("::ffff:172.20.0.4", hosts)).toBe(
      "::ffff:172.20.0.4 is the installation's own",
    );
    expect([...installationHosts([], "172.20.0.3", [])]).toEqual([
      "172.20.0.3",
    ]);
  });

  test("addressKeys keeps the addresses among a resolver's answers, in one spelling", () => {
    expect(
      addressKeys([
        "10.0.0.7",
        "::ffff:10.0.0.8",
        "FD00:0:0:0:0:0:0:9",
        "fe80::1%eth0",
        "not-an-address",
        "",
      ]),
    ).toEqual(["10.0.0.7", "10.0.0.8", "fd00::9", "fe80::1"]);
    expect(addressKeys(["not-an-address"])).toEqual([]);
  });

  test("addressMemory keeps what a name resolved to until it is that old, and no more than it may hold", () => {
    let now = 1_000;
    const seen = addressMemory(300, 2, () => now);
    expect(seen(["10.0.0.7"])).toEqual(["10.0.0.7"]);
    now += 200;
    // The name moved: the address it had is still remembered for a while.
    expect(seen(["10.0.0.8"])?.sort()).toEqual(["10.0.0.7", "10.0.0.8"]);
    // More than it may hold is not kept, and is no answer for as long as
    // the address left out would have been remembered: no set with a hole.
    expect(seen(["10.0.0.9"])).toBeNull();
    now += 299;
    expect(seen(["10.0.0.9"])).toBeNull();
    // Gone at exactly its age, not after it: .8 and the one left out.
    now += 1;
    expect(seen(["10.0.0.9"])).toEqual(["10.0.0.9"]);
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

/** What the proxy sends the exchange ledger. */
type LedgerRequest = {
  op: "open" | "renew" | "release";
  exchange_id: string;
  session_id?: string;
  attempt_id?: string;
  reserve?: Record<string, unknown>;
  /** The x-werft-exchange-call header, when sent. */
  call?: string;
};

type UsageReport = {
  exchange_id: string;
  session_id: string;
  attempt_id: string;
  judgment_id?: string;
  conversation_call_id?: string;
  usage: Record<string, unknown>;
};

describe("decidedWithin", () => {
  const undecided: Authorized = { kind: "undecided" };
  const granted: Authorized = { kind: "granted", grant: {} as EgressGrant };
  const hold = { ms: 20_000, backoffMs: [1_000, 2_000, 4_000] };
  /** A clock only the waits and the asks move. */
  function clocked(ended = false) {
    let now = 0;
    return {
      at: () => now,
      pass: (ms: number) => {
        now += ms;
      },
      clock: {
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
        ended: () => ended,
      },
    };
  }

  test("asks after 1, 2 and then every 4 seconds, each ask given only what is left, and is undecided once the hold is spent", async () => {
    const time = clocked();
    const asks: Array<{ at: number; within: number }> = [];
    const result = await decidedWithin(
      async (within) => {
        asks.push({ at: time.at(), within });
        return undecided;
      },
      hold,
      time.clock,
    );
    expect(result).toEqual(undecided);
    expect(asks.map((ask) => ask.at)).toEqual([
      1_000, 3_000, 7_000, 11_000, 15_000, 19_000,
    ]);
    expect(asks.at(-1)?.within).toBe(1_000);
    expect(time.at()).toBe(20_000);
  });

  test("a grant inside the hold is taken at once", async () => {
    const time = clocked();
    const answers = [undecided, granted];
    const result = await decidedWithin(
      async () => answers.shift() ?? undecided,
      hold,
      time.clock,
    );
    expect(result).toBe(granted);
    expect(time.at()).toBe(3_000);
  });

  test("a grant that is in hand only after the hold ended is not taken", async () => {
    const time = clocked();
    const result = await decidedWithin(
      async () => {
        if (time.at() < 19_000) return undecided;
        // Answered at 19,999 ms; read and checked by 20,001 ms.
        time.pass(1_001);
        return granted;
      },
      hold,
      time.clock,
    );
    expect(result).toEqual(undecided);
  });

  test("a refusal is an answer whenever it comes; an ask the hold's end cut short is not", async () => {
    const late = (answer: Authorized) => {
      const time = clocked();
      return decidedWithin(
        async () => {
          if (time.at() < 19_000) return undecided;
          time.pass(1_001);
          return answer;
        },
        hold,
        time.clock,
      );
    };
    const refusal: Authorized = { kind: "refused", status: 403 };
    expect(await late(refusal)).toBe(refusal);
    expect(await late({ kind: "refused", status: 503 })).toEqual(undecided);
  });

  test("an authorizer that stops answering inside the hold is not asked again", async () => {
    const time = clocked();
    const silent: Authorized = { kind: "refused", status: 503 };
    let asked = 0;
    const result = await decidedWithin(
      async () => {
        asked += 1;
        return silent;
      },
      hold,
      time.clock,
    );
    expect(result).toBe(silent);
    expect(asked).toBe(1);
  });

  test("nothing is asked once the exchange has ended", async () => {
    let asked = 0;
    const result = await decidedWithin(
      async () => {
        asked += 1;
        return granted;
      },
      hold,
      clocked(true).clock,
    );
    expect(result).toEqual(undecided);
    expect(asked).toBe(0);
  });
});

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
    answer: (body: {
      token: string;
      purpose: string;
    }) => Response | Promise<Response>,
    usageAnswer: () => Response = () => Response.json({}),
    ledgerAnswer: () => Response | Promise<Response> = () =>
      Response.json({ state: "open" }, { status: 201 }),
  ): {
    url: string;
    asked: Array<{ token: string; purpose: string; path?: string }>;
    /** Each authorize's x-werft-exchange-id header, null when not sent. */
    exchanges: Array<string | null>;
    /** Each authorize's x-werft-egress-features header, null when not sent. */
    features: Array<string | null>;
    reported: UsageReport[];
    ledgered: LedgerRequest[];
  } {
    const asked: Array<{ token: string; purpose: string; path?: string }> = [];
    const exchanges: Array<string | null> = [];
    const features: Array<string | null> = [];
    const reported: UsageReport[] = [];
    const ledgered: LedgerRequest[] = [];
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
        if (new URL(request.url).pathname === "/exchanges") {
          const call = request.headers.get("x-werft-exchange-call");
          ledgered.push({
            ...((await request.json()) as LedgerRequest),
            ...(call === null ? {} : { call }),
          });
          return ledgerAnswer();
        }
        const body = (await request.json()) as {
          token: string;
          purpose: string;
        };
        asked.push(body);
        exchanges.push(request.headers.get("x-werft-exchange-id"));
        features.push(request.headers.get("x-werft-egress-features"));
        return answer(body);
      },
    });
    servers.push(server);
    return {
      url: `http://127.0.0.1:${server.port}`,
      asked,
      exchanges,
      features,
      reported,
      ledgered,
    };
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

  test("a grant with request limits passes only its path, model and output cap", async () => {
    const up = upstream(() => Response.json({ id: "msg_1" }));
    const withPort = authorizer((body) =>
      body.token === WORKER_TOKEN
        ? Response.json({
            session_id: "sess-1",
            attempt_id: "att-1",
            upstream: {
              url: `http://upstream.test:${up.port}/base`,
              headers: [["x-api-key", PROVIDER_KEY]],
            },
            request_limits: {
              path: "/v1/messages",
              model: "m-title",
              max_tokens: 64,
            },
          })
        : new Response("unknown", { status: 401 }),
    );
    const server = proxy(withPort.url, up.port);
    const status = async (path: string, body: string) =>
      (await messages(server.port, { path, body })).status;
    const title = '{"model":"m-title","max_tokens":64,"messages":[]}';
    expect(await status("/provider/v1/messages", title)).toBe(200);
    for (const [path, body] of [
      ["/provider/v1/messages", '{"model":"m-other","max_tokens":64}'],
      ["/provider/v1/messages", '{"model":"m-title","max_tokens":65}'],
      ["/provider/v1/messages", '{"model":"m-title"}'],
      ["/provider/v1/messages", '{"model":"m-title","max_tokens":"64"}'],
      ["/provider/v1/messages", "[]"],
      ["/provider/v1/messages", "not json"],
      ["/provider/v1/messages?beta=true", title],
      ["/provider/v1/messages/count_tokens", title],
    ] as const) {
      expect({ path, body, status: await status(path, body) }).toEqual({
        path,
        body,
        status: 403,
      });
    }
    expect(up.seen).toHaveLength(1);
    // The one call it covers is a title's: its open says so, to be charged
    // to no turn's account; nothing else the proxy sends carries it.
    expect(withPort.ledgered.map((sent) => [sent.op, sent.call])).toEqual([
      ["open", "title"],
    ]);
  });

  test("a conversation call's grant: one exchange, its limits and body size, no ledger, its use reported to the call", async () => {
    const up = upstream(() =>
      Response.json({
        id: "msg_1",
        model: "m-call",
        usage: { input_tokens: 9, output_tokens: 3 },
      }),
    );
    const auth = authorizer((body) =>
      body.token === WORKER_TOKEN
        ? Response.json({
            conversation_call_id: "call-1",
            upstream: {
              url: `http://upstream.test:${up.port}/base`,
              headers: [["x-api-key", PROVIDER_KEY]],
            },
            request_limits: {
              path: "/v1/messages",
              model: "m-call",
              max_tokens: 64,
              max_request_bytes: 80,
            },
          })
        : new Response("unknown", { status: 401 }),
    );
    const server = proxy(auth.url, up.port);
    const status = async (body: string) =>
      (await messages(server.port, { path: "/provider/v1/messages", body }))
        .status;
    const fits = '{"model":"m-call","max_tokens":64,"messages":[]}';
    expect(await status(fits)).toBe(200);
    await until(() => auth.reported.length === 1);
    for (const body of [
      // Over the bytes the call's reservation was priced at.
      `{"model":"m-call","max_tokens":64,"messages":[],"pad":"${"x".repeat(40)}"}`,
      '{"model":"m-other","max_tokens":64}',
      '{"model":"m-call","max_tokens":65}',
    ]) {
      expect({ body, status: await status(body) }).toEqual({
        body,
        status: 403,
      });
    }
    expect(up.seen).toHaveLength(1);
    // Every authorize named its exchange; none of them repeat one.
    const { exchanges } = auth;
    expect(exchanges.every((id) => typeof id === "string")).toBe(true);
    expect(new Set(exchanges).size).toBe(exchanges.length);
    // Its account was held when the token was issued: no ledger open.
    expect(auth.ledgered).toEqual([]);
    expect(auth.reported).toHaveLength(1);
    const [report] = auth.reported;
    expect(report?.conversation_call_id).toBe("call-1");
    expect(report?.exchange_id).toBe(exchanges[0] as string);
    expect(report?.session_id).toBeUndefined();
    expect(report?.usage).toMatchObject({ input_tokens: 9, output_tokens: 3 });
  });

  test("a conversation call the provider answered with an error is reported unbilled before its caller hears", async () => {
    const up = upstream(() =>
      Response.json(
        { type: "error", error: { type: "api_error", message: "boom" } },
        { status: 500 },
      ),
    );
    const auth = authorizer(() =>
      Response.json({
        conversation_call_id: "call-1",
        upstream: {
          url: `http://upstream.test:${up.port}/base`,
          headers: [["x-api-key", PROVIDER_KEY]],
        },
        request_limits: {
          path: "/v1/messages",
          model: "m-call",
          max_tokens: 64,
          max_request_bytes: 80,
        },
      }),
    );
    const server = proxy(auth.url, up.port);
    const response = await messages(server.port, {
      path: "/provider/v1/messages",
      body: '{"model":"m-call","max_tokens":64,"messages":[]}',
    });
    expect(response.status).toBe(500);
    // Settled at nothing already, so a retry finds the call's place free.
    expect(auth.reported).toHaveLength(1);
    const [report] = auth.reported;
    expect(report?.conversation_call_id).toBe("call-1");
    expect(report?.exchange_id).toBe(auth.exchanges[0] as string);
    expect(report?.usage).toMatchObject({
      model: "m-call",
      input_tokens: 0,
      output_tokens: 0,
      estimated: false,
    });
  });

  test("a conversation call's grant takes the engine's ?beta=true, which a title's does not", async () => {
    const up = upstream(() =>
      Response.json({
        id: "msg_1",
        model: "m-call",
        usage: { input_tokens: 9, output_tokens: 3 },
      }),
    );
    const auth = authorizer(() =>
      Response.json({
        conversation_call_id: "call-1",
        upstream: {
          url: `http://upstream.test:${up.port}/base`,
          headers: [["x-api-key", PROVIDER_KEY]],
        },
        request_limits: {
          path: "/v1/messages",
          model: "m-call",
          max_tokens: 64,
          max_request_bytes: 80,
        },
      }),
    );
    const server = proxy(auth.url, up.port);
    const sent = (body: string) =>
      messages(server.port, { path: "/provider/v1/messages?beta=true", body });
    expect(
      (await sent('{"model":"m-call","max_tokens":64,"messages":[]}')).status,
    ).toBe(200);
    expect(new URL(up.seen[0]?.url ?? "").search).toBe("?beta=true");
    // Its limits hold on that request as on any other.
    expect((await sent('{"model":"m-call","max_tokens":65}')).status).toBe(403);
    expect(up.seen).toHaveLength(1);
  });

  test("a conversation call's grant is refused on any route but the provider's", async () => {
    const auth = authorizer(() =>
      Response.json({
        conversation_call_id: "call-1",
        upstream: { url: "https://upstream.test", headers: [] },
        request_limits: {
          path: "/v1/messages",
          model: "m-call",
          max_tokens: 64,
          max_request_bytes: 80,
        },
      }),
    );
    const server = proxy(auth.url, 1);
    const response = await fetch(
      `http://127.0.0.1:${server.port}/repository/app/info/refs?service=git-upload-pack`,
      { headers: { authorization: `Bearer ${WORKER_TOKEN}` } },
    );
    expect(response.status).toBe(503);
    // A repository's authorize names no exchange.
    expect(auth.exchanges).toEqual([null]);
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

    test("a part or tool six levels down is read, one seven levels down is refused unread", async () => {
      const up = upstream(() => Response.json({ id: "resp_1" }));
      const auth = authorizer(bearerKey(up));
      const server = proxy(auth.url, up.port);
      // `leaf` at `depth` below the top-level array, which is depth 0: the
      // array's item is depth 1 and each hop goes one deeper, through the
      // `key` property or, with no key, through one more array.
      const nested = (
        key: string | null,
        leaf: unknown,
        depth: number,
      ): unknown[] => {
        let value = leaf;
        for (let hop = 1; hop < depth; hop += 1) {
          value = key === null ? [value] : { [key]: value };
        }
        return [value];
      };
      const text = { type: "input_text", text: "hi" };
      const remote = { type: "input_file", file_id: "file_1" };
      const local = { type: "function", name: "f" };
      const outside = { type: "web_search" };
      const REMOTE = "a file or image the request only names";
      const TOOL = "a tool the upstream runs on a host";
      const INPUT_TOOL = "a tool or generated image the upstream keeps";
      // "ok", or the reason the proxy gave for refusing.
      const answer = async (request: Record<string, unknown>) => {
        const response = await responses(server.port, {
          body: JSON.stringify({ model: "gpt-5.5", ...request }),
        });
        return response.status === 200
          ? "ok"
          : `${response.status} ${await response.text()}`;
      };

      // Each walk the checks make: a harmless value at depth six passes, a
      // harmful one there is read and refused, a harmless one at seven is
      // refused unread, for the same reason.
      const walks: [string, string | null, unknown, unknown, string][] = [
        ["input", "content", text, remote, REMOTE],
        ["input", "output", text, remote, REMOTE],
        ["input", null, text, remote, REMOTE],
        ["tools", "tools", local, outside, TOOL],
        ["tools", null, local, outside, TOOL],
        ["input", "tools", local, outside, INPUT_TOOL],
      ];
      for (const [field, key, harmless, harmful, reason] of walks) {
        const at = `${field} through ${key ?? "arrays"}`;
        expect([
          at,
          await answer({ [field]: nested(key, harmless, 6) }),
        ]).toEqual([at, "ok"]);
        expect(await answer({ [field]: nested(key, harmful, 6) })).toStartWith(
          `400 ${reason}`,
        );
        expect(await answer({ [field]: nested(key, harmless, 7) })).toStartWith(
          `400 ${reason}`,
        );
      }

      // Only the ones read at depth six and found harmless went upstream.
      expect(up.seen).toHaveLength(walks.length);
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

    test("waits for the exchange ledger to open the call before calling the upstream, under the id its report carries", async () => {
      const up = upstream(() =>
        Response.json({
          id: "resp_1",
          model: "gpt-5.5",
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
      // Answered slowly: a proxy that did not wait would have gone upstream.
      let seenAtOpen = -1;
      const auth = authorizer(bearerKey(up), undefined, async () => {
        await Bun.sleep(200);
        seenAtOpen = up.seen.length;
        return Response.json({ state: "open" }, { status: 201 });
      });
      const server = proxy(auth.url, up.port);
      const body = '{"model":"gpt-5.5","stream":false}';
      expect((await responses(server.port, { body })).status).toBe(200);
      expect(seenAtOpen).toBe(0);
      expect(up.seen).toHaveLength(1);
      await until(() => auth.reported.length === 1);
      expect(auth.ledgered).toEqual([
        {
          op: "open",
          exchange_id: auth.reported[0]?.exchange_id ?? "",
          session_id: "sess-1",
          attempt_id: "att-1",
          reserve: expect.objectContaining({
            model: "gpt-5.5",
            input_tokens: body.length,
            output_tokens: 32_768,
            estimated: true,
          }),
        },
      ]);
      // The ledger has a route of its own: the authorizer was asked once.
      expect(auth.asked).toHaveLength(1);
    });

    test("a call the ledger does not open is answered 503, never sent, and released", async () => {
      for (const ledgerAnswer of [
        // An API from before the ledger.
        () => Response.json({ code: "NOT_FOUND" }, { status: 404 }),
        () => new Response("down", { status: 503 }),
        () => Response.json({ state: "settled" }),
        () => Response.json({ state: "released" }),
        () => Response.json({ code: "CONFLICT" }, { status: 409 }),
        () => Response.json({ code: "FORBIDDEN" }, { status: 403 }),
        () => new Response("not json"),
      ]) {
        const up = upstream(() => Response.json({ id: "resp_1" }));
        const auth = authorizer(bearerKey(up), undefined, ledgerAnswer);
        const server = proxy(auth.url, up.port);
        const answered = await responses(server.port);
        expect(answered.status).toBe(503);
        await answered.body?.cancel();
        // The API may have opened it and lost only its answer.
        await until(() => auth.ledgered.length === 2);
        const [open, release] = auth.ledgered;
        expect(open?.op).toBe("open");
        expect(release).toEqual({ ...open, op: "release" } as LedgerRequest);
        expect(up.seen).toEqual([]);
        expect(auth.reported).toEqual([]);
      }
    }, 20_000);

    test("a call the ledger refuses for its session's budget is answered in the Responses error shape, never sent nor released", async () => {
      const up = upstream(() => Response.json({ id: "resp_1" }));
      const auth = authorizer(bearerKey(up), undefined, () =>
        Response.json(
          { code: "BUDGET_EXCEEDED", message: "limit reached" },
          { status: 403 },
        ),
      );
      const server = proxy(auth.url, up.port);
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
      await Bun.sleep(100);
      expect(auth.ledgered.map((one) => one.op)).toEqual(["open"]);
      expect(up.seen).toEqual([]);
    });

    test("a call that ends while its open waits is released, never sent", async () => {
      const up = upstream(() => Response.json({ id: "resp_1" }));
      const auth = authorizer(
        bearerKey(up),
        undefined,
        () => new Promise<Response>(() => {}),
      );
      const cut = new AbortController();
      const server = proxy(auth.url, up.port, {
        exchangeDeadline: () => cut.signal,
      });
      const answering = responses(server.port);
      await until(() => auth.ledgered.length === 1);
      cut.abort(new Error("exchange deadline"));
      await (await answering).body?.cancel();
      await until(() => auth.ledgered.length === 2);
      const [open, release] = auth.ledgered;
      expect(release).toEqual({ ...open, op: "release" } as LedgerRequest);
      expect(up.seen).toEqual([]);
    });

    test("a call the upstream answers with an error is released, and one it answers is not", async () => {
      for (const [status, ops] of [
        [429, ["open", "release"]],
        [500, ["open", "release"]],
        [200, ["open"]],
      ] as const) {
        const up = upstream(() =>
          Response.json(
            {
              id: "resp_1",
              model: "gpt-5.5",
              usage: { input_tokens: 1, output_tokens: 1 },
            },
            { status },
          ),
        );
        const auth = authorizer(bearerKey(up));
        const server = proxy(auth.url, up.port);
        const answered = await responses(server.port);
        expect(answered.status).toBe(status);
        await answered.text();
        await until(() => auth.ledgered.length === ops.length);
        await Bun.sleep(100);
        expect({ status, ops: auth.ledgered.map((one) => one.op) }).toEqual({
          status,
          ops: [...ops],
        });
      }
    }, 20_000);

    test("a call whose upstream refused the connection or failed its certificate is released", async () => {
      const closed = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(),
      });
      const closedPort = closed.port ?? 0;
      closed.stop(true);
      const tls = upstream(() => Response.json({ id: "resp_1" }), certificate);
      for (const [url, port] of [
        [`http://upstream.test:${closedPort}`, closedPort],
        // No upstreamCa: its certificate is from no trusted root.
        [`https://upstream.test:${tls.port}`, tls.port],
      ] as const) {
        const auth = authorizer(
          granting(url, [["authorization", `Bearer ${OPENAI_KEY}`]]),
        );
        const server = proxy(auth.url, port);
        expect((await responses(server.port)).status).toBe(502);
        await until(() => auth.ledgered.length === 2);
        expect(auth.ledgered.map((one) => one.op)).toEqual(["open", "release"]);
      }
      expect(tls.seen).toEqual([]);
    }, 20_000);

    test("a call cut once its request reached the upstream keeps its reservation", async () => {
      const up = upstream(() => new Promise<Response>(() => {}));
      const auth = authorizer(bearerKey(up));
      const cut = new AbortController();
      const server = proxy(auth.url, up.port, {
        exchangeDeadline: () => cut.signal,
      });
      const answering = responses(server.port);
      await until(() => up.seen.length === 1);
      cut.abort(new Error("exchange deadline"));
      await (await answering).body?.cancel();
      await Bun.sleep(150);
      expect(auth.ledgered.map((one) => one.op)).toEqual(["open"]);
    });

    test("an open call is renewed in the ledger beside each regrant, and not once it has ended", async () => {
      const up = upstream(
        () =>
          new Response(
            new ReadableStream({
              async start(controller) {
                controller.enqueue(new TextEncoder().encode('{"id":"resp_1",'));
                await Bun.sleep(250);
                controller.enqueue(
                  new TextEncoder().encode(
                    '"model":"gpt-5.5","usage":{"input_tokens":1,"output_tokens":1}}',
                  ),
                );
                controller.close();
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      );
      const auth = authorizer(bearerKey(up));
      const server = proxy(auth.url, up.port, { regrantIntervalMs: 20 });
      await (await responses(server.port)).text();
      await until(() => auth.reported.length === 1);
      const [open, ...rest] = auth.ledgered;
      expect(open?.op).toBe("open");
      expect(rest.length).toBeGreaterThan(0);
      expect(rest).toEqual(
        rest.map(() => ({ op: "renew", exchange_id: open?.exchange_id ?? "" })),
      );
      // The regrant before each renewal is the authorizer's.
      expect(auth.asked.length).toBeGreaterThan(rest.length);
      const after = auth.ledgered.length;
      await Bun.sleep(150);
      expect(auth.ledgered).toHaveLength(after);
    }, 20_000);

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

    test("a Messages call is opened in the ledger and count_tokens is not", async () => {
      const up = upstream((request) =>
        new URL(request.url).pathname.endsWith("/count_tokens")
          ? Response.json({ input_tokens: 12 })
          : Response.json({ id: "msg_1" }),
      );
      const auth = authorizer(provider(up));
      const server = proxy(auth.url, up.port);
      await (
        await messages(server.port, {
          path: "/provider/v1/messages/count_tokens",
        })
      ).text();
      await Bun.sleep(100);
      expect(auth.ledgered).toEqual([]);
      const body = '{"model":"claude-sonnet-4-5","max_tokens":64}';
      await (await messages(server.port, { body })).text();
      await until(() => auth.reported.length === 1);
      expect(auth.ledgered).toEqual([
        {
          op: "open",
          exchange_id: auth.reported[0]?.exchange_id ?? "",
          session_id: auth.reported[0]?.session_id ?? "",
          attempt_id: auth.reported[0]?.attempt_id ?? "",
          reserve: expect.objectContaining({
            model: "claude-sonnet-4-5",
            input_tokens: body.length,
            output_tokens: 64,
            estimated: true,
          }),
        },
      ]);
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

    test("a call whose report was given up on stays in the ledger, and the proxy leaves the session's next call to it", async () => {
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
      // Not released: its row goes on counting at the session's next open.
      expect(auth.ledgered.map((one) => one.op)).toEqual(["open"]);

      const next = await messages(server.port);
      expect(next.status).toBe(200);
      await next.text();
      expect(auth.ledgered.filter((one) => one.op === "open")).toHaveLength(2);
      expect(up.seen).toHaveLength(2);
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

  describe("an authorizer whose store cannot be read", () => {
    const undecided = () =>
      Response.json(
        {
          code: "BACKEND_UNAVAILABLE",
          message: "Authorization unavailable",
          retryable: true,
        },
        { status: 503, headers: { "retry-after": "1" } },
      );
    const grant = (port: number) =>
      granting(`http://upstream.test:${port}`, [["x-api-key", PROVIDER_KEY]]);
    const quick = { ms: 2_000, backoffMs: [10] };

    test("a provider call is held and asked again, and goes upstream only once granted", async () => {
      const up = upstream(() => Response.json({ id: "msg_1" }));
      const answers = [undecided, undecided];
      const auth = authorizer(
        (body) => answers.shift()?.() ?? grant(up.port)(body),
      );
      const server = proxy(auth.url, up.port, { undecidedHold: quick });
      const response = await messages(server.port);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: "msg_1" });
      expect(auth.asked).toHaveLength(3);
      expect(up.seen).toHaveLength(1);
    });

    test("a held call is judged afresh at each ask: refused then, it is refused at once and never sent", async () => {
      const up = upstream(() => new Response("ok"));
      // The attempt lost its session while the call was held.
      const answers = [undecided, () => new Response("x", { status: 403 })];
      const auth = authorizer(
        (body) => answers.shift()?.() ?? grant(up.port)(body),
      );
      const server = proxy(auth.url, up.port, { undecidedHold: quick });
      const response = await messages(server.port);
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("egress token refused\n");
      expect(auth.asked).toHaveLength(2);
      expect(up.seen).toEqual([]);
    });

    test("undecided is never a grant: past the hold the call is answered 503 with Retry-After, and nothing was sent", async () => {
      const up = upstream(() => new Response("ok"));
      const auth = authorizer(undecided);
      const server = proxy(auth.url, up.port, {
        undecidedHold: { ms: 60, backoffMs: [10] },
      });
      const response = await messages(server.port);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.text()).toBe(
        "egress authorization unavailable; retry in a few seconds\n",
      );
      expect(auth.asked.length).toBeGreaterThan(1);
      expect(up.seen).toEqual([]);
    });

    test("a slow first answer counts towards the hold", async () => {
      const up = upstream(() => new Response("ok"));
      const auth = authorizer(async () => {
        await Bun.sleep(700);
        return undecided();
      });
      const server = proxy(auth.url, up.port, {
        undecidedHold: { ms: 1_000, backoffMs: [100] },
      });
      const started = performance.now();
      const response = await messages(server.port);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      // 1 s from the first ask; not 0.7 s of it and then a whole hold more.
      expect(performance.now() - started).toBeLessThan(1_400);
      expect(up.seen).toEqual([]);
    });

    test("no ask outlasts the hold: a grant that would come after it is not waited for, and nothing is sent", async () => {
      const up = upstream(() => new Response("ok"));
      let asks = 0;
      const slow = async (body: { token: string }) => {
        asks += 1;
        if (asks === 1) return undecided();
        await Bun.sleep(400);
        return grant(up.port)(body);
      };
      const auth = authorizer(slow as unknown as () => Response);
      const server = proxy(auth.url, up.port, {
        undecidedHold: { ms: 100, backoffMs: [10] },
      });
      const started = performance.now();
      const response = await messages(server.port);
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.text()).toBe(
        "egress authorization unavailable; retry in a few seconds\n",
      );
      expect(performance.now() - started).toBeLessThan(350);
      await Bun.sleep(400);
      expect(up.seen).toEqual([]);
    });

    test("only that answer is asked again: another 503, an error or no answer is given up on at once", async () => {
      const up = upstream(() => new Response("ok"));
      for (const answer of [
        () => Response.json({ code: "BACKEND_UNAVAILABLE" }, { status: 503 }),
        () => new Response("boom", { status: 500 }),
      ]) {
        const auth = authorizer(answer);
        const server = proxy(auth.url, up.port, { undecidedHold: quick });
        const response = await messages(server.port);
        expect(response.status).toBe(503);
        expect(response.headers.get("retry-after")).toBeNull();
        expect(await response.text()).toBe("egress token refused\n");
        expect(auth.asked).toHaveLength(1);
      }
      expect(up.seen).toEqual([]);
    });

    test("no more calls are held than the cap: the one over it is answered at once", async () => {
      const up = upstream(() => new Response("ok"));
      const auth = authorizer(undecided);
      const server = proxy(auth.url, up.port, {
        undecidedHold: { ms: 1_000, backoffMs: [900], max: 1 },
      });
      const first = messages(server.port);
      await until(() => auth.asked.length === 1);
      // Its answer is back and the hold begun before the second arrives.
      await Bun.sleep(50);
      const over = await messages(server.port);
      expect(over.status).toBe(503);
      expect(over.headers.get("retry-after")).toBe("1");
      await over.text();
      expect(auth.asked).toHaveLength(2);
      expect((await first).status).toBe(503);
      expect(up.seen).toEqual([]);
    });

    test("the object store route is not held: it answers at once what an S3 client sends again", async () => {
      const up = upstream(() => new Response("ok"));
      const auth = authorizer(undecided);
      const server = proxy(auth.url, up.port, { undecidedHold: quick });
      const response = await fetch(
        `http://127.0.0.1:${server.port}/object-store/bucket/key`,
        {
          headers: {
            authorization: `AWS4-HMAC-SHA256 Credential=${WORKER_TOKEN}/20261008/auto/s3/aws4_request, SignedHeaders=host, Signature=0`,
          },
        },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(await response.text()).toContain(
        "<Code>ServiceUnavailable</Code><Message>egress authorization unavailable; retry in a few seconds</Message>",
      );
      expect(auth.asked).toHaveLength(1);
      expect(up.seen).toEqual([]);
    });
  });

  describe("a request body that stops arriving", () => {
    const objectHead = (length = 10) => [
      "PUT /object-store/bucket/key HTTP/1.1",
      "host: 127.0.0.1",
      `authorization: AWS4-HMAC-SHA256 Credential=${WORKER_TOKEN}/20261008/auto/s3/aws4_request, SignedHeaders=host, Signature=0`,
      `content-length: ${length}`,
    ];
    const OBJECT_HEAD = objectHead();

    /**
     * What an S3 was sent before it answered anything, and whether the proxy
     * hung up. `deaf` reads nothing until `hear()`.
     */
    async function rawUpstream({
      answerAt,
      deaf = false,
    }: {
      answerAt?: number;
      deaf?: boolean;
    } = {}) {
      const sockets: Socket[] = [];
      const listen = (socket: Socket) =>
        socket.on("data", (chunk) => {
          state.received += chunk.toString("latin1");
          const head = state.received.indexOf("\r\n\r\n");
          if (
            answerAt !== undefined &&
            head >= 0 &&
            state.received.length - head - 4 >= answerAt
          ) {
            socket.end(
              "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
            );
          }
        });
      const state = {
        received: "",
        closed: false,
        hear() {
          for (const socket of sockets) listen(socket);
        },
      };
      const server = createServer((socket) => {
        sockets.push(socket);
        // With no reader the socket takes in a buffer's worth and no more.
        if (!deaf) listen(socket);
        socket.on("error", () => {});
        socket.on("close", () => {
          state.closed = true;
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      servers.push({
        stop() {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
      const { port } = server.address() as { port: number };
      return { port, state };
    }

    function granted(port: number, length = 10) {
      return Response.json({
        session_id: "sess-1",
        attempt_id: "att-1",
        upstream: {
          url: `http://upstream.test:${port}`,
          target: "/bucket/key",
          headers: [["content-length", String(length)]],
        },
      });
    }

    /** One request written by hand, so its body stops where a test says. */
    function raw(
      port: number,
      head: string[],
      send?: (socket: Socket) => unknown,
    ): Promise<{ answer: string; ms: number }> {
      const startedAt = performance.now();
      return new Promise((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port });
        let answer = "";
        socket.on("connect", () => {
          socket.write(`${head.join("\r\n")}\r\n\r\n`);
          void send?.(socket);
        });
        socket.on("data", (chunk) => {
          answer += chunk.toString("latin1");
          const end = answer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const length = Number(
            /content-length: (\d+)/i.exec(answer)?.[1] ?? 0,
          );
          if (answer.length - end - 4 < length) return;
          resolve({ answer, ms: performance.now() - startedAt });
          socket.destroy();
        });
        socket.on("error", reject);
        socket.on("close", () => reject(new Error("closed with no answer")));
      });
    }

    test("an object upload that stops half way is answered 503 with Retry-After within the hold, and its upstream is hung up on", async () => {
      const up = await rawUpstream();
      const auth = authorizer(() => granted(up.port));
      const server = proxy(auth.url, up.port, { undecidedHold: { ms: 400 } });
      const { answer, ms } = await raw(server.port, OBJECT_HEAD, (socket) =>
        socket.write("1234"),
      );
      expect(answer).toStartWith("HTTP/1.1 503");
      expect(answer.toLowerCase()).toContain("retry-after: 1\r\n");
      expect(answer).toContain(
        "<Code>ServiceUnavailable</Code><Message>request body stalled; retry in a few seconds</Message>",
      );
      // The rest of the body is still owed on this connection.
      expect(answer.toLowerCase()).toContain("connection: close\r\n");
      // The hold, counted from the last byte; never the upstream's patience.
      expect(ms).toBeGreaterThanOrEqual(350);
      expect(ms).toBeLessThan(3_000);
      // Granted, so the signed request went up: its head and what had come.
      expect(up.state.received).toContain("PUT /bucket/key HTTP/1.1");
      expect(up.state.received).toEndWith("\r\n\r\n1234");
      await until(() => up.state.closed);
    });

    test("the first byte is due within the hold of the request's arrival, whatever the authorizer took of it", async () => {
      const up = await rawUpstream();
      const auth = authorizer(async () => {
        await Bun.sleep(700);
        return granted(up.port);
      });
      const server = proxy(auth.url, up.port, {
        undecidedHold: { ms: 1_000 },
      });
      const { answer, ms } = await raw(server.port, OBJECT_HEAD);
      expect(answer).toStartWith("HTTP/1.1 503");
      expect(answer.toLowerCase()).toContain("retry-after: 1\r\n");
      // 1 s after the request, not 1 s after the 700 ms grant.
      expect(ms).toBeGreaterThanOrEqual(950);
      expect(ms).toBeLessThan(1_600);
      await until(() => up.state.closed);
    });

    test("bytes already in hand when the grant comes do not start the clock again", async () => {
      const up = await rawUpstream();
      const auth = authorizer(async () => {
        await Bun.sleep(700);
        return granted(up.port);
      });
      const server = proxy(auth.url, up.port, {
        undecidedHold: { ms: 1_000 },
      });
      const { answer, ms } = await raw(server.port, OBJECT_HEAD, (socket) =>
        socket.write("1234"),
      );
      expect(answer).toStartWith("HTTP/1.1 503");
      expect(answer).toContain("request body stalled");
      // 1 s after the four bytes, which came with the request: not 1 s
      // after the grant handed them on.
      expect(ms).toBeGreaterThanOrEqual(950);
      expect(ms).toBeLessThan(1_500);
      await until(() => up.state.closed);
    });

    test("a name that is slow to look up does not hide a body that is not coming", async () => {
      const up = await rawUpstream();
      const auth = authorizer(() => granted(up.port));
      const server = proxy(auth.url, up.port, {
        undecidedHold: { ms: 300 },
        resolve: async (host) => {
          await Bun.sleep(2_000);
          return host === "upstream.test" ? ["127.0.0.1"] : [];
        },
      });
      const { answer, ms } = await raw(server.port, OBJECT_HEAD);
      expect(answer).toStartWith("HTTP/1.1 503");
      expect(answer).toContain("request body stalled");
      expect(ms).toBeGreaterThanOrEqual(250);
      expect(ms).toBeLessThan(1_500);
      // Nothing was dialled: the lookup had not answered.
      expect(up.state.received).toBe("");
    });

    test("an upload that keeps arriving is not cut, however long it takes", async () => {
      const up = await rawUpstream({ answerAt: 10 });
      const auth = authorizer(() => granted(up.port));
      const server = proxy(auth.url, up.port, { undecidedHold: { ms: 400 } });
      const { answer, ms } = await raw(
        server.port,
        OBJECT_HEAD,
        async (socket) => {
          for (const byte of "0123456789") {
            socket.write(byte);
            await Bun.sleep(100);
          }
        },
      );
      expect(answer).toStartWith("HTTP/1.1 200");
      expect(ms).toBeGreaterThan(800);
      expect(up.state.received).toEndWith("\r\n\r\n0123456789");
    });

    test("an upload that stops half way is cut even while the upstream has stopped reading it", async () => {
      // Far more than a socket pair holds, so the proxy's write upstream
      // stops draining long before the worker's half is through.
      const length = 256 * 1024 * 1024;
      const up = await rawUpstream({ deaf: true });
      const auth = authorizer(() => granted(up.port, length));
      const server = proxy(auth.url, up.port, { undecidedHold: { ms: 400 } });
      const { answer, ms } = await raw(
        server.port,
        objectHead(length),
        (socket) => socket.write(Buffer.alloc(length / 4, 7)),
      );
      expect(answer).toStartWith("HTTP/1.1 503");
      expect(answer.toLowerCase()).toContain("retry-after: 1\r\n");
      expect(answer).toContain("request body stalled");
      expect(ms).toBeLessThan(10_000);
      // Deaf: nothing of it was read, so the proxy's write never drained.
      expect(up.state.received).toBe("");
      up.state.hear();
      await until(() => up.state.closed, 10_000);
    }, 30_000);

    test("a provider call whose body never arrives is not held past the hold by the wait for a decision", async () => {
      const up = upstream(() => Response.json({ id: "msg_1" }));
      // Each ask takes 700 ms to come back undecided: the first answer plus
      // a 1 s hold would end at 1.7 s.
      const auth = authorizer(async () => {
        await Bun.sleep(700);
        return Response.json(
          { code: "BACKEND_UNAVAILABLE", message: "no", retryable: true },
          { status: 503, headers: { "retry-after": "1" } },
        );
      });
      const server = proxy(auth.url, up.port, {
        undecidedHold: { ms: 1_000, backoffMs: [200] },
      });
      const { answer, ms } = await raw(server.port, [
        "POST /provider/v1/messages?beta=true HTTP/1.1",
        "host: 127.0.0.1",
        `x-api-key: ${WORKER_TOKEN}`,
        "content-length: 13",
      ]);
      expect(answer).toStartWith("HTTP/1.1 503");
      expect(answer.toLowerCase()).toContain("retry-after: 1\r\n");
      expect(answer).toContain("request body stalled");
      expect(ms).toBeGreaterThanOrEqual(950);
      expect(ms).toBeLessThan(1_500);
      expect(up.seen).toEqual([]);
    });

    test("a provider call whose body never arrives is answered the same 503, and nothing goes upstream", async () => {
      const up = upstream(() => Response.json({ id: "msg_1" }));
      const auth = authorizer(
        granting(`http://upstream.test:${up.port}`, [
          ["x-api-key", PROVIDER_KEY],
        ]),
      );
      const server = proxy(auth.url, up.port, { undecidedHold: { ms: 400 } });
      const { answer, ms } = await raw(server.port, [
        "POST /provider/v1/messages?beta=true HTTP/1.1",
        "host: 127.0.0.1",
        `x-api-key: ${WORKER_TOKEN}`,
        "content-length: 13",
      ]);
      expect(answer).toStartWith("HTTP/1.1 503");
      expect(answer.toLowerCase()).toContain("retry-after: 1\r\n");
      expect(answer).toContain("request body stalled");
      expect(ms).toBeGreaterThanOrEqual(350);
      expect(ms).toBeLessThan(3_000);
      expect(up.seen).toEqual([]);
    });
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

    test("keeps out a conversation call's body, which may echo its prompt", async () => {
      const prompt = "channel-text-the-upstream-echoes";
      const up = upstream(
        () => new Response(`refused: ${prompt}`, { status: 401 }),
      );
      const auth = authorizer(() =>
        Response.json({
          conversation_call_id: "call-1",
          upstream: {
            url: `http://upstream.test:${up.port}`,
            headers: [["x-api-key", PROVIDER_KEY]],
          },
          request_limits: {
            path: "/v1/messages",
            model: "m-call",
            max_tokens: 64,
            max_request_bytes: 1_024,
          },
        }),
      );
      const lines: string[] = [];
      const server = proxy(auth.url, up.port, {
        logger: createProxyLogger("debug", (line) => lines.push(line)),
      });
      const response = await messages(server.port, {
        path: "/provider/v1/messages",
        body: JSON.stringify({
          model: "m-call",
          max_tokens: 64,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      expect(response.status).toBe(401);
      const [record] = refusals(lines);
      expect(record?.fields).toMatchObject({
        status: 401,
        upstream_error_withheld: true,
        upstream_error_withheld_reason: "conversation_call",
      });
      expect(record?.fields).not.toHaveProperty("upstream_error");
      expect(lines.join("\n")).not.toContain(prompt);
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
      // A call that fails before the upstream sees it ends the wait too, so
      // the failure surfaces where the call is awaited, not as a timeout.
      let settled = false;
      const settle = () => {
        settled = true;
      };
      answered.then(settle, settle);
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

    /**
     * Fails naming the wait that has not ended, well inside the test's
     * timeout: each takes milliseconds, and one that stalls would otherwise
     * show only as the whole test timing out.
     */
    async function within<T>(wait: string, done: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${wait} did not end within 1500ms`)),
          1_500,
        );
      });
      try {
        return await Promise.race([done, stalled]);
      } finally {
        clearTimeout(timer);
      }
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
      // No pause between rounds: the proxy gives the slot back as the
      // exchange ends, before the upstream can see the hang-up, so `hungUp`
      // already follows the release. A leak still runs the cap of 2 out
      // within the twelve rounds.
      for (const [index, round] of [...rounds, ...rounds].entries()) {
        const at = (wait: string) =>
          `round ${index + 1} ${JSON.stringify(round)}: ${wait}`;
        if (round.head === "held") h.hold();
        const call = await within(at("open"), opened(h, server.port));
        if (round.head === "sent") await within(at("stream"), call.streaming());
        if (round.hangUp) call.hangUp();
        if (round.cut) h.end();
        if (!round.hangUp) await within(at("drain"), call.drain());
        await within(at("upstream hang-up"), h.hungUp());
        h.renew();
      }
      await within("the last call", admitted(h, server.port));
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

  test("an upstream on EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST that resolves to metadata gets no login", async () => {
    const up = upstream(() => Response.json({ id: "msg_1" }));
    const auth = authorizer(
      granting(`http://upstream.test:${up.port}`, [
        ["x-api-key", PROVIDER_KEY],
      ]),
    );
    // The policy the proxy builds from its environment today.
    const { credential } = egressProxyConfigFromEnv({
      EGRESS_ALLOWLIST: "api.anthropic.com:443",
      EGRESS_AUTHORIZER_URL: "http://api:3100",
      EGRESS_AUTHORIZER_TOKEN: "a".repeat(32),
      EGRESS_CREDENTIAL_PRIVATE_ALLOWLIST: `upstream.test:${up.port}`,
    });
    if (credential === null) throw new Error("no credential config");
    for (const address of [
      "100.100.100.200",
      "fd00:ec2::254",
      "::ffff:100.100.100.200",
      "64:ff9b::a9fe:a9fe",
    ]) {
      const server = proxy(auth.url, up.port, {
        policy: { allow: [], allowPrivate: credential.allowPrivate },
        resolve: async () => [address],
      });
      expect((await messages(server.port)).status, address).toBe(403);
    }
    expect(up.seen).toEqual([]);
  });

  test("a grant URL spelling a metadata address as one number is judged as that address", async () => {
    const up = upstream(() => Response.json({ id: "msg_1" }));
    for (const spelled of ["1684301000", "0x646464c8", "0144.0144.0144.0310"]) {
      const auth = authorizer(
        granting(`http://${spelled}:${up.port}`, [["x-api-key", PROVIDER_KEY]]),
      );
      const server = proxy(auth.url, up.port, {
        policy: {
          allow: [],
          allowPrivate: [{ host: "100.100.100.200", port: up.port }],
        },
        resolve: async (host) => [host],
      });
      const response = await messages(server.port);
      expect(response.status, spelled).toBe(403);
      expect(await response.text(), spelled).toContain(
        "100.100.100.200 is metadata",
      );
    }
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

    describe("a registered server's mark", () => {
      const REGISTERED = "registered.test";
      const grantOf = (url: string, mark: boolean) => ({
        session_id: "sess-1",
        attempt_id: "att-1",
        upstream: {
          url,
          headers: [["authorization", `Bearer ${SERVICE_ACCOUNT}`]],
          ...(mark ? { allow: "public_https" } : {}),
        },
      });
      function marked(
        answer: (body: { purpose: string }) => ReturnType<typeof grantOf>,
        resolveTo: (host: string) => Promise<string[]>,
        upstreamPort = 1,
      ) {
        const looked: string[] = [];
        const lines: string[] = [];
        const auth = authorizer((body) => Response.json(answer(body)));
        const server = proxy(auth.url, upstreamPort, {
          logger: createProxyLogger("warn", (line) => lines.push(line)),
          resolve: async (host) => {
            looked.push(host);
            return resolveTo(host);
          },
        });
        return { auth, server, looked, lines };
      }

      test("with an API that sends no mark, the operator's list decides as before", async () => {
        const up = upstream(() =>
          Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
        );
        let url = `http://upstream.test:${up.port}/mcp`;
        const { server, looked, lines } = marked(
          () => grantOf(url, false),
          async () => ["127.0.0.1"],
          up.port,
        );
        // A listed server is reached as it is today.
        expect((await call(server.port, TOOLS_CALL)).status).toBe(200);
        expect(up.seen).toHaveLength(1);
        // An unlisted one is refused before its name is even looked up.
        url = `https://${REGISTERED}/v2/mcp`;
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        expect(looked).toEqual(["upstream.test"]);
        expect(lines.join("\n")).toContain("destination is not allowlisted");
      });

      test("a marked https server off the list is judged by its addresses", async () => {
        let addresses: () => Promise<string[]> = async () => ["127.0.0.1"];
        // The trailing dot is the same host as the one it was registered as.
        const { server, looked, lines } = marked(
          () => grantOf(`https://${REGISTERED}./v2/mcp`, true),
          () => addresses(),
        );
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        expect(looked).toEqual([REGISTERED]);
        expect(lines.join("\n")).toContain("127.0.0.1 is loopback, not public");
        // One public address beside a private one is a rebinding, not a pass.
        addresses = async () => ["93.184.216.34", "10.0.0.1"];
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        expect(lines.join("\n")).toContain("10.0.0.1 is private, not public");
        // A lookup that fails, or finds nothing, is no pass either.
        addresses = async () => {
          throw new Error(`getaddrinfo ENOTFOUND ${REGISTERED}`);
        };
        expect((await call(server.port, TOOLS_CALL)).status).toBe(502);
        addresses = async () => [];
        expect((await call(server.port, TOOLS_CALL)).status).toBe(502);
        expect(looked).toEqual([
          REGISTERED,
          REGISTERED,
          REGISTERED,
          REGISTERED,
        ]);
      });

      test("a marked https server named by a public address passes the address rules, then is refused unnamed", async () => {
        const { server, looked, lines } = marked(
          () => grantOf("https://[2606:4700:4700::1111]/mcp", true),
          async (host) => [host],
        );
        const response = await call(server.port, TOOLS_CALL);
        expect(response.status).toBe(502);
        expect(await response.text()).toContain(
          "an https upstream must be named",
        );
        expect(looked).toEqual(["2606:4700:4700::1111"]);
        expect(lines.join("\n")).not.toContain("not public");
      });

      test("the mark takes a privately listed host out of the private plane", async () => {
        // A listener of the test's own, so a regression dials nothing else.
        const up = upstream(() => new Response("reached"), certificate);
        const { server, lines } = marked(
          () => grantOf(`https://upstream.test:${up.port}/mcp`, true),
          async () => ["127.0.0.1"],
          up.port,
        );
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        expect(lines.join("\n")).toContain("127.0.0.1 is loopback, not public");
        expect(up.seen).toEqual([]);
      });

      test("the mark opens the registered port of its one exchange, and nothing after it", async () => {
        let mark = true;
        const { server, looked, lines } = marked(
          () => grantOf(`https://${REGISTERED}:8443/mcp`, mark),
          async () => ["127.0.0.1"],
        );
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        // Looked up: the policy held 8443, the port the grant named.
        expect(looked).toEqual([REGISTERED]);
        mark = false;
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        expect(looked).toEqual([REGISTERED]);
        expect(lines.join("\n")).toContain("destination is not allowlisted");
      });

      test("the mark changes nothing on plain http or on another route", async () => {
        const up = upstream(() =>
          Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
        );
        const { server, looked } = marked(
          (body) =>
            body.purpose === "mcp"
              ? grantOf(`http://upstream.test:${up.port}/mcp`, true)
              : grantOf(`https://${REGISTERED}`, true),
          async () => ["127.0.0.1"],
          up.port,
        );
        // Plain http stays on the operator's list, which names it privately.
        expect((await call(server.port, TOOLS_CALL)).status).toBe(200);
        expect(up.seen).toHaveLength(1);
        // A provider grant with the mark is still refused by the list.
        expect((await messages(server.port)).status).toBe(403);
        expect(looked).toEqual(["upstream.test"]);
      });

      test("every ask says the proxy reads the mark, and the built-in server ignores it", async () => {
        const GRANT = "signed-grant-for-one-exchange";
        const features: Array<string | null> = [];
        const api = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            if (new URL(request.url).pathname === "/authorize") {
              features.push(request.headers.get("x-werft-egress-features"));
              const { purpose } = (await request.json()) as { purpose: string };
              return Response.json(
                purpose === "mcp"
                  ? {
                      session_id: "sess-1",
                      attempt_id: "att-1",
                      upstream: {
                        url: "/mcp/github",
                        headers: [["authorization", `Bearer ${GRANT}`]],
                        allow: "public_https",
                      },
                    }
                  : { error: "refused" },
                { status: purpose === "mcp" ? 200 : 403 },
              );
            }
            return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
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
        expect((await messages(server.port)).status).toBe(403);
        expect(features).toEqual([
          "registered-upstream,registered-private-upstream",
          "registered-upstream,registered-private-upstream",
        ]);
      });
    });

    describe("a registered private upstream's mark", () => {
      const INSIDE = "model.internal";
      // A private address of this machine for a test's upstream to listen
      // on: the rules under test refuse loopback, where the others listen.
      const lan = Object.values(networkInterfaces())
        .flat()
        .find(
          (entry) =>
            entry?.family === "IPv4" &&
            classifyAddress(entry.address) === "private",
        )?.address;
      const PRIVATE = { allow: "private", deny: [] as string[] };
      const grantOf = (
        url: string,
        mark: Record<string, unknown> = PRIVATE,
      ) => ({
        session_id: "sess-1",
        attempt_id: "att-1",
        upstream: {
          url,
          headers: [["authorization", `Bearer ${SERVICE_ACCOUNT}`]],
          ...mark,
        },
      });
      function marked(
        answer: (body: { purpose: string }) => Record<string, unknown>,
        resolveTo: (host: string) => Promise<string[]>,
        // No address of the machine the test runs on, unless a test says so.
        options: Partial<Parameters<typeof startCredentialProxy>[0]> = {
          selfAddresses: () => [],
        },
        listedPort = 1,
      ) {
        const looked: string[] = [];
        const lines: string[] = [];
        const auth = authorizer((body) => Response.json(answer(body)));
        const server = proxy(auth.url, listedPort, {
          logger: createProxyLogger("warn", (line) => lines.push(line)),
          resolve: async (host) => {
            looked.push(host);
            return resolveTo(host);
          },
          ...options,
        });
        return { auth, server, looked, lines };
      }
      function inside(
        answer: () => Response = () =>
          Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
        tls?: { cert: string; key: string },
      ) {
        const seen: Array<{ path: string; authorization: string | null }> = [];
        const server = Bun.serve({
          hostname: "0.0.0.0",
          port: 0,
          ...(tls === undefined ? {} : { tls }),
          fetch(request) {
            seen.push({
              path: new URL(request.url).pathname,
              authorization: request.headers.get("authorization"),
            });
            return answer();
          },
        });
        servers.push(server);
        return { port: server.port ?? 0, seen };
      }

      test("with an API that sends no mark, nothing changes: the operator's list decides", async () => {
        const up = upstream(() =>
          Response.json({ jsonrpc: "2.0", id: 1, result: {} }),
        );
        let grant = grantOf(`http://upstream.test:${up.port}/mcp`, {});
        let addresses = ["127.0.0.1"];
        const { server, looked, lines } = marked(
          () => grant,
          async () => addresses,
          {},
          up.port,
        );
        // A privately listed host still reaches loopback, as it does today.
        expect((await call(server.port, TOOLS_CALL)).status).toBe(200);
        expect((await messages(server.port)).status).toBe(200);
        expect(up.seen).toHaveLength(2);
        expect(looked).toEqual(["upstream.test", "upstream.test"]);
        // A private host off the list is refused before its name is looked up.
        grant = grantOf(`http://${INSIDE}:4000/mcp`, {});
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        expect((await messages(server.port)).status).toBe(403);
        expect(looked).toEqual(["upstream.test", "upstream.test"]);
        expect(lines.join("\n")).toContain("destination is not allowlisted");
        // A deny list alone is no mark: it does not close the listed host.
        const listed = `http://upstream.test:${up.port}/mcp`;
        grant = grantOf(listed, { deny: ["upstream.test", "127.0.0.1"] });
        expect((await call(server.port, TOOLS_CALL)).status).toBe(200);
        expect(up.seen).toHaveLength(3);
        expect(lines.join("\n")).not.toContain("installation's own");
        // With the mark the same listed host is held to the private rules,
        // which loopback does not pass. Not 127.0.0.1: the test's authorizer
        // listens there, and that is refused for being the authorizer.
        grant = grantOf(listed);
        addresses = ["127.0.0.2"];
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        expect(lines.join("\n")).toContain(
          "127.0.0.2 is loopback, not private",
        );
        // A private mark without its deny list is no grant at all.
        grant = grantOf(listed, { allow: "private" });
        expect((await call(server.port, TOOLS_CALL)).status).toBe(503);
        expect(up.seen).toHaveLength(3);
      });

      test.skipIf(lan === undefined)(
        "the mark opens a name that resolves privately, for an MCP server and a model alike",
        async () => {
          const up = inside();
          let addresses = [lan ?? ""];
          const { server, looked } = marked(
            () => grantOf(`http://${INSIDE}.:${up.port}/base`),
            async () => addresses,
            { selfAddresses: () => [] },
          );
          expect((await call(server.port, TOOLS_CALL)).status).toBe(200);
          expect((await messages(server.port)).status).toBe(200);
          expect(up.seen).toEqual([
            { path: "/base", authorization: `Bearer ${SERVICE_ACCOUNT}` },
            {
              path: "/base/v1/messages",
              authorization: `Bearer ${SERVICE_ACCOUNT}`,
            },
          ]);
          // Looked up afresh for each exchange.
          expect(looked).toEqual([INSIDE, INSIDE]);
          // And judged afresh: the answer that passed a moment ago is not kept.
          addresses = ["93.184.216.34"];
          expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
          expect(up.seen).toHaveLength(2);
        },
      );

      test.skipIf(lan === undefined)(
        "the mark opens a named https upstream, and no https address",
        async () => {
          const up = inside(undefined, certificate);
          let url = `https://upstream.test:${up.port}/mcp`;
          const { server } = marked(
            () => grantOf(url),
            async (host) => (host === "upstream.test" ? [lan ?? ""] : [host]),
            { selfAddresses: () => [], upstreamCa: certificate.cert },
          );
          expect((await call(server.port, TOOLS_CALL)).status).toBe(200);
          expect(up.seen).toHaveLength(1);
          url = "https://10.0.0.5/mcp";
          const unnamed = await call(server.port, TOOLS_CALL);
          expect(unnamed.status).toBe(502);
          expect(await unnamed.text()).toContain("must be named");
        },
      );

      test.skipIf(lan === undefined)(
        "this proxy's own address and a denied address are refused where the same upstream would answer",
        async () => {
          const up = inside();
          let deny: string[] = [];
          const answer = () =>
            grantOf(`http://${INSIDE}:${up.port}/mcp`, {
              allow: "private",
              deny,
            });
          // No selfAddresses: the host's interfaces, which hold this address.
          const own = marked(answer, async () => [lan ?? ""], {});
          expect((await call(own.server.port, TOOLS_CALL)).status).toBe(403);
          expect(own.lines.join("\n")).toContain(
            `${lan} is the installation's own`,
          );
          // The grant's deny list comes before the private rules pass it.
          const denied = marked(answer, async () => [lan ?? ""], {
            selfAddresses: () => [],
          });
          expect((await call(denied.server.port, TOOLS_CALL)).status).toBe(200);
          deny = [lan ?? ""];
          expect((await call(denied.server.port, TOOLS_CALL)).status).toBe(403);
          expect(denied.lines.join("\n")).toContain(
            `${lan} is the installation's own`,
          );
          expect(up.seen).toHaveLength(1);
        },
      );

      test("the mark holds the name to private addresses: a public answer, a mixed one and none are refused", async () => {
        let addresses: () => Promise<string[]> = async () => ["93.184.216.34"];
        const { server, looked, lines } = marked(
          () => grantOf(`http://${INSIDE}:4000/mcp`),
          () => addresses(),
        );
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        expect((await messages(server.port)).status).toBe(403);
        expect(lines.join("\n")).toContain(
          `93.184.216.34 is public, and ${INSIDE} is listed as private`,
        );
        // A rebinding: one private answer beside a public one is no pass.
        addresses = async () => ["10.0.0.5", "2606:4700:4700::1111"];
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        expect(lines.join("\n")).toContain("2606:4700:4700::1111 is public");
        addresses = async () => {
          throw new Error(`getaddrinfo ENOTFOUND ${INSIDE}`);
        };
        expect((await call(server.port, TOOLS_CALL)).status).toBe(502);
        addresses = async () => [];
        expect((await call(server.port, TOOLS_CALL)).status).toBe(502);
        expect(looked).toEqual([INSIDE, INSIDE, INSIDE, INSIDE, INSIDE]);
      });

      test("the addresses that are never dialled stay refused under the mark", async () => {
        const never: Array<[string, string]> = [
          // Cloud metadata, fc00::/7 carrying a9fe:a9fe among it.
          ["169.254.169.254", "is metadata"],
          ["169.254.170.2", "is metadata"],
          ["100.100.100.200", "is metadata"],
          ["fd00:ec2::254", "is metadata"],
          ["fd12:3456::a9fe:a9fe", "is metadata"],
          ["fd00:a9fe:a9fe::1", "is metadata"],
          ["::ffff:169.254.169.254", "is metadata"],
          ["64:ff9b::a9fe:a9fe", "is metadata"],
          // Loopback: this proxy's own container.
          ["127.0.0.2", "is loopback, not private"],
          ["127.255.255.254", "is loopback, not private"],
          ["::1", "is loopback, not private"],
          ["::ffff:127.0.0.2", "is loopback, not private"],
          ["169.254.10.10", "is link_local"],
          ["fe80::1", "is link_local"],
          ["0.0.0.0", "is unspecified"],
          ["::", "is unspecified"],
          ["224.0.0.251", "is multicast"],
          ["ff02::1", "is multicast"],
          ["240.0.0.1", "is reserved"],
          ["192.0.2.1", "is reserved"],
          // A private IPv4 address in IPv6 clothes.
          ["::ffff:10.0.0.5", "carries an IPv4 address"],
          ["64:ff9b::a00:5", "carries an IPv4 address"],
        ];
        let addresses: string[] = [];
        const { server, lines } = marked(
          (body) =>
            body.purpose === "mcp"
              ? grantOf(`http://${INSIDE}:4000/mcp`)
              : grantOf(`http://${INSIDE}:4000`),
          async () => addresses,
        );
        for (const [address, reason] of never) {
          // Alone, and beside an address that would pass.
          for (const answer of [[address], ["10.0.0.5", address]]) {
            addresses = answer;
            lines.length = 0;
            expect([
              address,
              (await call(server.port, TOOLS_CALL)).status,
            ]).toEqual([address, 403]);
            expect(lines.join("\n")).toContain(`${address} ${reason}`);
          }
        }
        // The model routes are held to the same rules.
        addresses = ["127.0.0.1"];
        expect((await messages(server.port)).status).toBe(403);
      });

      test("a metadata name is refused under the mark before it is looked up", async () => {
        let host = "metadata.google.internal";
        const { server, looked, lines } = marked(
          () => grantOf(`http://${host}/computeMetadata/v1`),
          async () => ["10.0.0.5"],
        );
        for (host of [
          "metadata.google.internal",
          "Metadata.",
          "instance-data.ec2.internal",
        ]) {
          expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        }
        expect(looked).toEqual([]);
        expect(lines.join("\n")).toContain("is a metadata service");
      });

      test("an address written another way is judged as the address it is", async () => {
        const spellings: Array<[string, string, string]> = [
          // A decimal integer, hex, octal and zero-padded octets.
          ["http://2130706434:8080/mcp", "127.0.0.2", "is loopback"],
          ["http://0x7f000002/mcp", "127.0.0.2", "is loopback"],
          ["http://0x7f.2/mcp", "127.0.0.2", "is loopback"],
          ["http://0177.0.0.2/mcp", "127.0.0.2", "is loopback"],
          ["http://127.000.000.002/mcp", "127.0.0.2", "is loopback"],
          ["http://127.2/mcp", "127.0.0.2", "is loopback"],
          ["http://2852039166/mcp", "169.254.169.254", "is metadata"],
          ["http://0xa9fea9fe/mcp", "169.254.169.254", "is metadata"],
          // IPv4-mapped IPv6 and NAT64.
          ["http://[::ffff:127.0.0.2]/mcp", "::ffff:7f00:2", "is loopback"],
          ["http://[0:0:0:0:0:0:0:1]/mcp", "::1", "is loopback"],
          [
            "http://[::ffff:169.254.169.254]/mcp",
            "::ffff:a9fe:a9fe",
            "is metadata",
          ],
          [
            "http://[64:ff9b::a9fe:a9fe]/mcp",
            "64:ff9b::a9fe:a9fe",
            "is metadata",
          ],
          [
            "http://[::FFFF:10.0.0.5]/mcp",
            "::ffff:a00:5",
            "carries an IPv4 address",
          ],
          // A leading zero is octal to the URL parser: not 10.0.0.5 at all.
          ["http://010.0.0.5/mcp", "8.0.0.5", "is public"],
        ];
        let url = "";
        const { server, looked, lines } = marked(
          () => grantOf(url),
          // As the system resolver answers for an address.
          async (host) => [host],
        );
        for (const [spelled, host, reason] of spellings) {
          url = spelled;
          looked.length = 0;
          lines.length = 0;
          expect([
            spelled,
            (await call(server.port, TOOLS_CALL)).status,
          ]).toEqual([spelled, 403]);
          expect(looked).toEqual([host]);
          expect(lines.join("\n")).toContain(`${host} ${reason}`);
        }
      });

      test("the grant's deny list is held by name and by address, before the private rules", async () => {
        const deny = ["Postgres.", "10.0.0.7", "FD00:0:0:0:0:0:0:7"];
        let url = "";
        let addresses: string[] = [];
        const { server, looked, lines } = marked(
          () => grantOf(url, { allow: "private", deny }),
          async () => addresses,
        );
        // By name, and an address named outright: refused without a lookup.
        for (const named of [
          "http://postgres:5432/mcp",
          "http://POSTGRES.:5432/mcp",
          "http://10.0.0.7:8080/mcp",
          "http://167772167:8080/mcp",
          "http://[fd00::7]:8080/mcp",
        ]) {
          url = named;
          expect([named, (await call(server.port, TOOLS_CALL)).status]).toEqual(
            [named, 403],
          );
        }
        expect(looked).toEqual([]);
        expect(lines.join("\n")).toContain(
          "postgres is the installation's own",
        );
        // By what another name resolves to, in any spelling, alone or not.
        url = `http://${INSIDE}:4000/mcp`;
        for (const answer of [
          ["10.0.0.7"],
          ["fd00::7"],
          ["fd00:0:0:0:0:0:0:7"],
          ["10.0.0.5", "10.0.0.7"],
        ]) {
          addresses = answer;
          lines.length = 0;
          expect([
            answer,
            (await call(server.port, TOOLS_CALL)).status,
          ]).toEqual([answer, 403]);
          expect(lines.join("\n")).toContain("is the installation's own");
        }
      });

      test("the authorizer is never a registered private upstream", async () => {
        let url = "";
        const { auth, server, looked, lines } = marked(
          () => grantOf(url),
          async (host) => [host],
        );
        url = `${auth.url}/mcp`;
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        // By its host, before any lookup, and whatever the port.
        url = "http://127.0.0.1:9/mcp";
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        // And in the IPv4-mapped spelling of the same address.
        url = "http://[::ffff:127.0.0.1]:9/mcp";
        expect((await call(server.port, TOOLS_CALL)).status).toBe(403);
        expect(looked).toEqual([]);
        expect(lines.join("\n")).toContain(
          "127.0.0.1 is the installation's own",
        );
      });

      test("an authorizer reached by name is refused by that name and by every address the name has had", async () => {
        let upstreamAnswer = ["10.0.0.7"];
        let authorizerAnswer: () => Promise<string[]> = async () => [
          "10.0.0.7",
        ];
        let url = `http://${INSIDE}:4000/mcp`;
        const looked: string[] = [];
        const lines: string[] = [];
        const auth = authorizer(() => Response.json(grantOf(url)));
        // The control requests reach it through the system's lookup of
        // localhost, which may be ::1 alone: it answers there too.
        try {
          servers.push(
            Bun.serve({
              hostname: "::1",
              port: Number(new URL(auth.url).port),
              fetch: async (request) =>
                fetch(auth.url + new URL(request.url).pathname, {
                  method: request.method,
                  headers: request.headers,
                  body: await request.text(),
                }),
            }),
          );
        } catch {}
        // The judgment asks the resolver below for the same name.
        const server = proxy(auth.url.replace("127.0.0.1", "localhost"), 1, {
          logger: createProxyLogger("warn", (line) => lines.push(line)),
          resolve: async (host) => {
            looked.push(host);
            return host === "localhost" ? authorizerAnswer() : upstreamAnswer;
          },
          selfAddresses: () => [],
        });
        const ask = async () => {
          looked.length = 0;
          lines.length = 0;
          return (await call(server.port, TOOLS_CALL)).status;
        };
        const OWN = "is the installation's own";
        // The address its name resolves to now, under another name.
        expect(await ask()).toBe(403);
        expect(lines.join("\n")).toContain(`10.0.0.7 ${OWN}`);
        // The name moved: the address it had is still refused, the new one too.
        authorizerAnswer = async () => ["10.0.0.8"];
        expect(await ask()).toBe(403);
        expect(lines.join("\n")).toContain(`10.0.0.7 ${OWN}`);
        upstreamAnswer = ["10.0.0.8"];
        expect(await ask()).toBe(403);
        expect(lines.join("\n")).toContain(`10.0.0.8 ${OWN}`);
        // An IPv4-mapped answer is the IPv4 address an upstream is dialled at.
        authorizerAnswer = async () => ["::ffff:10.0.0.9"];
        upstreamAnswer = ["10.0.0.9"];
        expect(await ask()).toBe(403);
        expect(lines.join("\n")).toContain(`10.0.0.9 ${OWN}`);
        // No address to tell it by is no judgment, whatever is remembered:
        // the upstream is not looked up, let alone dialled.
        upstreamAnswer = ["10.0.0.5"];
        const none: Array<() => Promise<string[]>> = [
          async () => [],
          async () => ["not-an-address"],
          async () => {
            throw new Error("getaddrinfo ENOTFOUND localhost");
          },
        ];
        for (const answer of none) {
          authorizerAnswer = answer;
          expect(await ask()).toBe(502);
          expect(looked).toEqual(["localhost"]);
          expect(lines.join("\n")).toContain(
            "the authorizer's addresses are unknown",
          );
        }
        // Its name is refused before the upstream is looked up.
        authorizerAnswer = async () => ["10.0.0.7"];
        url = "http://LOCALHOST.:4000/mcp";
        expect(await ask()).toBe(403);
        expect(looked).toEqual(["localhost"]);
        expect(lines.join("\n")).toContain(`localhost ${OWN}`);
      });

      test("a judge's private endpoint is held to the same rules", async () => {
        const lines: string[] = [];
        // Not 127.0.0.1: the test's authorizer listens there.
        let addresses = ["127.0.0.2"];
        const up = inside(() =>
          Response.json({
            model: "gpt-6-luna",
            choice: "yes",
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
        );
        const auth = authorizer(() =>
          Response.json({
            judgment_id: "judg-1",
            upstream: {
              url: `http://${INSIDE}:${up.port}`,
              headers: [],
              ...PRIVATE,
            },
          }),
        );
        const server = proxy(auth.url, 1, {
          logger: createProxyLogger("warn", (line) => lines.push(line)),
          resolve: async () => addresses,
          selfAddresses: () => [],
        });
        const decide = () =>
          fetch(`http://127.0.0.1:${server.port}/decisions/v1/decisions`, {
            method: "POST",
            headers: { authorization: "Bearer judge-token-of-this-test" },
            body: '{"model":"gpt-6-luna"}',
          });
        expect((await decide()).status).toBe(403);
        expect(lines.join("\n")).toContain(
          "127.0.0.2 is loopback, not private",
        );
        expect(up.seen).toEqual([]);
        if (lan === undefined) return;
        addresses = [lan];
        expect((await decide()).status).toBe(200);
        expect(up.seen.map(({ path }) => path)).toEqual(["/v1/decisions"]);
      });
    });

    test("the built-in server is not dialled when the authorizer's name resolves to metadata", async () => {
      const seen: string[] = [];
      const api = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/authorize") {
            return Response.json({
              session_id: "sess-1",
              attempt_id: "att-1",
              upstream: { url: "/mcp/github", headers: [] },
            });
          }
          seen.push(path);
          return Response.json({ jsonrpc: "2.0", id: 1, result: {} });
        },
      });
      servers.push(api);
      for (const address of [
        "100.100.100.200",
        "fd00:ec2::254",
        "169.254.170.2",
        "::ffff:a9fe:a9fe",
        "::ffff:169.254.169.254",
        "64:ff9b::a9fe:a9fe",
      ]) {
        const server = proxy(`http://127.0.0.1:${api.port}`, 1, {
          resolve: async () => [address],
        });
        const response = await fetch(
          `http://127.0.0.1:${server.port}/mcp/github`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${"w".repeat(24)}`,
              "content-type": "application/json",
            },
            body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
          },
        );
        expect(response.status, address).toBe(403);
        expect(await response.text(), address).toContain(
          `${address} is metadata`,
        );
      }
      expect(seen).toEqual([]);
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
      // A regrant says what the first ask said: the API may judge it alike.
      expect(auth.features.slice(0, 2)).toEqual([
        "registered-upstream,registered-private-upstream",
        "registered-upstream,registered-private-upstream",
      ]);
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

import { describe, expect, test } from "bun:test";
import {
  BODY_LIMIT,
  createCollector,
  formatCapture,
  globToRegExp,
  maskBody,
  shortBody,
  wanted,
  // @ts-expect-error plain .mjs next to the verify skill's scripts
} from "../.claude/skills/verify-werft/scripts/response-capture.mjs";

describe("wanted", () => {
  test("keeps 4xx and 5xx, drops 2xx and 3xx", () => {
    expect(wanted(400, "http://h/v1/x", undefined)).toBe(true);
    expect(wanted(503, "http://h/v1/x", undefined)).toBe(true);
    expect(wanted(200, "http://h/v1/x", undefined)).toBe(false);
    expect(wanted(302, "http://h/v1/x", undefined)).toBe(false);
  });

  test("a URL pattern also keeps successful responses", () => {
    const pattern = globToRegExp("*/v1/sessions*");
    expect(wanted(200, "http://h/v1/sessions?limit=5", pattern)).toBe(true);
    expect(wanted(200, "http://h/v1/members", pattern)).toBe(false);
  });

  test("a glob treats regex characters literally", () => {
    const pattern = globToRegExp("*/v1/a.b");
    expect(pattern.test("http://h/v1/a.b")).toBe(true);
    expect(pattern.test("http://h/v1/axb")).toBe(false);
  });
});

describe("maskBody", () => {
  test("hides JSON values under secret-looking keys, keeps the rest", () => {
    const out = maskBody(
      '{"error":"invalid","access_token":"abc123","nested":{"Password":"hunter2","name":"ok"}}',
    );
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("hunter2");
    expect(out).toContain('"error":"invalid"');
    expect(out).toContain('"name":"ok"');
  });

  test("hides Bearer tokens, cookies and Authorization lines", () => {
    const out = maskBody(
      "Authorization: Bearer abc.def-ghi\nCookie: sid=zzz\nset-cookie=sid2=yyy",
    );
    for (const secret of ["abc.def-ghi", "zzz", "yyy"])
      expect(out).not.toContain(secret);
  });

  test("hides invite tokens and OAuth query values", () => {
    const out = maskBody("see /invite/AbC123xyz and ?code=c0de&state=st4te");
    for (const secret of ["AbC123xyz", "c0de", "st4te"])
      expect(out).not.toContain(secret);
  });
});

describe("maskBody: shapes a first version leaked", () => {
  const leaks = (text: string) => maskBody(text).includes("SENTINEL");

  test("secret keys with array, object or escaped-name values", () => {
    expect(leaks('{"access_token":["SENTINEL"]}')).toBe(false);
    expect(leaks('{"token":{"value":"SENTINEL"}}')).toBe(false);
    expect(leaks('{"access_\\u0074oken":"SENTINEL"}')).toBe(false);
    expect(leaks('{"a":[{"client_secret":"SENTINEL"}]}')).toBe(false);
  });

  test("keeps error.code, the field a failure is read for", () => {
    expect(maskBody('{"error":{"code":"UNAUTHORIZED"}}')).toContain(
      "UNAUTHORIZED",
    );
  });

  test("bare and URL-encoded query values", () => {
    expect(leaks("token=SENTINEL")).toBe(false);
    expect(leaks("code=SENTINEL")).toBe(false);
    expect(leaks("?redir=https%3A%2F%2Fh%2Fcb%3Fcode%3DSENTINEL")).toBe(false);
  });

  test("every cookie in a list, not just the first", () => {
    expect(leaks("Cookie: first=x; session=SENTINEL")).toBe(false);
    expect(leaks("set-cookie: a=1, b=SENTINEL")).toBe(false);
  });

  test("an invite token in the reported path", () => {
    const line = formatCapture({
      method: "GET",
      url: "http://h/invite/SENTINEL",
      status: 404,
      body: "missing",
    });
    expect(line).not.toContain("SENTINEL");
  });
});

describe("createCollector", () => {
  const sent: string[] = [];
  const setup = (answer: () => Promise<unknown>) => {
    sent.length = 0;
    return createCollector({
      send: (method: string) => {
        sent.push(method);
        return answer();
      },
      pattern: undefined,
      settleMs: 500,
    });
  };
  const request = (id: string, status: number, url = "http://h/v1/x") => [
    {
      method: "Network.requestWillBeSent",
      params: { requestId: id, request: { method: "POST" } },
    },
    {
      method: "Network.responseReceived",
      params: { requestId: id, response: { status, url } },
    },
  ];
  const finished = (id: string) => ({
    method: "Network.loadingFinished",
    params: { requestId: id },
  });

  test("reads the body of a failed request and skips a successful one", async () => {
    const c = setup(async () => ({
      body: '{"error":"no"}',
      base64Encoded: false,
    }));
    for (const m of [
      ...request("1", 401),
      finished("1"),
      ...request("2", 200),
      finished("2"),
    ])
      c.onEvent(m);
    expect(await c.report()).toEqual([
      '! failed request: POST /v1/x -> 401 | {"error":"no"}',
    ]);
    expect(sent).toEqual(["Network.getResponseBody"]);
  });

  test("a response that finishes after report() started is still listed", async () => {
    const c = setup(async () => ({ body: "late", base64Encoded: false }));
    for (const m of request("1", 500)) c.onEvent(m);
    const lines = c.report();
    setTimeout(() => c.onEvent(finished("1")), 100);
    expect(await lines).toEqual(["! failed request: POST /v1/x -> 500 | late"]);
  });

  test("a connection reset after the status keeps method, path, status and the reason", async () => {
    const c = setup(async () => ({ body: "", base64Encoded: false }));
    for (const m of request("1", 500)) c.onEvent(m);
    c.onEvent({
      method: "Network.loadingFailed",
      params: { requestId: "1", errorText: "net::ERR_CONNECTION_RESET" },
    });
    expect(await c.report()).toEqual([
      "! failed request: POST /v1/x -> 500 | body unavailable: net::ERR_CONNECTION_RESET",
    ]);
  });

  test("a request that never finishes is listed, not dropped", async () => {
    const c = setup(async () => ({ body: "", base64Encoded: false }));
    for (const m of request("1", 503)) c.onEvent(m);
    expect((await c.report())[0]).toContain(
      "response had not finished loading",
    );
  });

  test("a body the browser no longer has is reported as unavailable", async () => {
    const c = setup(() =>
      Promise.reject(
        new Error("Network.getResponseBody: No resource with given identifier"),
      ),
    );
    for (const m of [...request("1", 404), finished("1")]) c.onEvent(m);
    expect((await c.report())[0]).toContain(
      "body unavailable: No resource with given identifier",
    );
  });

  test("a base64 body is decoded", async () => {
    const c = setup(async () => ({
      body: Buffer.from("héllo").toString("base64"),
      base64Encoded: true,
    }));
    for (const m of [...request("1", 400), finished("1")]) c.onEvent(m);
    expect((await c.report())[0]).toContain("| héllo");
  });
});

describe("shortBody", () => {
  test("cuts past the limit and says how much", () => {
    const out = shortBody("x".repeat(BODY_LIMIT + 50));
    expect(out.startsWith("x".repeat(BODY_LIMIT))).toBe(true);
    expect(out).toContain("+50 chars cut");
  });

  test("masks before cutting, so a secret at the edge cannot leak", () => {
    const body = `${"a".repeat(BODY_LIMIT - 20)}{"password":"${"s".repeat(40)}"}`;
    expect(shortBody(body)).not.toContain("sssss");
  });
});

describe("formatCapture", () => {
  test("names method, path and status, hides the query", () => {
    const line = formatCapture({
      method: "POST",
      url: "http://127.0.0.1:3000/v1/auth/login?code=secret1",
      status: 401,
      body: '{"error":"bad credentials"}',
    });
    expect(line).toBe(
      'POST /v1/auth/login?(query hidden) -> 401 | {"error":"bad credentials"}',
    );
  });

  test("reports an unreadable body and an empty one", () => {
    expect(
      formatCapture({
        method: "GET",
        url: "http://h/v1/x",
        status: 500,
        bodyError: "evicted",
      }),
    ).toBe("GET /v1/x -> 500 | body unavailable: evicted");
    expect(
      formatCapture({
        method: "GET",
        url: "http://h/v1/x",
        status: 404,
        body: "",
      }),
    ).toBe("GET /v1/x -> 404 | (empty body)");
  });
});

import { describe, expect, test } from "bun:test";
import {
  BODY_LIMIT,
  createCollector,
  formatCapture,
  globToRegExp,
  maskBody,
  NETWORK_ENABLE,
  READ_BUDGET,
  READ_LIMIT,
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

  test("an escaped secret key inside JSON embedded in other text", () => {
    expect(leaks('request: {"access_\\u0074oken":"SENTINEL"}')).toBe(false);
    expect(leaks('request: {"access_\\u0074oken":["SENTINEL"]}')).toBe(false);
    expect(leaks('x {"a":{"token":{"v":["SENTINEL"]}},"b":1}')).toBe(false);
  });

  test("a cut-off body still hides what follows a secret key", () => {
    expect(leaks('{"ok":1,"token":"SENTINEL')).toBe(false);
    expect(leaks('{"ok":1,"token":["SENTINEL')).toBe(false);
    expect(leaks('Cookie: a="SENTINEL')).toBe(false);
  });

  test("a stray quote before a secret key does not hide the key from the scan", () => {
    expect(leaks('prefix " {"token":"SENTINEL"}')).toBe(false);
    expect(leaks('a " b " c {"token":"SENTINEL"} " d')).toBe(false);
  });

  test("JSON inside a JSON string (escaped quotes)", () => {
    const body = JSON.stringify({
      note: JSON.stringify({ token: "two words SENTINEL", ok: "fine" }),
    });
    expect(leaks(body)).toBe(false);
  });

  test("a key with an escaped quote inside, or a doubly nested string", () => {
    expect(leaks('prefix {"token\\"label":"SENTINEL"}')).toBe(false);
    const nested = JSON.stringify({
      a: JSON.stringify({ b: JSON.stringify({ token: "SENTINEL" }) }),
    });
    expect(leaks(nested)).toBe(false);
  });

  test("long keys, punctuation in keys and whitespace before the colon", () => {
    expect(leaks(`prefix {"token${"x".repeat(41)}":"SENTINEL"}`)).toBe(false);
    expect(leaks(`prefix {"token${"x".repeat(200)}":"SENTINEL"}`)).toBe(false);
    expect(leaks('prefix {"token.label":"SENTINEL"}')).toBe(false);
    expect(leaks('prefix {"token"\t:"SENTINEL"}')).toBe(false);
    expect(leaks('prefix {"token"\n  :\n"SENTINEL"}')).toBe(false);
  });

  test("a very long key name stays fast", () => {
    const started = performance.now();
    maskBody(`prefix {"${"token".repeat(8000)}":"x"}`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("mismatched brackets hide the rest instead of ending early", () => {
    expect(leaks('prefix {"token":[}SENTINEL]}')).toBe(false);
  });

  test("a long run of escaped quotes is scanned in linear time", () => {
    const started = performance.now();
    maskBody('\\"'.repeat(100_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("keeps the fields after a hidden one in embedded JSON", () => {
    expect(maskBody('x {"token":"s","error":"bad request"}')).toContain(
      '"error":"bad request"',
    );
  });

  test("api_key in a query inside a body", () => {
    expect(leaks("https://h/cb?api_key=SENTINEL&password=x")).toBe(false);
  });

  test("every cookie in a list, quoted values included", () => {
    expect(leaks('Cookie: a="SENTINEL"; session=x')).toBe(false);
    expect(leaks('Cookie: a="x"; session=SENTINEL')).toBe(false);
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
    const encoded = formatCapture({
      method: "GET",
      url: "http://h/in%76ite/SENTINEL",
      status: 404,
      body: "missing",
    });
    expect(encoded).not.toContain("SENTINEL");
    for (const path of [
      "/invite/PREFIX%20SENTINEL",
      "/invite/a%22SENTINEL",
      "/in%76ite/SENTINEL%ZZ",
      "/in%76ite%2FSENTINEL",
      "/%FF%2Finvite%2FSENTINEL",
    ])
      expect(
        formatCapture({
          method: "GET",
          url: `http://h${path}`,
          status: 404,
          body: "",
        }),
      ).not.toContain("SENTINEL");
  });

  test("an encoded newline in the path cannot add a report line", () => {
    const line = formatCapture({
      method: "GET",
      url: "http://h/v1%0AFAKE%20ENTRY",
      status: 404,
      body: "",
    });
    expect(line.includes("\n")).toBe(false);
  });

  test("a non-invite path is printed as it is", () => {
    expect(
      formatCapture({
        method: "GET",
        url: "http://h/v1/members?x=1",
        status: 500,
        body: "",
      }),
    ).toContain("GET /v1/members?(query hidden) -> 500");
  });
});

describe("createCollector", () => {
  const sent: string[] = [];
  const setup = (
    answer: () => Promise<unknown>,
    pattern?: RegExp,
    settleMs = 500,
  ) => {
    sent.length = 0;
    return createCollector({
      send: (method: string) => {
        sent.push(method);
        return answer();
      },
      pattern,
      settleMs,
    });
  };
  const sentEvent = (id: string, url = "http://h/v1/x", extra = {}) => ({
    method: "Network.requestWillBeSent",
    params: { requestId: id, request: { method: "POST", url }, ...extra },
  });
  const request = (id: string, status: number, url = "http://h/v1/x") => [
    sentEvent(id, url),
    {
      method: "Network.responseReceived",
      params: { requestId: id, response: { status, url } },
    },
    // The browser reports the decoded size; a body of unknown size is not read.
    {
      method: "Network.dataReceived",
      params: { requestId: id, dataLength: 64 },
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
      "POST /v1/x -> 503 | body unavailable: no response body within the wait",
    );
  });

  test("a body read that never answers keeps the request, status and reason", async () => {
    const c = setup(() => new Promise(() => {}), undefined, 100);
    for (const m of [...request("1", 500), finished("1")]) c.onEvent(m);
    expect(await c.report()).toEqual([
      "! failed request: POST /v1/x -> 500 | body unavailable: no response body within the wait",
    ]);
  });

  test("a pattern match that fails before any header is listed", async () => {
    const c = setup(
      async () => ({ body: "", base64Encoded: false }),
      globToRegExp("*/v1/*"),
    );
    c.onEvent(sentEvent("1"));
    c.onEvent({
      method: "Network.loadingFailed",
      params: { requestId: "1", errorText: "net::ERR_CONNECTION_REFUSED" },
    });
    expect(await c.report()).toEqual([
      "! failed request: POST /v1/x -> no response | body unavailable: net::ERR_CONNECTION_REFUSED",
    ]);
  });

  test("a pattern-matching redirect hop is listed with its status", async () => {
    const c = setup(
      async () => ({ body: "done", base64Encoded: false }),
      globToRegExp("*/v1/start"),
    );
    c.onEvent(sentEvent("4", "http://h/v1/start"));
    c.onEvent(
      sentEvent("4", "http://h/end", {
        redirectResponse: { status: 302, url: "http://h/v1/start" },
      }),
    );
    c.onEvent({
      method: "Network.responseReceived",
      params: {
        requestId: "4",
        response: { status: 200, url: "http://h/end" },
      },
    });
    c.onEvent(finished("4"));
    expect(await c.report()).toEqual([
      "! failed request: POST /v1/start -> 302 | body unavailable: redirect, no body",
    ]);
  });

  test("a failure that arrives while another body is being read is also listed", async () => {
    let release: (v: unknown) => void = () => {};
    const c = setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      undefined,
      200,
    );
    for (const m of [...request("A", 500), finished("A")]) c.onEvent(m);
    const lines = c.report();
    setTimeout(() => {
      for (const m of request("B", 503)) c.onEvent(m);
      release({ body: "a-body", base64Encoded: false });
    }, 20);
    const out = await lines;
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("-> 500 | a-body");
    expect(out[1]).toContain("-> 503 | body unavailable");
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

  const responded = (
    id: string,
    status: number,
    response: Record<string, unknown> = {},
  ) => ({
    method: "Network.responseReceived",
    params: {
      requestId: id,
      response: { status, url: "http://h/v1/x", ...response },
    },
  });

  test("a binary body is not read", async () => {
    const c = setup(async () => ({ body: "x", base64Encoded: false }));
    c.onEvent(sentEvent("1"));
    c.onEvent(responded("1", 500, { mimeType: "application/octet-stream" }));
    c.onEvent(finished("1"));
    const out = await c.report();
    expect(sent).toEqual([]);
    expect(out[0]).toContain(
      "body unavailable: not read (application/octet-stream)",
    );
  });

  test("a body over the read limit is not read", async () => {
    const c = setup(async () => ({ body: "x", base64Encoded: false }));
    c.onEvent(sentEvent("1"));
    c.onEvent(responded("1", 500, { mimeType: "application/json" }));
    c.onEvent({
      method: "Network.dataReceived",
      params: { requestId: "1", dataLength: 1_000_000 },
    });
    c.onEvent(finished("1"));
    c.onEvent(sentEvent("2"));
    c.onEvent(
      responded("2", 500, {
        mimeType: "text/plain",
        headers: { "Content-Length": "1000000" },
      }),
    );
    c.onEvent(finished("2"));
    const out = await c.report();
    expect(sent).toEqual([]);
    expect(out[0]).toContain("body omitted: 1000000 bytes");
    expect(out[1]).toContain("body omitted: 1000000 bytes");
  });

  test("a body of unknown size is not read", async () => {
    const c = setup(async () => ({
      body: `{"error":"${"y".repeat(1_000_000)}"}`,
      base64Encoded: false,
    }));
    c.onEvent(sentEvent("1"));
    c.onEvent(responded("1", 500, { mimeType: "text/plain" }));
    c.onEvent({
      method: "Network.loadingFinished",
      params: { requestId: "1", encodedDataLength: 0 },
    });
    const out = await c.report();
    expect(sent).toEqual([]);
    expect(out[0]).toContain("body unavailable: not read (size unknown)");
  });

  test("a body larger than its reported size is cut before it is masked", async () => {
    const c = setup(async () => ({
      body: `{"error":"${"y".repeat(1_000_000)}"}`,
      base64Encoded: false,
    }));
    for (const m of [...request("1", 500), finished("1")]) c.onEvent(m);
    const out = await c.report();
    expect(out[0].length).toBeLessThan(BODY_LIMIT + 200);
    expect(out[0]).not.toContain("+998");
  });

  test("the read budget counts bytes, not characters", async () => {
    const c = setup(async () => ({
      body: "가".repeat(20_000),
      base64Encoded: false,
    }));
    for (let i = 0; i < 12; i++) {
      const id = String(i);
      c.onEvent(sentEvent(id));
      c.onEvent(responded(id, 500));
      c.onEvent({
        method: "Network.dataReceived",
        params: { requestId: id, dataLength: 60_000 },
      });
      c.onEvent(finished(id));
      await Promise.resolve();
      await Promise.resolve();
    }
    await c.report();
    expect(sent.length).toBe(4);
  });

  test("the number of listed requests and bytes read is capped", async () => {
    const c = setup(async () => ({
      body: "z".repeat(60_000),
      base64Encoded: false,
    }));
    for (let i = 0; i < 300; i++)
      for (const m of [
        ...request(String(i), 500),
        {
          method: "Network.dataReceived",
          params: { requestId: String(i), dataLength: 59_936 },
        },
        finished(String(i)),
      ])
        c.onEvent(m);
    const out = await c.report();
    expect(sent.length).toBeLessThan(10);
    expect(out.length).toBeLessThan(110);
    expect(out.at(-1)).toContain("more failed requests not listed");
  });

  test("a failed request whose headers arrive after report() started is listed", async () => {
    const c = setup(async () => ({ body: "late-500", base64Encoded: false }));
    c.onEvent(sentEvent("1"));
    const lines = c.report();
    setTimeout(() => {
      c.onEvent(responded("1", 500));
      c.onEvent({
        method: "Network.dataReceived",
        params: { requestId: "1", dataLength: 8 },
      });
      c.onEvent(finished("1"));
    }, 100);
    expect(await lines).toEqual([
      "! failed request: POST /v1/x -> 500 | late-500",
    ]);
  });

  test("a request sent just after report() started is waited for", async () => {
    const c = setup(async () => ({ body: "later", base64Encoded: false }));
    const lines = c.report();
    setTimeout(() => {
      for (const m of [...request("1", 502), finished("1")]) c.onEvent(m);
    }, 100);
    expect(await lines).toEqual([
      "! failed request: POST /v1/x -> 502 | later",
    ]);
  });

  test("a request with no headers by the deadline is listed", async () => {
    const c = setup(async () => ({ body: "", base64Encoded: false }));
    c.onEvent(sentEvent("1"));
    expect(await c.report()).toEqual([
      "! failed request: POST /v1/x -> no response | body unavailable: no response within the wait",
    ]);
  });

  test("a successful stream does not hold the report", async () => {
    const c = setup(
      async () => ({ body: "", base64Encoded: false }),
      undefined,
      2000,
    );
    c.onEvent(sentEvent("1"));
    c.onEvent(responded("1", 200, { mimeType: "text/event-stream" }));
    const started = performance.now();
    expect(await c.report()).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test("data arriving on a successful stream does not hold the report", async () => {
    const c = setup(
      async () => ({ body: "", base64Encoded: false }),
      undefined,
      2000,
    );
    c.onEvent(sentEvent("1"));
    c.onEvent(responded("1", 200, { mimeType: "text/event-stream" }));
    const tick = setInterval(
      () =>
        c.onEvent({
          method: "Network.dataReceived",
          params: { requestId: "1", dataLength: 10 },
        }),
      50,
    );
    const started = performance.now();
    const out = await c.report();
    clearInterval(tick);
    expect(out).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("maskBody: werft#1327 review", () => {
  const SYN = [
    "syn-sid-01",
    "syn-sid-02",
    "syn-sid-03",
    "syn-mail-04@example.test",
    "syn-sess-05",
    "syn-oauth-06",
    "syn-bearer-07",
    "c3luLWJhc2ljLTA4",
    "syn-inv-09",
    "syn-inv-10",
    "syn-inv-11",
    "syn-pw-12",
    "syn-sid-13",
    "syn-mail-14@example.test",
    "syn-inv-15",
    "syn-code-16",
  ];
  const leaked = (text: string) =>
    SYN.filter((s) => maskBody(text).includes(s));

  test("session ids, sid, email and session.id in JSON", () => {
    expect(
      leaked(
        '{"session_id":"syn-sid-01","sessionId":"syn-sid-02","sid":"syn-sid-03","email":"syn-mail-04@example.test"}',
      ),
    ).toEqual([]);
    expect(leaked('{"session":{"id":"syn-sess-05"}}')).toEqual([]);
  });

  test("a top-level OAuth code is hidden, error.code is kept", () => {
    expect(leaked('{"code":"syn-oauth-06","state":"x"}')).toEqual([]);
    expect(leaked('{"data":{"authCode":"syn-code-16"}}')).toEqual([]);
    expect(maskBody('{"error":{"code":"UNAUTHORIZED"}}')).toContain(
      "UNAUTHORIZED",
    );
    expect(maskBody('{"errors":[{"code":"BAD_INPUT"}]}')).toContain(
      "BAD_INPUT",
    );
  });

  test("the same keys in a body that is not JSON", () => {
    expect(leaked('prefix {"sid":"syn-sid-13"}')).toEqual([]);
    expect(leaked("email: syn-mail-14@example.test")).toEqual([]);
    expect(leaked("session_id=syn-sid-01")).toEqual([]);
  });

  test("lower-case schemes, upper-case and encoded invite paths, tags", () => {
    expect(leaked("authorization failed for bearer syn-bearer-07")).toEqual([]);
    expect(leaked("got basic c3luLWJhc2ljLTA4 back")).toEqual([]);
    expect(leaked("see https://h/INVITE/syn-inv-09")).toEqual([]);
    expect(leaked("see https://h/in%76ite/syn-inv-10")).toEqual([]);
    expect(leaked("see https://h/invite%2Fsyn-inv-11")).toEqual([]);
    expect(leaked("see https://h/in%2576ite/syn-inv-15")).toEqual([]);
    expect(leaked("<password>syn-pw-12</password>")).toEqual([]);
    expect(leaked("<Session-Id>syn-sid-13</Session-Id>")).toEqual([]);
  });

  test("everything inside a secret element: CDATA, nested and repeated tags", () => {
    expect(leaked("<password><![CDATA[syn-pw-12]]></password>")).toEqual([]);
    expect(leaked("<password><value>syn-pw-12</value></password>")).toEqual([]);
    expect(
      leaked("<password><password>a</password>syn-pw-12</password>"),
    ).toEqual([]);
    expect(leaked('<field name="password">syn-pw-12</field>')).toEqual([]);
    expect(leaked("<sid>syn-sid-13")).toEqual([]);
    // Markup with a secret-like name is withheld whole (werft#1327 round 4:
    // every close-tag scan was bypassed); markup without one stays readable.
    expect(maskBody("<password>x</password><error>kept</error>")).toBe(
      "(markup with secret-like names withheld, 41 chars)",
    );
    expect(maskBody("<error>Invalid payload</error>")).toContain(
      "Invalid payload",
    );
  });

  test("a status code in the body stays readable", () => {
    expect(
      maskBody('{"statusCode":500,"error":{"code":"UNAUTHORIZED"}}'),
    ).toContain('"statusCode":500');
  });

  test("a close tag inside CDATA, a comment or a quoted attribute does not end the element", () => {
    expect(
      leaked("<password><![CDATA[</password>syn-pw-12]]></password>"),
    ).toEqual([]);
    expect(
      leaked("<password><!-- </password> -->syn-pw-12</password>"),
    ).toEqual([]);
    expect(
      leaked('<password><x a="</password>">syn-pw-12</x></password>'),
    ).toEqual([]);
  });

  test("a secret tag of any length is recognised", () => {
    expect(leaked(`<password${" ".repeat(700)}>syn-pw-12</password>`)).toEqual(
      [],
    );
    expect(
      leaked(
        `<password${"x".repeat(700)}>syn-pw-12</password${"x".repeat(700)}>`,
      ),
    ).toEqual([]);
  });

  test("a slash before > does not make an HTML element empty", () => {
    expect(leaked("<textarea name=password/>syn-pw-12</textarea>")).toEqual([]);
    expect(leaked("<password/>syn-pw-12</password>")).toEqual([]);
  });

  test("a close tag inside a processing instruction, and names spelled with character references", () => {
    expect(
      leaked("<password><?probe </password> ?>syn-pw-12</password>"),
    ).toEqual([]);
    expect(
      leaked('<textarea name="pass&#119;ord">syn-pw-12</textarea>'),
    ).toEqual([]);
    expect(leaked("<textarea name=pass&#x77ord>syn-pw-12</textarea>")).toEqual(
      [],
    );
    expect(leaked('<비밀 name="pass&#119;ord" value="syn-pw-12"/>')).toEqual(
      [],
    );
  });
});

describe("createCollector: werft#1327 review round 2", () => {
  test("a request that fails before any header is listed without CAPTURE_URL", async () => {
    const c = createCollector({
      send: async () => ({ body: "", base64Encoded: false }),
      settleMs: 200,
    });
    c.onEvent({
      method: "Network.requestWillBeSent",
      params: { requestId: "1", request: { method: "GET", url: "http://h/x" } },
    });
    c.onEvent({
      method: "Network.loadingFailed",
      params: { requestId: "1", errorText: "net::ERR_CONNECTION_REFUSED" },
    });
    c.onEvent({
      method: "Network.requestWillBeSent",
      params: { requestId: "2", request: { method: "GET", url: "http://h/y" } },
    });
    c.onEvent({
      method: "Network.loadingFailed",
      params: { requestId: "2", errorText: "net::ERR_ABORTED", canceled: true },
    });
    expect(await c.report()).toEqual([
      "! failed request: GET /x -> no response | body unavailable: net::ERR_CONNECTION_REFUSED",
    ]);
  });

  test("a base64 body is charged its decoded bytes", async () => {
    let calls = 0;
    const c = createCollector({
      send: async () => {
        calls++;
        return {
          body: Buffer.alloc(65_536, 120).toString("base64"),
          base64Encoded: true,
        };
      },
      settleMs: 200,
    });
    for (let i = 0; i < 4; i++) {
      const id = String(i);
      c.onEvent({
        method: "Network.requestWillBeSent",
        params: {
          requestId: id,
          request: { method: "GET", url: "http://h/x" },
        },
      });
      c.onEvent({
        method: "Network.responseReceived",
        params: { requestId: id, response: { status: 500, url: "http://h/x" } },
      });
      c.onEvent({
        method: "Network.dataReceived",
        params: { requestId: id, dataLength: 65_536 },
      });
      c.onEvent({
        method: "Network.loadingFinished",
        params: { requestId: id },
      });
      await Promise.resolve();
      await Promise.resolve();
    }
    await c.report();
    expect(calls).toBe(4);
  });

  test("a request blocked with an empty error text names the reason", async () => {
    const c = createCollector({
      send: async () => ({ body: "", base64Encoded: false }),
      settleMs: 200,
    });
    c.onEvent({
      method: "Network.requestWillBeSent",
      params: { requestId: "1", request: { method: "GET", url: "http://h/x" } },
    });
    c.onEvent({
      method: "Network.loadingFailed",
      params: { requestId: "1", errorText: "", blockedReason: "csp" },
    });
    expect(await c.report()).toEqual([
      "! failed request: GET /x -> no response | body unavailable: csp",
    ]);
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

// Follow-ups of werft#1327 (hold queue 7 and 8). Values are placeholders; no
// real-looking secret literal is used.
describe("maskBody: prefixed JSON and form bodies", () => {
  const leaks = (text: string) => maskBody(text).includes("SENTINEL");

  test("JSON behind an anti-hijacking prefix is masked like plain JSON", () => {
    expect(leaks(`)]}'\n{"session":{"id":"SENTINEL"}}`)).toBe(false);
    expect(leaks(`)]}',\n{"a":[{"client_secret":"SENTINEL"}]}`)).toBe(false);
    expect(leaks(`while(1);{"auth":{"token":["SENTINEL"]}}`)).toBe(false);
    // The parse keeps error.code readable here too.
    expect(maskBody(`)]}'\n{"error":{"code":"UNAUTHORIZED"}}`)).toContain(
      "UNAUTHORIZED",
    );
  });

  test("a key with brackets or a comma in a body that is not JSON", () => {
    expect(leaks(`)]}'\n{"token,x":"SENTINEL"`)).toBe(false);
    expect(leaks(`)]}'\n{"token[0]":"SENTINEL"`)).toBe(false);
    expect(leaks(`)]}'\n{"api_key]":"SENTINEL"`)).toBe(false);
  });

  test("form and query shaped bodies", () => {
    expect(leaks("a=1&client_secret[0]=SENTINEL")).toBe(false);
    expect(leaks("password[]=SENTINEL&b=2")).toBe(false);
    expect(leaks("token%5Bx%5D=SENTINEL")).toBe(false);
    expect(leaks("api_key,v2=SENTINEL")).toBe(false);
    expect(leaks("refresh_token = SENTINEL\nnext=1")).toBe(false);
  });

  test("a key longer than 256 characters after the secret word", () => {
    expect(leaks(`x token${"y".repeat(300)}=SENTINEL`)).toBe(false);
    expect(leaks(`)]}'\n{"token${"y".repeat(300)},":"SENTINEL"`)).toBe(false);
  });

  test("many secret words with no separator stay fast", () => {
    const started = performance.now();
    maskBody(`x ${"token ".repeat(20_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("createCollector: body size bound", () => {
  const sent: string[] = [];
  const setup = (answer: () => Promise<unknown>) => {
    sent.length = 0;
    return createCollector({
      send: (method: string) => {
        sent.push(method);
        return answer();
      },
      settleMs: 500,
    });
  };
  const events = (id: string, headers: Record<string, string>, data = 0) => [
    {
      method: "Network.requestWillBeSent",
      params: { requestId: id, request: { method: "GET", url: "http://h/x" } },
    },
    {
      method: "Network.responseReceived",
      params: {
        requestId: id,
        response: {
          status: 500,
          url: "http://h/x",
          mimeType: "application/json",
          headers,
        },
      },
    },
    ...(data
      ? [
          {
            method: "Network.dataReceived",
            params: { requestId: id, dataLength: data },
          },
        ]
      : []),
    { method: "Network.loadingFinished", params: { requestId: id } },
  ];

  test("a Content-Length over the limit is not read and says how big", async () => {
    const c = setup(async () => ({ body: "x", base64Encoded: false }));
    for (const m of events("1", { "Content-Length": "5000000" })) c.onEvent(m);
    const out = await c.report();
    expect(sent).toEqual([]);
    expect(out[0]).toContain("body omitted: 5000000 bytes");
  });

  test("received bytes over the limit are not read", async () => {
    const c = setup(async () => ({ body: "x", base64Encoded: false }));
    for (const m of events("1", {}, 3_000_000)) c.onEvent(m);
    const out = await c.report();
    expect(sent).toEqual([]);
    expect(out[0]).toContain("body omitted: 3000000 bytes");
  });

  test("a body that turns out larger than reported is dropped, not kept", async () => {
    const big = `{"error":"${"y".repeat(2_000_000)}"}`;
    const c = setup(async () => ({ body: big, base64Encoded: false }));
    for (const m of events("1", {}, 64)) c.onEvent(m);
    const out = await c.report();
    expect(out[0]).toContain(`body omitted: ${Buffer.byteLength(big)} bytes`);
    expect(out[0]).not.toContain("yyyy");
  });

  test("the browser is told not to keep bodies over the limit", () => {
    expect(NETWORK_ENABLE.maxResourceBufferSize).toBe(READ_LIMIT);
    expect(NETWORK_ENABLE.maxTotalBufferSize).toBeGreaterThanOrEqual(
      READ_BUDGET,
    );
  });
});

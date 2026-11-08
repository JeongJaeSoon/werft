import { describe, expect, test } from "bun:test";
import {
  BODY_LIMIT,
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

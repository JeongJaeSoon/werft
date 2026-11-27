import { describe, expect, test } from "bun:test";
import { createLogger } from "@werft-ai/observability";
import { hashToken } from "@werft-ai/platform";
import {
  createEgressDenialHandler,
  EGRESS_DENIALS_PATH,
  routeEgressDenials,
} from "./egress-denials.ts";

const SERVICE = "s".repeat(40);
const URL_OF = `http://authorizer.internal${EGRESS_DENIALS_PATH}`;

function setup(record = async () => ({ outcome: "recorded" })) {
  const calls: Array<{ tokenHash: Uint8Array; host: string; port: number }> =
    [];
  const lines: string[] = [];
  const handler = createEgressDenialHandler({
    record: async (report) => {
      calls.push(report);
      return record();
    },
    logger: createLogger({
      sinks: [{ write: (record) => void lines.push(JSON.stringify(record)) }],
    }),
    token: SERVICE,
  });
  return { calls, handler, lines };
}

const post = (body: unknown, auth = `Bearer ${SERVICE}`) =>
  new Request(URL_OF, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("egress denial reports", () => {
  test("a report from the proxy is recorded by the token's hash", async () => {
    const { calls, handler, lines } = setup();
    const response = await handler(
      post({ token: "wed_marker", host: "example.com", port: 443 }),
    );
    expect(response.status).toBe(204);
    expect(calls).toEqual([
      { tokenHash: hashToken("wed_marker"), host: "example.com", port: 443 },
    ]);
    expect(lines.join("\n")).not.toContain("wed_marker");
  });

  test("only the proxy's bearer reaches it", async () => {
    const { calls, handler } = setup();
    for (const auth of ["", "Bearer wrong", `Basic ${SERVICE}`]) {
      const response = await handler(
        post({ token: "wed_marker", host: "example.com", port: 443 }, auth),
      );
      expect(response.status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  test("a host carrying anything but a name, or a bad port, is refused", async () => {
    const { calls, handler } = setup();
    for (const body of [
      "not json",
      { token: "wed_marker", host: "example.com/path", port: 443 },
      { token: "wed_marker", host: "example.com?q=1", port: 443 },
      { token: "wed_marker", host: "user@example.com", port: 443 },
      { token: "wed_marker", host: "Example.com", port: 443 },
      { token: "wed_marker", host: "example.com", port: 0 },
      { token: "t", host: "abc:def", port: 443 },
      { token: "t", host: `${"a".repeat(64)}.example`, port: 443 },
      { token: "", host: "example.com", port: 443 },
      { token: "wed_marker", host: "example.com", port: 443, path: "/x" },
    ]) {
      expect((await handler(post(body))).status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  test("a store that fails answers 503", async () => {
    const { handler } = setup(async () => {
      throw new Error("down");
    });
    const response = await handler(
      post({ token: "wed_marker", host: "example.com", port: 443 }),
    );
    expect(response.status).toBe(503);
  });

  test("the denial path is taken off the authorizer's listener, nothing else", async () => {
    const seen: string[] = [];
    const route = routeEgressDenials(
      async () => {
        seen.push("denials");
        return new Response(null, { status: 204 });
      },
      async () => {
        seen.push("authorizer");
        return new Response(null, { status: 404 });
      },
    );
    await route(new Request(URL_OF, { method: "POST" }));
    await route(
      new Request("http://authorizer.internal/authorize", { method: "POST" }),
    );
    expect(seen).toEqual(["denials", "authorizer"]);
  });
});

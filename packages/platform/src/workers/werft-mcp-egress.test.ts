import { describe, expect, test } from "bun:test";
import { verifyBuiltinMcpGrant } from "../action/github/github-mcp-server.ts";
import { WERFT_MCP_METHODS } from "../werft-mcp/index.ts";
import {
  createWerftMcpEgress,
  WERFT_MCP_UPSTREAM_PATH,
} from "./werft-mcp-egress.ts";

const KEY = new Uint8Array(32).fill(3);
const NOW = 1_800_000_000_000;
const fenced = { sessionId: "session-1", attemptId: "att_1" };
const decide = createWerftMcpEgress({ grantKey: KEY, now: () => NOW });
const request = (method: string | null, tool: string | null = null) => ({
  server: "werft",
  rpc: { method, tool },
  regrant: false,
});

describe("the werft MCP route's decision", () => {
  test("grants every method the server answers with a grant for the fenced session, to the built-in path", async () => {
    for (const method of [
      ...WERFT_MCP_METHODS,
      "notifications/cancelled",
      null,
    ]) {
      const decision = await decide(fenced, request(method, "anything"));
      if (decision.kind !== "granted") throw new Error(`${method} refused`);
      expect(decision.upstream.url).toBe(WERFT_MCP_UPSTREAM_PATH);
      const [[name, value] = []] = decision.upstream.headers ?? [];
      expect(name).toBe("authorization");
      expect(
        verifyBuiltinMcpGrant(KEY, (value ?? "").replace(/^Bearer /, ""), NOW),
      ).toEqual(fenced);
    }
  });

  test("a grant signed with another key is not this server's", async () => {
    const decision = await decide(fenced, request("ping"));
    if (decision.kind !== "granted") throw new Error("refused");
    const [[, value] = []] = decision.upstream.headers ?? [];
    expect(
      verifyBuiltinMcpGrant(
        new Uint8Array(32).fill(4),
        (value ?? "").replace(/^Bearer /, ""),
        NOW,
      ),
    ).toBeNull();
  });

  test("refuses a method the server does not answer", async () => {
    expect(await decide(fenced, request("logging/setLevel"))).toEqual({
      kind: "refused",
      status: 403,
      code: "FORBIDDEN",
      message: "JSON-RPC method logging/setLevel is not routed",
    });
  });
});

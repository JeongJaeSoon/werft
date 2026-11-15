import { describe, expect, test } from "bun:test";
import type {
  WorkspaceMcpEgressStore,
  WorkspaceMcpRefusalRecord,
  WorkspaceMcpSessionState,
} from "../ports/workspace-mcp-egress.ts";
import {
  createWorkspaceMcpEgress,
  type WorkspaceMcpCallCredential,
} from "./workspace-mcp-egress.ts";

const SERVER_ID = "6f9a2d4e-1b3c-4d5e-8f70-123456789abc";
const state: WorkspaceMcpSessionState = {
  ownerId: "owner-a",
  workspaceId: "ws-1",
  agentId: "agent-1",
  releaseId: "rel-1",
  serverId: SERVER_ID,
  available: true,
  url: "https://docs.example.test/mcp",
  connection: { state: "active", generation: 3 },
  tools: ["mcp__docs__search"],
  turnId: "7",
  actor: null,
};
const fenced = { sessionId: "sess-1", attemptId: "att-1" };
const call = (tool: string | null, method: string | null = "tools/call") => ({
  server: "docs",
  rpc: { method, tool },
  regrant: false,
});

function egress(
  current: Partial<WorkspaceMcpSessionState> | null = {},
  options: {
    credential?: WorkspaceMcpCallCredential | null;
    failRecord?: boolean;
  } = {},
) {
  const recorded: WorkspaceMcpRefusalRecord[] = [];
  const asked: Array<{ server: string }> = [];
  const credentialCalls: Array<[string, string]> = [];
  const store: WorkspaceMcpEgressStore = {
    async sessionState(input) {
      asked.push({ server: input.server });
      return current === null ? null : { ...state, ...current };
    },
    async recordRefusal(record) {
      if (options.failRecord) throw new Error("db down");
      recorded.push(record);
    },
  };
  const errors: unknown[] = [];
  const decide = createWorkspaceMcpEgress({
    store,
    credentialFor: async (workspaceId, serverId) => {
      credentialCalls.push([workspaceId, serverId]);
      return options.credential === undefined
        ? { kind: "bearer", token: "example-static-value" }
        : options.credential;
    },
    onReceiptError: (error) => errors.push(error),
  });
  return { decide, recorded, asked, credentialCalls, errors };
}

describe("createWorkspaceMcpEgress", () => {
  test("a route the snapshot does not name is left to the other decisions", async () => {
    const { decide, recorded, credentialCalls } = egress(null);
    expect(await decide(fenced, call("search"))).toBeNull();
    expect(recorded).toEqual([]);
    expect(credentialCalls).toEqual([]);
  });

  test("grants a stored tool and the handshake with the row's URL and the stored credential", async () => {
    const { decide, recorded, credentialCalls } = egress();
    for (const request of [
      call("search"),
      call(null, "initialize"),
      call(null, "ping"),
      call(null, "tools/list"),
      call(null, "notifications/initialized"),
      call(null, null),
    ]) {
      expect(await decide(fenced, request)).toEqual({
        kind: "granted",
        upstream: {
          url: "https://docs.example.test/mcp",
          headers: [["authorization", "Bearer example-static-value"]],
        },
      });
    }
    expect(recorded).toEqual([]);
    expect(credentialCalls[0]).toEqual(["ws-1", SERVER_ID]);
  });

  test("an OAuth connection sends its access token", async () => {
    const { decide } = egress(
      {},
      { credential: { kind: "oauth", accessToken: "example-access-value" } },
    );
    const decision = await decide(fenced, call("search"));
    expect(decision?.kind === "granted" && decision.upstream.headers).toEqual([
      ["authorization", "Bearer example-access-value"],
    ]);
  });

  test("a tool outside the current list, or a method outside the allowlist, is refused without a receipt", async () => {
    const { decide, recorded, credentialCalls } = egress();
    for (const request of [
      call("delete_everything"),
      call(null),
      call(null, "resources/read"),
      call(null, "prompts/get"),
    ]) {
      const decision = await decide(fenced, request);
      expect(decision?.kind).toBe("refused");
      expect(decision?.kind === "refused" && decision.code).toBe("FORBIDDEN");
    }
    expect(recorded).toEqual([]);
    expect(credentialCalls).toEqual([]);
  });

  test("a tool of the same name on another server is not this server's", async () => {
    const { decide } = egress({ tools: ["mcp__docs_x__search"] });
    expect((await decide(fenced, call("search")))?.kind).toBe("refused");
  });

  const refusals: Array<
    [string, Partial<WorkspaceMcpSessionState>, string, number | null]
  > = [
    [
      "the server turned off",
      { available: false },
      "workspace_server_unavailable",
      3,
    ],
    [
      "the server row gone",
      { available: false, url: null, connection: null },
      "workspace_server_unavailable",
      null,
    ],
    [
      "a connection that needs reauth",
      { connection: { state: "needs_reauth", generation: 4 } },
      "oauth_needs_reauth",
      4,
    ],
    [
      "a disconnected server",
      { connection: { state: "none", generation: 5 } },
      "credential_unavailable",
      5,
    ],
  ];
  for (const [what, current, reason, generation] of refusals) {
    test(`${what} is refused with a ${reason} receipt naming the server and generation`, async () => {
      const { decide, recorded, credentialCalls } = egress(current);
      const decision = await decide(fenced, call("search"));
      expect(decision).toMatchObject({
        kind: "refused",
        status: 403,
        code: "CREDENTIAL_UNBOUND",
      });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.status).toBe("failed");
      expect(recorded[0]?.result).toEqual({
        attempt_id: "att-1",
        agent_id: "agent-1",
        release_id: "rel-1",
        server_id: "docs",
        workspace_server_id: SERVER_ID,
        connection_generation: generation,
        reason: reason as WorkspaceMcpRefusalRecord["result"]["reason"],
      });
      expect(decision?.kind === "refused" && decision.receiptId).toBe(
        recorded[0]?.id as string,
      );
      expect(credentialCalls).toEqual([]);
    });
  }

  test("no credential to send is refused with credential_unavailable", async () => {
    const { decide, recorded } = egress({}, { credential: null });
    expect((await decide(fenced, call("search")))?.kind).toBe("refused");
    expect(recorded[0]?.result.reason).toBe("credential_unavailable");
  });

  test("a cut exchange is recorded as unknown, under another receipt than a failed one", async () => {
    const { decide, recorded } = egress({ available: false });
    await decide(fenced, call("search"));
    await decide(fenced, { ...call("search"), regrant: true });
    expect(recorded.map((record) => record.status)).toEqual([
      "failed",
      "unknown",
    ]);
    expect(recorded[0]?.id).not.toBe(recorded[1]?.id as string);
  });

  test("the same refusal twice names one receipt", async () => {
    const { decide, recorded } = egress({ available: false });
    await decide(fenced, call("search"));
    await decide(fenced, call("search"));
    expect(recorded[0]?.id).toBe(recorded[1]?.id as string);
  });

  test("a receipt that cannot be written still refuses, without an id", async () => {
    const { decide, errors } = egress(
      { available: false },
      { failRecord: true },
    );
    const decision = await decide(fenced, call("search"));
    expect(decision?.kind).toBe("refused");
    expect(decision?.kind === "refused" && "receiptId" in decision).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

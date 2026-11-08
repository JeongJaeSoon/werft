import { describe, expect, test } from "bun:test";
import type {
  McpEgressStore,
  McpRefusalRecord,
  McpSessionState,
} from "../ports/mcp-egress.ts";
import { mcpBinding, type SessionCatalog } from "../sessions/catalog.ts";
import { createMcpEgress, uuidV5 } from "./mcp-egress.ts";

const server = {
  url: "http://fake-mcp:4020/mcp",
  credential_ref: "mcp/fake",
  auth: {
    kind: "bearer" as const,
    value: "sa-value",
    ref: { value_env: "FAKE_MCP_SA" },
  },
  workspaces: ["default"],
};
const catalog: SessionCatalog = {
  profiles: {},
  repositories: {},
  mcp_servers: { fake: server },
};
const state: McpSessionState = {
  ownerId: "owner-a",
  workspaceSlug: "default",
  agentId: "agent-1",
  releaseId: "rel-1",
  server: "fake",
  tools: ["mcp__fake__whoami"],
  boundRefs: ["mcp/fake"],
  turnId: "turn-1",
  actor: null,
};
const fenced = {
  sessionId: "sess-1",
  attemptId: "att-1",
  binding: mcpBinding("rel-1", "fake", server),
};
const call = (tool: string | null, method = "tools/call") => ({
  server: "fake",
  rpc: { method, tool },
  regrant: false,
});

function egress(
  current: Partial<McpSessionState> | null = {},
  options: { failRecord?: boolean } = {},
) {
  const recorded: McpRefusalRecord[] = [];
  const store: McpEgressStore = {
    async sessionState() {
      return current === null ? null : { ...state, ...current };
    },
    async recordRefusal(record) {
      if (options.failRecord) throw new Error("db down");
      recorded.push(record);
    },
  };
  const errors: unknown[] = [];
  const decide = createMcpEgress({
    catalog,
    store,
    onReceiptError: (error) => errors.push(error),
  });
  return { decide, recorded, errors };
}

describe("createMcpEgress", () => {
  test("grants a pinned tool and the handshake with the catalog's bearer", async () => {
    const { decide, recorded } = egress();
    for (const request of [
      call("whoami"),
      call(null, "initialize"),
      call(null, "tools/list"),
      call(null, "notifications/initialized"),
      { ...call(null), rpc: { method: null, tool: null } },
    ]) {
      expect(await decide(fenced, request)).toEqual({
        kind: "granted",
        upstream: {
          url: server.url,
          headers: [["authorization", "Bearer sa-value"]],
        },
      });
    }
    expect(recorded).toEqual([]);
  });

  test("refuses an unpinned tool or method without a receipt", async () => {
    const { decide, recorded } = egress();
    for (const request of [
      call("other"),
      call(null),
      call(null, "resources/read"),
      call(null, "prompts/get"),
    ]) {
      expect(await decide(fenced, request)).toMatchObject({
        kind: "refused",
        code: "FORBIDDEN",
      });
    }
    expect(
      await decide(fenced, { ...call("whoami"), server: "other" }),
    ).toMatchObject({ code: "FORBIDDEN" });
    expect(await egress(null).decide(fenced, call("whoami"))).toMatchObject({
      code: "FORBIDDEN",
    });
    expect(recorded).toEqual([]);
  });

  test("an unbound credential is refused with one failed receipt per turn", async () => {
    const { decide, recorded } = egress({ boundRefs: [] });
    const first = await decide(fenced, call("whoami"));
    const again = await decide(fenced, call(null, "tools/list"));
    expect(first).toMatchObject({
      kind: "refused",
      status: 403,
      code: "CREDENTIAL_UNBOUND",
    });
    expect(first.kind === "refused" && first.receiptId).toBe(
      uuidV5(
        JSON.stringify([
          "att-1",
          "fake",
          "credential_unbound",
          "turn-1",
          "failed",
        ]),
      ),
    );
    expect(again).toEqual(first);
    expect(recorded).toHaveLength(2);
    expect(new Set(recorded.map((r) => r.id)).size).toBe(1);
    expect(recorded[0]).toMatchObject({
      ownerId: "owner-a",
      sessionId: "sess-1",
      turnId: "turn-1",
      status: "failed",
      result: {
        attempt_id: "att-1",
        agent_id: "agent-1",
        release_id: "rel-1",
        server_id: "fake",
        reason: "credential_unbound",
      },
    });
    expect(JSON.stringify(recorded)).not.toContain("sa-value");
  });

  test("an exchange cut under way is an unknown receipt of its own", async () => {
    const { decide, recorded } = egress({ boundRefs: [] });
    const cut = await decide(fenced, { ...call("whoami"), regrant: true });
    const fresh = await decide(fenced, call("whoami"));
    expect(recorded.map((r) => r.status)).toEqual(["unknown", "failed"]);
    expect(cut.kind === "refused" && cut.receiptId).not.toBe(
      fresh.kind === "refused" && fresh.receiptId,
    );
  });

  test("a workspace the catalog does not list, or a moved server, is the same refusal", async () => {
    for (const [current, binding, reason] of [
      [{ workspaceSlug: "other" }, fenced.binding, "workspace_not_allowed"],
      [{ workspaceSlug: null }, fenced.binding, "workspace_not_allowed"],
      [
        {},
        mcpBinding("rel-1", "fake", { ...server, url: "http://x.test/mcp" }),
        "catalog_moved",
      ],
    ] as const) {
      const { decide, recorded } = egress(current);
      expect(
        await decide({ ...fenced, binding }, call("whoami")),
      ).toMatchObject({
        code: "CREDENTIAL_UNBOUND",
      });
      expect(recorded[0]?.result.reason).toBe(reason);
    }
  });

  test("a receipt that cannot be written leaves the refusal standing", async () => {
    const { decide, errors } = egress({ boundRefs: [] }, { failRecord: true });
    const refused = await decide(fenced, call("whoami"));
    expect(refused).toMatchObject({
      kind: "refused",
      code: "CREDENTIAL_UNBOUND",
    });
    expect(refused).not.toHaveProperty("receiptId");
    expect(errors).toHaveLength(1);
  });
});

describe("uuidV5", () => {
  test("is a stable version 5 UUID", () => {
    const id = uuidV5("x");
    expect(id).toBe(uuidV5("x"));
    expect(id).not.toBe(uuidV5("y"));
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

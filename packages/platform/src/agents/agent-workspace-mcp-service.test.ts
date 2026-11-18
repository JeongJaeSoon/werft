import { describe, expect, test } from "bun:test";
import { callerFor, createAuthorizationPolicy } from "../musterrolle/policy.ts";
import { createAgentWorkspaceMcpService } from "./agent-workspace-mcp-service.ts";
import type {
  AgentWorkspaceMcpStore,
  PutAgentWorkspaceMcpServersResult,
} from "./ports/agent-workspace-mcp-store.ts";

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const USER = "019a0000-0000-7000-8000-0000000000d1";
const SERVER = "019a0000-0000-7000-8000-0000000000e1";

const owner = (surface: "web" | "api") =>
  callerFor(
    {
      kind: "user",
      id: USER,
      workspace_id: WORKSPACE,
      role: "owner",
      scopes: ["sessions:read", "sessions:write"],
    },
    { kind: surface },
    crypto.randomUUID(),
  );

type Put = Parameters<AgentWorkspaceMcpStore["put"]>[0];

function serviceWith(result: PutAgentWorkspaceMcpServersResult) {
  const puts: Put[] = [];
  const store: AgentWorkspaceMcpStore = {
    list: async () => [],
    async put(input) {
      puts.push(input);
      return result;
    },
  };
  return {
    puts,
    service: createAgentWorkspaceMcpService({
      authorization: createAuthorizationPolicy({}),
      store,
    }),
  };
}

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    const failure = error as {
      code: string;
      details?: { reason_code?: string; field?: string };
    };
    return `${failure.code}:${failure.details?.reason_code ?? ""}:${failure.details?.field ?? ""}`;
  }
  return "saved";
};

describe("the agent workspace MCP service", () => {
  test("only a signed-in console user saves, and the store gets that person", async () => {
    const { service, puts } = serviceWith({
      outcome: "saved",
      receiptId: null,
    });
    expect(
      await refusal(service.put(owner("api"), AGENT, { server_ids: [] })),
    ).toBe("FORBIDDEN:web_session_required:");
    expect(puts).toHaveLength(0);
    await service.put(owner("web"), AGENT, {
      server_ids: [SERVER.toUpperCase()],
    });
    expect(puts[0]).toMatchObject({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      serverIds: [SERVER],
      userId: USER,
    });
  });

  test("each store refusal maps to its error", async () => {
    const cases: [PutAgentWorkspaceMcpServersResult, string][] = [
      [
        { outcome: "server_unknown", at: 2 },
        "BAD_REQUEST:server_unknown:server_ids.2",
      ],
      [{ outcome: "not_found" }, "NOT_FOUND::"],
      [{ outcome: "actor_inactive" }, "FORBIDDEN::"],
      [{ outcome: "outranked" }, "FORBIDDEN:role:"],
    ];
    for (const [result, expected] of cases) {
      const { service } = serviceWith(result);
      expect(
        await refusal(
          service.put(owner("web"), AGENT, { server_ids: [SERVER] }),
        ),
      ).toBe(expected);
    }
  });

  test("an id named twice in any case is refused before the store", async () => {
    const { service, puts } = serviceWith({
      outcome: "saved",
      receiptId: null,
    });
    expect(
      await refusal(
        service.put(owner("web"), AGENT, {
          server_ids: [SERVER, SERVER.toUpperCase()],
        }),
      ),
    ).toBe("BAD_REQUEST:duplicate:server_ids.1");
    expect(puts).toHaveLength(0);
  });
});

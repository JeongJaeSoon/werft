import { describe, expect, test } from "bun:test";
import {
  type AuthorizationDecision,
  INITIATOR_ROOT_KINDS,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import type { AgentRecord } from "../agents/ports/agent-store.ts";
import {
  type ConversationTurnListStore,
  createConversationTurnListService,
} from "./conversation-turn-list.ts";
import { SessionServiceError } from "./service-errors.ts";

const WORKSPACE = "019a0000-0000-7000-8000-000000000021";
const AGENT = "019a0000-0000-7000-8000-000000000022";

function service(allow = true, exists = true) {
  const authorized: unknown[] = [];
  const paged: Parameters<ConversationTurnListStore["page"]>[0][] = [];
  const list = createConversationTurnListService({
    authorization: {
      authorize: async (request: unknown) => {
        authorized.push(request);
        return (allow
          ? { outcome: "allow", reason_code: "ok" }
          : {
              outcome: "deny",
              reason_code: "role",
              effective_scopes: [],
            }) as unknown as AuthorizationDecision;
      },
    },
    agents: {
      get: async (workspaceId, agentId) =>
        exists && workspaceId === WORKSPACE && agentId === AGENT
          ? ({ id: AGENT } as unknown as AgentRecord)
          : null,
    },
    store: {
      page: async (input) => {
        paged.push(input);
        return { items: [], nextCursor: "next" };
      },
    },
  });
  return { list, authorized, paged };
}

describe("who reads an agent's conversation turns", () => {
  test("one refused conversation_turn.read on the agent reads nothing", async () => {
    const { list, authorized, paged } = service(false);
    await expect(
      list.listConversationTurns(testCaller(WORKSPACE), AGENT, { limit: 50 }),
    ).rejects.toBeInstanceOf(SessionServiceError);
    expect(JSON.stringify(authorized)).toContain("conversation_turn.read");
    expect(JSON.stringify(authorized)).toContain(AGENT);
    expect(paged).toEqual([]);
  });

  test("one allowed reads the page of the workspace's agent as asked", async () => {
    const { list, paged } = service();
    const page = await list.listConversationTurns(
      testCaller(WORKSPACE),
      AGENT,
      {
        limit: 20,
        cursor: "abc",
      },
    );
    expect(page).toEqual({ items: [], next_cursor: "next" });
    expect(paged).toEqual([
      {
        workspaceId: WORKSPACE,
        agentId: AGENT,
        rootKinds: null,
        cursor: "abc",
        limit: 20,
      },
    ]);
  });

  test("an agent the workspace does not hold, or no longer, is 404 and reads nothing", async () => {
    const { list, paged } = service(true, false);
    const refused = await list
      .listConversationTurns(testCaller(WORKSPACE), AGENT, { limit: 50 })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SessionServiceError);
    expect((refused as SessionServiceError).code).toBe("NOT_FOUND");
    expect(paged).toEqual([]);
  });

  test("initiator reads the shared split of root kinds", async () => {
    const { list, paged } = service();
    for (const initiator of ["person", "agent"] as const) {
      await list.listConversationTurns(testCaller(WORKSPACE), AGENT, {
        limit: 50,
        initiator,
      });
    }
    expect(paged.map((input) => input.rootKinds)).toEqual([
      INITIATOR_ROOT_KINDS.person,
      INITIATOR_ROOT_KINDS.agent,
    ]);
  });
});

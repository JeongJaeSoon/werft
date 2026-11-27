import { describe, expect, test } from "bun:test";
import type { ConversationTurnId } from "@werft-ai/contracts";
import {
  type ConversationRouteStore,
  type PendingConversationRoute,
  routeConversationTurn,
} from "./conversation-routes.ts";

const TURN = "00000000-0000-4000-8000-000000000001" as ConversationTurnId;
const ROUTE = {
  turnId: TURN,
  workspaceId: "w",
  agentId: "a",
  conversationId: "c",
  topicId: "t",
  sessionId: "s",
  thread: {
    installationId: "i",
    slackAppId: "app",
    teamId: "T",
    channelId: "C",
    threadTs: "2.0",
    messageTs: "2.0",
  },
  requesterUserId: "u",
  subject: { subject: { kind: "user" } },
  sources: null,
} as unknown as PendingConversationRoute;

/**
 * Another run of the same turn writes its input while this one is on its
 * way: at this run's first end (`settle`), or while it judges the right
 * (`authorize`). The store's receipt guard holds back every end but routed
 * once the input is in.
 */
function harness(lands: "settle" | "authorize") {
  let handed = false;
  const settled: [string, unknown][] = [];
  const told: unknown[] = [];
  const store: ConversationRouteStore = {
    pending: async () => ROUTE,
    handed: async () => handed,
    sourceDeleted: async () => false,
    // Gone: this run can only end the turn failed.
    requestText: async () => null,
    openTask: async () => ({ channelId: "C", threadTs: "1.0" }),
    settle: async (_route, effect, _line, mirror) => {
      if (lands === "settle") handed = true;
      if (effect !== "routed" && handed) return false;
      settled.push([effect, mirror]);
      return true;
    },
  };
  const run = () =>
    routeConversationTurn(
      {
        store,
        authorization: {
          authorize: async () => {
            if (lands === "authorize") {
              handed = true;
              return { outcome: "deny", reason_code: "x" } as never;
            }
            return { outcome: "allow" } as never;
          },
        },
        sessions: {
          appendMessage: async () => {
            throw new Error("not called");
          },
        },
        tellRequester: async (_route, notice) => {
          told.push(notice);
          return true;
        },
        connectUrl: "https://example.test/connect",
        logger: { info() {}, warn() {} },
      },
      TURN,
    );
  return { run, settled, told };
}

describe("routeConversationTurn beside another run of the same turn", () => {
  test("an end the other run's input holds back is recorded as routed, with its mirror", async () => {
    const h = harness("settle");
    expect(await h.run()).toBe("routed");
    expect(h.settled).toEqual([
      ["routed", { channelId: "C", threadTs: "1.0" }],
    ]);
  });

  test("a refusal is not told once the other run's input is in the task", async () => {
    const h = harness("authorize");
    expect(await h.run()).toBe("routed");
    expect(h.told).toEqual([]);
    expect(h.settled.map(([effect]) => effect)).toEqual(["routed"]);
  });
});

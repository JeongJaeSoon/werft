import { describe, expect, test } from "bun:test";
import type { ConversationTurnId } from "@werft-ai/contracts";
import { SessionServiceError } from "../access-control/index.ts";
import {
  type ConversationRouteStore,
  type ConversationRouteTask,
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
    openTask: async () => ({
      kind: "linked",
      channelId: "C",
      threadTs: "1.0",
      openedByTs: "1.0",
    }),
    bindStandalone: async () => {
      throw new Error("not called");
    },
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

// A DM turn naming its person's standalone session (v1-b/DM3).
const DM_ROUTE = {
  ...ROUTE,
  thread: {
    ...ROUTE.thread,
    channelId: "D1",
    threadTs: "5.0",
    messageTs: "5.1",
  },
  dm: { personUserId: "u", surfaceBindingId: "b" },
} as unknown as PendingConversationRoute;

function standalone(options: {
  found: ConversationRouteTask | null;
  bind?: "bound" | "gone" | "thread_taken" | "other_parent";
  append?: () => Promise<void>;
}) {
  const steps: string[] = [];
  const settled: [string, unknown, unknown][] = [];
  const store: ConversationRouteStore = {
    pending: async () => DM_ROUTE,
    handed: async () => false,
    sourceDeleted: async () => false,
    requestText: async () => "carry on",
    openTask: async () => options.found,
    bindStandalone: async () => {
      steps.push("bind");
      return options.bind ?? "bound";
    },
    settle: async (_route, effect, line, mirror) => {
      steps.push(`settle:${effect}`);
      settled.push([effect, line, mirror]);
      return true;
    },
  };
  const run = () =>
    routeConversationTurn(
      {
        store,
        authorization: {
          authorize: async () => ({ outcome: "allow" }) as never,
        },
        sessions: {
          appendMessage: async () => {
            steps.push("append");
            await options.append?.();
            return {} as never;
          },
        },
        tellRequester: async () => true,
        connectUrl: "https://example.test/connect",
        logger: { info() {}, warn() {} },
      },
      TURN,
    );
  return { run, steps, settled };
}

describe("routeConversationTurn to a DM person's standalone session", () => {
  test("binds the DM thread before the input, then tells the thread it is a task", async () => {
    const h = standalone({ found: { kind: "standalone" } });
    expect(await h.run()).toBe("routed");
    expect(h.steps).toEqual(["bind", "append", "settle:routed"]);
    expect(h.settled).toEqual([["routed", "routeStandalone", null]]);
  });

  test("a thread another link holds is not bound and nothing is written", async () => {
    const h = standalone({
      found: { kind: "standalone" },
      bind: "thread_taken",
    });
    expect(await h.run()).toBe("failed");
    expect(h.steps).toEqual(["bind", "settle:failed"]);
    expect(h.settled).toEqual([["failed", "routeFailed", null]]);
  });

  test("an input the session refuses is settled refused, which takes the binding back", async () => {
    const h = standalone({
      found: { kind: "standalone" },
      append: async () => {
        throw new SessionServiceError("FORBIDDEN", "no", undefined, {
          reason_code: "x",
        });
      },
    });
    expect(await h.run()).toBe("refused");
    expect(h.steps).toEqual(["bind", "append", "settle:refused"]);
  });

  test("a run after a crash finds its own binding: not bound again, still told", async () => {
    const h = standalone({
      found: {
        kind: "linked",
        channelId: "D1",
        threadTs: "5.0",
        openedByTs: "5.1",
      },
    });
    expect(await h.run()).toBe("routed");
    expect(h.steps).toEqual(["append", "settle:routed"]);
    expect(h.settled).toEqual([["routed", "routeStandalone", null]]);
  });

  test("a task already open in the thread is handed to as before, with no line", async () => {
    const h = standalone({
      found: {
        kind: "linked",
        channelId: "D1",
        threadTs: "5.0",
        openedByTs: "5.0",
      },
    });
    expect(await h.run()).toBe("routed");
    expect(h.settled).toEqual([["routed", null, null]]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_CALL_TOKEN_PREFIX,
  CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
} from "../limits/conversation-calls.ts";
import type {
  ConversationCallAuthorization,
  ConversationCallStore,
} from "../limits/ports/conversation-call-store.ts";
import type {
  EgressAuthorization,
  WorkerUnitOfWork,
} from "../ports/worker-unit-of-work.ts";
import type { JudgmentEgressStore } from "../sessions/achievements/achievement-judgment-store.ts";
import { JUDGMENT_TOKEN_PREFIX } from "../sessions/achievements/judgment-token.ts";
import {
  createCatalogRegistry,
  registryCatalog,
} from "../sessions/catalog-registry.ts";
import type { SettingsSnapshot } from "../sessions/installation-settings.ts";
import type { SessionTitleStore } from "../sessions/ports/session-title-store.ts";
import {
  type SessionTitler,
  TITLE_TOKEN_PREFIX,
} from "../sessions/session-titler.ts";
import { testConnection } from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
import { createWorkerGateway, WorkerGatewayError } from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const EXCHANGE = "5d0c9a8b-7e6f-4a3b-9c2d-1e0f9a8b7c6d";
const CALL = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";

function snapshot(
  generation: number,
  connections: SettingsSnapshot["connections"],
): SettingsSnapshot {
  return {
    generation,
    connections,
    judge_connections: {},
    repositories: {},
    mcp_servers: {},
    left_out: [],
    unavailable_repositories: new Set(),
    unavailable_connections: new Set(),
  };
}

const live = (generation: number) =>
  snapshot(generation, { "conn-1": testConnection() });
const disabled = (generation: number) => snapshot(generation, {});

/** What the database holds; a write raises the generation, as its trigger does. */
function storedSettings() {
  const state = { stored: live(1), reads: 0, failRead: null as Error | null };
  return {
    state,
    disable() {
      state.stored = disabled(state.stored.generation + 1);
    },
    registry: createCatalogRegistry({
      generation: { read: async () => state.stored.generation },
      settings: {
        read: async () => {
          state.reads += 1;
          if (state.failRead !== null) throw state.failRead;
          return state.stored;
        },
      },
    }),
  };
}

const sessionAuthorized: EgressAuthorization = {
  outcome: "ok",
  sessionId: SESSION,
  attemptId: "att_1",
  binding: "b",
  connectionId: "conn-1",
  model: "claude-sonnet-5",
  repository: null,
  githubPolicySource: "none",
  costUsd: 0,
  providerTokens: 0,
};

const callAuthorized: ConversationCallAuthorization = {
  outcome: "ok",
  callId: CALL as never,
  connectionId: "conn-1",
  path: "/v1/messages",
  model: "claude-sonnet-5",
  maxTokens: 1_000,
  maxRequestBytes: 100_000,
};

function harness(settings: ReturnType<typeof storedSettings>) {
  const order: string[] = [];
  const caughtUp = () => {
    order.push("caughtUp");
    return settings.registry.caughtUp();
  };
  const work = {
    async authorizeEgressAtomic() {
      order.push("fence");
      return sessionAuthorized;
    },
    async recordModelCutAtomic() {},
  } as unknown as WorkerUnitOfWork;
  const titles: SessionTitleStore = {
    issueAtomic: async () => {
      throw new Error("not reached");
    },
    async authorizeAtomic() {
      order.push("title");
      return {
        outcome: "ok",
        sessionId: SESSION,
        attemptId: "att_first",
        connectionId: "conn-1",
        model: "claude-sonnet-5",
        costUsd: 0,
        providerTokens: 0,
      };
    },
    settleAtomic: async () => {
      throw new Error("not reached");
    },
  };
  const titler: SessionTitler = { afterFirstTurn: () => new Promise(() => {}) };
  const calls = {
    async authorizeAtomic() {
      order.push("bind");
      return callAuthorized;
    },
    async authorizeTurnCallAtomic(input: {
      reserveFor: (permit: {
        connectionId: string;
        model: string;
        maxTokens: number;
        maxRequestBytes: number;
      }) => unknown;
    }) {
      order.push("reserve");
      const held = input.reserveFor({
        connectionId: "conn-1",
        model: "claude-sonnet-5",
        maxTokens: 1_000,
        maxRequestBytes: 100_000,
      });
      return held === null
        ? { outcome: "unavailable" }
        : { ...callAuthorized, outcome: "ok" };
    },
  } as unknown as ConversationCallStore;
  const judgments = {
    async authorizeToken() {
      order.push("judgment");
      return {
        outcome: "ok",
        judgmentId: "j",
        connectionId: "judge-1",
        dailyBudgetUsd: 1,
        spentUsd: 0,
      };
    },
  } as unknown as JudgmentEgressStore;
  const gateway = createWorkerGateway({
    work,
    catalog: registryCatalog({ repositories: {} }, settings.registry),
    checkpoints: acceptAllCheckpoints,
    titles: { store: titles, titler },
    conversationCalls: { store: calls },
    judgments: {
      store: judgments,
      // What the registry holds when the judgment is answered.
      upstream: async (id) =>
        settings.registry.settings?.connections[
          id === "judge-1" ? "conn-1" : id
        ]
          ? { url: "https://decisions.example.invalid", headers: [] }
          : null,
    },
    settingsCaughtUp: caughtUp,
    options: {
      sessionBudget: { costUsd: 1_000, tokens: null },
      leaseTtlMs: 30_000,
    },
  });
  return { gateway, order };
}

const asks = {
  session: (gateway: ReturnType<typeof harness>["gateway"]) =>
    gateway.authorizeEgress({ token: "wep_session", purpose: "provider" }),
  title: (gateway: ReturnType<typeof harness>["gateway"]) =>
    gateway.authorizeEgress({
      token: `${TITLE_TOKEN_PREFIX}title`,
      purpose: "provider",
    }),
  call: (gateway: ReturnType<typeof harness>["gateway"]) =>
    gateway.authorizeConversationCallEgress({
      token: `${CONVERSATION_CALL_TOKEN_PREFIX}call`,
      exchange_id: EXCHANGE,
    }),
  turn: (gateway: ReturnType<typeof harness>["gateway"]) =>
    gateway.authorizeConversationCallEgress({
      token: `${CONVERSATION_TURN_PERMIT_TOKEN_PREFIX}turn`,
      exchange_id: EXCHANGE,
    }),
  judgment: (gateway: ReturnType<typeof harness>["gateway"]) =>
    gateway.authorizeJudgmentEgress({ token: `${JUDGMENT_TOKEN_PREFIX}j` }),
};

const FIRST_STEP = {
  session: "fence",
  title: "title",
  call: "bind",
  turn: "reserve",
  judgment: "judgment",
} as const;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("granted");
}

describe("the provider and judgment routes read the settings generation first", () => {
  for (const route of Object.keys(asks) as Array<keyof typeof asks>) {
    test(`${route}: a connection disabled on another replica is refused at once, before ${FIRST_STEP[route]}`, async () => {
      const settings = storedSettings();
      await settings.registry.refresh();
      const { gateway, order } = harness(settings);
      // Granted while the connection is live: an open exchange's regrant
      // asks the same question again.
      await asks[route](gateway);
      expect(order).toEqual(["caughtUp", FIRST_STEP[route]]);
      order.length = 0;
      // Another replica's write: this registry's periodic read has not come.
      settings.disable();
      const refused = await refusal(asks[route](gateway));
      expect(refused).toBeInstanceOf(WorkerGatewayError);
      const { status, code } = refused as WorkerGatewayError;
      expect({ status, code }).toEqual(
        route === "judgment"
          ? { status: 503, code: "BACKEND_UNAVAILABLE" }
          : { status: 409, code: "CATALOG_MISMATCH" },
      );
      expect(order[0]).toBe("caughtUp");
      expect(settings.registry.settings?.generation).toBe(2);
    });

    test(`${route}: a settings read that fails refuses with its own error, and nothing after it runs`, async () => {
      const settings = storedSettings();
      await settings.registry.refresh();
      const { gateway, order } = harness(settings);
      settings.disable();
      const down = Object.assign(new Error("terminating connection"), {
        code: "57P01",
      });
      settings.state.failRead = down;
      // Not a WorkerGatewayError: the authorizer reads the store's own
      // error as storage unavailable, 503 retryable, and the proxy holds on.
      expect(await refusal(asks[route](gateway))).toBe(down);
      // No fence, no bind, no reserve: what was read before is not used.
      expect(order).toEqual(["caughtUp"]);
    });
  }

  test("before the first read, a session's call is judged on the settings read then, not on none", async () => {
    const settings = storedSettings();
    const { gateway } = harness(settings);
    const grant = await asks.session(gateway);
    expect(grant.upstream.url).toBe("https://api.anthropic.invalid");
    expect(settings.state.reads).toBe(1);
  });

  test("one read of the generation per request: a session token passes the conversation route without one", async () => {
    const settings = storedSettings();
    const { gateway, order } = harness(settings);
    expect(
      await gateway.authorizeConversationCallEgress({
        token: "wep_session",
        exchange_id: EXCHANGE,
      }),
    ).toBeNull();
    await asks.session(gateway);
    expect(order).toEqual(["caughtUp", "fence"]);
  });

  test("a repository grant does not wait on the settings generation", async () => {
    const settings = storedSettings();
    const { gateway, order } = harness(settings);
    await refusal(
      gateway.authorizeEgress({ token: "wer_repo", purpose: "repository" }),
    );
    expect(order).toEqual(["fence"]);
  });
});

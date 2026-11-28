import { describe, expect, test } from "bun:test";
import type {
  ConnectionNetwork,
  EgressUpstream,
  SessionCatalog,
} from "../catalog/catalog.ts";
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
import type { SessionTitleStore } from "../sessions/ports/session-title-store.ts";
import {
  type SessionTitler,
  TITLE_TOKEN_PREFIX,
} from "../sessions/session-titler.ts";
import { testConnection } from "../testing/catalog-fakes.ts";
import { acceptAllCheckpoints } from "../testing/checkpoints.ts";
import { createWorkerGateway } from "./worker-gateway.ts";

const SESSION = "0b3f1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
const EXCHANGE = "5d0c9a8b-7e6f-4a3b-9c2d-1e0f9a8b7c6d";
const CALL = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const INSIDE = "http://llm.corp:4000";
const JUDGE: EgressUpstream = { url: "http://judge.corp:4100", headers: [] };
const OWN = ["api", "postgres", "172.20.0.3"];

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

function harness(
  options: {
    network?: ConnectionNetwork;
    judgeNetwork?: ConnectionNetwork;
    /** null: the installation's hosts cannot all be told. */
    deny?: readonly string[] | null;
    operatorListed?: boolean;
    gate?: boolean;
  } = {},
) {
  const denyAsked: number[] = [];
  const catalog: SessionCatalog = {
    connections: {
      "conn-1": testConnection({
        provider: {
          kind: "anthropic",
          endpoint: INSIDE,
          auth: {
            kind: "api_key",
            value: "provider-key",
            ref: { stored: "connection:conn-1" },
          },
        },
        ...(options.network === undefined ? {} : { network: options.network }),
      }),
    },
    repositories: {},
  };
  const work = {
    authorizeEgressAtomic: async () => sessionAuthorized,
    recordModelCutAtomic: async () => {},
  } as unknown as WorkerUnitOfWork;
  const titles: SessionTitleStore = {
    issueAtomic: async () => {
      throw new Error("not reached");
    },
    authorizeAtomic: async () => ({
      outcome: "ok",
      sessionId: SESSION,
      attemptId: "att_first",
      connectionId: "conn-1",
      model: "claude-sonnet-5",
      costUsd: 0,
      providerTokens: 0,
    }),
    settleAtomic: async () => {
      throw new Error("not reached");
    },
  };
  const titler: SessionTitler = { afterFirstTurn: () => new Promise(() => {}) };
  const calls = {
    authorizeAtomic: async () => callAuthorized,
    async authorizeTurnCallAtomic(input: {
      reserveFor: (permit: {
        connectionId: string;
        model: string;
        maxTokens: number;
        maxRequestBytes: number;
      }) => unknown;
    }) {
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
    authorizeToken: async () => ({
      outcome: "ok",
      judgmentId: "j",
      connectionId: "judge-1",
      dailyBudgetUsd: 1,
      spentUsd: 0,
    }),
  } as unknown as JudgmentEgressStore;
  const gateway = createWorkerGateway({
    work,
    catalog,
    checkpoints: acceptAllCheckpoints,
    titles: { store: titles, titler },
    conversationCalls: { store: calls },
    judgments: {
      store: judgments,
      upstream: async () => JUDGE,
      network: () => options.judgeNetwork,
    },
    ...(options.gate === false
      ? {}
      : {
          privateUpstream: {
            deny: async () => {
              denyAsked.push(1);
              return options.deny === undefined ? OWN : options.deny;
            },
            operatorListed: () => options.operatorListed === true,
          },
        }),
    options: {
      sessionBudget: { costUsd: 1_000, tokens: null },
      leaseTtlMs: 30_000,
    },
  });
  return { gateway, denyAsked };
}

type Gateway = ReturnType<typeof harness>["gateway"];
const session = (gateway: Gateway, reads?: boolean) =>
  gateway.authorizeEgress({
    token: "session-token",
    purpose: "provider",
    ...(reads === undefined ? {} : { registeredPrivateUpstream: reads }),
  });
const title = (gateway: Gateway, reads?: boolean) =>
  gateway.authorizeEgress({
    token: `${TITLE_TOKEN_PREFIX}x`,
    purpose: "provider",
    ...(reads === undefined ? {} : { registeredPrivateUpstream: reads }),
  });
const judgment = (gateway: Gateway, reads?: boolean) =>
  gateway.authorizeJudgmentEgress({
    token: `${JUDGMENT_TOKEN_PREFIX}x`,
    ...(reads === undefined ? {} : { registeredPrivateUpstream: reads }),
  });

const UNMARKED: EgressUpstream = {
  url: INSIDE,
  headers: [["x-api-key", "provider-key"]],
};
const MARK: Pick<EgressUpstream, "allow" | "deny"> = {
  allow: "private",
  deny: OWN,
};

describe("a connection registered as private", () => {
  test("its session, title and judgment grants carry the private mark and the installation's hosts, for a proxy that reads the mark", async () => {
    const { gateway, denyAsked } = harness({
      network: "private",
      judgeNetwork: "private",
    });
    expect((await session(gateway, true)).upstream).toEqual({
      ...UNMARKED,
      ...MARK,
    });
    expect((await title(gateway, true)).upstream).toMatchObject(MARK);
    expect((await judgment(gateway, true)).upstream).toEqual({
      ...JUDGE,
      ...MARK,
    });
    // Collected for each grant by the process that answers it.
    expect(denyAsked).toHaveLength(3);
  });

  test("a proxy that does not say it reads the mark is refused the grant, before the hosts are even collected", async () => {
    const { gateway, denyAsked } = harness({
      network: "private",
      judgeNetwork: "private",
    });
    for (const reads of [false, undefined]) {
      for (const ask of [session, title, judgment]) {
        await expect(ask(gateway, reads)).rejects.toMatchObject({
          status: 403,
          code: "FORBIDDEN",
          reasonCode: "egress_proxy_outdated",
          retryable: false,
        });
      }
    }
    expect(denyAsked).toEqual([]);
  });

  test("on the operator's private allowlist, that proxy is granted as before the mark: unmarked, its own lists deciding", async () => {
    const { gateway } = harness({
      network: "private",
      judgeNetwork: "private",
      operatorListed: true,
    });
    const granted = await session(gateway, false);
    expect(granted.upstream).toEqual({
      url: INSIDE,
      headers: [["x-api-key", "provider-key"]],
    });
    expect((await judgment(gateway, false)).upstream).toEqual(JUDGE);
  });

  test("hosts that cannot all be told leave no private grant: a retryable refusal, never a mark with a shorter list", async () => {
    for (const operatorListed of [false, true]) {
      const { gateway } = harness({
        network: "private",
        judgeNetwork: "private",
        deny: null,
        operatorListed,
      });
      for (const ask of [session, title, judgment]) {
        await expect(ask(gateway, true)).rejects.toMatchObject({
          status: 503,
          code: "BACKEND_UNAVAILABLE",
          reasonCode: "private_deny_unavailable",
          retryable: true,
        });
      }
    }
  });

  test("a conversation call's grant never carries the mark: the proxy's own lists hold it", async () => {
    const { gateway, denyAsked } = harness({ network: "private" });
    for (const prefix of [
      CONVERSATION_CALL_TOKEN_PREFIX,
      CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
    ]) {
      const granted = await gateway.authorizeConversationCallEgress({
        token: `${prefix}x`,
        exchange_id: EXCHANGE,
      });
      expect(granted).toMatchObject({
        conversation_call_id: CALL,
        upstream: { url: INSIDE, headers: [["x-api-key", "provider-key"]] },
      });
      expect(
        Object.keys((granted as { upstream: object }).upstream).sort(),
      ).toEqual(["headers", "url"]);
    }
    expect(denyAsked).toEqual([]);
  });
});

describe("any other connection", () => {
  test("a public one, or one from before the network column, is granted unmarked whatever the proxy reads", async () => {
    for (const network of ["public", undefined] as const) {
      const { gateway, denyAsked } = harness({
        ...(network === undefined ? {} : { network, judgeNetwork: network }),
      });
      for (const reads of [true, false, undefined]) {
        expect((await session(gateway, reads)).upstream).toEqual({
          url: INSIDE,
          headers: [["x-api-key", "provider-key"]],
        });
        expect((await title(gateway, reads)).upstream).not.toHaveProperty(
          "allow",
        );
        expect((await judgment(gateway, reads)).upstream).toEqual(JUDGE);
      }
      expect(denyAsked).toEqual([]);
    }
  });

  test("a gateway given no way to tell the installation's hosts marks nothing", async () => {
    const { gateway } = harness({ network: "private", gate: false });
    expect((await session(gateway, true)).upstream).not.toHaveProperty("allow");
  });
});

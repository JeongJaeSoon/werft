import { describe, expect, test } from "bun:test";
import {
  conversationCallKeySchema,
  conversationIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
} from "@werft-ai/contracts";
import type { SessionCatalog } from "../catalog/index.ts";
import type { BudgetRoot } from "./budget-accounts.ts";
import {
  CONVERSATION_CALL_TOKEN_TTL_MS,
  CONVERSATION_TURN_PERMIT_TOKEN_PREFIX,
  createConversationCalls,
  hashConversationCallToken,
  OPERATOR_CALL_KEY_PREFIX,
} from "./conversation-calls.ts";
import type {
  ConversationCallIssueInput,
  ConversationCallStore,
  ConversationTurnPermitInput,
} from "./ports/conversation-call-store.ts";

const TURN = conversationTurnIdSchema.parse(
  "00000000-0000-4000-8000-0000000000d1",
);
const catalog = {
  connections: {
    conn: {
      provider: { kind: "anthropic", endpoint: "https://api.example.invalid" },
      models: ["claude-haiku-4-5"],
    },
  },
} as unknown as Pick<SessionCatalog, "connections">;

/** The calls over a store that records what it was asked to write. */
function calls() {
  const written: ConversationCallIssueInput[] = [];
  const permits: ConversationTurnPermitInput[] = [];
  const store = {
    issueAtomic: async (input: ConversationCallIssueInput) => {
      written.push(input);
      return { outcome: "issued", expiresAt: new Date() };
    },
    issueTurnPermitAtomic: async (input: ConversationTurnPermitInput) => {
      permits.push(input);
      return { outcome: "issued", expiresAt: new Date() };
    },
  } as unknown as ConversationCallStore;
  return {
    written,
    permits,
    calls: createConversationCalls({ store, catalog }),
  };
}

const call = {
  workspaceId: "00000000-0000-4000-8000-0000000000c2",
  agentId: "00000000-0000-4000-8000-0000000000a1",
  conversationId: conversationIdSchema.parse(
    "00000000-0000-4000-8000-0000000000b1",
  ),
  topicId: null,
  callClass: "m2" as const,
  releaseId: null,
  connectionId: "conn",
  model: "claude-haiku-4-5",
  maxTokens: 256,
  maxRequestBytes: 4_096,
};
const keyed = (key: string) => conversationCallKeySchema.parse(key);

const operatorTurn = {
  workspaceId: call.workspaceId,
  agentId: call.agentId,
  conversationId: call.conversationId,
  topicId: conversationTopicIdSchema.parse(
    "00000000-0000-4000-8000-0000000000e1",
  ),
  turnId: TURN,
  operator: "ops@api-host",
  releaseId: null,
  connectionId: "conn",
  model: "claude-haiku-4-5",
  maxTokens: 256,
  maxRequestBytes: 4_096,
  ttlMs: 180_000,
};

describe("an operator's conversation turn", () => {
  test("is written with a permit for an operator key's calls under the operator prefix, so its ledger rows are told apart", async () => {
    const { written, permits, calls: c } = calls();

    const issued = await c.issueOperatorTurn(operatorTurn);
    if (issued.outcome !== "issued") throw new Error(issued.outcome);
    expect(issued.token.startsWith(CONVERSATION_TURN_PERMIT_TOKEN_PREFIX)).toBe(
      true,
    );

    // Nothing is reserved when the turn is written: each call is, as asked.
    expect(written).toEqual([]);
    expect(permits).toHaveLength(1);
    const [permit] = permits;
    expect(permit?.root).toEqual({
      kind: "key",
      keyKind: "operator",
      createdByUserId: null,
    });
    expect(permit?.requester).toEqual({ kind: "operator", id: "ops@api-host" });
    expect(permit?.callKey).toBe(keyed(`operator-${TURN}:m2`));
    expect(permit?.callKey.startsWith(OPERATOR_CALL_KEY_PREFIX)).toBe(true);
    expect(permit?.path).toBe("/v1/messages");
    // Only its hash is kept.
    expect(permit?.tokenHash).toEqual(hashConversationCallToken(issued.token));
    // The permit lasts as long as the turn it is for, not a lone call's two minutes.
    expect(permit?.ttlMs).toBe(180_000);
    await expect(
      c.issueOperatorTurn({ ...operatorTurn, ttlMs: 0 }),
    ).rejects.toThrow(/ttlMs must be a positive integer/);
    expect(
      (await c.issueOperatorTurn({ ...operatorTurn, connectionId: "gone" }))
        .outcome,
    ).toBe("unavailable");
    expect(permits).toHaveLength(1);
  });

  test("cannot be issued the way every other call is: the root and the prefix are both refused, and nothing is written", async () => {
    const { written, calls: c } = calls();
    const operatorRoot: BudgetRoot = {
      kind: "key",
      keyKind: "operator",
      createdByUserId: null,
    };
    const attempts: [BudgetRoot, string][] = [
      [operatorRoot, "input-1:m2"],
      [{ kind: "user", userId: call.agentId }, `operator-${TURN}:m2`],
      [{ kind: "none" }, "operator-anything:m2"],
    ];
    for (const [root, key] of attempts) {
      await expect(
        c.issue({ ...call, root, callKey: keyed(key), attempt: 1 }),
      ).rejects.toThrow(/issueOperatorTurn alone/);
    }
    expect(written).toEqual([]);

    // Every other root and key goes through as before.
    for (const root of [
      { kind: "none" },
      { kind: "user", userId: call.agentId },
      { kind: "key", keyKind: "agent", createdByUserId: null },
      { kind: "slack_bot" },
    ] as BudgetRoot[]) {
      expect(
        (
          await c.issue({
            ...call,
            root,
            callKey: keyed("input-1:m2"),
            attempt: 1,
          })
        ).outcome,
      ).toBe("issued");
    }
    expect(
      written.some((input) =>
        input.callKey.startsWith(OPERATOR_CALL_KEY_PREFIX),
      ),
    ).toBe(false);
    // And each keeps a lone call's life.
    expect(new Set(written.map((input) => input.ttlMs))).toEqual(
      new Set([CONVERSATION_CALL_TOKEN_TTL_MS]),
    );
  });
});

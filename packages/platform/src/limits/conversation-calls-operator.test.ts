import { describe, expect, test } from "bun:test";
import {
  conversationCallKeySchema,
  conversationIdSchema,
} from "@werft-ai/contracts";
import type { SessionCatalog } from "../catalog/index.ts";
import type { BudgetRoot } from "./budget-accounts.ts";
import {
  CONVERSATION_CALL_TOKEN_TTL_MS,
  createConversationCalls,
  OPERATOR_CALL_KEY_PREFIX,
} from "./conversation-calls.ts";
import type {
  ConversationCallIssueInput,
  ConversationCallStore,
} from "./ports/conversation-call-store.ts";

const TURN = "00000000-0000-4000-8000-0000000000d1";
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
  const store = {
    issueAtomic: async (input: ConversationCallIssueInput) => {
      written.push(input);
      return { outcome: "issued", expiresAt: new Date() };
    },
  } as unknown as ConversationCallStore;
  return { written, calls: createConversationCalls({ store, catalog }) };
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

describe("an operator's conversation call", () => {
  test("is written as an operator key's call under the operator prefix, so its ledger row is told apart", async () => {
    const { written, calls: c } = calls();

    expect(
      (await c.issueForOperator({ ...call, turnId: TURN, ttlMs: 180_000 }))
        .outcome,
    ).toBe("issued");

    expect(written).toHaveLength(1);
    expect(written[0]?.root).toEqual({
      kind: "key",
      keyKind: "operator",
      createdByUserId: null,
    });
    expect(written[0]?.callKey).toBe(keyed(`operator-${TURN}:m2`));
    expect(written[0]?.callKey.startsWith(OPERATOR_CALL_KEY_PREFIX)).toBe(true);
    expect(written[0]?.attempt).toBe(1);
    // The permit lasts as long as the turn it is for, not a lone call's two minutes.
    expect(written[0]?.ttlMs).toBe(180_000);
    await expect(
      c.issueForOperator({ ...call, turnId: TURN, ttlMs: 0 }),
    ).rejects.toThrow(/ttlMs must be a positive integer/);
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
      ).rejects.toThrow(/issueForOperator alone/);
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

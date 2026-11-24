import { describe, expect, test } from "bun:test";
import {
  conversationCallKeySchema,
  conversationIdSchema,
} from "@werft-ai/contracts";
import type { SessionCatalog } from "../catalog/index.ts";
import {
  createConversationCalls,
  judgmentCallOf,
} from "./conversation-calls.ts";
import type { ConversationCallStore } from "./ports/conversation-call-store.ts";

const MODEL = "claude-haiku-4-5";
const provider = (kind: string) => ({
  kind,
  endpoint: "https://api.example.invalid",
  auth: { kind: "api_key", value: "k", ref: { stored: "c" } },
});
// The installation's connections as the catalog holds them: enabled, with a
// credential that resolves. A disabled or removed one is not here.
const catalog = {
  connections: {
    "conn-anthropic": { provider: provider("anthropic"), models: [MODEL] },
    "conn-litellm": { provider: provider("litellm"), models: [MODEL] },
    "conn-responses": {
      provider: provider("openai_responses"),
      models: ["gpt-5.5"],
    },
  },
} as unknown as Pick<SessionCatalog, "connections">;

function issueWith(connectionId: string, model = MODEL) {
  const reached: string[] = [];
  const store = {
    issueAtomic: async (input: { connectionId: string }) => {
      reached.push(input.connectionId);
      return { outcome: "issued", expiresAt: new Date() };
    },
  } as unknown as ConversationCallStore;
  return createConversationCalls({ store, catalog })
    .issue({
      workspaceId: "00000000-0000-4000-8000-0000000000c2",
      agentId: "00000000-0000-4000-8000-0000000000a1",
      conversationId: conversationIdSchema.parse(
        "00000000-0000-4000-8000-0000000000b1",
      ),
      topicId: null,
      callClass: "m1",
      releaseId: null,
      callKey: conversationCallKeySchema.parse("input-1:m1"),
      attempt: 1,
      root: { kind: "none" },
      connectionId,
      model,
      maxTokens: 256,
      maxRequestBytes: 4_096,
    })
    .then((result) => ({
      outcome: result.outcome,
      ...("reason" in result ? { reason: result.reason } : {}),
      reached,
    }));
}

describe("a conversation call runs only on a connection the installation holds", () => {
  test("a connection of the installation's list that serves Messages is issued", async () => {
    for (const id of ["conn-anthropic", "conn-litellm"]) {
      expect(await issueWith(id)).toEqual({ outcome: "issued", reached: [id] });
    }
  });

  test("a connection not in the list is unavailable before anything is reserved", async () => {
    // Inherited names too: a lookup must not reach the object's prototype.
    for (const id of [
      "conn-gone",
      "",
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
    ]) {
      expect(await issueWith(id)).toEqual({
        outcome: "unavailable",
        reason: "connection_missing",
        reached: [],
      });
    }
  });

  test("a listed connection that serves no Messages is unavailable", async () => {
    expect(await issueWith("conn-responses")).toEqual({
      outcome: "unavailable",
      reason: "connection_missing",
      reached: [],
    });
  });

  test("a model off the connection's list is unavailable before anything is reserved", async () => {
    expect(await issueWith("conn-anthropic", "claude-haiku-3")).toEqual({
      outcome: "unavailable",
      reason: "model_removed",
      reached: [],
    });
  });
});

describe("an agent's judgment calls use its release's judgment model", () => {
  const release = (
    snapshot: Record<string, unknown>,
    connection_id = "conn-anthropic",
  ) => ({
    id: "sha256:release",
    connection_id,
    runtime_config_snapshot: { model: MODEL, ...snapshot },
  });

  test("the judgment model when the card names one", () => {
    const catalogWith = {
      connections: {
        "conn-anthropic": {
          provider: provider("anthropic"),
          models: [MODEL, "claude-opus-4-5"],
        },
      },
    } as unknown as Pick<SessionCatalog, "connections">;
    expect(
      judgmentCallOf(
        catalogWith,
        release({ model: "claude-opus-4-5", judgment_model: MODEL }),
      ),
    ).toEqual({
      outcome: "ready",
      releaseId: "sha256:release",
      connectionId: "conn-anthropic",
      model: MODEL,
    });
  });

  test("the card's model when it names none", () => {
    expect(judgmentCallOf(catalog, release({}))).toEqual({
      outcome: "ready",
      releaseId: "sha256:release",
      connectionId: "conn-anthropic",
      model: MODEL,
    });
  });

  test("a judgment model off the list or a connection gone is a reason, not a fallback", () => {
    expect(
      judgmentCallOf(catalog, release({ judgment_model: "claude-haiku-3" })),
    ).toEqual({ outcome: "unavailable", reason: "model_removed" });
    expect(judgmentCallOf(catalog, release({}, "conn-gone"))).toEqual({
      outcome: "unavailable",
      reason: "connection_missing",
    });
  });
});

import { describe, expect, test } from "bun:test";
import {
  conversationIdSchema,
  conversationInputIdSchema,
  conversationJudgmentIdSchema,
  conversationTopicIdSchema,
} from "@werft-ai/contracts";
import type {
  ConversationCalls,
  ConversationTurnQueue,
  UnsolicitedTurnRequest,
} from "@werft-ai/platform";
import {
  createUnsolicitedConversationTurns,
  OPERATOR_TURN_MAX_TOKENS,
} from "./conversation-runtime.ts";

const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const PERMIT = "unasked-permit";

type Issue = Awaited<ReturnType<ConversationCalls["issueUnsolicitedTurn"]>>;
type Enqueued = Parameters<ConversationTurnQueue["enqueue"]>;

function harness(
  options: {
    issue?: Issue;
    queued?: "queued" | "duplicate" | "ended";
    release?: unknown;
  } = {},
) {
  const issued: Parameters<ConversationCalls["issueUnsolicitedTurn"]>[0][] = [];
  const enqueued: Enqueued[] = [];
  const ended: string[] = [];
  const released: string[] = [];
  const turns = createUnsolicitedConversationTurns({
    calls: {
      async issueUnsolicitedTurn(input) {
        issued.push(input);
        return (
          options.issue ?? {
            outcome: "issued",
            token: PERMIT,
            expiresAt: new Date(Date.now() + 180_000),
            place: "channel",
          }
        );
      },
      async endTurn(turnId) {
        ended.push(turnId);
        return {
          ended: "recorded",
          state: "no_decision",
          refusal: null,
          limit: null,
        };
      },
    },
    queue: {
      async enqueue(...args) {
        enqueued.push(args);
        return options.queued ?? "queued";
      },
    },
    statuses: {
      async releaseReset(turnId) {
        released.push(turnId);
      },
    },
    agents: {
      async get(workspaceId: string, agentId: string) {
        if (workspaceId !== WORKSPACE || agentId !== AGENT) return null;
        return {
          active_release:
            "release" in options
              ? options.release
              : {
                  id: "release-1",
                  connection_id: "anthropic",
                  runtime_config_snapshot: { model: "claude-haiku-5" },
                },
        };
      },
    } as never,
    catalog: {
      connections: {
        anthropic: {
          provider: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.com",
          },
        },
      },
    } as never,
  });
  const request: UnsolicitedTurnRequest = {
    judgmentId: conversationJudgmentIdSchema.parse(crypto.randomUUID()),
    workspaceId: WORKSPACE,
    agentId: AGENT,
    conversationId: conversationIdSchema.parse(crypto.randomUUID()),
    topicId: conversationTopicIdSchema.parse(crypto.randomUUID()),
    teamId: "T1",
    channelId: "C1",
    target: {
      inputId: conversationInputIdSchema.parse(crypto.randomUUID()),
      ts: "100.000002",
    },
    text: "where is the deploy doc?",
    sources: ["100.000002", "100.000001"],
  };
  return { turns, request, issued, enqueued, ended, released };
}

describe("an unasked turn's start (v1-b/U1)", () => {
  test("writes it on the judgment, queues it as the named post's first try, answer or quiet only", async () => {
    const h = harness();
    const started = await h.turns.start(h.request);
    expect(started.outcome).toBe("queued");
    expect(h.issued).toHaveLength(1);
    expect(h.issued[0]).toMatchObject({
      judgmentId: h.request.judgmentId,
      topicId: h.request.topicId,
      teamId: "T1",
      channelId: "C1",
      sources: ["100.000002", "100.000001"],
      releaseId: "release-1",
      connectionId: "anthropic",
      model: "claude-haiku-5",
    });
    const [[turn, at] = []] = h.enqueued;
    expect(turn).toMatchObject({
      turn_id: h.issued[0]?.turnId,
      scope: { topic_id: h.request.topicId },
      provider: { auth: { kind: "egress_token", token: PERMIT } },
      call: { max_tokens: OPERATOR_TURN_MAX_TOKENS },
      input: { id: h.request.target.inputId, text: h.request.text },
      decision_tools: ["reply", "no_reply"],
    });
    expect(at).toMatchObject({ inputId: h.request.target.inputId, attempt: 1 });
    expect(h.released).toEqual([h.issued[0]?.turnId as string]);
    expect(h.ended).toEqual([]);
  });

  test("a post queued before: the permit is ended unused, and it is a duplicate", async () => {
    const h = harness({ queued: "duplicate" });
    expect(await h.turns.start(h.request)).toEqual({ outcome: "duplicate" });
    expect(h.ended).toEqual([h.issued[0]?.turnId as string]);
    expect(h.released).toEqual([h.issued[0]?.turnId as string]);
  });

  test("ended as it was queued (a stop): the channel stopped", async () => {
    const h = harness({ queued: "ended" });
    expect(await h.turns.start(h.request)).toEqual({
      outcome: "channel_stopped",
    });
  });

  test("names why a turn was not made, and queues nothing", async () => {
    const cases: [Issue, string][] = [
      [{ outcome: "rollout_off" }, "rollout_off"],
      [{ outcome: "duplicate" }, "duplicate"],
      [{ outcome: "source_deleted" }, "source_deleted"],
      [{ outcome: "no_binding" }, "channel_stopped"],
      [{ outcome: "channel_stopped" }, "channel_stopped"],
      [{ outcome: "unknown_conversation" }, "unknown_conversation"],
      [
        { outcome: "unavailable", reason: "unknown_connection" } as never,
        "connection_unavailable",
      ],
    ];
    for (const [issue, outcome] of cases) {
      const h = harness({ issue });
      expect((await h.turns.start(h.request)).outcome).toBe(outcome as never);
      expect(h.enqueued).toEqual([]);
    }
  });

  test("before any permit: an unknown agent, no release, or a text too long", async () => {
    const unknown = harness();
    expect(
      (await unknown.turns.start({ ...unknown.request, agentId: WORKSPACE }))
        .outcome,
    ).toBe("unknown_agent");
    const noRelease = harness({ release: null });
    expect((await noRelease.turns.start(noRelease.request)).outcome).toBe(
      "no_active_release",
    );
    const long = harness();
    expect(
      (
        await long.turns.start({
          ...long.request,
          text: "x".repeat(1_000_000),
        })
      ).outcome,
    ).toBe("too_long");
    for (const h of [unknown, noRelease, long]) expect(h.issued).toEqual([]);
  });
});

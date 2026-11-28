import { describe, expect, test } from "bun:test";
import type {
  SurfaceOutboxClaim,
  SurfaceOutboxSettle,
  SurfaceOutboxStore,
} from "@werft-ai/platform";
import { createRowDelivery, slackOutboxSettleFor } from "./outbox-delivery.ts";
import {
  createSlackBotApi,
  type SlackBotSender,
  type SlackSendResponse,
} from "./slack-config-api.ts";
import { drainSlackOutbox } from "./slack-outbox.ts";
import {
  slackInstructionFallbackText,
  slackOutboxPresentation,
  slackOutboxText,
} from "./slack-outbox-render.ts";

const TABLE_REPLY = [
  "저장소는 2개입니다.",
  "",
  "| 저장소 | 상태 |",
  "| --- | --- |",
  "| acme/web | 기본 저장소 |",
  "| acme/api | 붙일 수 있음 |",
].join("\n");
const response = (
  over: Partial<SlackSendResponse> = {},
): SlackSendResponse => ({
  httpStatus: 200,
  retryAfterHeader: null,
  body: { ok: true, ts: "200.000200" },
  ...over,
});
const claim = (over: Partial<SurfaceOutboxClaim> = {}): SurfaceOutboxClaim => ({
  id: "outbox-1",
  claimToken: "claim-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  slackAppId: "app-1",
  installationId: "installation-1",
  kind: "reply",
  channelId: "C0OPS",
  threadTs: "100.000100",
  slackUserId: null,
  sessionId: "session-1",
  sessionLinkId: null,
  body: { text: "hi" },
  dedupeKey: "reply:link-1:1",
  attempts: 1,
  ...over,
});

describe("slackOutboxSettleFor", () => {
  test.each([
    ["3", 3_000],
    ["300", 300_000],
    ["86400", 300_000],
    [null, 1_000],
    ["0", 1_000],
    ["-3", 1_000],
    ["1e3", 1_000],
    ["1.5", 1_000],
  ])(
    "a 429 with Retry-After %p waits %p ms even without a body",
    (header, ms) => {
      expect(
        slackOutboxSettleFor(
          1,
          response({ httpStatus: 429, retryAfterHeader: header, body: null }),
        ),
      ).toEqual({ status: "pending", errorCode: "ratelimited", retryInMs: ms });
    },
  );

  test.each([429, 200])(
    "rate limit at HTTP %p never fails the row, however many attempts came before",
    (httpStatus) => {
      const limited = response({
        httpStatus,
        retryAfterHeader: "7",
        body: { ok: false, error: "ratelimited" },
      });
      for (const attempts of [1, 9, 10, 11, 100]) {
        for (const progress of [false, true]) {
          expect(slackOutboxSettleFor(attempts, limited, progress)).toEqual({
            status: "pending",
            errorCode: "ratelimited",
            retryInMs: 7_000,
          });
        }
      }
    },
  );

  test.each([
    [1, 30_000],
    [2, 60_000],
    [3, 120_000],
    [4, 240_000],
  ])("transient attempt %p waits %p ms", (attempts, retryInMs) => {
    expect(
      slackOutboxSettleFor(
        attempts,
        response({ body: { ok: false, error: "internal_error" } }),
      ),
    ).toEqual({ status: "pending", errorCode: "internal_error", retryInMs });
  });

  test("the fifth transient failure gives up; a permanent failure gives up immediately", () => {
    expect(
      slackOutboxSettleFor(
        5,
        response({ body: { ok: false, error: "internal_error" } }),
      ),
    ).toEqual({ status: "failed", errorCode: "internal_error" });
    expect(
      slackOutboxSettleFor(
        1,
        response({ body: { ok: false, error: "not_in_channel" } }),
      ),
    ).toEqual({ status: "failed", errorCode: "not_in_channel" });
    expect(slackOutboxSettleFor(1, response({ body: { ok: true } }))).toEqual({
      status: "failed",
      errorCode: "missing_ts",
    });
    expect(slackOutboxSettleFor(1, response())).toEqual({
      status: "sent",
      slackTs: "200.000200",
    });
  });

  test.each([200, 204, 299, 500, 503])(
    "unreadable HTTP %p is uncertain even at the attempt cap",
    (httpStatus) => {
      expect(
        slackOutboxSettleFor(10, response({ httpStatus, body: null })),
      ).toEqual({ status: "uncertain", errorCode: "unreadable_answer" });
    },
  );

  test("an unreadable 4xx follows ordinary retry policy", () => {
    expect(
      slackOutboxSettleFor(1, response({ httpStatus: 400, body: null })),
    ).toEqual({ status: "pending", errorCode: "http_400", retryInMs: 30_000 });
  });
});

describe("slackOutboxPresentation", () => {
  test("instruction sender takes precedence over explicit and generated blocks", () => {
    expect(
      slackOutboxPresentation(
        claim({
          kind: "instruction",
          body: {
            text: TABLE_REPLY,
            blocks: [{ type: "divider" }],
            sender: { username: "Owner", slack_user_id: "U0OWNER" },
          },
        }),
      ),
    ).toEqual({
      kind: "instruction",
      sender: { username: "Owner", slack_user_id: "U0OWNER" },
    });
  });

  test.each(["reply", "instruction", "input_notice"] as const)(
    "explicit blocks on %s take precedence over generated tables without fallback",
    (kind) => {
      expect(
        slackOutboxPresentation(
          claim({
            kind,
            body: { text: TABLE_REPLY, blocks: [{ type: "divider" }] },
          }),
        ),
      ).toEqual({
        kind: "blocks",
        blocks: [{ type: "divider" }],
        fallback: false,
      });
    },
  );

  test("a table reply has section, table and link blocks and row-list text", () => {
    const body = {
      text: TABLE_REPLY,
      link_url: "https://console.example/sessions/s1",
    };
    const presentation = slackOutboxPresentation(claim({ body }));
    expect(presentation.kind).toBe("blocks");
    if (presentation.kind !== "blocks") throw new Error("no table blocks");
    expect(presentation.fallback).toBe(true);
    expect(
      presentation.blocks.map((block) => (block as { type: string }).type),
    ).toEqual(["section", "table", "section"]);
    expect(slackOutboxText(body)).toContain("*acme/web* — 상태: 기본 저장소");
    expect(slackOutboxText(body)).not.toContain("```");
  });

  test.each(["instruction", "failure_notice", "notice"] as const)(
    "a table in %s stays text without explicit blocks",
    (kind) => {
      expect(
        slackOutboxPresentation(claim({ kind, body: { text: TABLE_REPLY } })),
      ).toEqual({ kind: "text" });
    },
  );

  test("a reply without a table stays text even with a stray sender", () => {
    expect(
      slackOutboxPresentation(
        claim({ body: { text: "hi", sender: { username: "ignored" } } }),
      ),
    ).toEqual({ kind: "text" });
  });

  test.each(["Add a test, <!here>", "owner (웹 콘솔)\nAdd a test, <!here>"])(
    "instruction fallback names the sender once for %p",
    (text) => {
      expect(
        slackInstructionFallbackText(
          { text },
          slackOutboxText({ text }),
          "owner (웹 콘솔)",
        ),
      ).toBe("owner (웹 콘솔)\nAdd a test, &lt;!here&gt;");
    },
  );
});

// Scripted reads and recorded effects only: SQL owns eligibility and fencing.
async function drainFixture(
  row: SurfaceOutboxClaim,
  answers: SlackSendResponse[],
) {
  const effects: unknown[] = [];
  const messages: Parameters<SlackBotSender["postMessage"]>[1][] = [];
  const settlements: SurfaceOutboxSettle[] = [];
  const notFound: string[] = [];
  const askedAt: (number | undefined)[] = [];
  const batches = [[row], []];
  const outbox: SurfaceOutboxStore = {
    enqueue: async (entry) => {
      effects.push(["enqueue", entry]);
      return "enqueued";
    },
    readerLocale: async () => null,
    aiLabelFor: async () => null,
    advanceAnswered: async () => 0,
    closeFinishedLinks: async () => 0,
    unpostedInstructions: async () => [],
    unmirroredInputs: async () => [],
    unansweredTurns: async () => [],
    afterTurnReplies: async () => [],
    promptCard: async () => null,
    progressLink: async () => null,
    postedCard: async () => null,
    unpromptedRequests: async () => [],
    expireSending: async () => [],
    closeUnaddressed: async () => [],
    closeOverdueHeld: async () => 0,
    matchMirrorEcho: async () => "no_candidate",
    untoldUncertain: async () => [],
    claim: async () => batches.shift() ?? [],
    beginSend: async (fence) => {
      effects.push(["beginSend", fence.id]);
      return true;
    },
    settle: async (fence, outcome) => {
      effects.push(["settle", fence.id, outcome]);
      settlements.push(outcome);
      return true;
    },
  };
  const slack: Parameters<typeof drainSlackOutbox>[0]["slack"] = {
    setStatus: async () => {},
    userImage: async (_token, userId) => {
      effects.push(["userImage", userId]);
      return "https://images.example/owner.png";
    },
    postMessage: async (_token, input) => {
      effects.push(["postMessage", input]);
      messages.push(input);
      const answer = answers.shift();
      if (answer === undefined) throw new Error("no scripted response");
      return answer;
    },
    postEphemeral: async () => {
      throw new Error("unexpected ephemeral");
    },
  };
  const botToken = async () => "test-credential";
  const consoleOrigin = "https://console.example";
  const pass = await drainSlackOutbox({
    outbox,
    slack,
    botToken,
    delivery: createRowDelivery({ slack, botToken, consoleOrigin }),
    bindings: {
      channelNotFound: async (installationId, channelId, asked) => {
        notFound.push(`${installationId}:${channelId}`);
        askedAt.push(asked);
        return "gone";
      },
    },
    logger: { info: () => {}, warn: () => {} },
    consoleOrigin,
    batchSize: 10,
    leaseMs: 30_000,
    deadline: 1_000,
    now: () => 0,
  });
  return { pass, effects, messages, settlements, notFound, askedAt };
}

describe("outbox policy wiring without SQL", () => {
  test.each([
    ["Add a test", "Add a test", "owner (웹 콘솔)\nAdd a test"],
    [
      // G7: a group mention leaves a person's instruction too.
      "owner (웹 콘솔)\nAdd a test, <!here>",
      "owner (웹 콘솔)\nAdd a test,",
      "owner (웹 콘솔)\nAdd a test,",
    ],
  ])(
    "a refused sender posts %p once as the app, after image lookup and beginSend",
    async (text, initialText, fallbackText) => {
      const result = await drainFixture(
        claim({
          kind: "instruction",
          body: {
            text,
            blocks: [{ type: "divider" }],
            sender: { username: "owner (웹 콘솔)", slack_user_id: "U0OWNER" },
          },
        }),
        [response({ body: { ok: false, error: "missing_scope" } }), response()],
      );
      expect(result.pass).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
      expect(result.messages).toEqual([
        {
          channelId: "C0OPS",
          threadTs: "100.000100",
          text: initialText,
          username: "owner (웹 콘솔)",
          iconUrl: "https://images.example/owner.png",
        },
        {
          channelId: "C0OPS",
          threadTs: "100.000100",
          text: fallbackText,
        },
      ]);
      expect(result.effects.map((effect) => (effect as unknown[])[0])).toEqual([
        "userImage",
        "beginSend",
        "postMessage",
        "postMessage",
        "settle",
      ]);
      expect(result.settlements).toEqual([
        { status: "sent", slackTs: "200.000200" },
      ]);
    },
  );

  test("a generated table is posted with row-list fallback text", async () => {
    const result = await drainFixture(
      claim({
        body: {
          text: TABLE_REPLY,
          link_url: "https://console.example/sessions/s1",
        },
      }),
      [response()],
    );
    expect(result.pass).toMatchObject({ sent: 1, failed: 0 });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toContain(
      "*acme/web* — 상태: 기본 저장소",
    );
    expect(result.messages[0]?.text).not.toContain("```");
    expect(
      result.messages[0]?.blocks?.map(
        (block) => (block as { type: string }).type,
      ),
    ).toEqual(["section", "table", "section"]);
  });

  test.each(["invalid_blocks", "msg_blocks_too_long"])(
    "generated blocks refused with %s retry as text, explicit blocks do not",
    async (error) => {
      const refused = response({ body: { ok: false, error } });
      const generated = await drainFixture(
        claim({ body: { text: TABLE_REPLY } }),
        [refused, response()],
      );
      expect(generated.pass).toMatchObject({ sent: 1, failed: 0 });
      expect(generated.messages).toHaveLength(2);
      expect(generated.messages[1]?.blocks).toBeUndefined();
      expect(generated.messages[1]?.text).toContain(
        "*acme/api* — 상태: 붙일 수 있음",
      );
      const explicit = await drainFixture(
        claim({ body: { text: TABLE_REPLY, blocks: [{ type: "divider" }] } }),
        [refused],
      );
      expect(explicit.messages).toHaveLength(1);
      expect(explicit.messages[0]?.blocks).toEqual([{ type: "divider" }]);
      expect(explicit.settlements).toEqual([
        { status: "failed", errorCode: error },
      ]);
    },
  );

  test("a send Slack answers channel_not_found fails and tells the binding store; 429, an outage or a token error does not", async () => {
    const before = Date.now() * 1000;
    const lost = await drainFixture(claim(), [
      response({ body: { ok: false, error: "channel_not_found" } }),
    ]);
    expect(lost.settlements).toEqual([
      { status: "failed", errorCode: "channel_not_found" },
    ]);
    expect(lost.notFound).toEqual(["installation-1:C0OPS"]);
    // When Slack was asked, so the store can tell a join noted since.
    expect(lost.askedAt[0]).toBeGreaterThanOrEqual(before);
    expect(lost.askedAt[0]).toBeLessThanOrEqual(Date.now() * 1000);
    // A DM has no binding of its own to change.
    const dm = await drainFixture(claim({ channelId: "D0PERSON" }), [
      response({ body: { ok: false, error: "channel_not_found" } }),
    ]);
    expect(dm.notFound).toEqual([]);
    for (const answer of [
      response({ httpStatus: 429, retryAfterHeader: "3", body: null }),
      response({ httpStatus: 503, body: null }),
      response({ body: { ok: false, error: "fatal_error" } }),
      response({ body: { ok: false, error: "invalid_auth" } }),
      response({ body: { ok: false, error: "token_revoked" } }),
      response({ body: { ok: false, error: "not_in_channel" } }),
    ]) {
      const other = await drainFixture(claim(), [answer]);
      expect(other.settlements).toHaveLength(1);
      expect(other.notFound).toEqual([]);
    }
  });

  test("an unreadable 429 defers with Retry-After; a later claim sends", async () => {
    const api = createSlackBotApi({
      apiUrl: "https://slack.example/api",
      fetch: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 429, headers: { "retry-after": "3" } },
        )) as unknown as typeof fetch,
    });
    const limited = await api.postMessage("test-credential", {
      channelId: "C0OPS",
      threadTs: "100.000100",
      text: "hi",
    });
    expect(limited).toEqual({
      httpStatus: 429,
      retryAfterHeader: "3",
      body: null,
    });
    const first = await drainFixture(claim(), [limited]);
    expect(first.pass).toMatchObject({ retried: 1, uncertain: 0, sent: 0 });
    expect(first.settlements).toEqual([
      { status: "pending", errorCode: "ratelimited", retryInMs: 3_000 },
    ]);
    const later = await drainFixture(claim({ attempts: 2 }), [response()]);
    expect(later.pass).toMatchObject({ sent: 1 });
    expect(later.messages).toHaveLength(1);
  });
});

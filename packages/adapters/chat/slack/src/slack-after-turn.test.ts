import { expect, test } from "bun:test";
import type {
  SurfaceAfterTurnReply,
  SurfaceOutboxEntry,
} from "@werft-ai/platform";
import {
  enqueueSlackAfterTurnReplies,
  slackAfterTurnDedupeKey,
} from "./slack-outbox-enqueue.ts";
import { SLACK_OUTBOX_MESSAGES } from "./slack-outbox-render.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const said = (text: string) => ({ type: "assistant", payload: { text } });
const tool = {
  type: "tool_use",
  payload: { tool_call: { id: "tu1", name: "Read", input: {} } },
};

const reply = (
  over: Partial<SurfaceAfterTurnReply>,
): SurfaceAfterTurnReply => ({
  sessionLinkId: "link-1",
  sessionId: SESSION,
  workspaceId: "workspace-1",
  agentId: "agent-1",
  slackAppId: "app-1",
  installationId: "installation-1",
  channelId: "C0OPS",
  threadTs: "100.000100",
  locale: "ko",
  turnId: 2,
  sources: {
    direct: [{ team_id: "T0ACME", channel_id: "C0OPS", ts: "100.000100" }],
    inherited: [],
  },
  requesterSlackUserId: "U0ASKER",
  resultSequence: 7,
  resultId: String(over.resultSequence ?? 7),
  events: [said("The build passed.")],
  ...over,
});

async function rowsFor(replies: SurfaceAfterTurnReply[], limit = 10) {
  const rows: SurfaceOutboxEntry[] = [];
  const { enqueued: count, complete } = await enqueueSlackAfterTurnReplies({
    outbox: {
      // As the store pages them: oldest first, past the cursor.
      afterTurnReplies: async (pageLimit, after) =>
        replies
          .filter(
            (reply) =>
              after === undefined || Number(reply.resultId) > Number(after),
          )
          .slice(0, pageLimit),
      enqueue: async (entry) => {
        rows.push(entry);
        return "enqueued" as const;
      },
    },
    consoleOrigin: "https://console.example",
    limit,
  });
  return { rows, count, complete };
}

test("an answer after the turn becomes one reply in the turn's thread, under the line that says so, mentioning who asked", async () => {
  const { rows, count } = await rowsFor([reply({})]);
  expect(count).toBe(1);
  expect(rows).toEqual([
    {
      workspaceId: "workspace-1",
      agentId: "agent-1",
      slackAppId: "app-1",
      installationId: "installation-1",
      kind: "reply",
      channelId: "C0OPS",
      threadTs: "100.000100",
      slackUserId: null,
      sessionId: SESSION,
      sessionLinkId: "link-1",
      body: {
        text: "<@U0ASKER> 배경 작업이 끝나 이어서 알려 드립니다.\n\nThe build passed.",
        locale: "ko",
        link_url: `https://console.example/sessions/${SESSION}`,
        mention_user_ids: ["U0ASKER"],
      },
      dedupeKey: "after_turn:link-1:2:7",
      // The turn's own: a delete of what the turn answers voids it too.
      sources: {
        direct: [{ team_id: "T0ACME", channel_id: "C0OPS", ts: "100.000100" }],
        inherited: [],
      },
      sourcesTurn: 2,
    },
  ]);
});

test("each answer is keyed by its own result, so two answers are two posts and the same one again is one", () => {
  expect(slackAfterTurnDedupeKey("link-1", 2, 7)).toBe("after_turn:link-1:2:7");
  expect(slackAfterTurnDedupeKey("link-1", 2, 9)).not.toBe(
    slackAfterTurnDedupeKey("link-1", 2, 7),
  );
  // Not the turn's own reply key: the follow-up never takes its place.
  expect(slackAfterTurnDedupeKey("link-1", 2, 7)).not.toBe("reply:link-1:2");
});

test("the text is what the engine said after its last tool call; an answer with none posts nothing", async () => {
  const { rows, count } = await rowsFor([
    reply({ events: [said("Checking."), tool, said("All green.")] }),
    reply({ resultSequence: 9, events: [said("Looking."), tool] }),
    reply({ resultSequence: 11, events: [] }),
  ]);
  expect(count).toBe(1);
  expect(rows.map((row) => row.body.text)).toEqual([
    `<@U0ASKER> ${SLACK_OUTBOX_MESSAGES.ko.afterTurn}\n\nAll green.`,
  ]);
});

test("answers with nothing to say are paged past, so a later one still goes and the pass is complete", async () => {
  const { rows, count, complete } = await rowsFor(
    [
      reply({ resultSequence: 1, events: [said("Looking."), tool] }),
      reply({ resultSequence: 2, events: [] }),
      reply({ resultSequence: 3, events: [said("Done.")] }),
    ],
    2,
  );
  expect([count, complete]).toEqual([1, true]);
  expect(rows.map((row) => row.dedupeKey)).toEqual(["after_turn:link-1:2:3"]);
});

test("a pass that fills its limit is not complete, and leaves the rest to the next", async () => {
  const { rows, complete } = await rowsFor(
    [reply({ resultSequence: 1 }), reply({ resultSequence: 2 })],
    1,
  );
  expect(complete).toBe(false);
  expect(rows.map((row) => row.dedupeKey)).toEqual(["after_turn:link-1:2:1"]);
});

test("the line is in the thread's language, English with none, and no one is mentioned when no Slack account asked", async () => {
  const { rows } = await rowsFor([
    reply({ locale: "ja" }),
    reply({ locale: null, requesterSlackUserId: null, resultSequence: 8 }),
  ]);
  expect(rows[0]?.body.text).toStartWith(
    "<@U0ASKER> バックグラウンド作業が終わったので、続きをお知らせします。\n\n",
  );
  expect(rows[1]?.body.text).toStartWith(
    "The background work finished; here is what followed.\n\n",
  );
  expect(rows[1]?.body.locale).toBe("en");
  expect(rows[1]?.body).not.toHaveProperty("mention_user_ids");
});

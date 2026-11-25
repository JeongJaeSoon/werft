import { expect, test } from "bun:test";
import { SLACK_NOTICE_MESSAGES } from "@werft-ai/contracts";
import type {
  SurfaceOutboxEntry,
  SurfaceUnansweredTurn,
} from "@werft-ai/platform";
import { enqueueSlackTurnAnswers } from "./slack-outbox-enqueue.ts";

const turn = (
  turnId: number,
  over: Partial<SurfaceUnansweredTurn>,
): SurfaceUnansweredTurn => ({
  sessionLinkId: "link-1",
  sessionId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  slackAppId: "app-1",
  installationId: "installation-1",
  channelId: "C0OPS",
  threadTs: "100.000100",
  locale: "ko",
  turnId,
  sources: null,
  state: "failed",
  requesterSlackUserId: "U0ASKER",
  events: [],
  ...over,
});

async function rowsFor(turns: SurfaceUnansweredTurn[]) {
  const rows: SurfaceOutboxEntry[] = [];
  await enqueueSlackTurnAnswers({
    outbox: {
      unansweredTurns: async () => turns,
      enqueue: async (entry) => {
        rows.push(entry);
        return "enqueued" as const;
      },
    },
    consoleOrigin: "https://console.example",
    limit: 10,
  });
  return rows.map(({ kind, channelId, slackUserId, body, dedupeKey }) => ({
    kind,
    channelId,
    slackUserId,
    text: body.text,
    mentions: body.mention_user_ids ?? null,
    dedupeKey,
  }));
}

const userLine = SLACK_NOTICE_MESSAGES.ko.budgetAccountUser;

test("a refused turn's notice says whose limit, never to try again: the first in the thread, a later one to the person who asked alone", async () => {
  expect(
    await rowsFor([
      turn(1, { budgetRefusal: { owner: "user", first: true } }),
      turn(2, { budgetRefusal: { owner: "team", first: false } }),
    ]),
  ).toEqual([
    {
      kind: "failure_notice",
      channelId: "C0OPS",
      slackUserId: null,
      text: userLine,
      mentions: ["U0ASKER"],
      dedupeKey: "failure:link-1:1",
    },
    {
      kind: "notice",
      channelId: "C0OPS",
      slackUserId: "U0ASKER",
      text: SLACK_NOTICE_MESSAGES.ko.budgetAccountTeam,
      mentions: null,
      dedupeKey: "failure:link-1:2",
    },
  ]);
});

test("a direct message hears every refusal in the thread", async () => {
  const rows = await rowsFor([
    turn(2, {
      channelId: "D0ASKER",
      budgetRefusal: { owner: "user", first: false },
    }),
  ]);
  expect(rows.map((row) => [row.kind, row.slackUserId, row.text])).toEqual([
    ["failure_notice", null, userLine],
  ]);
});

test("a later refusal with no Slack account to tell alone goes to the thread", async () => {
  const rows = await rowsFor([
    turn(2, {
      requesterSlackUserId: null,
      budgetRefusal: { owner: "user", first: false },
    }),
  ]);
  expect(rows.map((row) => [row.kind, row.slackUserId, row.text])).toEqual([
    ["failure_notice", null, userLine],
  ]);
});

test("a failed turn no budget account refused keeps its notice", async () => {
  const rows = await rowsFor([turn(3, { budgetRefusal: null })]);
  expect(rows.map((row) => [row.kind, row.text])).toEqual([
    ["failure_notice", SLACK_NOTICE_MESSAGES.ko.failed],
  ]);
});

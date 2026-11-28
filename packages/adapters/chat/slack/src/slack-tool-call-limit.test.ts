import { expect, test } from "bun:test";
import {
  SLACK_NOTICE_MESSAGES,
  TURN_TOOL_CALL_LIMIT_REASON,
  type UserLocale,
} from "@werft-ai/contracts";
import type {
  SurfaceOutboxEntry,
  SurfaceUnansweredTurn,
} from "@werft-ai/platform";
import { enqueueSlackTurnAnswers } from "./slack-outbox-enqueue.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";

const turn = (
  turnId: number,
  over: Partial<SurfaceUnansweredTurn>,
): SurfaceUnansweredTurn => ({
  sessionLinkId: "link-1",
  sessionId: SESSION,
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
  return rows;
}

test.each(["ko", "en", "ja"] satisfies UserLocale[])(
  "a turn its tool call limit ended tells the thread so, in %s, as its one failure notice",
  async (locale) => {
    const [row] = await rowsFor([
      turn(3, { locale, terminalReason: TURN_TOOL_CALL_LIMIT_REASON }),
    ]);
    expect(row?.kind).toBe("failure_notice");
    expect(row?.dedupeKey).toBe("failure:link-1:3");
    expect(row?.body.text).toBe(SLACK_NOTICE_MESSAGES[locale].toolCallLimit);
    expect(row?.body.mention_user_ids).toEqual(["U0ASKER"]);
  },
);

test("any other failed turn keeps the plain notice", async () => {
  const [row] = await rowsFor([turn(4, { terminalReason: "turn_timeout" })]);
  expect(row?.body.text).toBe(SLACK_NOTICE_MESSAGES.ko.failed);
});

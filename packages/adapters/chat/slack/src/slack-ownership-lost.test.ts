import { expect, test } from "bun:test";
import {
  SLACK_INTERACTION_ACTIONS,
  SLACK_NOTICE_MESSAGES,
} from "@werft-ai/contracts";
import {
  type SurfaceOutboxEntry,
  type SurfaceUnansweredTurn,
  WORKER_OWNERSHIP_LOST_REASON,
} from "@werft-ai/platform";
import { enqueueSlackTurnAnswers } from "./slack-outbox-enqueue.ts";
import { slackOwnershipLostNotice } from "./slack-prompts.ts";

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

const buttons = (blocks: unknown[] | undefined) =>
  (blocks ?? []).flatMap((block) => {
    const { type, elements } = block as {
      type: string;
      elements?: { action_id?: string; value?: string; url?: string }[];
    };
    return type === "actions" ? (elements ?? []) : [];
  });

test("a turn its worker's lost lease ended is told as the turn's one failure notice, with the button that goes on from it", async () => {
  const [row, plain] = await rowsFor([
    turn(3, { terminalReason: WORKER_OWNERSHIP_LOST_REASON }),
    turn(4, {}),
  ]);
  // The key every failed turn's notice has: the outbox takes it once.
  expect(row?.kind).toBe("failure_notice");
  expect(row?.dedupeKey).toBe("failure:link-1:3");
  expect(row?.body.text).toBe(
    "작업이 중간에 끊겼어요. 서버 연결이 잠시 끊겼어요. 마지막 저장 지점 뒤에 한 일은 확인이 필요해요.",
  );
  expect(row?.body.text).not.toContain(SLACK_NOTICE_MESSAGES.ko.failed);
  const [go, open] = buttons(row?.body.blocks);
  expect(go?.action_id).toBe(SLACK_INTERACTION_ACTIONS.turnContinue);
  expect(JSON.parse(go?.value ?? "")).toEqual({ s: SESSION, r: "3" });
  expect(JSON.stringify(row?.body.blocks)).toContain("이어서 하기");
  expect(open?.url).toBe(`https://console.example/sessions/${SESSION}`);
  // Any other failed turn keeps the plain notice, with no button.
  expect(plain?.body.text).toBe(SLACK_NOTICE_MESSAGES.ko.failed);
  expect(plain?.body.blocks).toBeUndefined();
});

test("how the turn ended decides its notice: a budget refusal recorded before the lease went does not take the button away", async () => {
  // A later refusal would go to the person who asked alone; this does not.
  const [row] = await rowsFor([
    turn(3, {
      terminalReason: WORKER_OWNERSHIP_LOST_REASON,
      budgetRefusal: { owner: "user", first: false },
    }),
  ]);
  expect(row?.kind).toBe("failure_notice");
  expect(row?.slackUserId).toBeNull();
  expect(row?.body.text).toBe(SLACK_NOTICE_MESSAGES.ko.ownershipLost);
  expect(buttons(row?.body.blocks)[0]?.action_id).toBe(
    SLACK_INTERACTION_ACTIONS.turnContinue,
  );
});

test("once someone pressed, the notice keeps its words and link and has no button to press", () => {
  const notice = slackOwnershipLostNotice({
    locale: "ko",
    sessionId: SESSION,
    turnId: 3,
    linkUrl: `https://console.example/sessions/${SESSION}`,
    continued: true,
  });
  expect(notice.text).toBe(SLACK_NOTICE_MESSAGES.ko.ownershipLost);
  expect(
    buttons(notice.blocks).map((button) => button.action_id),
  ).not.toContain(SLACK_INTERACTION_ACTIONS.turnContinue);
  expect(buttons(notice.blocks)).toHaveLength(1);
  expect(JSON.stringify(notice.blocks)).toContain(
    SLACK_NOTICE_MESSAGES.ko.ownershipLostContinued,
  );
});

test("a link that is not safe to show is left out, and the button stays", () => {
  const notice = slackOwnershipLostNotice({
    locale: "en",
    sessionId: SESSION,
    turnId: 3,
    linkUrl: "javascript:alert(1)",
  });
  expect(buttons(notice.blocks).map((button) => button.action_id)).toEqual([
    SLACK_INTERACTION_ACTIONS.turnContinue,
  ]);
});

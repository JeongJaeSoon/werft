import { expect, test } from "bun:test";
import {
  SLACK_INTERACTION_ACTIONS,
  SLACK_NOTICE_MESSAGES,
} from "@werft-ai/contracts";
import type {
  SurfaceOutboxEntry,
  SurfaceUnansweredTurn,
} from "@werft-ai/platform";
import { enqueueSlackTurnAnswers } from "./slack-outbox-enqueue.ts";
import { slackStartFreshNotice } from "./slack-prompts.ts";

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

test("a turn of unknown outcome with no save point is told with its warning and the button that runs it again in a new context", async () => {
  const [row, plain] = await rowsFor([
    turn(1, { terminalReason: "execution_gone", startFreshOffered: true }),
    turn(2, { terminalReason: "execution_gone" }),
  ]);
  expect(row?.kind).toBe("failure_notice");
  expect(row?.dedupeKey).toBe("failure:link-1:1");
  expect(row?.body.text).toBe(
    "작업이 중간에 끊겼어요. 이 대화에는 아직 저장 지점이 없어요.",
  );
  const shown = JSON.stringify(row?.body.blocks);
  expect(shown).toContain(
    "이전 대화 문맥 없이 같은 요청을 처음부터 다시 해요. 끊기기 전에 한 일은 확인이 필요해요.",
  );
  const [go, open] = buttons(row?.body.blocks);
  expect(go?.action_id).toBe(SLACK_INTERACTION_ACTIONS.turnStartFresh);
  expect(JSON.parse(go?.value ?? "")).toEqual({ s: SESSION, r: "1" });
  expect(shown).toContain("새 문맥으로 계속");
  expect(open?.url).toBe(`https://console.example/sessions/${SESSION}`);
  // One with a save point keeps the plain notice: abandon comes first there.
  expect(plain?.body.text).toBe(SLACK_NOTICE_MESSAGES.ko.failed);
  expect(plain?.body.blocks).toBeUndefined();
});

test("the offer goes before a budget refusal recorded on the turn", async () => {
  const [row] = await rowsFor([
    turn(1, {
      startFreshOffered: true,
      budgetRefusal: { owner: "user", first: false },
    }),
  ]);
  expect(row?.slackUserId).toBeNull();
  expect(row?.body.text).toBe(SLACK_NOTICE_MESSAGES.ko.startFresh);
});

test("once someone pressed, the notice says it runs again and has no button to press", () => {
  for (const locale of ["ko", "ja", "en"] as const) {
    const notice = slackStartFreshNotice({
      locale,
      sessionId: SESSION,
      turnId: 1,
      linkUrl: `https://console.example/sessions/${SESSION}`,
      continued: true,
    });
    expect(notice.text).toBe(SLACK_NOTICE_MESSAGES[locale].startFresh);
    const shown = JSON.stringify(notice.blocks);
    expect(shown).toContain(SLACK_NOTICE_MESSAGES[locale].startFreshContinued);
    expect(shown).not.toContain(
      SLACK_NOTICE_MESSAGES[locale].startFreshWarning,
    );
    expect(
      buttons(notice.blocks).map((button) => button.action_id),
    ).not.toContain(SLACK_INTERACTION_ACTIONS.turnStartFresh);
  }
});

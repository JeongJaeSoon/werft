import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SlackOutboxClaim, SlackOutboxKind } from "@werft-ai/platform";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import {
  createRowDelivery,
  SLACK_READER_OUTSIDE_CODE,
} from "./outbox-delivery.ts";
import { createSlackBotApi } from "./slack-config-api.ts";

// Answer 15 (PR2): a session's direct message goes only to someone who can
// see the session; the check is the sender's, asked right before the send.

const BOT = "bot-reader-outside";
const SLACK_APP = "slack-app-reader-outside";

const fakeSlack = startFakeSlackApi();
beforeAll(() => {
  fakeSlack.apps.set(SLACK_APP, {
    appId: SLACK_APP,
    clientId: "client",
    clientSecret: "client-secret",
    signingSecret: "signing-secret",
    manifest: null,
    botTokens: [BOT],
  });
});
afterAll(() => fakeSlack.stop());

function rowOf(
  kind: SlackOutboxKind,
  sessionId: string | null,
): SlackOutboxClaim {
  const direct = kind === "model_notice";
  return {
    id: `row-${kind}-${sessionId}`,
    claimToken: "claim",
    attempts: 1,
    workspaceId: "ws-1",
    agentId: "agent-1",
    slackAppId: SLACK_APP,
    installationId: "installation-1",
    kind,
    channelId: direct ? "U0READER" : "C0ROOM",
    threadTs: direct ? "" : "100.000100",
    slackUserId: null,
    sessionId,
    sessionLinkId: null,
    body: { text: "Done." },
    dedupeKey: `${kind}:${sessionId}`,
  };
}

async function deliver(row: SlackOutboxClaim, outside: boolean) {
  fakeSlack.messages.length = 0;
  const asked: SlackOutboxClaim[] = [];
  let begun = false;
  const delivery = createRowDelivery({
    slack: createSlackBotApi({ apiUrl: fakeSlack.url }),
    botToken: async () => BOT,
    consoleOrigin: null,
    readerOutside: async (claim) => {
      asked.push(claim);
      return outside;
    },
  });
  const outcome = await delivery.direct({
    row,
    attempts: row.attempts,
    begin: async () => {
      begun = true;
      return true;
    },
  });
  return {
    outcome,
    begun,
    asked: asked.length,
    posted: fakeSlack.messages.map((message) => message.channelId),
  };
}

describe("a session's direct message", () => {
  test("to someone outside the session's channels fails unsent", async () => {
    const sent = await deliver(rowOf("model_notice", "session-1"), true);
    expect(sent).toEqual({
      outcome: { kind: "failed", code: SLACK_READER_OUTSIDE_CODE },
      begun: false,
      asked: 1,
      posted: [],
    });
  });

  test("to someone who can see the session goes out", async () => {
    const sent = await deliver(rowOf("model_notice", "session-1"), false);
    expect(sent.outcome.kind).toBe("sent");
    expect(sent.posted).toEqual(["U0READER"]);
  });

  test("of no session, and a thread's row, ask nothing", async () => {
    for (const row of [rowOf("model_notice", null), rowOf("reply", "s")]) {
      const sent = await deliver(row, true);
      expect(sent.outcome.kind).toBe("sent");
      expect(sent.asked).toBe(0);
    }
  });
});

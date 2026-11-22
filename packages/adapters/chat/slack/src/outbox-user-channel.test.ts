import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SlackOutboxClaim, SlackOutboxKind } from "@werft-ai/platform";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import { createRowDelivery } from "./outbox-delivery.ts";
import { createSlackBotApi } from "./slack-config-api.ts";

const TOKEN = "xoxb-user-channel";
const SLACK_APP = "slack-app-user-channel";

const fakeSlack = startFakeSlackApi();
beforeAll(() => {
  fakeSlack.apps.set(SLACK_APP, {
    appId: SLACK_APP,
    clientId: "client",
    clientSecret: "client-secret",
    signingSecret: "signing-secret",
    manifest: null,
    botTokens: [TOKEN],
  });
});
afterAll(() => fakeSlack.stop());

function rowOf(kind: SlackOutboxKind, channelId: string): SlackOutboxClaim {
  return {
    id: `row-${kind}-${channelId}`,
    claimToken: "claim-1",
    attempts: 1,
    workspaceId: "ws-1",
    agentId: "agent-1",
    slackAppId: SLACK_APP,
    installationId: "installation-1",
    kind,
    channelId,
    threadTs: kind === "model_notice" ? "" : "100.000100",
    slackUserId: null,
    sessionId: kind === "model_notice" ? "session-1" : null,
    body: { text: "Done." },
    dedupeKey: `${kind}:${channelId}`,
  };
}

async function deliver(row: SlackOutboxClaim) {
  fakeSlack.messages.length = 0;
  const before = fakeSlack.calls.length;
  let begun = false;
  const delivery = createRowDelivery({
    slack: createSlackBotApi({ apiUrl: fakeSlack.url }),
    botToken: async () => TOKEN,
    consoleOrigin: null,
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
    calls: fakeSlack.calls.slice(before).map((call) => call.method),
    posted: fakeSlack.messages.map((message) => message.channelId),
  };
}

// Design v3 decision 45: the agent never opens a direct message first, and
// chat.postMessage with a user id as the channel would do just that.
describe("an outbox row whose channel is a Slack user id", () => {
  test("is posted as it stands", async () => {
    const sent = await deliver(rowOf("reply", "U0PERSON"));
    expect(sent.outcome.kind).toBe("sent");
    expect(sent.begun).toBe(true);
    expect(sent.posted).toEqual(["U0PERSON"]);
  });
});

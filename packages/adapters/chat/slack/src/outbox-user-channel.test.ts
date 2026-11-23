import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SurfaceOutboxClaim, SurfaceOutboxKind } from "@werft-ai/platform";
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

function rowOf(kind: SurfaceOutboxKind, channelId: string): SurfaceOutboxClaim {
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
    sessionLinkId: null,
    body: { text: "Done." },
    dedupeKey: `${kind}:${channelId}`,
  };
}

async function deliver(row: SurfaceOutboxClaim) {
  fakeSlack.messages.length = 0;
  const before = fakeSlack.calls.length;
  let begun = false;
  let tokenReads = 0;
  const delivery = createRowDelivery({
    slack: createSlackBotApi({ apiUrl: fakeSlack.url }),
    botToken: async () => {
      tokenReads += 1;
      return TOKEN;
    },
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
    tokenReads,
    calls: fakeSlack.calls.slice(before).map((call) => call.method),
    posted: fakeSlack.messages.map((message) => message.channelId),
  };
}

// Design v3 decision 45: the agent never opens a direct message first, and
// chat.postMessage with a user id as the channel would do just that.
const REFUSED_KINDS: SurfaceOutboxKind[] = [
  "instruction",
  "reply",
  "notice",
  "failure_notice",
  "input_notice",
  "welcome",
  "action_notice",
];

describe("an outbox row whose channel is a Slack user id", () => {
  for (const kind of REFUSED_KINDS) {
    for (const channelId of ["U0PERSON", "W0GRIDPERSON"]) {
      test(`a ${kind} to ${channelId} fails before any Slack call`, async () => {
        const sent = await deliver(rowOf(kind, channelId));
        expect(sent.outcome).toEqual({ kind: "failed", code: "user_channel" });
        expect(sent.begun).toBe(false);
        expect(sent.tokenReads).toBe(0);
        expect(sent.calls).toEqual([]);
        expect(sent.posted).toEqual([]);
      });
    }
  }

  test("a model notice still goes to the person as a direct message", async () => {
    const sent = await deliver(rowOf("model_notice", "U0PERSON"));
    expect(sent.outcome.kind).toBe("sent");
    expect(sent.posted).toEqual(["U0PERSON"]);
  });
});

describe("an outbox row whose channel is a conversation", () => {
  for (const channelId of ["C0PUBLIC", "G0PRIVATE", "D0DIRECT"]) {
    test(`a reply to ${channelId} is posted`, async () => {
      const sent = await deliver(rowOf("reply", channelId));
      expect(sent.outcome.kind).toBe("sent");
      expect(sent.begun).toBe(true);
      expect(sent.posted).toEqual([channelId]);
    });
  }
});

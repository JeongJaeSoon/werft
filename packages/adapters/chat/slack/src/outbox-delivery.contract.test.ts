import { afterAll, beforeAll, describe } from "bun:test";
import type { ClaimedOutboxRow, SlackOutboxKind } from "@werft-ai/platform";
import { describeApprovableContract } from "@werft-ai/platform/testing/approvable";
import type {
  ChannelAnswer,
  DeliverySubject,
} from "@werft-ai/platform/testing/delivery";
import { describeNotifiableContract } from "@werft-ai/platform/testing/notifiable";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import { createRowDelivery } from "./outbox-delivery.ts";
import {
  createSlackBotApi,
  SlackApiError,
  type SlackBotSender,
  type SlackSendResponse,
} from "./slack-config-api.ts";
import { SLACK_SEND_MAX_ATTEMPTS } from "./slack-send-result.ts";

// `Notifiable` and `Approvable` are both held by `createRowDelivery`, so one
// file runs both contracts. Two ways to make the Slack side answer: the Web
// API client over HTTP against the testkit's fake Slack, and an in-memory
// sender that returns the answers Slack gives.
const TOKEN = "xoxb-contract-token";
const WORKSPACE = "ws-1";
const SLACK_APP = "slack-app-1";

const bodies: Record<SlackOutboxKind, ClaimedOutboxRow["body"]> = {
  instruction: { text: "Do the thing", sender: { username: "Ada" } },
  reply: { text: "Done." },
  notice: { text: "Link your Slack account on the web", locale: "en" },
  failure_notice: { text: "The turn could not finish." },
  input_notice: {
    text: "Approve the push?",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "Approve the push?" } },
    ],
  },
  welcome: { text: "Hello" },
  action_notice: { text: "Pushed to agent/1" },
  model_notice: { text: "The model is not on the list" },
};

function rowOf(kind: SlackOutboxKind): ClaimedOutboxRow {
  const direct = kind === "model_notice";
  return {
    id: `row-${kind}`,
    claimToken: "claim-1",
    attempts: 1,
    workspaceId: WORKSPACE,
    agentId: "agent-1",
    slackAppId: SLACK_APP,
    installationId: "installation-1",
    kind,
    // A model notice is a direct message to one person, outside any thread.
    channelId: direct ? "U0A" : "C0OPS",
    threadTs: direct || kind === "welcome" ? "" : "100.000100",
    slackUserId: kind === "notice" ? "U0A" : null,
    sessionId: direct ? "session-1" : null,
    body: bodies[kind],
    dedupeKey: `${kind}:1`,
  };
}

type Wiring = Pick<DeliverySubject, "script" | "requestsSent"> & {
  slack: Pick<SlackBotSender, "postMessage" | "postEphemeral" | "userImage">;
};

function subjectOf(wiring: Wiring) {
  let token: string | null = TOKEN;
  const delivery = createRowDelivery({
    slack: wiring.slack,
    botToken: async () => token,
    consoleOrigin: "https://console.example",
  });
  const subject: DeliverySubject = {
    row: rowOf,
    script: wiring.script,
    withoutCredential() {
      token = null;
    },
    requestsSent: wiring.requestsSent,
    maxAttempts: SLACK_SEND_MAX_ATTEMPTS,
  };
  return {
    ...subject,
    notifiable: delivery.notifiable,
    approvable: delivery.approvable,
  };
}

// The Web API client over HTTP, against the fake Slack.
const fakeSlack = startFakeSlackApi();
const SEND_METHODS = ["chat.postMessage", "chat.postEphemeral"] as const;

beforeAll(() => {
  fakeSlack.apps.set(SLACK_APP, {
    appId: SLACK_APP,
    clientId: "client",
    clientSecret: "secret",
    signingSecret: "signing",
    manifest: null,
    botTokens: [TOKEN],
  });
});
afterAll(() => fakeSlack.stop());

function overFakeSlack() {
  fakeSlack.failures.clear();
  fakeSlack.missingTs.clear();
  fakeSlack.messages.length = 0;
  // A rate limit set for both send methods leaves the one a row did not use.
  for (const method of SEND_METHODS) fakeSlack.rateLimit(method, 1, 0);
  let dead = false;
  const live = createSlackBotApi({ apiUrl: fakeSlack.url });
  // Nothing listens on the discard port: the request goes out, no answer comes.
  const unreachable = createSlackBotApi({
    apiUrl: "http://127.0.0.1:9/api",
    timeoutMs: 1000,
  });
  const sender = () => (dead ? unreachable : live);
  return subjectOf({
    slack: {
      postMessage: (...args) => sender().postMessage(...args),
      postEphemeral: (...args) => sender().postEphemeral(...args),
      userImage: (...args) => sender().userImage(...args),
    },
    script(answer) {
      for (const method of SEND_METHODS) {
        if (answer === "rate_limited") fakeSlack.rateLimit(method, 7);
        if (answer === "transient_error") {
          fakeSlack.failures.set(method, "internal_error");
        }
        if (answer === "refused") {
          fakeSlack.failures.set(method, "channel_not_found");
        }
        if (answer === "accepted_without_reference") {
          fakeSlack.missingTs.add(method);
        }
      }
      dead = answer === "no_answer";
    },
    requestsSent: () => fakeSlack.messages.length,
  });
}

// The answers Slack gives, as an in-memory sender returns them.
const ANSWERS: Record<
  Exclude<ChannelAnswer, "no_answer">,
  SlackSendResponse
> = {
  accepted: {
    httpStatus: 200,
    retryAfterHeader: null,
    body: { ok: true, ts: "1700000000.000100" },
  },
  rate_limited: {
    httpStatus: 429,
    retryAfterHeader: "7",
    body: { ok: false, error: "ratelimited" },
  },
  transient_error: {
    httpStatus: 200,
    retryAfterHeader: null,
    body: { ok: false, error: "internal_error" },
  },
  refused: {
    httpStatus: 200,
    retryAfterHeader: null,
    body: { ok: false, error: "channel_not_found" },
  },
  accepted_without_reference: {
    httpStatus: 200,
    retryAfterHeader: null,
    body: { ok: true },
  },
};

function overInMemorySender() {
  let answer: ChannelAnswer = "accepted";
  let requests = 0;
  const send = async (): Promise<SlackSendResponse> => {
    if (answer === "no_answer") {
      requests += 1;
      throw new SlackApiError("chat.postMessage", "send_threw", false, {});
    }
    requests += 1;
    return ANSWERS[answer];
  };
  return subjectOf({
    slack: {
      postMessage: send,
      postEphemeral: send,
      userImage: async () => null,
    },
    script(next) {
      answer = next;
    },
    requestsSent: () => requests,
  });
}

describe("over the fake Slack Web API", () => {
  describeNotifiableContract(async () => overFakeSlack());
  describeApprovableContract(async () => overFakeSlack());
});

describe("over an in-memory sender", () => {
  describeNotifiableContract(async () => overInMemorySender());
  describeApprovableContract(async () => overInMemorySender());
});

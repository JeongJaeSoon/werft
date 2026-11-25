import { describe, expect, test } from "bun:test";
import type { SurfaceOutboxClaim } from "@werft-ai/platform";
import { createRowDelivery } from "./outbox-delivery.ts";
import { SlackApiError, type SlackSendResponse } from "./slack-config-api.ts";
import { slackReactionDedupeKey } from "./slack-reaction.ts";
import { SLACK_SEND_MAX_ATTEMPTS } from "./slack-send-result.ts";

const row = (attempts: number): SurfaceOutboxClaim => ({
  id: "row-reaction",
  claimToken: "claim-1",
  attempts,
  workspaceId: "ws-1",
  agentId: "agent-1",
  slackAppId: "slack-app-1",
  installationId: "installation-1",
  kind: "reaction",
  channelId: "C0OPS",
  threadTs: "100.000200",
  slackUserId: null,
  sessionId: null,
  sessionLinkId: null,
  body: { text: "" },
  dedupeKey: "reaction:T0ACME:C0OPS:100.000200",
});

function deliveryAnswering(answer: () => Promise<SlackSendResponse>) {
  const asked: unknown[] = [];
  const unused = async (): Promise<SlackSendResponse> => {
    throw new Error("a reaction posts nothing");
  };
  const delivery = createRowDelivery({
    slack: {
      postMessage: unused,
      postEphemeral: unused,
      userImage: async () => null,
      addReaction: async (_token, input) => {
        asked.push(input);
        return answer();
      },
    },
    botToken: async () => "bot",
    consoleOrigin: null,
  });
  const deliver = (attempts: number) =>
    delivery.direct({
      row: row(attempts),
      attempts,
      begin: async () => true,
    });
  return { deliver, asked };
}

const answer =
  (body: unknown, httpStatus = 200) =>
  async () => ({
    httpStatus,
    retryAfterHeader: null,
    body,
  });

describe("a reaction row", () => {
  test("puts 👀 on the message its thread_ts names, and is sent with that ts", async () => {
    const { deliver, asked } = deliveryAnswering(answer({ ok: true }));
    expect(await deliver(1)).toEqual({ kind: "sent", ref: "100.000200" });
    expect(asked).toEqual([
      { channelId: "C0OPS", ts: "100.000200", name: "eyes" },
    ]);
  });

  test("already_reacted is sent; missing_scope fails at once", async () => {
    expect(
      await deliveryAnswering(
        answer({ ok: false, error: "already_reacted" }),
      ).deliver(1),
    ).toEqual({ kind: "sent", ref: "100.000200" });
    expect(
      await deliveryAnswering(
        answer({ ok: false, error: "missing_scope" }),
      ).deliver(1),
    ).toEqual({ kind: "failed", code: "missing_scope" });
  });

  test("no answer, or one that cannot be read, is asked again, never left uncertain", async () => {
    const lost = deliveryAnswering(async () => {
      throw new SlackApiError("reactions.add", "timeout", false, {});
    });
    expect(await lost.deliver(1)).toMatchObject({
      kind: "retry",
      code: "timeout",
    });
    expect(await lost.deliver(SLACK_SEND_MAX_ATTEMPTS)).toEqual({
      kind: "failed",
      code: "timeout",
    });
    expect(await deliveryAnswering(answer(null, 502)).deliver(1)).toMatchObject(
      { kind: "retry", code: "http_502" },
    );
  });

  test("a 429 waits its Retry-After, whether or not a body came with it", async () => {
    for (const body of [null, { ok: false, error: "ratelimited" }]) {
      const limited = deliveryAnswering(async () => ({
        httpStatus: 429,
        retryAfterHeader: "120",
        body,
      }));
      expect(await limited.deliver(1)).toEqual({
        kind: "retry",
        code: "ratelimited",
        retryAfterMs: 120_000,
      });
    }
  });

  test("one key per Slack team, channel and message", () => {
    expect(
      slackReactionDedupeKey({
        teamId: "T0ACME",
        channelId: "C0OPS",
        ts: "100.000200",
      }),
    ).toBe("reaction:T0ACME:C0OPS:100.000200");
  });
});

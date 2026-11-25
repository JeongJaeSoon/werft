import { describe, expect, test } from "bun:test";
import {
  type AuthorizationDecision,
  type ConversationJudgmentId,
  conversationJudgmentIdSchema,
} from "@werft-ai/contracts";
import { testCaller } from "@werft-ai/testkit/callers";
import {
  createJudgmentReviewService,
  type JudgmentReviewItem,
  type JudgmentTallyRow,
} from "./judgment-review.ts";
import type { Caller } from "./policy.ts";
import { SessionServiceError } from "./service-errors.ts";

const WORKSPACE = "019a0000-0000-7000-8000-000000000011";
const AGENT = "019a0000-0000-7000-8000-000000000012";
const USER = "019a0000-0000-7000-8000-000000000013";
const TEAM = "T0REVIEW";
const NOW = new Date("2026-11-25T00:00:00.000Z");

const person: Caller = {
  ...testCaller(WORKSPACE),
  actor: {
    principal: { kind: "user", id: USER },
    userId: USER,
    workspaceId: WORKSPACE,
    apiKeyId: null,
  },
};
const judgmentId = (n: number): ConversationJudgmentId =>
  conversationJudgmentIdSchema.parse(
    `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  );

const tally = (
  channelId: string,
  channelKind: JudgmentTallyRow["channelKind"],
  rest: Partial<JudgmentTallyRow> = {},
): JudgmentTallyRow => ({
  teamId: TEAM,
  channelId,
  channelKind,
  m1JudgmentsPerHour: channelKind === null ? null : 12,
  reason: "human_conversation",
  decision: "quiet",
  count: 1,
  ...rest,
});

const item = (n: number, channelId: string): JudgmentReviewItem => ({
  id: judgmentId(n),
  grade: "buffer_m1",
  teamId: TEAM,
  channelId,
  ts: `1764000000.00000${n}`,
  outcome: "judged",
  decision: "quiet",
  reason: "human_conversation",
  judgedAt: NOW,
});

function service(options: { tallies: JudgmentTallyRow[]; allow?: boolean }) {
  const listed: string[][] = [];
  const review = createJudgmentReviewService({
    authorization: {
      authorize: async () =>
        (options.allow === false
          ? { outcome: "deny", reason_code: "role", effective_scopes: [] }
          : {
              outcome: "allow",
              reason_code: "ok",
            }) as unknown as AuthorizationDecision,
    },
    store: {
      now: async () => NOW,
      tallies: async () => options.tallies,
      recent: async (input) => {
        listed.push(input.channels.map((channel) => channel.channelId));
        return input.channels.map((channel, index) =>
          item(index + 1, channel.channelId),
        );
      },
    },
  });
  return { review, listed };
}

describe("who sees M1's shadow records (a1/S3)", () => {
  test("counts add up per channel: judgments, speak, and reasons most first", async () => {
    const { review } = service({
      tallies: [
        tally("C0PUBLIC", "public_channel", { count: 2 }),
        tally("C0PUBLIC", "public_channel", {
          reason: "needs_agent",
          decision: "speak",
          count: 3,
        }),
        tally("C0PUBLIC", "public_channel", {
          reason: "rate_limited",
          count: 1,
        }),
      ],
    });
    const read = await review.getSlackJudgments(person, AGENT);
    expect(read.window_days).toBe(7);
    expect(read.since).toBe("2026-11-18T00:00:00.000Z");
    expect(read.channels).toEqual([
      {
        slack_team_id: TEAM,
        channel_id: "C0PUBLIC",
        channel_kind: "public_channel",
        m1_judgments_per_hour: 12,
        judgments: 6,
        speak: 3,
        reasons: [
          { reason: "needs_agent", count: 3 },
          { reason: "human_conversation", count: 2 },
          { reason: "rate_limited", count: 1 },
        ],
      },
    ]);
    // A link and codes only: no text of any message.
    expect(read.recent).toEqual([
      {
        id: judgmentId(1),
        grade: "buffer_m1",
        slack_team_id: TEAM,
        channel_id: "C0PUBLIC",
        ts: "1764000000.000001",
        url: "https://slack.com/archives/C0PUBLIC/p1764000000000001",
        outcome: "judged",
        decision: "quiet",
        reason: "human_conversation",
        judged_at: NOW.toISOString(),
      },
    ]);
  });

  test("a private channel's counts, list and links are read like a public one's", async () => {
    const { review, listed } = service({
      tallies: [
        tally("C0PUBLIC", "public_channel"),
        tally("G0PRIVATE", "private_channel", { count: 4 }),
        tally("C0UNBOUND", null, { count: 2 }),
      ],
    });
    const read = await review.getSlackJudgments(person, AGENT);
    expect(read.channels.map((channel) => channel.channel_id)).toEqual([
      "G0PRIVATE",
      "C0UNBOUND",
      "C0PUBLIC",
    ]);
    expect(read.channels[0]?.channel_kind).toBe("private_channel");
    expect(listed).toEqual([["G0PRIVATE", "C0UNBOUND", "C0PUBLIC"]]);
    expect(read.recent.map((entry) => entry.url)).toContain(
      "https://slack.com/archives/G0PRIVATE/p1764000000000001",
    );
  });

  test("a caller with no person behind it, but the permission, reads it too", async () => {
    const { review } = service({
      tallies: [tally("G0PRIVATE", "private_channel")],
    });
    const read = await review.getSlackJudgments(testCaller(WORKSPACE), AGENT);
    expect(read.channels.map((channel) => channel.channel_id)).toEqual([
      "G0PRIVATE",
    ]);
  });

  test("no response field holds a message body", async () => {
    const { review } = service({
      tallies: [tally("G0PRIVATE", "private_channel")],
    });
    const read = await review.getSlackJudgments(person, AGENT);
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object")
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key);
          walk(inner);
        }
    };
    walk(read);
    for (const key of keys)
      expect(key).not.toMatch(/^(text|body|message|content|blocks)$/);
  });

  test("a caller the policy refuses gets FORBIDDEN and nothing is read", async () => {
    const { review, listed } = service({
      tallies: [tally("C0PUBLIC", "public_channel")],
      allow: false,
    });
    const refused = await review
      .getSlackJudgments(person, AGENT)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SessionServiceError);
    expect((refused as SessionServiceError).code).toBe("FORBIDDEN");
    expect(listed).toEqual([]);
  });
});

import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresJudgmentReviewStore } from "./judgment-review.ts";

let client: PGlite;
let db: Database;

const WORKSPACE = "00000000-0000-4000-8000-0000000000c3";
const AGENT = "00000000-0000-4000-8000-0000000001c3";
const OTHER_AGENT = "00000000-0000-4000-8000-0000000002c3";
const TEAM = "T0REVIEW";

beforeEach(async () => {
  client = await migratedPGlite();
  // Only the rows the review reads; foreign keys are not what is under test.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

async function judgment(row: {
  channel: string;
  outcome: "judged" | "not_called" | null;
  decision?: "speak" | "quiet";
  reason?: string;
  answer?: string;
  refs?: string[];
  agent?: string;
  judgedAgo?: string;
}) {
  await client.query(
    `INSERT INTO conversation_judgments (id, workspace_id, agent_id,
      conversation_id, grade, slack_team_id, slack_channel_id, refs,
      prompt_version, outcome, decision, reason, judged_at, rule_decision,
      rule_reason, target_ts, answer)
     VALUES ($1, $2, $3, $4, $12, $5, $6, $7, 1, $8, $9, $10,
      CASE WHEN $8::text IS NULL THEN NULL ELSE now() - $11::interval END,
      $13, $14, $15, $16)`,
    [
      randomUUID(),
      WORKSPACE,
      row.agent ?? AGENT,
      randomUUID(),
      TEAM,
      row.channel,
      row.refs ?? ["100.000001"],
      row.outcome,
      row.outcome === null ? null : (row.decision ?? "quiet"),
      row.outcome === null ? null : (row.reason ?? "human_conversation"),
      row.judgedAgo ?? "1 hour",
      // A batch's is written judged; one still waiting is a reply's.
      row.outcome === null ? "m1_engaged" : "buffer_m1",
      row.outcome === null ? "none" : null,
      row.outcome === null ? "stray_reply" : null,
      // An answer needs a target among the refs and a judged speak.
      row.answer === undefined ? null : (row.refs ?? ["100.000001"]).at(-1),
      row.answer ?? null,
    ],
  );
}

async function binding(channel: string, kind: string, cap?: number) {
  await client.query(
    `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface,
      installation_id, external_surface_id, surface_kind, mode, listen,
      ceiling_actions, ceiling_disclosure, status, m1_judgments_per_hour)
     VALUES ($1, $2, $3, 'slack', $4, $5, $6, 'on', 'free', '{}', 'full',
      'ready', $7)`,
    [randomUUID(), WORKSPACE, AGENT, randomUUID(), channel, kind, cap ?? 12],
  );
}

const since = () => new Date(Date.now() - 7 * 86_400_000);

test("the tallies are the judged rows of the window, per channel, reason and decision", async () => {
  await binding("C0PUBLIC", "public_channel", 5);
  await binding("G0PRIVATE", "private_channel");
  await judgment({
    channel: "C0PUBLIC",
    outcome: "judged",
    decision: "speak",
    reason: "needs_agent",
  });
  await judgment({
    channel: "C0PUBLIC",
    outcome: "judged",
    decision: "speak",
    reason: "needs_agent",
  });
  await judgment({ channel: "C0PUBLIC", outcome: "judged" });
  await judgment({
    channel: "C0PUBLIC",
    outcome: "not_called",
    reason: "rate_limited",
  });
  await judgment({ channel: "G0PRIVATE", outcome: "judged" });
  await judgment({
    channel: "C0LOOSE",
    outcome: "not_called",
    reason: "budget_refused",
  });
  // Not counted: waiting for its judge, past the window, another agent's.
  await judgment({ channel: "C0PUBLIC", outcome: null });
  await judgment({
    channel: "C0PUBLIC",
    outcome: "judged",
    judgedAgo: "8 days",
  });
  await judgment({
    channel: "C0PUBLIC",
    outcome: "judged",
    agent: OTHER_AGENT,
  });
  const store = createPostgresJudgmentReviewStore(db);
  const rows = await store.tallies({
    workspaceId: WORKSPACE,
    agentId: AGENT,
    since: since(),
  });
  const sorted = [...rows].sort((a, b) =>
    `${a.channelId}${a.reason}`.localeCompare(`${b.channelId}${b.reason}`),
  );
  expect(sorted).toEqual([
    {
      teamId: TEAM,
      channelId: "C0LOOSE",
      channelKind: null,
      m1JudgmentsPerHour: null,
      reason: "budget_refused",
      decision: "quiet",
      count: 1,
    },
    {
      teamId: TEAM,
      channelId: "C0PUBLIC",
      channelKind: "public_channel",
      m1JudgmentsPerHour: 5,
      reason: "human_conversation",
      decision: "quiet",
      count: 1,
    },
    {
      teamId: TEAM,
      channelId: "C0PUBLIC",
      channelKind: "public_channel",
      m1JudgmentsPerHour: 5,
      reason: "needs_agent",
      decision: "speak",
      count: 2,
    },
    {
      teamId: TEAM,
      channelId: "C0PUBLIC",
      channelKind: "public_channel",
      m1JudgmentsPerHour: 5,
      reason: "rate_limited",
      decision: "quiet",
      count: 1,
    },
    {
      teamId: TEAM,
      channelId: "G0PRIVATE",
      channelKind: "private_channel",
      m1JudgmentsPerHour: 12,
      reason: "human_conversation",
      decision: "quiet",
      count: 1,
    },
  ]);
  // The SQL count agrees with the rows the window holds.
  const total = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM conversation_judgments WHERE agent_id = $1 AND outcome IS NOT NULL AND judged_at > now() - interval '7 days'",
    [AGENT],
  );
  expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(
    total.rows[0]?.n ?? -1,
  );
});

test("the recent list is of the channels named only, newest first, the last message's ts", async () => {
  await judgment({
    channel: "C0PUBLIC",
    outcome: "judged",
    refs: ["100.000001", "100.000009"],
    judgedAgo: "2 hours",
  });
  await judgment({
    channel: "C0PUBLIC",
    outcome: "not_called",
    reason: "budget_refused",
    refs: ["100.000010"],
    judgedAgo: "1 hour",
  });
  await judgment({
    channel: "G0HIDDEN",
    outcome: "judged",
    refs: ["100.000020"],
  });
  const store = createPostgresJudgmentReviewStore(db);
  const items = await store.recent({
    workspaceId: WORKSPACE,
    agentId: AGENT,
    since: since(),
    channels: [{ teamId: TEAM, channelId: "C0PUBLIC" }],
    limit: 50,
  });
  expect(items.map((item) => [item.ts, item.outcome, item.reason])).toEqual([
    ["100.000010", "not_called", "budget_refused"],
    ["100.000009", "judged", "human_conversation"],
  ]);
  expect(Object.keys(items[0] ?? {}).sort()).toEqual([
    "answer",
    "channelId",
    "decision",
    "grade",
    "id",
    "judgedAt",
    "outcome",
    "reason",
    "teamId",
    "ts",
  ]);
  expect(
    await store.recent({
      workspaceId: WORKSPACE,
      agentId: AGENT,
      since: since(),
      channels: [],
      limit: 50,
    }),
  ).toEqual([]);
});

test("a voided record is neither counted nor listed: it has no result", async () => {
  await judgment({ channel: "C0VOID", outcome: "judged" });
  await client.query(
    `INSERT INTO conversation_judgments (id, workspace_id, agent_id,
      conversation_id, grade, slack_team_id, slack_channel_id, refs,
      prompt_version, outcome, reason, judged_at)
     VALUES ($1, $2, $3, $4, 'buffer_m1', $5, 'C0VOID', '{}', 1, 'voided',
      'voided_by_delete', now())`,
    [randomUUID(), WORKSPACE, AGENT, randomUUID(), TEAM],
  );
  const store = createPostgresJudgmentReviewStore(db);
  const input = { workspaceId: WORKSPACE, agentId: AGENT, since: since() };
  expect(
    (await store.tallies(input)).map((row) => [row.reason, row.count]),
  ).toEqual([["human_conversation", 1]]);
  expect(
    (
      await store.recent({
        ...input,
        channels: [{ teamId: TEAM, channelId: "C0VOID" }],
        // The newer voided row takes no place in the list's limit.
        limit: 1,
      })
    ).map((item) => item.outcome),
  ).toEqual(["judged"]);
});

test("recent with a reason is that reason's records only, newest first, inside the same limit", async () => {
  for (const [reason, ago] of [
    ["human_conversation", "4 hours"],
    ["needs_agent", "3 hours"],
    ["human_conversation", "2 hours"],
    ["unclear", "90 minutes"],
    ["human_conversation", "1 hour"],
  ] as const) {
    await judgment({
      channel: "C0PUBLIC",
      outcome: "judged",
      reason,
      judgedAgo: ago,
    });
  }
  // Another channel not named, and a record of a reason nobody asked for.
  await judgment({ channel: "C0OTHER", outcome: "judged" });
  const store = createPostgresJudgmentReviewStore(db);
  const input = {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    since: since(),
    channels: [{ teamId: TEAM, channelId: "C0PUBLIC" }],
  };
  const ago = (items: { judgedAt: Date }[]) =>
    items.map((item) =>
      Math.round((Date.now() - item.judgedAt.getTime()) / 3_600_000),
    );
  const filtered = await store.recent({
    ...input,
    reason: "human_conversation",
    limit: 50,
  });
  expect(filtered.map((item) => item.reason)).toEqual([
    "human_conversation",
    "human_conversation",
    "human_conversation",
  ]);
  expect(ago(filtered)).toEqual([1, 2, 4]);
  // The limit counts the filtered records, not the unfiltered ones.
  expect(
    ago(
      await store.recent({ ...input, reason: "human_conversation", limit: 2 }),
    ),
  ).toEqual([1, 2]);
  expect(
    (await store.recent({ ...input, reason: "needs_agent", limit: 50 })).length,
  ).toBe(1);
  expect(
    await store.recent({ ...input, reason: "rate_limited", limit: 50 }),
  ).toEqual([]);
  // No reason: every record of the channel, as before.
  expect((await store.recent({ ...input, limit: 50 })).length).toBe(5);
});

test("recent with an answer is that answer's records only, alone or with a reason, newest first inside the limit", async () => {
  for (const [reason, answer, ago] of [
    ["needs_agent", "replied", "4 hours"],
    ["needs_agent", "no_reply", "3 hours"],
    ["needs_agent", "replied", "2 hours"],
    ["unclear", "replied", "90 minutes"],
    ["needs_agent", "replied", "1 hour"],
  ] as const) {
    await judgment({
      channel: "C0PUBLIC",
      outcome: "judged",
      decision: "speak",
      reason,
      answer,
      judgedAgo: ago,
    });
  }
  // A quiet record has no answer, and neither has a speak of a shadow rollout.
  await judgment({
    channel: "C0PUBLIC",
    outcome: "judged",
    judgedAgo: "30 minutes",
  });
  await judgment({
    channel: "C0PUBLIC",
    outcome: "judged",
    decision: "speak",
    judgedAgo: "20 minutes",
  });
  const store = createPostgresJudgmentReviewStore(db);
  const input = {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    since: since(),
    channels: [{ teamId: TEAM, channelId: "C0PUBLIC" }],
  };
  const hours = (items: { judgedAt: Date }[]) =>
    items.map((item) =>
      Math.round((Date.now() - item.judgedAt.getTime()) / 3_600_000),
    );
  const replied = await store.recent({
    ...input,
    answer: "replied",
    limit: 50,
  });
  expect(replied.map((item) => item.answer)).toEqual([
    "replied",
    "replied",
    "replied",
    "replied",
  ]);
  expect(hours(replied)).toEqual([1, 2, 2, 4]);
  // The limit counts the filtered records, not the unfiltered ones.
  expect(
    hours(await store.recent({ ...input, answer: "replied", limit: 2 })),
  ).toEqual([1, 2]);
  expect(
    (
      await store.recent({
        ...input,
        answer: "replied",
        reason: "unclear",
        limit: 50,
      })
    ).length,
  ).toBe(1);
  expect(
    (await store.recent({ ...input, answer: "no_reply", limit: 50 })).map(
      (item) => item.answer,
    ),
  ).toEqual(["no_reply"]);
  expect(
    await store.recent({ ...input, answer: "not_started", limit: 50 }),
  ).toEqual([]);
  // No answer: every record, the unanswered ones with a null.
  const every = await store.recent({ ...input, limit: 50 });
  expect(every.length).toBe(7);
  expect(every.filter((item) => item.answer === null).length).toBe(2);
});

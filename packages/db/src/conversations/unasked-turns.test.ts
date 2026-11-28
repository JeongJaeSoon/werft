import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationJudgmentId,
  type ConversationTopicId,
  type ConversationTurnId,
  conversationCallIdSchema,
  conversationCallKeySchema,
  conversationIdSchema,
  conversationJudgmentIdSchema,
  conversationTopicIdSchema,
  conversationTurnIdSchema,
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
} from "@werft-ai/contracts";
import {
  conversationCallReserve,
  hashConversationCallToken,
  type M1Judge,
  type M1Record,
  type M1Spoken,
  runReplyJudgments,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { saveBudgetLimit } from "../budget-accounts.ts";
import { createPostgresConversationCalls } from "../conversation-calls.ts";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { agents, memberTeams } from "../schema.ts";
import {
  createPostgresJudgmentAnswers,
  createPostgresM1JudgmentStore,
} from "../surface/m1-judgments.ts";
import { newPartitionedSession } from "../testing/sessions.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
} from "../testing/spec-pins.ts";
import { endConversationTurn } from "./conversation-turns.ts";
import { createPostgresJudgmentBatchStore } from "./judgment-batches.ts";
import { holdBufferedInput } from "./judgment-buffer.ts";
import { createPostgresMentionTurnStatuses } from "./mention-turn-statuses.ts";
import { takeSlackTurnInput } from "./slack-turn-inputs.ts";

let client: PGlite;
let db: Database;

const WORKSPACE = "00000000-0000-4000-8000-0000000000e5";
const AGENT = "00000000-0000-4000-8000-0000000001e5";
const TEAM = "T0UNASKED";
const CHANNEL = "C0UNASKED";
const APP = "A0UNASKED";
const MODEL = "claude-haiku-4-5";
const LIMITS = { model: MODEL, maxTokens: 256, maxRequestBytes: 4_096 };

beforeEach(async () => {
  client = await migratedPGlite();
  // Only the rows the turn reads; foreign keys are not what is under test.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

async function fresh() {
  await client.close();
  client = await migratedPGlite();
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
}

type Place = {
  teamId: string;
  conversationId: ReturnType<typeof conversationIdSchema.parse>;
  topicId: ConversationTopicId;
  bindingId: string;
  installationId: string;
};

async function place(
  options: { rollout?: "off" | "shadow" | "on"; budgetTokens?: number } = {},
): Promise<Place> {
  const teamId = randomUUID();
  await db
    .insert(memberTeams)
    .values({ id: teamId, workspaceId: WORKSPACE, name: "team" });
  await db.insert(agents).values({
    id: AGENT,
    workspaceId: WORKSPACE,
    managingTeamId: teamId,
    slug: "agent",
    name: "agent",
    conversationRollout: options.rollout ?? "on",
  });
  const reserve = conversationCallReserve(LIMITS);
  await saveBudgetLimit(
    db,
    WORKSPACE,
    { kind: "team", teamId },
    { costUsd: null, tokens: options.budgetTokens ?? reserve.tokens * 100 },
  );
  const installationId = randomUUID();
  await client.query(
    `INSERT INTO slack_installations (id, workspace_id, app_id, team_id)
     VALUES ($1, $2, $3, $4)`,
    [installationId, WORKSPACE, APP, TEAM],
  );
  const bindingId = randomUUID();
  await client.query(
    `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface,
      installation_id, external_surface_id, surface_kind, mode, listen,
      ceiling_actions, ceiling_disclosure, status, m1_judgments_per_hour)
     VALUES ($1, $2, $3, 'slack', $4, $5, 'public_channel', 'on', 'free', '{}',
      'full', 'ready', 12)`,
    [bindingId, WORKSPACE, AGENT, installationId, CHANNEL],
  );
  const conversationId = conversationIdSchema.parse(randomUUID());
  await client.query(
    `INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id)
     VALUES ($1, $2, $3, 'channel', $4, $5)`,
    [conversationId, WORKSPACE, AGENT, TEAM, CHANNEL],
  );
  return {
    teamId,
    conversationId,
    topicId: await topic(conversationId, "100.000001"),
    bindingId,
    installationId,
  };
}

async function topic(conversationId: string, threadTs: string) {
  const id = conversationTopicIdSchema.parse(randomUUID());
  await client.query(
    `INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id,
      conversation_kind, slack_team_id, slack_channel_id, slack_thread_ts)
     VALUES ($1, $2, $3, $4, 'channel', $5, $6, $7)`,
    [id, WORKSPACE, AGENT, conversationId, TEAM, CHANNEL, threadTs],
  );
  return id;
}

/** A judgment that spoke for `target`, of the posts `refs`: a batch's by default. */
async function spoke(
  at: Place,
  target = "100.000001",
  refs = ["100.000001", "100.000002"],
  grade: "buffer_m1" | "m1_engaged" | "m1" | "m1_to_task" = "buffer_m1",
): Promise<ConversationJudgmentId> {
  const id = conversationJudgmentIdSchema.parse(randomUUID());
  const rule = {
    buffer_m1: [null, null],
    m1_engaged: ["none", "stray_reply"],
    m1: ["reply", "default_reply"],
    m1_to_task: ["reply", "default_reply"],
  }[grade];
  await client.query(
    `INSERT INTO conversation_judgments (id, workspace_id, agent_id,
      conversation_id, grade, slack_team_id, slack_channel_id, refs,
      prompt_version, outcome, decision, reason, judged_at, target_ts,
      rule_decision, rule_reason)
     VALUES ($1, $2, $3, $4, $9, $5, $6, $7, 3, 'judged', 'speak',
      'needs_agent', now(), $8, $10, $11)`,
    [
      id,
      WORKSPACE,
      AGENT,
      at.conversationId,
      TEAM,
      CHANNEL,
      refs,
      target,
      grade,
      ...rule,
    ],
  );
  return id;
}

const calls = () => createPostgresConversationCalls(db);

function issue(
  at: Place,
  judgmentId: ConversationJudgmentId,
  overrides: {
    sources?: string[];
    turnId?: ConversationTurnId;
    topicId?: ConversationTopicId;
  } = {},
) {
  const turnId =
    overrides.turnId ?? conversationTurnIdSchema.parse(randomUUID());
  const token = `call-${turnId}`;
  return {
    turnId,
    token,
    issued: calls().issueUnsolicitedTurnAtomic({
      judgmentId,
      turnId,
      tokenHash: hashConversationCallToken(token),
      workspaceId: WORKSPACE,
      agentId: AGENT,
      conversationId: at.conversationId,
      topicId: overrides.topicId ?? at.topicId,
      teamId: TEAM,
      channelId: CHANNEL,
      sources: overrides.sources ?? ["100.000001", "100.000002"],
      releaseId: null,
      connectionId: "conn-messages",
      path: "/v1/messages",
      ...LIMITS,
      callKey: conversationCallKeySchema.parse(`${turnId}:m2`),
      ttlMs: 180_000,
    }),
  };
}

const turnsOf = () =>
  client.query<{
    id: string;
    state: string;
    requester_kind: string;
    requester_id: string;
  }>(
    "SELECT id, state, requester_kind, requester_id FROM conversation_turns WHERE agent_id = $1",
    [AGENT],
  );
const judgmentOf = async (id: ConversationJudgmentId) =>
  (
    await client.query<{ turn_id: string | null; answer: string | null }>(
      "SELECT turn_id, answer FROM conversation_judgments WHERE id = $1",
      [id],
    )
  ).rows[0];

describe("the unasked turn of a judgment that spoke (v1-b/U1)", () => {
  test("rollout on: one running turn of the agent, root none with no requester, tied to its judgment", async () => {
    const at = await place();
    const judgmentId = await spoke(at);
    const { turnId, issued } = issue(at, judgmentId);
    expect((await issued).outcome).toBe("issued");
    expect((await turnsOf()).rows).toEqual([
      {
        id: turnId,
        state: "running",
        requester_kind: "agent",
        requester_id: AGENT,
      },
    ]);
    const permit = await client.query(
      "SELECT root_kind, requester_user_id FROM conversation_turn_permits WHERE turn_id = $1",
      [turnId],
    );
    expect(permit.rows).toEqual([
      { root_kind: "none", requester_user_id: null },
    ]);
    expect(await judgmentOf(judgmentId)).toEqual({
      turn_id: turnId,
      answer: null,
    });
  });

  test("the same judgment again makes no second turn", async () => {
    const at = await place();
    const judgmentId = await spoke(at);
    const first = issue(at, judgmentId);
    expect((await first.issued).outcome).toBe("issued");
    expect((await issue(at, judgmentId).issued).outcome).toBe("duplicate");
    expect((await turnsOf()).rows.map((row) => row.id)).toEqual([first.turnId]);
    expect((await judgmentOf(judgmentId))?.turn_id).toBe(first.turnId);
  });

  test("a judgment whose end is written already, or that did not speak, makes none", async () => {
    const at = await place();
    const ended = await spoke(at);
    await createPostgresJudgmentAnswers(db).notStarted(ended, "not_started");
    expect((await issue(at, ended).issued).outcome).toBe("duplicate");
    const quiet = conversationJudgmentIdSchema.parse(randomUUID());
    await client.query(
      `INSERT INTO conversation_judgments (id, workspace_id, agent_id,
        conversation_id, grade, slack_team_id, slack_channel_id, refs,
        prompt_version, outcome, decision, reason, judged_at)
       VALUES ($1, $2, $3, $4, 'buffer_m1', $5, $6, '{100.000001}', 3,
        'judged', 'quiet', 'unclear', now())`,
      [quiet, WORKSPACE, AGENT, at.conversationId, TEAM, CHANNEL],
    );
    expect((await issue(at, quiet).issued).outcome).toBe("duplicate");
    expect((await turnsOf()).rows).toEqual([]);
  });

  for (const rollout of ["shadow", "off"] as const) {
    test(`rollout ${rollout}: the judgment is recorded, and no turn is made`, async () => {
      const at = await place({ rollout });
      const judgmentId = await spoke(at);
      expect((await issue(at, judgmentId).issued).outcome).toBe("rollout_off");
      expect((await turnsOf()).rows).toEqual([]);
      expect(await judgmentOf(judgmentId)).toEqual({
        turn_id: null,
        answer: null,
      });
    });
  }

  test("a deleted post of its text makes none", async () => {
    const at = await place();
    const judgmentId = await spoke(at);
    await client.query(
      `INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts,
        deleted_at) VALUES ($1, $2, $3, '100.000002', now())`,
      [WORKSPACE, TEAM, CHANNEL],
    );
    expect((await issue(at, judgmentId).issued).outcome).toBe("source_deleted");
    expect((await turnsOf()).rows).toEqual([]);
  });

  for (const [name, change, outcome] of [
    ["listening off", "listen = 'off'", "no_binding"],
    // Since the batch closed: it hears no post it is not called for.
    ["listening for mentions alone", "listen = 'mention'", "no_binding"],
    ["the binding off", "mode = 'off'", "no_binding"],
    [
      "the binding revoked",
      "status = 'revoked', revoked_at = now()",
      "no_binding",
    ],
    [
      "an emergency stop",
      "mode = 'off', emergency_stopped_at = now(), emergency_stop_reason = 'test'",
      "channel_stopped",
    ],
  ] as const) {
    test(`${name}: no turn`, async () => {
      const at = await place();
      const judgmentId = await spoke(at);
      await client.query(
        `UPDATE surface_bindings SET ${change} WHERE id = $1`,
        [at.bindingId],
      );
      expect((await issue(at, judgmentId).issued).outcome).toBe(outcome);
      expect((await turnsOf()).rows).toEqual([]);
    });
  }

  test("an engaged reply still speaks while the channel hears mentions alone", async () => {
    const at = await place();
    const judgmentId = await spoke(
      at,
      "100.000002",
      ["100.000002"],
      "m1_engaged",
    );
    await client.query(
      "UPDATE surface_bindings SET listen = 'mention' WHERE id = $1",
      [at.bindingId],
    );
    expect((await issue(at, judgmentId).issued).outcome).toBe("issued");
  });

  /** Work bound to the place's thread, its link open, at `admission`. */
  async function threadWork(at: Place, admission: "active" | "closing") {
    await client.query(
      `INSERT INTO slack_apps (id, workspace_id, kind, state, redirect_url,
        app_id, client_id, agent_id)
       VALUES ($1, $2, 'agent', 'created', 'https://console.example/slack',
        $3, 'client', $4)`,
      [randomUUID(), WORKSPACE, APP, AGENT],
    );
    const { sessionId, ownerId } = await newPartitionedSession(db, "work");
    await client.query(
      "UPDATE sessions SET admission_state = $2 WHERE id = $1",
      [sessionId, admission],
    );
    await client.query(
      `INSERT INTO session_links (id, workspace_id, owner_id, session_id,
        installation_id, surface_binding_id, surface_ref, channel_id,
        thread_id, opened_by_ts, agent_id, release_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '100.000001', '100.000001',
        $9, 'rel-work')`,
      [
        randomUUID(),
        WORKSPACE,
        ownerId,
        sessionId,
        at.installationId,
        at.bindingId,
        `${CHANNEL}:100.000001`,
        CHANNEL,
        AGENT,
      ],
    );
    return sessionId;
  }

  test("a reply of work going on that spoke (m1_to_task) makes none: the work answers it", async () => {
    const at = await place();
    await threadWork(at, "active");
    const judgmentId = await spoke(
      at,
      "100.000002",
      ["100.000002"],
      "m1_to_task",
    );
    expect((await issue(at, judgmentId).issued).outcome).toBe("duplicate");
    expect((await turnsOf()).rows).toEqual([]);
    expect(await judgmentOf(judgmentId)).toEqual({
      turn_id: null,
      answer: null,
    });
  });

  for (const [name, admission] of [
    ["closing as it is answered", "closing"],
    ["gone from its thread", null],
  ] as const) {
    test(`a reply held for its work (m1_to_task), that work ${name} (94S-2506): one unasked turn`, async () => {
      const at = await place();
      if (admission !== null) await threadWork(at, admission);
      const judgmentId = await spoke(
        at,
        "100.000002",
        ["100.000002"],
        "m1_to_task",
      );
      expect((await issue(at, judgmentId).issued).outcome).toBe("issued");
      expect((await turnsOf()).rows).toHaveLength(1);
      expect((await issue(at, judgmentId).issued).outcome).toBe("duplicate");
    });
  }

  /** The reply as the judgment buffer holds it, no turn's yet. */
  const heldReply = (ts: string) =>
    client.query(
      `INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id,
        seq, slack_team_id, slack_channel_id, slack_ts, requester_kind,
        requester_id, body, buffer_expires_at)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, 'slack_user', 'U0POSTER',
        'and the next step', now() + interval '10 minutes')`,
      [randomUUID(), WORKSPACE, AGENT, randomUUID(), TEAM, CHANNEL, ts],
    );

  test("a closed work's held reply that spoke (m1) makes its one unasked turn", async () => {
    const at = await place();
    await heldReply("100.000002");
    const judgmentId = await spoke(at, "100.000002", ["100.000002"], "m1");
    // The binding hears mentions alone: a bound thread's reply speaks still.
    await client.query(
      "UPDATE surface_bindings SET listen = 'mention' WHERE id = $1",
      [at.bindingId],
    );
    const { turnId, issued } = issue(at, judgmentId, {
      sources: ["100.000002"],
    });
    expect((await issued).outcome).toBe("issued");
    expect((await turnsOf()).rows).toEqual([
      expect.objectContaining({ id: turnId, requester_kind: "agent" }),
    ]);
  });

  test("a closed work's reply its session took (m1) makes none: one post, one answer", async () => {
    const at = await place();
    const session = await newPartitionedSession(db, "unasked-taken");
    await client.query(
      "UPDATE sessions SET status = 'idle', workspace_id = $2 WHERE id = $1",
      [session.sessionId, WORKSPACE],
    );
    await client.query(
      "UPDATE turns SET requester_kind = 'user', requester_id = $2 WHERE session_id = $1",
      [session.sessionId, randomUUID()],
    );
    await db.transaction((tx) =>
      takeSlackTurnInput(
        tx,
        { workspaceId: WORKSPACE, agentId: AGENT, teamId: TEAM },
        {
          topicId: at.topicId,
          channelId: CHANNEL,
          ts: "100.000002",
          turn: { sessionId: session.sessionId, sequence: 1 },
          engagement: "bound",
        },
      ),
    );
    const judgmentId = await spoke(at, "100.000002", ["100.000002"], "m1");
    expect(
      (await issue(at, judgmentId, { sources: ["100.000002"] }).issued).outcome,
    ).toBe("duplicate");
    expect((await turnsOf()).rows).toEqual([]);
    expect(await judgmentOf(judgmentId)).toEqual({
      turn_id: null,
      answer: null,
    });
  });

  for (const [name, change] of [
    [
      "the channel archived",
      "UPDATE conversations SET channel_state = 'archived' WHERE agent_id = $1",
    ],
    ["the agent paused", "UPDATE agents SET status = 'paused' WHERE id = $1"],
  ] as const) {
    test(`${name} since the judgment: no turn`, async () => {
      const at = await place();
      const judgmentId = await spoke(at);
      await client.query(change, [AGENT]);
      expect((await issue(at, judgmentId).issued).outcome).toBe("no_binding");
      expect((await turnsOf()).rows).toEqual([]);
    });
  }

  test("its calls are the agent's team's, refused past 80% of the account", async () => {
    const reserve = conversationCallReserve(LIMITS);
    for (const [tokens, outcome] of [
      [reserve.tokens * 100, "ok"],
      // One call's reserve is all the account holds: past root none's 80%.
      [reserve.tokens, "refused"],
    ] as const) {
      await fresh();
      const at = await place({ budgetTokens: tokens });
      const { token, issued } = issue(at, await spoke(at));
      expect((await issued).outcome).toBe("issued");
      const granted = await calls().authorizeTurnCallAtomic({
        tokenHash: hashConversationCallToken(token),
        exchangeId: randomUUID(),
        callId: conversationCallIdSchema.parse(randomUUID()),
        reserveFor: () => ({ reserve, unmetered: false }),
      });
      expect(granted.outcome).toBe(outcome);
      if (granted.outcome === "refused") {
        expect(granted.rootKind).toBe("none");
      }
    }
  });
});

describe("what became of a judgment that spoke", () => {
  async function ended(
    end: Parameters<typeof endConversationTurn>[1]["end"] | null,
    refusal: string | null = null,
  ) {
    const at = await place();
    const judgmentId = await spoke(at);
    const { turnId, issued } = issue(at, judgmentId);
    expect((await issued).outcome).toBe("issued");
    if (refusal !== null) {
      await client.query(
        "UPDATE conversation_turn_permits SET refusal = $2 WHERE turn_id = $1",
        [turnId, refusal],
      );
    }
    if (end !== null) {
      expect(await endConversationTurn(db, { turnId, end })).toBe("recorded");
    }
    const answers = createPostgresJudgmentAnswers(db);
    const first = await answers.ended(turnId);
    const again = await answers.ended(turnId);
    return { first, again, answer: (await judgmentOf(judgmentId))?.answer };
  }

  test("a reply is replied, another decision no_reply, written once", async () => {
    expect(
      await ended({
        state: "decided",
        decision: "reply",
        reason: "asked",
        answer: "the doc is in the wiki",
      }),
    ).toEqual({ first: true, again: false, answer: "replied" });
    await fresh();
    expect(
      await ended({
        state: "decided",
        decision: "no_reply",
        reason: "nothing to add",
        answer: null,
      }),
    ).toEqual({ first: true, again: false, answer: "no_reply" });
  });

  test("no decision is no_decision; one the budget refused, budget_refused; a delete's, source_deleted", async () => {
    for (const [end, refusal, answer] of [
      [{ state: "no_decision" }, null, "no_decision"],
      [{ state: "no_decision" }, "budget", "budget_refused"],
      [{ state: "voided_by_delete" }, null, "source_deleted"],
    ] as const) {
      await fresh();
      expect(await ended(end as never, refusal)).toEqual({
        first: true,
        again: false,
        answer,
      });
    }
  });

  test("a running turn writes nothing yet", async () => {
    expect(await ended(null)).toEqual({
      first: false,
      again: false,
      answer: null,
    });
  });

  test("why no turn was made is written once, and never over a turn's", async () => {
    const at = await place();
    const answers = createPostgresJudgmentAnswers(db);
    const notMade = await spoke(at);
    await answers.notStarted(notMade, "channel_stopped");
    await answers.notStarted(notMade, "not_started");
    expect((await judgmentOf(notMade))?.answer).toBe("channel_stopped");
    const made = await spoke(at);
    expect((await issue(at, made).issued).outcome).toBe("issued");
    await answers.notStarted(made, "source_deleted");
    expect((await judgmentOf(made))?.answer).toBeNull();
  });
});

describe("the endings pass and an unasked turn", () => {
  test("is due once its writer lets it go, marked unsolicited", async () => {
    const at = await place();
    const { turnId, issued } = issue(at, await spoke(at));
    expect((await issued).outcome).toBe("issued");
    const statuses = createPostgresMentionTurnStatuses(db);
    // Its writer's until queued.
    expect(await statuses.due(10, 60_000)).toEqual([]);
    await statuses.releaseReset(turnId);
    const [due, ...others] = await statuses.due(10, 60_000);
    expect(others).toEqual([]);
    expect(due).toMatchObject({
      turnId,
      agentId: AGENT,
      thread: { teamId: TEAM, channelId: CHANNEL, threadTs: "100.000001" },
      unsolicited: true,
    });
  });

  test("a mention's turn of the thread is not superseded by a newer unasked one", async () => {
    const at = await place();
    const mention = conversationTurnIdSchema.parse(randomUUID());
    await client.query(
      `INSERT INTO conversation_turns (id, workspace_id, agent_id, conversation_id,
        topic_id, origin, state, requester_kind, requester_id, decision,
        slack_installation_id, created_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, 'm2', 'decided', 'slack_user', 'U1',
        'no_reply', $6, now() - interval '1 minute', now())`,
      [
        mention,
        WORKSPACE,
        AGENT,
        at.conversationId,
        at.topicId,
        at.installationId,
      ],
    );
    await client.query(
      `INSERT INTO conversation_engagements (workspace_id, agent_id, team_id,
        channel_id, ts, kind, conversation_turn_id)
       VALUES ($1, $2, $3, $4, '100.000009', 'mention', $5)`,
      [WORKSPACE, AGENT, TEAM, CHANNEL, mention],
    );
    const { issued } = issue(at, await spoke(at));
    expect((await issued).outcome).toBe("issued");
    const statuses = createPostgresMentionTurnStatuses(db);
    // Its thread is set back to active: no newer mention holds "processing".
    expect(await statuses.claimReset(mention, 60_000)).toBe("send");
  });

  const newerMention = async (at: Place) => {
    const mention = conversationTurnIdSchema.parse(randomUUID());
    await client.query(
      `INSERT INTO conversation_turns (id, workspace_id, agent_id, conversation_id,
        topic_id, origin, state, requester_kind, requester_id,
        slack_installation_id, created_at, slack_status_claimed_at)
       VALUES ($1, $2, $3, $4, $5, 'm2', 'running', 'slack_user', 'U1', $6,
        now() + interval '1 second', now())`,
      [
        mention,
        WORKSPACE,
        AGENT,
        at.conversationId,
        at.topicId,
        at.installationId,
      ],
    );
    return mention;
  };
  const threadRows = async () =>
    (await client.query("SELECT thread_ts FROM mention_thread_statuses")).rows;

  test("its end leaves no thread to set again, though a newer mention holds it", async () => {
    const at = await place();
    const { turnId, issued } = issue(at, await spoke(at));
    expect((await issued).outcome).toBe("issued");
    await newerMention(at);
    const statuses = createPostgresMentionTurnStatuses(db);
    expect(await statuses.confirmReset(turnId)).toBe(false);
    expect(await threadRows()).toEqual([]);
  });

  test("a thread's status to set waits on no unasked turn of it", async () => {
    const at = await place();
    await client.query(
      `INSERT INTO mention_thread_statuses (workspace_id, agent_id,
        slack_installation_id, team_id, channel_id, thread_ts)
       VALUES ($1, $2, $3, $4, $5, '100.000001')`,
      [WORKSPACE, AGENT, at.installationId, TEAM, CHANNEL],
    );
    // Claimed by its writer, as every unasked turn is when made.
    const { issued } = issue(at, await spoke(at));
    expect((await issued).outcome).toBe("issued");
    const statuses = createPostgresMentionTurnStatuses(db);
    const claimed = await statuses.claimThreads(10, 60_000);
    expect(claimed.map((row) => row.thread.threadTs)).toEqual(["100.000001"]);
  });
});

describe("conversation_judgments' unasked columns (migration)", () => {
  const insert = (fields: {
    decision: "speak" | "quiet" | null;
    reason: string;
    target?: string | null;
    turnId?: string | null;
    answer?: string | null;
    refs?: (string | null)[];
  }) =>
    client.query(
      `INSERT INTO conversation_judgments (id, workspace_id, agent_id,
        conversation_id, grade, slack_team_id, slack_channel_id, refs,
        prompt_version, outcome, decision, reason, judged_at, target_ts,
        turn_id, answer)
       VALUES ($1, $2, $3, $4, 'buffer_m1', $5, $6, $12,
        3, 'judged', $7, $8, now(), $9, $10, $11)`,
      [
        randomUUID(),
        WORKSPACE,
        AGENT,
        randomUUID(),
        TEAM,
        CHANNEL,
        fields.decision,
        fields.reason,
        fields.target ?? null,
        fields.turnId ?? null,
        fields.answer ?? null,
        fields.refs ?? ["100.000001", "100.000002"],
      ],
    );

  test("a record of before, with none of them, still reads", async () => {
    await insert({ decision: "speak", reason: "needs_agent" });
    await insert({ decision: "quiet", reason: "unclear" });
  });

  test("quiet with invalid_target is a record; speak with it is not", async () => {
    await insert({ decision: "quiet", reason: "invalid_target" });
    await expect(
      insert({ decision: "speak", reason: "invalid_target" }),
    ).rejects.toThrow();
  });

  test("a judged record with no decision holds no target", async () => {
    await expect(
      insert({ decision: null, reason: "needs_agent", target: "100.000002" }),
    ).rejects.toThrow();
  });

  test("a target not among the refs is refused, a null among them too", async () => {
    await expect(
      insert({
        decision: "speak",
        reason: "needs_agent",
        target: "100.000009",
        refs: ["100.000001", null],
      }),
    ).rejects.toThrow();
  });

  test("a target is one of the refs, and only a speak's", async () => {
    await insert({
      decision: "speak",
      reason: "needs_agent",
      target: "100.000002",
    });
    for (const bad of [
      { decision: "speak", reason: "needs_agent", target: "100.000009" },
      { decision: "quiet", reason: "unclear", target: "100.000001" },
    ] as const) {
      await expect(insert(bad)).rejects.toThrow();
    }
  });

  test("a turn or an answer needs a target; an answer is one of the list", async () => {
    for (const bad of [
      { decision: "speak", reason: "needs_agent", turnId: randomUUID() },
      { decision: "speak", reason: "needs_agent", answer: "replied" },
      {
        decision: "speak",
        reason: "needs_agent",
        target: "100.000001",
        answer: "sent",
      },
    ] as const) {
      await expect(insert(bad)).rejects.toThrow();
    }
    await insert({
      decision: "speak",
      reason: "needs_agent",
      target: "100.000001",
      answer: "not_started",
    });
  });

  test("one judgment per turn; any number with none", async () => {
    const turnId = randomUUID();
    const tied = {
      decision: "speak",
      reason: "needs_agent",
      target: "100.000001",
    } as const;
    await insert({ ...tied, turnId });
    await expect(insert({ ...tied, turnId })).rejects.toThrow(
      "conversation_judgments_turn_uniq",
    );
    for (let n = 0; n < 3; n++) await insert(tied);
  });

  // A turn's row goes only with its conversation (cascade), which takes
  // the judgment too; SET NULL keeps a judgment whose turn alone goes.
  test("a deleted turn empties its judgment's turn and keeps the record", async () => {
    const fk = await client.query<{ rule: string; columns: string }>(
      `SELECT confdeltype AS rule, pg_get_constraintdef(oid) AS columns
       FROM pg_constraint WHERE conname = 'conversation_judgments_turn_fk'`,
    );
    expect(fk.rows).toEqual([
      {
        rule: "n",
        columns:
          "FOREIGN KEY (turn_id) REFERENCES conversation_turns(id) ON DELETE SET NULL",
      },
    ]);
  });
});

describe("a closed work's thread reply that spoke (v1-b/U1)", () => {
  test("a reply held again by a second event of it is answered once", async () => {
    const at = await place();
    const first = await spoke(at, "100.000007", ["100.000007"], "m1");
    expect(
      (await issue(at, first, { sources: ["100.000007"] }).issued).outcome,
    ).toBe("issued");
    const again = await spoke(at, "100.000007", ["100.000007"], "m1");
    expect(
      (await issue(at, again, { sources: ["100.000007"] }).issued).outcome,
    ).toBe("duplicate");
    expect(await judgmentOf(again)).toEqual({ turn_id: null, answer: null });
  });

  test("a post a batch holds stays the batch's when a session's turn takes it", async () => {
    const at = await place();
    const session = await newPartitionedSession(db, "unasked-batched");
    await client.query(
      "UPDATE sessions SET status = 'idle', workspace_id = $2 WHERE id = $1",
      [session.sessionId, WORKSPACE],
    );
    await client.query(
      "UPDATE turns SET requester_kind = 'user', requester_id = $2 WHERE session_id = $1",
      [session.sessionId, randomUUID()],
    );
    await db.transaction((tx) =>
      holdBufferedInput(
        tx,
        { workspaceId: WORKSPACE, agentId: AGENT, teamId: TEAM },
        {
          topicId: at.topicId,
          channelId: CHANNEL,
          ts: "100.000006",
          buffered: { body: "where is the deploy doc?", slackUserId: "U0P" },
          // A work's judgment beside it, as a shadow append can write.
          judgment: {
            grade: "m1_to_task",
            rule: { decision: "reply", reason: "default_reply" },
          },
        },
        JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
      ),
    );
    await client.query(
      "UPDATE conversation_inputs SET judgment_batch_id = $1 WHERE slack_ts = '100.000006'",
      [randomUUID()],
    );
    await db.transaction((tx) =>
      takeSlackTurnInput(
        tx,
        { workspaceId: WORKSPACE, agentId: AGENT, teamId: TEAM },
        {
          topicId: at.topicId,
          channelId: CHANNEL,
          ts: "100.000006",
          turn: { sessionId: session.sessionId, sequence: 1 },
          engagement: "bound",
        },
      ),
    );
    const { rows } = await client.query(
      "SELECT turn_id, judgment_batch_id IS NOT NULL AS batched, buffer_expires_at IS NOT NULL AS held FROM conversation_inputs WHERE slack_ts = '100.000006'",
    );
    expect(rows).toEqual([{ turn_id: null, batched: true, held: true }]);
  });

  test("the session takes it as its one turn; M1's speak makes no unasked turn", async () => {
    const at = await place();
    const session = await newPartitionedSession(db, "unasked-closed");
    await client.query(
      "UPDATE sessions SET status = 'idle', admission_state = 'closed', workspace_id = $2 WHERE id = $1",
      [session.sessionId, WORKSPACE],
    );
    await client.query(
      "UPDATE turns SET requester_kind = 'user', requester_id = $2 WHERE session_id = $1",
      [session.sessionId, randomUUID()],
    );
    await db.transaction((tx) =>
      takeSlackTurnInput(
        tx,
        { workspaceId: WORKSPACE, agentId: AGENT, teamId: TEAM },
        {
          topicId: at.topicId,
          channelId: CHANNEL,
          ts: "100.000005",
          turn: { sessionId: session.sessionId, sequence: 1 },
          engagement: "bound",
          judgment: { rule: { decision: "reply", reason: "default_reply" } },
        },
      ),
    );
    const judge: M1Judge = {
      judge: async (subject) => ({
        record: {
          verdict: {
            outcome: "judged",
            decision: "speak",
            reason: "needs_agent",
          },
          refs: subject.posts.map((post) => post.ts),
          sources: { keys: [], overflow: false },
          releaseId: null,
          callKey: conversationCallKeySchema.parse(`${subject.key}:m1`),
          attempts: 1,
          summary: null,
          target: "100.000005",
        },
        left: [],
        modelCalled: true,
      }),
    };
    const spoken: M1Spoken[] = [];
    const run = await runReplyJudgments({
      store: createPostgresM1JudgmentStore(db),
      judge,
      speaker: { speak: async (each) => void spoken.push(each) },
      logger: { warn: () => {}, info: () => {} },
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(run.judged).toBe(1);
    const judged = await client.query<{
      grade: string;
      decision: string;
      turn_id: string | null;
      answer: string | null;
    }>(
      "SELECT grade, decision, turn_id, answer FROM conversation_judgments WHERE agent_id = $1",
      [AGENT],
    );
    expect(judged.rows).toEqual([
      { grade: "m1", decision: "speak", turn_id: null, answer: null },
    ]);
    expect(spoken).toEqual([]);
    expect((await turnsOf()).rows).toEqual([]);
    const sessionTurns = await client.query(
      "SELECT sequence FROM turns WHERE session_id = $1",
      [session.sessionId],
    );
    expect(sessionTurns.rows).toEqual([{ sequence: 1 }]);
  });
});

describe("a batch that spoke keeps its post's topic for the turn (v1-b/U1)", () => {
  const POST = "100.000009";
  /** A post held in a thread of its own, judged in a batch that spoke for it. */
  async function judged(rollout: "on" | "shadow") {
    const at = await place({ rollout });
    // A batch is closed for an agent with a release only.
    await client.query(
      "UPDATE agents SET status = 'active', active_release_id = 'rel-unasked', activation_revision = 1 WHERE id = $1",
      [AGENT],
    );
    await client.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         repository_id, runtime_config_snapshot, effective_tools, policy_pins,
         ${RELEASE_SPEC_SQL_COLUMNS})
       VALUES ('rel-unasked', $1, $2, $3, 'sample-app', '{}', '{}', '{}', ${releaseSpecSqlValues()})`,
      [AGENT, randomUUID(), "a".repeat(64)],
    );
    const topicId = await topic(at.conversationId, POST);
    const held = await db.transaction((tx) =>
      holdBufferedInput(
        tx,
        { workspaceId: WORKSPACE, agentId: AGENT, teamId: TEAM },
        {
          topicId,
          channelId: CHANNEL,
          ts: POST,
          buffered: { body: "where is the deploy doc?", slackUserId: "U0P" },
        },
        JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
      ),
    );
    expect(held.outcome).toBe("held");
    await client.query(
      "UPDATE conversation_inputs SET received_at = now() - interval '20 seconds'",
    );
    const closed = await createPostgresJudgmentBatchStore(db).closeNext();
    if (closed?.outcome !== "judging") {
      throw new Error(`no batch to judge: ${JSON.stringify(closed)}`);
    }
    const record: M1Record = {
      verdict: { outcome: "judged", decision: "speak", reason: "needs_agent" },
      refs: [POST],
      sources: { keys: [], overflow: false },
      releaseId: null,
      callKey: conversationCallKeySchema.parse(`${closed.batch.id}:m1`),
      attempts: 1,
      summary: null,
      target: POST,
    };
    const written = await createPostgresM1JudgmentStore(db).recordBatch(
      closed.batch,
      record,
      closed.batch.inputs,
    );
    if (written.outcome !== "written") throw new Error(written.outcome);
    return { at, topicId, judgmentId: written.judgmentId };
  }
  const topicThere = async (id: ConversationTopicId) =>
    (
      await client.query("SELECT 1 FROM conversation_topics WHERE id = $1", [
        id,
      ])
    ).rows.length === 1;

  test("rollout on: the post's row goes, its topic stays, and the turn is made in it", async () => {
    const { at, topicId, judgmentId } = await judged("on");
    const rows = await client.query(
      "SELECT 1 FROM conversation_inputs WHERE slack_ts = $1",
      [POST],
    );
    expect(rows.rows).toEqual([]);
    expect(await topicThere(topicId)).toBe(true);
    const { issued } = issue(at, judgmentId, { topicId, sources: [POST] });
    expect((await issued).outcome).toBe("issued");
    // The turn holds it now: a let-go removes nothing.
    await createPostgresJudgmentAnswers(db).topicUnused(topicId);
    expect(await topicThere(topicId)).toBe(true);
  });

  test("rollout on, no turn made: the let-go removes the empty topic", async () => {
    const { topicId } = await judged("on");
    await createPostgresJudgmentAnswers(db).topicUnused(topicId);
    expect(await topicThere(topicId)).toBe(false);
  });

  test("rollout shadow: no turn comes, and the topic goes with the post", async () => {
    const { at, topicId, judgmentId } = await judged("shadow");
    expect(await topicThere(topicId)).toBe(false);
    // The rollout is told, not the topic gone: nothing is written on it.
    const { issued } = issue(at, judgmentId, { topicId, sources: [POST] });
    expect((await issued).outcome).toBe("rollout_off");
  });
});

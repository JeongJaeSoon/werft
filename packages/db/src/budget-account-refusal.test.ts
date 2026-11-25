import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  SLACK_NOTICE_MESSAGES,
  sessionEventPayloadSchema,
} from "@werft-ai/contracts";
import {
  budgetRefusalTurnDedupeKey,
  type ProviderUsage,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { saveBudgetLimit } from "./budget-accounts.ts";
import {
  budgetAccountRefused,
  budgetChoiceOfCall,
  recordBudgetAccountRefusal,
} from "./exchange-budget.ts";
import { createProviderExchangeLedger } from "./provider-exchanges.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  agents,
  attempts,
  events,
  linkedAccounts,
  memberTeams,
  sessionLinks,
  sessions,
  slackApps,
  slackInstallations,
  slackOutbox,
  turns,
  users,
} from "./schema.ts";
import { createPostgresSlackOutboxStore } from "./surface/slack-outbox.ts";

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  // Only the rows the refusal reads; their foreign keys are not under test.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

const WORKSPACE = "00000000-0000-4000-8000-0000000000c2";
const RESERVE: ProviderUsage = {
  model: "gpt-5.5",
  inputTokens: 1_200,
  outputTokens: 32_768,
  cacheCreationInputTokens: 0,
  cacheCreation1hInputTokens: 0,
  cacheReadInputTokens: 0,
  speed: "standard",
  inferenceGeo: "unknown",
  webSearchRequests: 0,
  webFetchRequests: 0,
  codeExecutionRequests: 0,
  estimated: true,
};

/**
 * A session whose first turn a person asked for (locale ko), run by one
 * attempt, and, unless `link` is false, a live Slack thread for it in
 * `channel` (C1). The person's Slack account is `slackUser` (U1), or none.
 */
async function threaded(
  options: {
    link?: false | { muted?: boolean };
    channel?: string;
    slackUser?: string | null;
  } = {},
) {
  const teamId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const attemptId = `att-${crypto.randomUUID()}`;
  await db.insert(memberTeams).values({
    id: teamId,
    workspaceId: WORKSPACE,
    name: `team-${teamId.slice(0, 8)}`,
  });
  await db.insert(agents).values({
    id: agentId,
    workspaceId: WORKSPACE,
    managingTeamId: teamId,
    slug: `a-${agentId.slice(0, 8)}`,
    name: "agent",
  });
  await db.insert(users).values({
    id: userId,
    email: `${userId}@example.invalid`,
    passwordHash: "argon2id$placeholder",
    displayName: "ko",
    locale: "ko",
  });
  await db.insert(sessions).values({
    id: sessionId,
    ownerId: "owner-refusal",
    repoUrl: "https://github.com/acme/app.git",
    branch: "main",
    repositoryId: "app",
    checkpointRevision: 1,
    workspaceId: WORKSPACE,
    agentReleaseId: `rel-${agentId}`,
  });
  await db.insert(attempts).values({
    id: attemptId,
    sessionId,
    executionId: `exec-${attemptId}`,
    leaseEpoch: 1,
    executionGeneration: 1,
    authRevision: 1,
    state: "running",
    leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
  });
  let linkId: string | null = null;
  if (options.link !== false) {
    const appRowId = crypto.randomUUID();
    const appId = `A${appRowId.slice(0, 8).toUpperCase()}`;
    const installationId = crypto.randomUUID();
    linkId = crypto.randomUUID();
    await db.insert(slackApps).values({
      id: appRowId,
      workspaceId: WORKSPACE,
      kind: "agent",
      agentId,
      state: "created",
      appId,
      clientId: `1.${appRowId.slice(0, 8)}`,
      redirectUrl: "https://example.invalid/slack/callback",
      botTokenRef: `slack_app:${appRowId}/slack_bot_token`,
      eventsState: "verified",
      eventsUrl: "https://example.invalid/slack/events",
    });
    await db.insert(slackInstallations).values({
      id: installationId,
      workspaceId: WORKSPACE,
      appId,
      teamId: "T1",
    });
    await db.insert(sessionLinks).values({
      id: linkId,
      workspaceId: WORKSPACE,
      ownerId: "owner-refusal",
      sessionId,
      installationId,
      surfaceBindingId: crypto.randomUUID(),
      surfaceRef: options.channel ?? "C1",
      channelId: options.channel ?? "C1",
      threadId: "1730000000.000100",
      openedByTs: "1730000000.000100",
      agentId,
      releaseId: `rel-${agentId}`,
      createdBy: userId,
      muted: options.link?.muted ?? false,
    });
    const slackUser =
      options.slackUser === undefined ? "U1" : options.slackUser;
    if (slackUser !== null) {
      await db.insert(linkedAccounts).values({
        id: crypto.randomUUID(),
        workspaceId: WORKSPACE,
        userId,
        provider: "slack",
        externalTenant: "T1",
        externalUserId: slackUser,
        verifiedVia: "slack_oidc",
        verifiedAt: new Date("2026-11-01T00:00:00Z"),
      });
    }
  }
  let sequence = 0;
  /**
   * Ends the running turn, if any (failed, as a refused turn ends, or
   * completed), and starts the person's next one.
   */
  async function run(end: "failed" | "completed" = "failed") {
    await db
      .update(turns)
      .set({ status: end })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.status, "running")));
    sequence += 1;
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId,
        sequence,
        message: `turn ${sequence}`,
        status: "running",
        attemptId,
        actorId: userId,
        requesterKind: "user",
        requesterId: userId,
        requesterAuth: {
          method: "web_session",
          web_session_id: crypto.randomUUID(),
        },
      })
      .returning({ id: turns.id });
    return turn?.id ?? 0;
  }
  return { sessionId, attemptId, teamId, userId, linkId, run };
}

/** The proxy's open of a call, as the authorizer passes it on. */
async function open(who: { sessionId: string; attemptId: string }) {
  const ids = {
    exchangeId: crypto.randomUUID(),
    sessionId: who.sessionId,
    attemptId: who.attemptId,
  };
  const { choice: budget } = await budgetChoiceOfCall(db, ids);
  const call = { ...ids, reserve: RESERVE };
  return createProviderExchangeLedger(db, {
    admits: async () => () => true,
  }).open(budget === undefined ? call : { ...call, budget });
}

async function refusalEvents(sessionId: string) {
  return db
    .select({ turnId: events.turnId, payload: events.payload })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), eq(events.type, "error")))
    .orderBy(asc(events.id));
}

async function notices(sessionId: string) {
  return db
    .select({
      kind: slackOutbox.kind,
      slackUserId: slackOutbox.slackUserId,
      status: slackOutbox.status,
      channelId: slackOutbox.channelId,
      threadTs: slackOutbox.threadTs,
      sessionLinkId: slackOutbox.sessionLinkId,
      body: slackOutbox.body,
      dedupeKey: slackOutbox.dedupeKey,
    })
    .from(slackOutbox)
    .where(eq(slackOutbox.sessionId, sessionId))
    .orderBy(asc(slackOutbox.seq));
}

/** Opens a call the person's zero limit refuses, and records it as the authorizer does. */
async function refusedFor(who: { sessionId: string; attemptId: string }) {
  const opened = await open(who);
  if (opened.outcome !== "budget_exceeded" || opened.by !== "account") {
    throw new Error(`not an account's refusal: ${JSON.stringify(opened)}`);
  }
  return recordBudgetAccountRefusal(db, {
    sessionId: who.sessionId,
    attemptId: who.attemptId,
    owner: opened.owner,
  });
}

describe("a budget account's refusal on its session", () => {
  test("names whose account refused, on the turn; the thread hears the first, the person alone the next", async () => {
    const who = await threaded();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "user", userId: who.userId },
      { costUsd: 0, tokens: 0 },
    );
    const first = await who.run();
    expect(await open(who)).toMatchObject({
      outcome: "budget_exceeded",
      by: "account",
      owner: "user",
    });
    expect(await refusedFor(who)).toBe("thread");
    // The engine retrying the refused call within the same turn.
    expect(await refusedFor(who)).toBe("recorded_before");
    const recorded = await refusalEvents(who.sessionId);
    expect(recorded).toEqual([
      {
        turnId: first,
        payload: {
          code: "BUDGET_EXCEEDED",
          message: SLACK_NOTICE_MESSAGES.en.budgetAccountUser,
          budget_owner: "user",
        },
      },
    ]);
    // What every reader of the stream parses it with.
    expect(
      sessionEventPayloadSchema.safeParse({
        event: "error",
        data: recorded[0]?.payload,
      }).success,
    ).toBe(true);
    const line = {
      text: SLACK_NOTICE_MESSAGES.ko.budgetAccountUser,
      locale: "ko" as const,
    };
    expect(await notices(who.sessionId)).toEqual([
      {
        kind: "failure_notice",
        slackUserId: null,
        status: "pending",
        channelId: "C1",
        threadTs: "1730000000.000100",
        sessionLinkId: who.linkId,
        body: line,
        dedupeKey: budgetRefusalTurnDedupeKey(who.linkId ?? "", 1),
      },
    ]);

    // The refused turn failed; the next is refused too: its own event, and
    // the same line to the person who asked, in the thread, them alone.
    const second = await who.run();
    expect(await refusedFor(who)).toBe("ephemeral");
    expect((await refusalEvents(who.sessionId)).map((e) => e.turnId)).toEqual([
      first,
      second,
    ]);
    expect((await notices(who.sessionId))[1]).toEqual({
      kind: "notice",
      slackUserId: "U1",
      status: "pending",
      channelId: "C1",
      threadTs: "1730000000.000100",
      sessionLinkId: who.linkId,
      body: line,
      dedupeKey: budgetRefusalTurnDedupeKey(who.linkId ?? "", 2),
    });
  });

  test("the refused turns' rows answer them: no failed-turn notice follows", async () => {
    const who = await threaded();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "user", userId: who.userId },
      { costUsd: 0, tokens: 0 },
    );
    await who.run();
    await refusedFor(who);
    await who.run();
    await refusedFor(who);
    await db
      .update(turns)
      .set({ status: "failed" })
      .where(eq(turns.sessionId, who.sessionId));
    const outbox = createPostgresSlackOutboxStore(db);
    expect(await outbox.unansweredTurns(10)).toEqual([]);
    // Without the refusal's row the same failed turn is owed its notice.
    await db
      .delete(slackOutbox)
      .where(eq(slackOutbox.sessionId, who.sessionId));
    expect(
      (await outbox.unansweredTurns(10)).map((turn) => turn.turnId),
    ).toEqual([1, 2]);
  });

  test("after a completed turn, or in a new month, a refusal is the first again", async () => {
    const who = await threaded();
    await who.run();
    const refuse = () =>
      recordBudgetAccountRefusal(db, {
        sessionId: who.sessionId,
        attemptId: who.attemptId,
        owner: "user",
      });
    expect(await refuse()).toBe("thread");
    await who.run();
    expect(await refuse()).toBe("ephemeral");
    // The limit was raised: this turn's calls went through and it completed.
    const passed = await who.run();
    await db.insert(events).values({
      sessionId: who.sessionId,
      type: "assistant",
      payload: { type: "assistant" },
      turnId: passed,
    });
    await who.run("completed");
    expect(await refuse()).toBe("thread");
    // The refusals so far were last month's; the account is a new one.
    await db
      .update(events)
      .set({ createdAt: sql`now() - interval '40 days'` })
      .where(eq(events.sessionId, who.sessionId));
    await who.run();
    expect(await refuse()).toBe("thread");
  });

  test("a direct message hears every refusal in the thread", async () => {
    const who = await threaded({ channel: "D1" });
    for (let turn = 1; turn <= 2; turn += 1) {
      await who.run();
      expect(
        await recordBudgetAccountRefusal(db, {
          sessionId: who.sessionId,
          attemptId: who.attemptId,
          owner: "user",
        }),
      ).toBe("thread");
    }
    expect((await notices(who.sessionId)).map((n) => n.kind)).toEqual([
      "failure_notice",
      "failure_notice",
    ]);
  });

  test("a later refusal whose person has no Slack account stays silent", async () => {
    const who = await threaded({ slackUser: null });
    const refuse = () =>
      recordBudgetAccountRefusal(db, {
        sessionId: who.sessionId,
        attemptId: who.attemptId,
        owner: "user",
      });
    await who.run();
    expect(await refuse()).toBe("thread");
    await who.run();
    expect(await refuse()).toBe("unposted");
    const [, silent] = await db
      .select({
        kind: slackOutbox.kind,
        status: slackOutbox.status,
        errorCode: slackOutbox.errorCode,
      })
      .from(slackOutbox)
      .where(eq(slackOutbox.sessionId, who.sessionId))
      .orderBy(asc(slackOutbox.seq));
    // Written failed: never sent, and still the turn's answer.
    expect(silent).toEqual({
      kind: "failure_notice",
      status: "failed",
      errorCode: "no_requester_slack_user",
    });
  });

  test("the agent team's account says the team's, in the team's words", async () => {
    const who = await threaded();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "team", teamId: who.teamId },
      { costUsd: 0, tokens: 0 },
    );
    await who.run();
    expect(
      await recordBudgetAccountRefusal(db, {
        sessionId: who.sessionId,
        attemptId: who.attemptId,
        owner: "team",
      }),
    ).toBe("thread");
    expect(await budgetAccountRefused(db, who.sessionId)).toBe("team");
    expect((await notices(who.sessionId))[0]?.body).toEqual({
      text: SLACK_NOTICE_MESSAGES.ko.budgetAccountTeam,
      locale: "ko",
    });
  });

  test("the agent's own work with no team to charge reads as the team's", async () => {
    const who = await threaded({ link: false });
    await who.run();
    await recordBudgetAccountRefusal(db, {
      sessionId: who.sessionId,
      attemptId: who.attemptId,
      owner: null,
    });
    expect(await budgetAccountRefused(db, who.sessionId)).toBe("team");
  });

  test("a session with no thread, or a muted one, keeps the event and posts nothing", async () => {
    for (const link of [false, { muted: true }] as const) {
      const who = await threaded({ link });
      await who.run();
      expect(
        await recordBudgetAccountRefusal(db, {
          sessionId: who.sessionId,
          attemptId: who.attemptId,
          owner: "user",
        }),
      ).toBe("unposted");
      expect(await refusalEvents(who.sessionId)).toHaveLength(1);
      expect(await notices(who.sessionId)).toEqual([]);
    }
  });

  test("a call between turns is the attempt's, recorded once", async () => {
    const who = await threaded({ link: false });
    const refuse = () =>
      recordBudgetAccountRefusal(db, {
        sessionId: who.sessionId,
        attemptId: who.attemptId,
        owner: "user",
      });
    expect(await refuse()).toBe("unposted");
    expect(await refuse()).toBe("recorded_before");
    expect((await refusalEvents(who.sessionId)).map((e) => e.turnId)).toEqual([
      null,
    ]);
  });

  test("no such session records nothing", async () => {
    expect(
      await recordBudgetAccountRefusal(db, {
        sessionId: crypto.randomUUID(),
        attemptId: "att-none",
        owner: "user",
      }),
    ).toBe("no_session");
  });
});

describe("budgetAccountRefused", () => {
  test("is told until a turn of the session completes after the refusal", async () => {
    const who = await threaded({ link: false });
    expect(await budgetAccountRefused(db, who.sessionId)).toBeNull();
    const refusedTurn = await who.run();
    await recordBudgetAccountRefusal(db, {
      sessionId: who.sessionId,
      attemptId: who.attemptId,
      owner: "user",
    });
    expect(await budgetAccountRefused(db, who.sessionId)).toBe("user");
    // The refused turn ends failed; the next one is still before any
    // completion, so the refusal still shows.
    await db
      .update(turns)
      .set({ status: "failed" })
      .where(eq(turns.id, refusedTurn));
    const next = await who.run();
    expect(await budgetAccountRefused(db, who.sessionId)).toBe("user");
    // That turn's calls went through: its events follow the refusal.
    await db.insert(events).values({
      sessionId: who.sessionId,
      type: "assistant",
      payload: { type: "assistant" },
      turnId: next,
    });
    await db
      .update(turns)
      .set({ status: "completed" })
      .where(eq(turns.id, next));
    expect(await budgetAccountRefused(db, who.sessionId)).toBeNull();
  });

  test("an error event of another code is not a refusal", async () => {
    const who = await threaded({ link: false });
    await db.insert(events).values({
      sessionId: who.sessionId,
      type: "error",
      payload: { code: "MODEL_NOT_ALLOWED", message: "cut", model: "m" },
    });
    await db.insert(events).values({
      sessionId: who.sessionId,
      type: "error",
      payload: { code: "BUDGET_EXCEEDED", message: "no owner" },
    });
    expect(await budgetAccountRefused(db, who.sessionId)).toBeNull();
  });
});

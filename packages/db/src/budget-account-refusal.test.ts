import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  SLACK_NOTICE_MESSAGES,
  sessionEventPayloadSchema,
} from "@werft-ai/contracts";
import type { ProviderUsage } from "@werft-ai/platform";
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
      .set({ status: end, endedAt: new Date() })
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
  const { choice: budget, turnId } = await budgetChoiceOfCall(db, ids);
  const call = { ...ids, reserve: RESERVE };
  const opened = await createProviderExchangeLedger(db, {
    admits: async () => () => true,
  }).open(budget === undefined ? call : { ...call, budget });
  return { opened, turnId };
}

async function refusalEvents(sessionId: string) {
  return db
    .select({ turnId: events.turnId, payload: events.payload })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), eq(events.type, "error")))
    .orderBy(asc(events.id));
}

/** The session's ended turns its thread is owed an answer for, and their refusals. */
async function owed(sessionId: string) {
  return (await createPostgresSlackOutboxStore(db).unansweredTurns(50))
    .filter((turn) => turn.sessionId === sessionId)
    .map(({ turnId, state, budgetRefusal }) => ({
      turnId,
      state,
      budgetRefusal,
    }));
}

/** Opens a call the person's zero limit refuses, and records it as the authorizer does. */
async function refusedFor(who: { sessionId: string; attemptId: string }) {
  const { opened, turnId } = await open(who);
  if (opened.outcome !== "budget_exceeded" || opened.by !== "account") {
    throw new Error(`not an account's refusal: ${JSON.stringify(opened)}`);
  }
  return recordBudgetAccountRefusal(db, {
    sessionId: who.sessionId,
    attemptId: who.attemptId,
    turnId,
    owner: opened.owner,
  });
}

/** Records a refusal of the turn the call was chosen for, as the authorizer does. */
const refuse = (
  who: { sessionId: string; attemptId: string },
  turnId: string | null,
  owner: "user" | "team" | null = "user",
) =>
  recordBudgetAccountRefusal(db, {
    sessionId: who.sessionId,
    attemptId: who.attemptId,
    turnId,
    owner,
  });

describe("a budget account's refusal on its session", () => {
  test("names whose account refused, on the turn the call was chosen for, once", async () => {
    const who = await threaded();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "user", userId: who.userId },
      { costUsd: 0, tokens: 0 },
    );
    const first = await who.run();
    expect((await open(who)).opened).toMatchObject({
      outcome: "budget_exceeded",
      by: "account",
      owner: "user",
    });
    expect(await refusedFor(who)).toBe("recorded");
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
  });

  test("a turn that ended after its call was chosen still holds the refusal", async () => {
    const who = await threaded();
    const first = await who.run();
    // The turn ends and the next starts between the choice and the record.
    await who.run();
    expect(await refuse(who, "1")).toBe("recorded");
    expect((await refusalEvents(who.sessionId)).map((e) => e.turnId)).toEqual([
      first,
    ]);
  });

  test("the agent team's account, and the agent's own work with no team, read as the team's", async () => {
    for (const owner of ["team", null] as const) {
      const who = await threaded({ link: false });
      await who.run();
      expect(await refuse(who, "1", owner)).toBe("recorded");
      expect(await budgetAccountRefused(db, who.sessionId)).toBe("team");
    }
  });

  test("a call no turn serves is the attempt's, recorded once", async () => {
    const who = await threaded({ link: false });
    expect(await refuse(who, null)).toBe("recorded");
    expect(await refuse(who, null)).toBe("recorded_before");
    expect((await refusalEvents(who.sessionId)).map((e) => e.turnId)).toEqual([
      null,
    ]);
  });

  test("no such session records nothing", async () => {
    expect(
      await refuse(
        { sessionId: crypto.randomUUID(), attemptId: "att-none" },
        "1",
      ),
    ).toBe("no_session");
  });
});

describe("the refused turns' Slack answers (unansweredTurns)", () => {
  test("the first refused turn is the first; the next is not", async () => {
    const who = await threaded();
    await who.run();
    await refuse(who, "1");
    await who.run();
    await refuse(who, "2");
    await who.run();
    expect(await owed(who.sessionId)).toEqual([
      {
        turnId: 1,
        state: "failed",
        budgetRefusal: { owner: "user", first: true },
      },
      {
        turnId: 2,
        state: "failed",
        budgetRefusal: { owner: "user", first: false },
      },
    ]);
  });

  test("a refusal no turn holds told nobody, so the next turn's is the first", async () => {
    const who = await threaded();
    await refuse(who, null);
    await who.run();
    await refuse(who, "1");
    await who.run();
    expect((await owed(who.sessionId))[0]?.budgetRefusal).toEqual({
      owner: "user",
      first: true,
    });
  });

  test("after a completed turn the limit was lifted: the next refusal is the first again", async () => {
    const who = await threaded();
    await who.run();
    await refuse(who, "1");
    await who.run();
    await who.run("completed");
    await refuse(who, "3");
    await who.run();
    expect(await owed(who.sessionId)).toEqual([
      {
        turnId: 1,
        state: "failed",
        budgetRefusal: { owner: "user", first: true },
      },
      { turnId: 2, state: "completed", budgetRefusal: null },
      {
        turnId: 3,
        state: "failed",
        budgetRefusal: { owner: "user", first: true },
      },
    ]);
  });

  test("a refusal on a turn told nothing (interrupted, or completed after all) does not take the first", async () => {
    const who = await threaded();
    await who.run();
    await refuse(who, "1");
    await db
      .update(turns)
      .set({ status: "interrupted", endedAt: new Date() })
      .where(and(eq(turns.sessionId, who.sessionId), eq(turns.sequence, 1)));
    await who.run();
    await refuse(who, "2");
    await who.run();
    expect(await owed(who.sessionId)).toEqual([
      {
        turnId: 2,
        state: "failed",
        budgetRefusal: { owner: "user", first: true },
      },
    ]);
  });

  test("a refusal last month does not hold this month's", async () => {
    const who = await threaded();
    await who.run();
    await refuse(who, "1");
    await db
      .update(events)
      .set({ createdAt: sql`now() - interval '40 days'` })
      .where(eq(events.sessionId, who.sessionId));
    await who.run();
    await refuse(who, "2");
    await who.run();
    expect((await owed(who.sessionId))[1]?.budgetRefusal).toEqual({
      owner: "user",
      first: true,
    });
  });

  test("a turn that completed after all is answered as a reply", async () => {
    const who = await threaded();
    await who.run();
    await refuse(who, "1");
    await who.run("completed");
    expect(await owed(who.sessionId)).toEqual([
      { turnId: 1, state: "completed", budgetRefusal: null },
    ]);
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
      turnId: "1",
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

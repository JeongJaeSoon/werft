import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  SLACK_NOTICE_MESSAGES,
  sessionEventPayloadSchema,
} from "@werft-ai/contracts";
import type { ProviderUsage } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, asc, eq } from "drizzle-orm";
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
  memberTeams,
  sessionLinks,
  sessions,
  slackApps,
  slackInstallations,
  slackOutbox,
  turns,
  users,
} from "./schema.ts";

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
 * attempt, and, unless `link` is false, a live Slack thread for it.
 */
async function threaded(options: { link?: false | { muted?: boolean } } = {}) {
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
      surfaceRef: "C1",
      channelId: "C1",
      threadId: "1730000000.000100",
      openedByTs: "1730000000.000100",
      agentId,
      releaseId: `rel-${agentId}`,
      createdBy: userId,
      muted: options.link?.muted ?? false,
    });
  }
  let sequence = 0;
  /** Completes the running turn, if any, and starts the person's next one. */
  async function run() {
    await db
      .update(turns)
      .set({ status: "completed" })
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
      channelId: slackOutbox.channelId,
      threadTs: slackOutbox.threadTs,
      sessionLinkId: slackOutbox.sessionLinkId,
      body: slackOutbox.body,
      dedupeKey: slackOutbox.dedupeKey,
    })
    .from(slackOutbox)
    .where(eq(slackOutbox.sessionId, sessionId));
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
  test("names whose account refused, on the turn, and tells the thread once", async () => {
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
    expect(await notices(who.sessionId)).toEqual([
      {
        kind: "failure_notice",
        channelId: "C1",
        threadTs: "1730000000.000100",
        sessionLinkId: who.linkId,
        body: {
          text: SLACK_NOTICE_MESSAGES.ko.budgetAccountUser,
          locale: "ko",
        },
        dedupeKey: expect.stringMatching(
          new RegExp(`^budget_account:${who.linkId}:user:\\d{4}-\\d{2}$`),
        ),
      },
    ]);

    // A later turn refused again: its own event, and still one notice.
    const second = await who.run();
    expect(await refusedFor(who)).toBe("recorded");
    expect((await refusalEvents(who.sessionId)).map((e) => e.turnId)).toEqual([
      first,
      second,
    ]);
    expect(await notices(who.sessionId)).toHaveLength(1);
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
    ).toBe("recorded");
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
      ).toBe("recorded");
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
    expect(await refuse()).toBe("recorded");
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

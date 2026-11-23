import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ProviderUsage,
  reservationCostUsd,
  reservationTokens,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { saveBudgetLimit } from "./budget-accounts.ts";
import { budgetChoiceOfCall } from "./exchange-budget.ts";
import { createProviderExchangeLedger } from "./provider-exchanges.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  attempts,
  budgetAccounts,
  budgetReservations,
  memberTeams,
  providerExchanges,
  sessions,
  turns,
} from "./schema.ts";
import { releaseSpecColumns, TEST_CONNECTION_ID } from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  // Only the rows the choice reads; their triggers and foreign keys are
  // not what is under test.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

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
const COST = reservationCostUsd(RESERVE);
const TOKENS = reservationTokens(RESERVE);
const BILLED = 0.0084;
const USED: ProviderUsage = { ...RESERVE, outputTokens: 80, estimated: false };

const WORKSPACE = "00000000-0000-4000-8000-0000000000c1";

type Requester = {
  requesterKind: string | null;
  requesterId: string | null;
  requesterAuth: unknown;
};

const web = (userId: string): Requester => ({
  requesterKind: "user",
  requesterId: userId,
  requesterAuth: {
    method: "web_session",
    web_session_id: crypto.randomUUID(),
  },
});

/** A session of an agent whose managing team is `teamId`, with an attempt. */
async function sessionOf(
  options: { teamArchived?: boolean; workspaceId?: string | null } = {},
) {
  const teamId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const releaseId = `rel-${agentId}`;
  await db.insert(memberTeams).values({
    id: teamId,
    workspaceId: WORKSPACE,
    name: `team-${teamId.slice(0, 8)}`,
    ...(options.teamArchived ? { archivedAt: new Date() } : {}),
  });
  await db.insert(agents).values({
    id: agentId,
    workspaceId: WORKSPACE,
    managingTeamId: teamId,
    slug: `a-${agentId.slice(0, 8)}`,
    name: "agent",
  });
  await db.insert(agentReleases).values({
    id: releaseId,
    agentId,
    versionId: crypto.randomUUID(),
    cardSha256: "0".repeat(64),
    connectionId: TEST_CONNECTION_ID,
    ...releaseSpecColumns(),
    runtimeConfigSnapshot: {},
    effectiveTools: [],
  });
  const sessionId = crypto.randomUUID();
  const attemptId = `att-${crypto.randomUUID()}`;
  await db.insert(sessions).values({
    id: sessionId,
    ownerId: "owner-budget",
    repoUrl: "https://github.com/acme/app.git",
    branch: "main",
    repositoryId: "app",
    checkpointRevision: 1,
    workspaceId:
      options.workspaceId === undefined ? WORKSPACE : options.workspaceId,
    agentReleaseId: releaseId,
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
  let sequence = 0;
  /** Ends the running turn, if any, and starts one with this requester. */
  async function run(requester: Requester) {
    await db
      .update(turns)
      .set({ status: "completed" })
      .where(eq(turns.sessionId, sessionId));
    sequence += 1;
    await db.insert(turns).values({
      sessionId,
      sequence,
      message: `turn ${sequence}`,
      status: "running",
      attemptId,
      ...requester,
    });
  }
  return { sessionId, attemptId, teamId, agentId, run };
}

function ledger() {
  return createProviderExchangeLedger(db, { admits: async () => () => true });
}

/** The proxy's open as the authorizer passes it on; a replay names its id. */
async function open(
  who: { sessionId: string; attemptId: string },
  exchangeId: string = crypto.randomUUID(),
) {
  const ids = {
    exchangeId,
    sessionId: who.sessionId,
    attemptId: who.attemptId,
  };
  const { choice: budget } = await budgetChoiceOfCall(db, ids);
  const call = { ...ids, reserve: RESERVE };
  const opened = await ledger().open(
    budget === undefined ? call : { ...call, budget },
  );
  return { exchangeId, budget, opened };
}

function report(
  who: { sessionId: string; attemptId: string },
  exchangeId: string,
) {
  return createPostgresWorkerUnitOfWork(db).recordProviderUsageAtomic({
    exchangeId,
    ...who,
    usage: USED,
    priceFor: () => ({ costUsd: BILLED, pricedBy: "table" }),
  });
}

async function accountOf(ownerId: string) {
  const [account] = await db
    .select()
    .from(budgetAccounts)
    .where(eq(budgetAccounts.ownerId, ownerId));
  return account;
}

async function rowOf(exchangeId: string) {
  const [row] = await db
    .select()
    .from(providerExchanges)
    .where(eq(providerExchanges.exchangeId, exchangeId));
  return row;
}

async function reservationOf(exchangeId: string) {
  const [row] = await db
    .select()
    .from(budgetReservations)
    .where(eq(budgetReservations.callId, exchangeId));
  return row;
}

describe("the account a running turn's calls are held on", () => {
  test("a person's turn: their account, a call past its limit refused, the account settled to the turn's use", async () => {
    const who = await sessionOf();
    const person = crypto.randomUUID();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "user", userId: person },
      { costUsd: COST * 1.5, tokens: null },
    );
    await who.run(web(person));

    const first = await open(who);
    expect(first.budget).toEqual({
      rootKind: "user",
      owner: { kind: "user", userId: person },
    });
    expect(first.opened).toEqual({ outcome: "created" });
    // A second call in flight beside it would take the account past 1.5x.
    const second = await open(who);
    expect(second.opened).toMatchObject({
      outcome: "budget_exceeded",
      by: "account",
    });
    expect(await rowOf(second.exchangeId)).toBeUndefined();

    await report(who, first.exchangeId);
    const settled = await accountOf(person);
    expect(settled?.spentCostUsd).toBe(BILLED);
    expect(settled?.reservedCostUsd).toBe(0);
    expect(settled?.reservedTokens).toBe(0);
    // With the first settled at its real cost, the next call fits again.
    expect((await open(who)).opened).toEqual({ outcome: "created" });
    expect(await rowOf(first.exchangeId)).toBeUndefined();
  });

  test("a call refused on the account, asked again smaller, is held when it fits", async () => {
    const who = await sessionOf();
    const person = crypto.randomUUID();
    // Room for a reserve a quarter the size, not for the full one.
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "user", userId: person },
      { costUsd: null, tokens: Math.floor(TOKENS / 2) },
    );
    await who.run(web(person));
    const ids = { sessionId: who.sessionId, attemptId: who.attemptId };
    const { choice } = await budgetChoiceOfCall(db, {
      exchangeId: crypto.randomUUID(),
      ...ids,
    });
    if (choice === undefined) throw new Error("no account chosen");
    const full = { exchangeId: crypto.randomUUID(), ...ids, reserve: RESERVE };
    expect(await ledger().open({ ...full, budget: choice })).toMatchObject({
      outcome: "budget_exceeded",
      by: "account",
    });
    const smaller: ProviderUsage = {
      ...RESERVE,
      outputTokens: Math.floor(RESERVE.outputTokens / 4),
    };
    expect(reservationTokens(smaller)).toBeLessThan(Math.floor(TOKENS / 2));
    const retry = {
      exchangeId: crypto.randomUUID(),
      ...ids,
      reserve: smaller,
    };
    expect(await ledger().open({ ...retry, budget: choice })).toEqual({
      outcome: "created",
    });
    expect(await reservationOf(full.exchangeId)).toBeUndefined();
    expect((await accountOf(person))?.reservedTokens).toBe(
      reservationTokens(smaller),
    );
  });

  test("the running turn's id comes with the choice; none without a running turn", async () => {
    const who = await sessionOf();
    const call = () =>
      budgetChoiceOfCall(db, {
        exchangeId: crypto.randomUUID(),
        sessionId: who.sessionId,
        attemptId: who.attemptId,
      });
    expect(await call()).toEqual({ choice: undefined, turnId: null });
    await who.run(web(crypto.randomUUID()));
    await who.run(web(crypto.randomUUID()));
    expect((await call()).turnId).toBe("2");
  });

  test("an open's replay keeps the first open's account after its turn ends or the next one starts", async () => {
    const who = await sessionOf();
    const [ana, ben] = [crypto.randomUUID(), crypto.randomUUID()];
    await who.run(web(ana));
    const first = await open(who);
    expect(first.opened).toEqual({ outcome: "created" });
    // The turn ended: a new open would choose the first turn's account.
    await db
      .update(turns)
      .set({ status: "completed" })
      .where(eq(turns.sessionId, who.sessionId));
    const ended = await open(who, first.exchangeId);
    expect(ended.budget).toEqual(first.budget);
    expect(ended.opened).toEqual({ outcome: "open" });
    // The next turn is another person's.
    await who.run(web(ben));
    const next = await open(who, first.exchangeId);
    expect(next.budget).toEqual(first.budget);
    expect(next.opened).toEqual({ outcome: "open" });
    expect((await reservationOf(first.exchangeId))?.accountId).toBe(
      (await accountOf(ana))?.id,
    );
    expect(await accountOf(ben)).toBeUndefined();
  });

  test("an open held on the session's limit alone is replayed so after a turn starts", async () => {
    const who = await sessionOf();
    const first = await open(who);
    expect(first.budget).toBeUndefined();
    await who.run(web(crypto.randomUUID()));
    const again = await open(who, first.exchangeId);
    expect(again.budget).toBeUndefined();
    expect(again.opened).toEqual({ outcome: "open" });
  });

  test("a team's reservation is replayed on the team, a team-less key's on no account", async () => {
    for (const teamArchived of [false, true]) {
      const who = await sessionOf({ teamArchived });
      await who.run({
        requesterKind: "api_key",
        requesterId: crypto.randomUUID(),
        requesterAuth: { method: "agent_key", agent_id: who.agentId },
      });
      const first = await open(who);
      expect(first.budget).toEqual({
        rootKind: "key",
        owner: teamArchived ? null : { kind: "team", teamId: who.teamId },
      });
      await who.run(web(crypto.randomUUID()));
      const again = await open(who, first.exchangeId);
      expect(again.budget).toEqual(first.budget);
      expect(again.opened).toEqual({ outcome: "open" });
    }
  });

  test("two people's turns in one session are each charged to their own account", async () => {
    const who = await sessionOf();
    const [ana, ben] = [crypto.randomUUID(), crypto.randomUUID()];
    await who.run(web(ana));
    const first = await open(who);
    await who.run(web(ben));
    const second = await open(who);
    expect((await reservationOf(first.exchangeId))?.accountId).toBe(
      (await accountOf(ana))?.id,
    );
    expect((await reservationOf(second.exchangeId))?.accountId).toBe(
      (await accountOf(ben))?.id,
    );
    expect((await accountOf(ana))?.reservedTokens).toBe(TOKENS);
    expect((await accountOf(ben))?.reservedTokens).toBe(TOKENS);
  });

  test("a push follow-up and a continuation are charged to the root's person, as user", async () => {
    const who = await sessionOf();
    const person = crypto.randomUUID();
    const asked = web(person);
    await who.run({
      requesterKind: "agent",
      requesterId: who.agentId,
      requesterAuth: {
        method: "push_decision",
        push_request_id: crypto.randomUUID(),
        decision: "approve",
        root: {
          requester_kind: asked.requesterKind,
          requester_id: asked.requesterId,
          requester_auth: asked.requesterAuth,
          via: [],
        },
        carried_from: { turn: "1", reason: "push_follow_up" },
      },
    });
    const followUp = await open(who);
    await who.run({
      ...asked,
      requesterAuth: {
        ...(asked.requesterAuth as object),
        carried_from: { turn: "2", reason: "continuation" },
      },
    });
    const continued = await open(who);
    const account = await accountOf(person);
    for (const call of [followUp, continued]) {
      expect(call.opened).toEqual({ outcome: "created" });
      expect(await rowOf(call.exchangeId)).toMatchObject({
        budgetRootKind: "user",
        budgetAccountId: account?.id,
      });
    }
  });

  test("a personal key's turn: root kind key, the account of the person who made it", async () => {
    const who = await sessionOf();
    const maker = crypto.randomUUID();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "user", userId: maker },
      { costUsd: COST * 1.5, tokens: null },
    );
    await who.run({
      requesterKind: "user",
      requesterId: maker,
      requesterAuth: {
        method: "personal_key",
        api_key_id: crypto.randomUUID(),
      },
    });
    const first = await open(who);
    expect(first.opened).toEqual({ outcome: "created" });
    expect(await rowOf(first.exchangeId)).toMatchObject({
      budgetRootKind: "key",
      budgetAccountId: (await accountOf(maker))?.id,
    });
    expect((await open(who)).opened).toMatchObject({
      outcome: "budget_exceeded",
      by: "account",
    });
  });

  test("a key with no person: the agent's team; past a team limit refused, with none it runs and is kept", async () => {
    const limited = await sessionOf();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "team", teamId: limited.teamId },
      { costUsd: COST * 1.5, tokens: null },
    );
    const agentKey = {
      requesterKind: "api_key",
      requesterId: crypto.randomUUID(),
      requesterAuth: { method: "agent_key", agent_id: limited.agentId },
    };
    await limited.run(agentKey);
    const first = await open(limited);
    expect(first.budget).toEqual({
      rootKind: "key",
      owner: { kind: "team", teamId: limited.teamId },
    });
    expect(first.opened).toEqual({ outcome: "created" });
    expect((await open(limited)).opened).toMatchObject({
      outcome: "budget_exceeded",
      by: "account",
    });

    const open_ = await sessionOf();
    await open_.run({ ...agentKey, requesterAuth: { method: "service_key" } });
    const unlimited = await open(open_);
    expect(unlimited.opened).toEqual({ outcome: "created" });
    expect(await rowOf(unlimited.exchangeId)).toMatchObject({
      budgetRootKind: "key",
      budgetAccountId: (await accountOf(open_.teamId))?.id,
    });
  });

  test("a key turn of an agent whose team is archived runs with no account, its root kind kept", async () => {
    const who = await sessionOf({ teamArchived: true });
    await who.run({
      requesterKind: "api_key",
      requesterId: crypto.randomUUID(),
      requesterAuth: { method: "agent_key", agent_id: who.agentId },
    });
    const call = await open(who);
    expect(call.budget).toEqual({ rootKind: "key", owner: null });
    expect(call.opened).toEqual({ outcome: "created" });
    expect(await rowOf(call.exchangeId)).toMatchObject({
      budgetRootKind: "key",
      budgetAccountId: null,
    });
    expect((await reservationOf(call.exchangeId))?.accountId).toBeNull();
  });

  test("an allowed Slack bot's turn: the agent's team as slack_bot, running with no team limit", async () => {
    const who = await sessionOf();
    await who.run({
      requesterKind: "slack_bot",
      requesterId: "U0BOT",
      requesterAuth: {
        method: "slack_bot",
        installation_id: crypto.randomUUID(),
        agent_id: who.agentId,
      },
    });
    const call = await open(who);
    expect(call.opened).toEqual({ outcome: "created" });
    expect(await rowOf(call.exchangeId)).toMatchObject({
      budgetRootKind: "slack_bot",
      budgetAccountId: (await accountOf(who.teamId))?.id,
    });
  });

  test("the agent's own work (root none) is refused with no team limit, and held with one", async () => {
    const who = await sessionOf();
    await who.run({
      requesterKind: "agent",
      requesterId: who.agentId,
      requesterAuth: null,
    });
    const refused = await open(who);
    expect(refused.budget).toEqual({
      rootKind: "none",
      owner: { kind: "team", teamId: who.teamId },
    });
    expect(refused.opened).toMatchObject({
      outcome: "budget_exceeded",
      by: "account",
    });
    expect(await rowOf(refused.exchangeId)).toBeUndefined();

    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "team", teamId: who.teamId },
      { costUsd: COST * 1.5, tokens: null },
    );
    const held = await open(who);
    expect(held.opened).toEqual({ outcome: "created" });
    expect((await rowOf(held.exchangeId))?.budgetRootKind).toBe("none");
  });

  // Before 94S-2019 both were held on the session's limit alone.
  test("a call no running turn serves, and a title call, are charged as the session's first turn", async () => {
    const who = await sessionOf();
    const [ana, ben] = [crypto.randomUUID(), crypto.randomUUID()];
    const ofAna = {
      rootKind: "user" as const,
      owner: { kind: "user" as const, userId: ana },
    };
    await who.run(web(ana));
    await who.run(web(ben));
    const title = () =>
      budgetChoiceOfCall(db, {
        exchangeId: crypto.randomUUID(),
        sessionId: who.sessionId,
        attemptId: who.attemptId,
        title: true,
      });
    // Ben's turn runs: his calls are his, the title call is still Ana's.
    expect((await open(who)).budget).toEqual({
      rootKind: "user",
      owner: { kind: "user", userId: ben },
    });
    expect(await title()).toEqual({ choice: ofAna, turnId: null });
    // Between turns, a call is the session's.
    await db
      .update(turns)
      .set({ status: "completed" })
      .where(eq(turns.sessionId, who.sessionId));
    const between = await open(who);
    expect(between.budget).toEqual(ofAna);
    expect(between.opened).toEqual({ outcome: "created" });
    expect((await reservationOf(between.exchangeId))?.accountId).toBe(
      (await accountOf(ana))?.id,
    );
  });

  test("a session made with a personal key charges its between-turn calls to the key's maker", async () => {
    const who = await sessionOf();
    const maker = crypto.randomUUID();
    await who.run({
      requesterKind: "user",
      requesterId: maker,
      requesterAuth: {
        method: "personal_key",
        api_key_id: crypto.randomUUID(),
      },
    });
    await db
      .update(turns)
      .set({ status: "completed" })
      .where(eq(turns.sessionId, who.sessionId));
    expect((await open(who)).budget).toEqual({
      rootKind: "key",
      owner: { kind: "user", userId: maker },
    });
  });

  test("an old person's turn with no credential recorded is still that person's", async () => {
    const who = await sessionOf();
    const person = crypto.randomUUID();
    await who.run({
      requesterKind: "user",
      requesterId: person,
      requesterAuth: null,
    });
    expect((await open(who)).budget).toEqual({
      rootKind: "user",
      owner: { kind: "user", userId: person },
    });
  });

  describe("held on the session's limit alone, as before accounts, even with a team limit of 0", () => {
    const cases: [string, Requester | null][] = [
      [
        "a turn with no requester recorded",
        { requesterKind: null, requesterId: null, requesterAuth: null },
      ],
      [
        "a requester kind this build does not know",
        { requesterKind: "robot", requesterId: "r-1", requesterAuth: null },
      ],
      [
        "a push follow-up whose push request's turn was not found",
        {
          requesterKind: "agent",
          requesterId: "agent-1",
          requesterAuth: {
            method: "push_decision",
            push_request_id: crypto.randomUUID(),
            decision: "approve",
          },
        },
      ],
      ["a session with no turn yet, so no first turn to charge", null],
    ];
    for (const [name, requester] of cases) {
      test(name, async () => {
        const who = await sessionOf();
        await saveBudgetLimit(
          db,
          WORKSPACE,
          { kind: "team", teamId: who.teamId },
          { costUsd: 0, tokens: 0 },
        );
        if (requester !== null) await who.run(requester);
        const call = await open(who);
        expect(call.budget).toBeUndefined();
        expect(call.opened).toEqual({ outcome: "created" });
        expect(await rowOf(call.exchangeId)).toMatchObject({
          budgetRootKind: null,
          budgetAccountId: null,
        });
        expect(await reservationOf(call.exchangeId)).toBeUndefined();
      });
    }

    test("a session with no workspace", async () => {
      const who = await sessionOf({ workspaceId: null });
      await who.run(web(crypto.randomUUID()));
      const call = await open(who);
      expect(call.budget).toBeUndefined();
      expect(call.opened).toEqual({ outcome: "created" });
    });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type BudgetChoice,
  type BudgetRoot,
  chooseBudgetAccount,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  budgetLimitOf,
  createBudgetLedger,
  saveBudgetLimit,
} from "./budget-accounts.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { budgetAccounts, budgetReservations, workspaces } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("budget accounts on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;
  let workspaceId: string;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "budget_accounts_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema }) as NodePgDatabase<
      typeof schema
    > as unknown as Database;
    workspaceId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "Budget" });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const ledger = () => createBudgetLedger(db);
  const person = (): BudgetChoice => ({
    rootKind: "user",
    owner: { kind: "user", userId: crypto.randomUUID() },
  });
  const team = (rootKind: "key" | "none"): BudgetChoice => ({
    rootKind,
    owner: { kind: "team", teamId: crypto.randomUUID() },
  });
  const reserveFor = (
    choice: BudgetChoice,
    costUsd: number,
    tokens = 10,
    unmetered = false,
  ) =>
    ledger().reserve({
      callId: `call-${crypto.randomUUID()}`,
      workspaceId,
      choice,
      reserve: { costUsd, tokens },
      unmetered,
    });

  async function accountOf(id: string | null) {
    if (id === null) throw new Error("no account");
    const [row] = await db
      .select()
      .from(budgetAccounts)
      .where(eq(budgetAccounts.id, id as never));
    return row;
  }

  test("two reserves of 6 against a limit of 10 at once: one gets in", async () => {
    const choice = person();
    if (choice.owner?.kind !== "user") throw new Error("person");
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "user", userId: choice.owner.userId },
      { costUsd: 10, tokens: null },
    );
    // The month's row exists already, so only its lock orders the two.
    const warm = await reserveFor(choice, 1);
    if (warm.outcome !== "reserved") throw new Error(warm.outcome);
    await db
      .update(budgetReservations)
      .set({ state: "released", endedAt: sql`now()` })
      .where(eq(budgetReservations.accountId, warm.accountId as never));
    await db
      .update(budgetAccounts)
      .set({ reservedCostUsd: 0, reservedTokens: 0 })
      .where(eq(budgetAccounts.id, warm.accountId as never));
    const results = await Promise.all([
      reserveFor(choice, 6),
      reserveFor(choice, 6),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "refused",
      "reserved",
    ]);
    const reserved = results.find((result) => result.outcome === "reserved");
    const account = await accountOf(
      reserved?.outcome === "reserved" ? reserved.accountId : null,
    );
    expect(account?.reservedCostUsd).toBe(6);
  });

  test("settling 4 of a 6 reserve: spent +4, reserved -6, once per call id", async () => {
    const callId = `call-${crypto.randomUUID()}`;
    const reserved = await ledger().reserve({
      callId,
      workspaceId,
      choice: person(),
      reserve: { costUsd: 6, tokens: 600 },
      unmetered: false,
    });
    if (reserved.outcome !== "reserved") throw new Error(reserved.outcome);
    const before = await accountOf(reserved.accountId);
    expect([before?.spentCostUsd, before?.reservedCostUsd]).toEqual([0, 6]);
    const actual = { costUsd: 4, tokens: 400 };
    expect(await ledger().settle({ callId, actual })).toBe("settled");
    expect(await ledger().settle({ callId, actual })).toBe("already_settled");
    const after = await accountOf(reserved.accountId);
    expect({
      spentCostUsd: after?.spentCostUsd,
      spentTokens: after?.spentTokens,
      reservedCostUsd: after?.reservedCostUsd,
      reservedTokens: after?.reservedTokens,
    }).toEqual({
      spentCostUsd: 4,
      spentTokens: 400,
      reservedCostUsd: 0,
      reservedTokens: 0,
    });
    // Releasing after the settlement changes nothing.
    expect(await ledger().release(callId)).toBe("settled");
    expect((await accountOf(reserved.accountId))?.spentCostUsd).toBe(4);
  });

  test("a release takes off the reserve only, once", async () => {
    const choice = person();
    const first = await reserveFor(choice, 2, 20);
    const callId = `call-${crypto.randomUUID()}`;
    const second = await ledger().reserve({
      callId,
      workspaceId,
      choice,
      reserve: { costUsd: 3, tokens: 30 },
      unmetered: false,
    });
    if (first.outcome !== "reserved" || second.outcome !== "reserved")
      throw new Error("reserve");
    expect(second.accountId).toBe(first.accountId);
    expect(await ledger().release(callId)).toBe("released");
    expect(await ledger().release(callId)).toBe("already_released");
    const account = await accountOf(first.accountId);
    expect([
      account?.spentCostUsd,
      account?.spentTokens,
      account?.reservedCostUsd,
      account?.reservedTokens,
    ]).toEqual([0, 0, 2, 20]);
  });

  test("the same reserve again is a replay; another amount under its id a conflict", async () => {
    const choice = person();
    const input = {
      callId: `call-${crypto.randomUUID()}`,
      workspaceId,
      choice,
      reserve: { costUsd: 1.5, tokens: 15 },
      unmetered: false,
    };
    const first = await ledger().reserve(input);
    expect(first.outcome).toBe("reserved");
    expect(await ledger().reserve(input)).toEqual({
      outcome: "replayed",
      state: "reserved",
    });
    expect(
      await ledger().reserve({ ...input, reserve: { costUsd: 2, tokens: 15 } }),
    ).toEqual({ outcome: "conflict" });
    if (first.outcome !== "reserved") throw new Error("reserve");
    expect((await accountOf(first.accountId))?.reservedCostUsd).toBe(1.5);
  });

  test("a new month starts its own row at zero", async () => {
    const choice = person();
    if (choice.owner?.kind !== "user") throw new Error("person");
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "user", userId: choice.owner.userId },
      { costUsd: 10, tokens: null },
    );
    // Last month's row, spent to its limit.
    await db.insert(budgetAccounts).values({
      id: crypto.randomUUID() as never,
      workspaceId,
      ownerKind: "user",
      ownerId: choice.owner.userId,
      periodStart: sql<string>`(date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') - interval '1 month')::date`,
      spentCostUsd: 10,
    });
    const reserved = await reserveFor(choice, 6);
    if (reserved.outcome !== "reserved") throw new Error(reserved.outcome);
    const account = await accountOf(reserved.accountId);
    expect(account?.spentCostUsd).toBe(0);
    const [{ thisMonth } = { thisMonth: "" }] = await db
      .select({
        thisMonth: sql<string>`date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date::text`,
      })
      .from(sql`(SELECT 1) AS one`);
    expect(account?.periodStart).toBe(thisMonth);
  });

  test("an unmetered connection's call holds and spends tokens only", async () => {
    const callId = `call-${crypto.randomUUID()}`;
    const reserved = await ledger().reserve({
      callId,
      workspaceId,
      choice: person(),
      reserve: { costUsd: 6, tokens: 600 },
      unmetered: true,
    });
    if (reserved.outcome !== "reserved") throw new Error(reserved.outcome);
    expect((await accountOf(reserved.accountId))?.reservedCostUsd).toBe(0);
    await ledger().settle({ callId, actual: { costUsd: 4, tokens: 400 } });
    const account = await accountOf(reserved.accountId);
    expect([account?.spentCostUsd, account?.spentTokens]).toEqual([0, 400]);
  });

  test("a person with no limit always reserves, and the record stays", async () => {
    const callId = `call-${crypto.randomUUID()}`;
    const reserved = await ledger().reserve({
      callId,
      workspaceId,
      choice: person(),
      reserve: { costUsd: 1_000_000, tokens: 1_000_000 },
      unmetered: false,
    });
    expect(reserved.outcome).toBe("reserved");
    await ledger().settle({ callId, actual: { costUsd: 5, tokens: 50 } });
    const [row] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.callId, callId));
    expect([row?.rootKind, row?.state, row?.settledCostUsd]).toEqual([
      "user",
      "settled",
      5,
    ]);
  });

  test("a team with no limit: a key's reserve is recorded, the agent's own is refused", async () => {
    const choice = team("key");
    expect((await reserveFor(choice, 6)).outcome).toBe("reserved");
    expect((await reserveFor({ ...choice, rootKind: "none" }, 6)).outcome).toBe(
      "refused",
    );
  });

  test("an agent with no team: a key's reserve is recorded with no account, the agent's own is refused", async () => {
    const callId = `call-${crypto.randomUUID()}`;
    const keyRoot: BudgetRoot = {
      kind: "key",
      keyKind: "agent",
      createdByUserId: null,
    };
    expect(
      await ledger().reserve({
        callId,
        workspaceId,
        choice: chooseBudgetAccount(keyRoot, null),
        reserve: { costUsd: 6, tokens: 60 },
        unmetered: false,
      }),
    ).toEqual({ outcome: "reserved", accountId: null, rootKind: "key" });
    const [row] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.callId, callId));
    expect([row?.accountId, row?.rootKind]).toEqual([null, "key"]);
    expect(
      await ledger().settle({ callId, actual: { costUsd: 1, tokens: 1 } }),
    ).toBe("settled");
    expect(
      (await reserveFor(chooseBudgetAccount({ kind: "none" }, null), 6))
        .outcome,
    ).toBe("refused");
  });

  test("a team with a limit holds a key's reserves to it too", async () => {
    const choice = team("key");
    if (choice.owner?.kind !== "team") throw new Error("team");
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "team", teamId: choice.owner.teamId },
      { costUsd: 10, tokens: null },
    );
    expect((await reserveFor(choice, 6)).outcome).toBe("reserved");
    expect((await reserveFor(choice, 6)).outcome).toBe("refused");
    expect((await reserveFor({ ...choice, rootKind: "none" }, 3)).outcome).toBe(
      "reserved",
    );
  });

  test("a person's limit: their own, else the workspace's for every person, else none", async () => {
    const own = crypto.randomUUID();
    const other = crypto.randomUUID();
    const workspace = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspace, slug: `ws-${workspace}`, name: "Limits" });
    expect(
      await budgetLimitOf(db, workspace, { kind: "user", userId: other }),
    ).toBeNull();
    await saveBudgetLimit(
      db,
      workspace,
      { kind: "person_default" },
      { costUsd: 20, tokens: 1_000 },
    );
    await saveBudgetLimit(
      db,
      workspace,
      { kind: "user", userId: own },
      { costUsd: 5, tokens: null },
    );
    expect(
      await budgetLimitOf(db, workspace, { kind: "user", userId: own }),
    ).toEqual({ costUsd: 5, tokens: null });
    expect(
      await budgetLimitOf(db, workspace, { kind: "user", userId: other }),
    ).toEqual({ costUsd: 20, tokens: 1_000 });
    // Saving again replaces the row; null removes it.
    await saveBudgetLimit(
      db,
      workspace,
      { kind: "person_default" },
      { costUsd: 30, tokens: null },
    );
    expect(
      await budgetLimitOf(db, workspace, { kind: "user", userId: other }),
    ).toEqual({ costUsd: 30, tokens: null });
    await saveBudgetLimit(db, workspace, { kind: "person_default" }, null);
    expect(
      await budgetLimitOf(db, workspace, { kind: "user", userId: other }),
    ).toBeNull();
  });

  test("the same reserve twice at once: one reserves, the other replays", async () => {
    const choice = person();
    if (choice.owner?.kind !== "user") throw new Error("person");
    await saveBudgetLimit(
      db,
      workspaceId,
      { kind: "user", userId: choice.owner.userId },
      { costUsd: 10, tokens: null },
    );
    const input = {
      callId: `call-${crypto.randomUUID()}`,
      workspaceId,
      choice,
      reserve: { costUsd: 6, tokens: 60 },
      unmetered: false,
    };
    const results = await Promise.all([
      ledger().reserve(input),
      ledger().reserve(input),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "replayed",
      "reserved",
    ]);
  });

  test("a replayed reserve and the call's settlement at once finish without a deadlock", async () => {
    for (let round = 0; round < 5; round++) {
      const input = {
        callId: `call-${crypto.randomUUID()}`,
        workspaceId,
        choice: person(),
        reserve: { costUsd: 6, tokens: 60 },
        unmetered: false,
      };
      const first = await ledger().reserve(input);
      if (first.outcome !== "reserved") throw new Error(first.outcome);
      const [replay, settled] = await Promise.all([
        ledger().reserve(input),
        ledger().settle({
          callId: input.callId,
          actual: { costUsd: 4, tokens: 40 },
        }),
      ]);
      expect(replay.outcome).toBe("replayed");
      expect(settled).toBe("settled");
      const account = await accountOf(first.accountId);
      expect([account?.spentCostUsd, account?.reservedCostUsd]).toEqual([4, 0]);
    }
  });

  test("a NaN or negative amount is refused before it reaches a row, and by the table", async () => {
    await expect(reserveFor(person(), Number.NaN)).rejects.toThrow(RangeError);
    await expect(
      ledger().settle({ callId: "none", actual: { costUsd: -1, tokens: 0 } }),
    ).rejects.toThrow(RangeError);
    await expect(
      db.execute(
        sql`INSERT INTO budget_limits (workspace_id, subject, cost_usd) VALUES (${workspaceId}, 'person_default', 'NaN')`,
      ),
    ).rejects.toThrow();
  });

  test("an installation with no team limit: an agent key's reserve always gets in", async () => {
    const choice = chooseBudgetAccount(
      { kind: "key", keyKind: "agent", createdByUserId: null },
      crypto.randomUUID(),
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveFor(choice, 1_000)),
    );
    expect(results.map((result) => result.outcome)).toEqual(
      Array(5).fill("reserved"),
    );
  });
});

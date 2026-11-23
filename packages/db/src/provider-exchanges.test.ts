import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  type BudgetChoice,
  type HeldSpend,
  type ProviderUsage,
  reservationCostUsd,
  reservationTokens,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { saveBudgetLimit } from "./budget-accounts.ts";
import {
  createProviderExchangeLedger,
  PROVIDER_EXCHANGE_KEEP_DAYS,
  reconcileProviderExchanges,
} from "./provider-exchanges.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  attempts,
  budgetAccounts,
  budgetReservations,
  providerExchanges,
  providerUsage,
  sessions,
} from "./schema.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  // The session and attempt rows are not what is under test; skip their
  // triggers and foreign keys.
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

const USED: ProviderUsage = {
  ...RESERVE,
  outputTokens: 80,
  estimated: false,
};

type Owner = { sessionId: string; attemptId: string };

async function owner(): Promise<Owner> {
  const sessionId = crypto.randomUUID();
  const attemptId = `att-${crypto.randomUUID()}`;
  await db.insert(sessions).values({
    id: sessionId,
    ownerId: "owner-ledger",
    repoUrl: "https://github.com/acme/app.git",
    branch: "main",
    repositoryId: "app",
    checkpointRevision: 1,
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
  return { sessionId, attemptId };
}

function report(who: Owner, exchangeId: string, usage = USED) {
  return createPostgresWorkerUnitOfWork(db).recordProviderUsageAtomic({
    exchangeId,
    ...who,
    usage,
    priceFor: () => ({ costUsd: 0.0084, pricedBy: "table" }),
  });
}

async function rows() {
  return db.select().from(providerExchanges);
}

function ledgerOf(admits: (held: HeldSpend) => boolean = () => true) {
  return createProviderExchangeLedger(db, { admits: async () => admits });
}

async function releasedAgo(exchangeId: string, agoMs: number) {
  await db
    .update(providerExchanges)
    .set({
      releasedAt: sql`clock_timestamp() - ${agoMs}::double precision * interval '1 millisecond'`,
    })
    .where(eq(providerExchanges.exchangeId, exchangeId));
}

async function expireLease(exchangeId: string, agoMs = 1_000) {
  await db
    .update(providerExchanges)
    .set({
      leaseExpiresAt: sql`clock_timestamp() - ${agoMs}::double precision * interval '1 millisecond'`,
    })
    .where(eq(providerExchanges.exchangeId, exchangeId));
}

describe("opening and renewing a provider exchange", () => {
  test("an open makes a row with the reserve and a lease; the same open again keeps its first time", async () => {
    const who = await owner();
    const ledger = ledgerOf();
    const exchangeId = crypto.randomUUID();
    expect(await ledger.open({ exchangeId, ...who, reserve: RESERVE })).toEqual(
      { outcome: "created" },
    );
    const [first] = await rows();
    expect(first).toMatchObject({ exchangeId, ...who, reserve: RESERVE });
    expect(first?.noticedAt).toBeNull();
    const leaseMs =
      (first?.leaseExpiresAt.getTime() ?? 0) - (first?.openedAt.getTime() ?? 0);
    expect(leaseMs).toBeGreaterThan(299_000);
    expect(leaseMs).toBeLessThan(301_000);

    expect(await ledger.open({ exchangeId, ...who, reserve: RESERVE })).toEqual(
      { outcome: "open" },
    );
    const [again] = await rows();
    expect(again?.openedAt.getTime()).toBe(first?.openedAt.getTime() ?? -1);
  });

  test("another owner or another reserve under the same id is refused and changes nothing", async () => {
    const a = await owner();
    const b = await owner();
    const ledger = ledgerOf();
    const exchangeId = crypto.randomUUID();
    await ledger.open({ exchangeId, ...a, reserve: RESERVE });
    const before = await rows();
    expect(await ledger.open({ exchangeId, ...b, reserve: RESERVE })).toEqual({
      outcome: "conflict",
    });
    expect(
      await ledger.open({
        exchangeId,
        ...a,
        reserve: { ...RESERVE, outputTokens: 1 },
      }),
    ).toEqual({ outcome: "conflict" });
    expect(await rows()).toEqual(before);
  });

  test("an open for a pair that does not exist makes no row", async () => {
    const a = await owner();
    const b = await owner();
    const ledger = ledgerOf();
    expect(
      await ledger.open({
        exchangeId: crypto.randomUUID(),
        sessionId: a.sessionId,
        attemptId: b.attemptId,
        reserve: RESERVE,
      }),
    ).toEqual({ outcome: "unknown_attempt" });
    expect(await rows()).toEqual([]);
  });

  test("a renewal extends a row that exists and clears its notice; it never makes one", async () => {
    const who = await owner();
    const ledger = ledgerOf();
    expect(await ledger.renew(crypto.randomUUID())).toBe("gone");
    expect(await rows()).toEqual([]);

    const exchangeId = crypto.randomUUID();
    await ledger.open({ exchangeId, ...who, reserve: RESERVE });
    await expireLease(exchangeId);
    await reconcileProviderExchanges(db, { limit: 10, dryRun: false });
    expect((await rows())[0]?.noticedAt).not.toBeNull();

    expect(await ledger.renew(exchangeId)).toBe("open");
    const [renewed] = await rows();
    expect(renewed?.noticedAt).toBeNull();
    expect(renewed?.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("judging a session's budget at the open", () => {
  test("the judge sees the stored spend and every unreleased reserve, the new one's included", async () => {
    const who = await owner();
    const other = await owner();
    const seen: HeldSpend[] = [];
    const ledger = ledgerOf((held) => {
      seen.push(held);
      return true;
    });
    const first = crypto.randomUUID();
    await ledger.open({ exchangeId: first, ...who, reserve: RESERVE });
    // Another session's row and a released row of this one count nothing.
    await ledger.open({
      exchangeId: crypto.randomUUID(),
      ...other,
      reserve: RESERVE,
    });
    const released = crypto.randomUUID();
    await ledger.open({ exchangeId: released, ...who, reserve: RESERVE });
    await ledger.release({ exchangeId: released, ...who, reserve: RESERVE });
    const bigger = { ...RESERVE, outputTokens: 64_000 };
    await ledger.open({
      exchangeId: crypto.randomUUID(),
      ...who,
      reserve: bigger,
    });
    expect(seen[3]).toMatchObject({
      costUsd: 0,
      providerTokens: 0,
      unmetered: false,
    });
    expect(seen[3]?.reserves).toHaveLength(2);
    expect(seen[3]?.reserves).toEqual(
      expect.arrayContaining([RESERVE, bigger]),
    );

    // Reported, the first call counts as stored spend and no longer as a
    // reserve. (Triggers are off here: the token count is the integration
    // test's.)
    await report(who, first);
    await ledger.open({
      exchangeId: crypto.randomUUID(),
      ...who,
      reserve: RESERVE,
    });
    expect(seen[4]).toMatchObject({ costUsd: 0.0084, unmetered: false });
    expect(seen[4]?.reserves).toHaveLength(2);
    expect(seen[4]?.reserves).toEqual(
      expect.arrayContaining([RESERVE, bigger]),
    );
  });

  test("a refused open makes no row; the same open again once admitted is not judged twice", async () => {
    const who = await owner();
    const exchangeId = crypto.randomUUID();
    expect(
      await ledgerOf(() => false).open({
        exchangeId,
        ...who,
        reserve: RESERVE,
      }),
    ).toEqual({ outcome: "budget_exceeded" });
    expect(await rows()).toEqual([]);

    await ledgerOf().open({ exchangeId, ...who, reserve: RESERVE });
    expect(
      await ledgerOf(() => false).open({
        exchangeId,
        ...who,
        reserve: RESERVE,
      }),
    ).toEqual({ outcome: "open" });
  });

  test("limits that cannot be read refuse a new open, not the same open again", async () => {
    const who = await owner();
    let reads = 0;
    const unreadable = createProviderExchangeLedger(db, {
      admits: async () => {
        reads += 1;
        throw new Error("the installation settings could not be read");
      },
    });
    const exchangeId = crypto.randomUUID();
    await expect(
      unreadable.open({ exchangeId, ...who, reserve: RESERVE }),
    ).rejects.toThrow("could not be read");
    expect(await rows()).toEqual([]);

    await ledgerOf().open({ exchangeId, ...who, reserve: RESERVE });
    expect(
      await unreadable.open({ exchangeId, ...who, reserve: RESERVE }),
    ).toEqual({ outcome: "open" });
    // Read before each open, so a saved limit applies to the next call.
    expect(reads).toBe(2);
  });

  test("an unmetered session's judge is told so", async () => {
    const who = await owner();
    await db
      .update(sessions)
      .set({ unmetered: true })
      .where(eq(sessions.id, who.sessionId));
    let unmetered: boolean | undefined;
    await ledgerOf((held) => {
      unmetered = held.unmetered;
      return true;
    }).open({ exchangeId: crypto.randomUUID(), ...who, reserve: RESERVE });
    expect(unmetered).toBe(true);
  });
});

describe("releasing a call the provider never billed", () => {
  test("a release marks the row; it no longer renews, and the same open finds it released", async () => {
    const who = await owner();
    const ledger = ledgerOf();
    const exchangeId = crypto.randomUUID();
    await ledger.open({ exchangeId, ...who, reserve: RESERVE });
    expect(await ledger.release({ exchangeId, ...who, reserve: RESERVE })).toBe(
      "released",
    );
    const [marked] = await rows();
    expect(marked?.releasedAt).not.toBeNull();
    expect(await ledger.renew(exchangeId)).toBe("gone");
    expect(await ledger.open({ exchangeId, ...who, reserve: RESERVE })).toEqual(
      { outcome: "released" },
    );
    // Released twice, the first time stands.
    await ledger.release({ exchangeId, ...who, reserve: RESERVE });
    expect((await rows())[0]?.releasedAt?.getTime()).toBe(
      marked?.releasedAt?.getTime() ?? -1,
    );
  });

  test("a release before its open leaves a mark, so the late open counts nothing", async () => {
    const who = await owner();
    const ledger = ledgerOf();
    const exchangeId = crypto.randomUUID();
    expect(await ledger.release({ exchangeId, ...who, reserve: RESERVE })).toBe(
      "released",
    );
    expect(await ledger.open({ exchangeId, ...who, reserve: RESERVE })).toEqual(
      { outcome: "released" },
    );
    const [mark] = await rows();
    expect(mark?.releasedAt).not.toBeNull();
  });

  test("a release after the report changes nothing; a released row a report reaches is deleted", async () => {
    const who = await owner();
    const ledger = ledgerOf();
    const reported = crypto.randomUUID();
    await report(who, reported);
    expect(
      await ledger.release({ exchangeId: reported, ...who, reserve: RESERVE }),
    ).toBe("settled");
    expect(await rows()).toEqual([]);

    const released = crypto.randomUUID();
    await ledger.open({ exchangeId: released, ...who, reserve: RESERVE });
    await ledger.release({ exchangeId: released, ...who, reserve: RESERVE });
    expect(await report(who, released)).toMatchObject({ outcome: "recorded" });
    expect(await rows()).toEqual([]);
  });

  test("another owner's release, or one for no such pair, changes nothing", async () => {
    const a = await owner();
    const b = await owner();
    const ledger = ledgerOf();
    const exchangeId = crypto.randomUUID();
    await ledger.open({ exchangeId, ...a, reserve: RESERVE });
    const before = await rows();
    expect(await ledger.release({ exchangeId, ...b, reserve: RESERVE })).toBe(
      "conflict",
    );
    expect(
      await ledger.release({
        exchangeId: crypto.randomUUID(),
        sessionId: a.sessionId,
        attemptId: b.attemptId,
        reserve: RESERVE,
      }),
    ).toBe("unknown_attempt");
    expect(await rows()).toEqual(before);
  });
});

describe("a usage report and the ledger", () => {
  test("a report deletes its own row, and a replay of it changes nothing more", async () => {
    const who = await owner();
    const ledger = ledgerOf();
    const exchangeId = crypto.randomUUID();
    await ledger.open({ exchangeId, ...who, reserve: RESERVE });
    expect(await report(who, exchangeId)).toMatchObject({
      outcome: "recorded",
    });
    expect(await rows()).toEqual([]);
    const replayed = await report(who, exchangeId);
    expect(replayed).toMatchObject({ outcome: "replayed" });
    expect("ledgerForeignRow" in replayed).toBe(false);
  });

  test("a replayed report deletes a row an open left after the first report", async () => {
    const who = await owner();
    const exchangeId = crypto.randomUUID();
    await report(who, exchangeId);
    // A row the first report could not see: as an older API replica would
    // leave, written here straight in.
    await db.insert(providerExchanges).values({
      exchangeId,
      ...who,
      reserve: RESERVE,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(await report(who, exchangeId)).toMatchObject({
      outcome: "replayed",
    });
    expect(await rows()).toEqual([]);
  });

  test("once reported, a late open makes no row and a late renewal finds none", async () => {
    const who = await owner();
    const ledger = ledgerOf();
    const exchangeId = crypto.randomUUID();
    await report(who, exchangeId);
    expect(await ledger.open({ exchangeId, ...who, reserve: RESERVE })).toEqual(
      { outcome: "settled" },
    );
    expect(await ledger.renew(exchangeId)).toBe("gone");
    expect(await rows()).toEqual([]);
  });

  test("a late open naming the report's session in upper case is the same owner", async () => {
    const who = await owner();
    expect(who.sessionId.toUpperCase()).not.toBe(who.sessionId);
    const exchangeId = crypto.randomUUID();
    await report(who, exchangeId);
    expect(
      await ledgerOf().open({
        exchangeId,
        sessionId: who.sessionId.toUpperCase(),
        attemptId: who.attemptId,
        reserve: RESERVE,
      }),
    ).toEqual({ outcome: "settled" });
    expect(await rows()).toEqual([]);
  });

  test("a late open naming another owner than the report is refused", async () => {
    const a = await owner();
    const b = await owner();
    const ledger = ledgerOf();
    const exchangeId = crypto.randomUUID();
    await report(a, exchangeId);
    expect(await ledger.open({ exchangeId, ...b, reserve: RESERVE })).toEqual({
      outcome: "conflict",
    });
    expect(await rows()).toEqual([]);
  });

  test("a report from another owner leaves the row and says so; a conflicting report leaves it too", async () => {
    const a = await owner();
    const b = await owner();
    const ledger = ledgerOf();
    const exchangeId = crypto.randomUUID();
    await ledger.open({ exchangeId, ...a, reserve: RESERVE });
    expect(await report(b, exchangeId)).toMatchObject({
      outcome: "recorded",
      ledgerForeignRow: true,
    });
    expect(await rows()).toHaveLength(1);

    const second = crypto.randomUUID();
    await report(a, second);
    await db.insert(providerExchanges).values({
      exchangeId: second,
      ...a,
      reserve: RESERVE,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(await report(a, second, { ...USED, outputTokens: 81 })).toEqual({
      outcome: "conflict",
    });
    expect(await rows()).toHaveLength(2);
  });

  test("a report for no such attempt leaves the row", async () => {
    const who = await owner();
    const ledger = ledgerOf();
    const exchangeId = crypto.randomUUID();
    await ledger.open({ exchangeId, ...who, reserve: RESERVE });
    expect(
      await report(
        { sessionId: who.sessionId, attemptId: "att-missing" },
        exchangeId,
      ),
    ).toEqual({ outcome: "unknown_attempt" });
    expect(await rows()).toHaveLength(1);
  });
});

describe("the reconciler's pass over the ledger", () => {
  async function expiredRow(who: Owner, agoMs = 1_000): Promise<string> {
    const exchangeId = crypto.randomUUID();
    await ledgerOf().open({
      exchangeId,
      ...who,
      reserve: RESERVE,
    });
    await expireLease(exchangeId, agoMs);
    return exchangeId;
  }

  test("an expired row a report of the same owner settled is deleted without a notice", async () => {
    const who = await owner();
    const exchangeId = await expiredRow(who);
    // As an older API replica records it: the usage row, the ledger untouched.
    await db.insert(providerUsage).values({
      exchangeId,
      ...who,
      model: USED.model,
      inputTokens: USED.inputTokens,
      outputTokens: USED.outputTokens,
      cacheCreationInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      cacheReadInputTokens: 0,
      estimated: false,
      costUsd: 0.0084,
      pricedBy: "table",
    });
    expect(
      await reconcileProviderExchanges(db, { limit: 10, dryRun: false }),
    ).toEqual({ settled: 1, noticed: [], deleted: 0 });
    expect(await rows()).toEqual([]);
  });

  test("an expired unsettled row is noticed once; a renewal and a second expiry notice it again", async () => {
    const who = await owner();
    const exchangeId = await expiredRow(who);
    const first = await reconcileProviderExchanges(db, {
      limit: 10,
      dryRun: false,
    });
    expect(first.noticed).toEqual([
      expect.objectContaining({ exchangeId, ...who }),
    ]);
    expect(
      (await reconcileProviderExchanges(db, { limit: 10, dryRun: false }))
        .noticed,
    ).toEqual([]);

    await ledgerOf().renew(exchangeId);
    expect(
      (await reconcileProviderExchanges(db, { limit: 10, dryRun: false }))
        .noticed,
    ).toEqual([]);
    await expireLease(exchangeId);
    expect(
      (await reconcileProviderExchanges(db, { limit: 10, dryRun: false }))
        .noticed,
    ).toEqual([expect.objectContaining({ exchangeId })]);
  });

  test("a row whose lease is still running is left alone", async () => {
    const who = await owner();
    await ledgerOf().open({
      exchangeId: crypto.randomUUID(),
      ...who,
      reserve: RESERVE,
    });
    expect(
      await reconcileProviderExchanges(db, { limit: 10, dryRun: false }),
    ).toEqual({ settled: 0, noticed: [], deleted: 0 });
    expect(await rows()).toHaveLength(1);
  });

  test("a row released past the keep period is deleted; an unreleased row is kept whatever its age", async () => {
    const who = await owner();
    const day = 24 * 60 * 60 * 1_000;
    const gone = await expiredRow(who, day);
    await releasedAgo(gone, (PROVIDER_EXCHANGE_KEEP_DAYS + 1) * day);
    const recent = await expiredRow(who, day);
    await releasedAgo(recent, (PROVIDER_EXCHANGE_KEEP_DAYS - 1) * day);
    const unreleased = await expiredRow(
      who,
      (PROVIDER_EXCHANGE_KEEP_DAYS + 30) * day,
    );
    const result = await reconcileProviderExchanges(db, {
      limit: 10,
      dryRun: false,
    });
    expect(result.deleted).toBe(1);
    expect((await rows()).map((row) => row.exchangeId).sort()).toEqual(
      [recent, unreleased].sort(),
    );
  });

  test("a released row is never noticed, expired or not", async () => {
    const who = await owner();
    const exchangeId = await expiredRow(who);
    await ledgerOf().release({ exchangeId, ...who, reserve: RESERVE });
    expect(
      (await reconcileProviderExchanges(db, { limit: 10, dryRun: false }))
        .noticed,
    ).toEqual([]);
  });

  test("each step takes at most the batch limit", async () => {
    const who = await owner();
    for (let n = 0; n < 3; n += 1) await expiredRow(who);
    const result = await reconcileProviderExchanges(db, {
      limit: 2,
      dryRun: false,
    });
    expect(result.noticed).toHaveLength(2);
  });

  test("a dry run counts a settled row past the keep period once, as the writes do", async () => {
    const who = await owner();
    const day = 24 * 60 * 60 * 1_000;
    const exchangeId = await expiredRow(
      who,
      (PROVIDER_EXCHANGE_KEEP_DAYS + 1) * day,
    );
    await db.insert(providerUsage).values({
      exchangeId,
      ...who,
      model: USED.model,
      inputTokens: USED.inputTokens,
      outputTokens: USED.outputTokens,
      cacheCreationInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      cacheReadInputTokens: 0,
      estimated: false,
      costUsd: 0.0084,
      pricedBy: "table",
    });
    expect(
      await reconcileProviderExchanges(db, { limit: 10, dryRun: true }),
    ).toEqual({ settled: 1, noticed: [], deleted: 0 });
    expect(
      await reconcileProviderExchanges(db, { limit: 10, dryRun: false }),
    ).toEqual({ settled: 1, noticed: [], deleted: 0 });
  });

  test("a dry run counts a settled row beyond the batch limit as the cleanup step does", async () => {
    const who = await owner();
    const day = 24 * 60 * 60 * 1_000;
    for (let n = 0; n < 2; n += 1) {
      const exchangeId = await expiredRow(
        who,
        (PROVIDER_EXCHANGE_KEEP_DAYS + 1 + n) * day,
      );
      await releasedAgo(exchangeId, (PROVIDER_EXCHANGE_KEEP_DAYS + 1) * day);
      await db.insert(providerUsage).values({
        exchangeId,
        ...who,
        model: USED.model,
        inputTokens: USED.inputTokens,
        outputTokens: USED.outputTokens,
        cacheCreationInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        cacheReadInputTokens: 0,
        estimated: false,
        costUsd: 0.0084,
        pricedBy: "table",
      });
    }
    expect(
      await reconcileProviderExchanges(db, { limit: 1, dryRun: true }),
    ).toEqual({ settled: 1, noticed: [], deleted: 1 });
    expect(
      await reconcileProviderExchanges(db, { limit: 1, dryRun: false }),
    ).toEqual({ settled: 1, noticed: [], deleted: 1 });
    expect(await rows()).toEqual([]);
  });

  test("a dry run reports what it would do and writes nothing", async () => {
    const who = await owner();
    const exchangeId = await expiredRow(who);
    const before = await rows();
    const result = await reconcileProviderExchanges(db, {
      limit: 10,
      dryRun: true,
    });
    expect(result.noticed).toEqual([expect.objectContaining({ exchangeId })]);
    expect(await rows()).toEqual(before);
  });
});

describe("holding a call on a budget account beside its session", () => {
  const WORKSPACE = "00000000-0000-4000-8000-0000000000b1";
  const COST = reservationCostUsd(RESERVE);
  const TOKENS = reservationTokens(RESERVE);

  async function budgeted() {
    const who = await owner();
    await db
      .update(sessions)
      .set({ workspaceId: WORKSPACE })
      .where(eq(sessions.id, who.sessionId));
    const userId = crypto.randomUUID();
    const budget: BudgetChoice = {
      rootKind: "user",
      owner: { kind: "user", userId },
    };
    return { who, userId, budget };
  }

  async function accountOf(userId: string) {
    const [account] = await db
      .select()
      .from(budgetAccounts)
      .where(eq(budgetAccounts.ownerId, userId));
    return account;
  }

  async function reservationOf(exchangeId: string) {
    const [row] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.callId, exchangeId));
    return row;
  }

  test("an open both admit holds the reserve on the session and on the account", async () => {
    const { who, userId, budget } = await budgeted();
    const exchangeId = crypto.randomUUID();
    expect(
      await ledgerOf().open({ exchangeId, ...who, reserve: RESERVE, budget }),
    ).toEqual({ outcome: "created" });
    const account = await accountOf(userId);
    expect(account).toMatchObject({
      reservedCostUsd: Math.round(COST * 1e6) / 1e6,
      reservedTokens: TOKENS,
      spentCostUsd: 0,
      spentTokens: 0,
    });
    const [row] = await rows();
    expect(row).toMatchObject({
      budgetRootKind: "user",
      budgetAccountId: account?.id,
    });
    expect(await reservationOf(exchangeId)).toMatchObject({
      state: "reserved",
      rootKind: "user",
      accountId: account?.id,
    });
  });

  test("the session's limit refuses though the account has room: nothing held on either", async () => {
    const { who, userId, budget } = await budgeted();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "user", userId },
      {
        costUsd: 1_000,
        tokens: null,
      },
    );
    const exchangeId = crypto.randomUUID();
    expect(
      await ledgerOf(() => false).open({
        exchangeId,
        ...who,
        reserve: RESERVE,
        budget,
      }),
    ).toEqual({ outcome: "budget_exceeded" });
    expect(await rows()).toEqual([]);
    expect(await reservationOf(exchangeId)).toBeUndefined();
    expect(await accountOf(userId)).toBeUndefined();
  });

  test("the account's limit refuses though the session admits: nothing held on either", async () => {
    const { who, userId, budget } = await budgeted();
    await saveBudgetLimit(
      db,
      WORKSPACE,
      { kind: "user", userId },
      {
        costUsd: COST / 2,
        tokens: null,
      },
    );
    const exchangeId = crypto.randomUUID();
    expect(
      await ledgerOf().open({ exchangeId, ...who, reserve: RESERVE, budget }),
    ).toEqual({ outcome: "budget_exceeded" });
    expect(await rows()).toEqual([]);
    expect(await reservationOf(exchangeId)).toBeUndefined();
    expect(await accountOf(userId)).toMatchObject({
      reservedCostUsd: 0,
      reservedTokens: 0,
    });
  });

  test("a report settles the account at what it charged, once however often it comes", async () => {
    const { who, userId, budget } = await budgeted();
    const exchangeId = crypto.randomUUID();
    await ledgerOf().open({ exchangeId, ...who, reserve: RESERVE, budget });
    expect((await report(who, exchangeId)).outcome).toBe("recorded");
    const settled = {
      spentCostUsd: 0.0084,
      spentTokens: reservationTokens(USED),
      reservedCostUsd: 0,
      reservedTokens: 0,
    };
    expect(await accountOf(userId)).toMatchObject(settled);
    expect(await reservationOf(exchangeId)).toMatchObject({
      state: "settled",
      settledCostUsd: 0.0084,
      settledTokens: reservationTokens(USED),
    });
    expect((await report(who, exchangeId)).outcome).toBe("replayed");
    expect(await accountOf(userId)).toMatchObject(settled);
  });

  test("a release frees the account's reserve; a second release and a late report count once", async () => {
    const { who, userId, budget } = await budgeted();
    const exchangeId = crypto.randomUUID();
    const ledger = ledgerOf();
    await ledger.open({ exchangeId, ...who, reserve: RESERVE, budget });
    expect(await ledger.release({ exchangeId, ...who, reserve: RESERVE })).toBe(
      "released",
    );
    expect(await accountOf(userId)).toMatchObject({
      reservedCostUsd: 0,
      reservedTokens: 0,
      spentCostUsd: 0,
    });
    expect(await reservationOf(exchangeId)).toMatchObject({
      state: "released",
    });
    expect(await ledger.release({ exchangeId, ...who, reserve: RESERVE })).toBe(
      "released",
    );
    expect(await accountOf(userId)).toMatchObject({ reservedCostUsd: 0 });
    // Billed after all: the spend counts, the reserve is not taken off again.
    expect((await report(who, exchangeId)).outcome).toBe("recorded");
    expect(await accountOf(userId)).toMatchObject({
      reservedCostUsd: 0,
      reservedTokens: 0,
      spentCostUsd: 0.0084,
    });
  });

  test("an account with no limit never refuses, and still records the reserve and the settlement", async () => {
    const { who, userId, budget } = await budgeted();
    const exchangeId = crypto.randomUUID();
    expect(
      await ledgerOf().open({ exchangeId, ...who, reserve: RESERVE, budget }),
    ).toEqual({ outcome: "created" });
    expect(await reservationOf(exchangeId)).toMatchObject({
      state: "reserved",
    });
    await report(who, exchangeId);
    expect(await reservationOf(exchangeId)).toMatchObject({ state: "settled" });
    expect(await accountOf(userId)).toMatchObject({ spentCostUsd: 0.0084 });
  });

  test("an open with no account holds nothing on any account, as before accounts", async () => {
    const { who } = await budgeted();
    const exchangeId = crypto.randomUUID();
    expect(
      await ledgerOf().open({ exchangeId, ...who, reserve: RESERVE }),
    ).toEqual({ outcome: "created" });
    const [row] = await rows();
    expect(row?.budgetRootKind).toBeNull();
    expect(row?.budgetAccountId).toBeNull();
    await report(who, exchangeId);
    expect(await db.select().from(budgetReservations)).toEqual([]);
    expect(await db.select().from(budgetAccounts)).toEqual([]);
  });

  test("the same open again keeps its account; another account, or none, is a conflict", async () => {
    const { who, userId, budget } = await budgeted();
    const exchangeId = crypto.randomUUID();
    const ledger = ledgerOf();
    await ledger.open({ exchangeId, ...who, reserve: RESERVE, budget });
    expect(
      await ledger.open({ exchangeId, ...who, reserve: RESERVE, budget }),
    ).toEqual({ outcome: "open" });
    expect(
      await ledger.open({
        exchangeId,
        ...who,
        reserve: RESERVE,
        budget: {
          rootKind: "user",
          owner: { kind: "user", userId: crypto.randomUUID() },
        },
      }),
    ).toEqual({ outcome: "conflict" });
    expect(await ledger.open({ exchangeId, ...who, reserve: RESERVE })).toEqual(
      { outcome: "conflict" },
    );
    expect(await accountOf(userId)).toMatchObject({ reservedTokens: TOKENS });
  });

  test("the agent's own work with no team to charge is refused and holds nothing", async () => {
    const { who } = await budgeted();
    const exchangeId = crypto.randomUUID();
    expect(
      await ledgerOf().open({
        exchangeId,
        ...who,
        reserve: RESERVE,
        budget: { rootKind: "none", owner: null },
      }),
    ).toEqual({ outcome: "budget_exceeded" });
    expect(await rows()).toEqual([]);
    expect(await reservationOf(exchangeId)).toBeUndefined();
  });
});

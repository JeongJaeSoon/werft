import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  admitsReservations,
  type BudgetChoice,
  type HeldSpend,
  PRICE_VERSION,
  type ProviderUsage,
  priceSettledUsage,
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
    ).toEqual({
      outcome: "budget_exceeded",
      by: "session",
      accountId: null,
      owner: null,
    });
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
    ).toEqual({ settled: 1, noticed: [], deleted: 0, unknown: 0 });
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
    ).toEqual({ settled: 0, noticed: [], deleted: 0, unknown: 0 });
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
    ).toEqual({ settled: 1, noticed: [], deleted: 0, unknown: 0 });
    expect(
      await reconcileProviderExchanges(db, { limit: 10, dryRun: false }),
    ).toEqual({ settled: 1, noticed: [], deleted: 0, unknown: 0 });
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
    ).toEqual({ settled: 1, noticed: [], deleted: 1, unknown: 0 });
    expect(
      await reconcileProviderExchanges(db, { limit: 1, dryRun: false }),
    ).toEqual({ settled: 1, noticed: [], deleted: 1, unknown: 0 });
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
    ).toEqual({
      outcome: "budget_exceeded",
      by: "session",
      accountId: null,
      owner: null,
    });
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
    ).toMatchObject({ outcome: "budget_exceeded", by: "account" });
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

  describe("a call with no report within the lease", () => {
    async function unknownCall() {
      const { who, userId, budget } = await budgeted();
      // Room for one reserve and a half.
      await saveBudgetLimit(
        db,
        WORKSPACE,
        { kind: "user", userId },
        { costUsd: COST * 1.5, tokens: null },
      );
      const exchangeId = crypto.randomUUID();
      const ledger = ledgerOf();
      await ledger.open({ exchangeId, ...who, reserve: RESERVE, budget });
      await expireLease(exchangeId);
      expect(
        await reconcileProviderExchanges(db, { limit: 10, dryRun: false }),
      ).toMatchObject({ noticed: [{ exchangeId }], unknown: 1 });
      return { who, userId, budget, exchangeId, ledger };
    }

    test("is unknown and still held; a reserve past the rest is refused", async () => {
      const { who, userId, budget, exchangeId, ledger } = await unknownCall();
      // Before, nothing marked it past its lease. Still reserved, so an
      // older image settles or releases it as before.
      expect(await reservationOf(exchangeId)).toMatchObject({
        state: "reserved",
        unknownAt: expect.any(Date),
        endedAt: null,
      });
      expect(await accountOf(userId)).toMatchObject({
        reservedCostUsd: Math.round(COST * 1e6) / 1e6,
        reservedTokens: TOKENS,
        spentCostUsd: 0,
      });
      expect(
        await ledger.open({
          exchangeId: crypto.randomUUID(),
          ...who,
          reserve: RESERVE,
          budget,
        }),
      ).toMatchObject({ outcome: "budget_exceeded", by: "account" });
      // Marked once: a second pass finds nothing more to mark.
      expect(
        await reconcileProviderExchanges(db, { limit: 10, dryRun: false }),
      ).toMatchObject({ noticed: [], unknown: 0 });
    });

    test("a late report settles it at what it charged and frees the reserve", async () => {
      const { who, userId, exchangeId } = await unknownCall();
      expect((await report(who, exchangeId)).outcome).toBe("recorded");
      expect(await reservationOf(exchangeId)).toMatchObject({
        state: "settled",
        settledCostUsd: 0.0084,
        settledTokens: reservationTokens(USED),
        unknownAt: null,
      });
      expect(await accountOf(userId)).toMatchObject({
        reservedCostUsd: 0,
        reservedTokens: 0,
        spentCostUsd: 0.0084,
        spentTokens: reservationTokens(USED),
      });
    });

    test("a renewal, or the same open again, clears the mark", async () => {
      const { who, budget, exchangeId, ledger } = await unknownCall();
      expect(await ledger.renew(exchangeId)).toBe("open");
      expect(await reservationOf(exchangeId)).toMatchObject({
        state: "reserved",
        unknownAt: null,
      });
      await expireLease(exchangeId);
      expect(
        await reconcileProviderExchanges(db, { limit: 10, dryRun: false }),
      ).toMatchObject({ unknown: 1 });
      expect(
        await ledger.open({ exchangeId, ...who, reserve: RESERVE, budget }),
      ).toEqual({ outcome: "open" });
      expect(await reservationOf(exchangeId)).toMatchObject({
        state: "reserved",
        unknownAt: null,
      });
    });

    test("a release frees it", async () => {
      const { who, userId, exchangeId, ledger } = await unknownCall();
      expect(
        await ledger.release({ exchangeId, ...who, reserve: RESERVE }),
      ).toBe("released");
      expect(await reservationOf(exchangeId)).toMatchObject({
        state: "released",
        unknownAt: null,
      });
      expect(await accountOf(userId)).toMatchObject({
        reservedCostUsd: 0,
        reservedTokens: 0,
      });
    });

    test("a row noticed by an earlier build is marked on the next pass; a dry run only counts", async () => {
      const { who, budget } = await budgeted();
      const exchangeId = crypto.randomUUID();
      await ledgerOf().open({ exchangeId, ...who, reserve: RESERVE, budget });
      await expireLease(exchangeId);
      await db
        .update(providerExchanges)
        .set({ noticedAt: sql`clock_timestamp()` })
        .where(eq(providerExchanges.exchangeId, exchangeId));
      expect(
        await reconcileProviderExchanges(db, { limit: 10, dryRun: true }),
      ).toMatchObject({ noticed: [], unknown: 1 });
      expect(await reservationOf(exchangeId)).toMatchObject({
        unknownAt: null,
      });
      expect(
        await reconcileProviderExchanges(db, { limit: 10, dryRun: false }),
      ).toMatchObject({ noticed: [], unknown: 1 });
      expect(await reservationOf(exchangeId)).toMatchObject({
        state: "reserved",
        unknownAt: expect.any(Date),
      });
    });

    test("a dry run counts a call expiring in this pass as the writes mark it", async () => {
      const { who, budget } = await budgeted();
      const exchangeId = crypto.randomUUID();
      await ledgerOf().open({ exchangeId, ...who, reserve: RESERVE, budget });
      await expireLease(exchangeId);
      expect(
        await reconcileProviderExchanges(db, { limit: 10, dryRun: true }),
      ).toMatchObject({ noticed: [{ exchangeId }], unknown: 1 });
      expect(
        await reconcileProviderExchanges(db, { limit: 10, dryRun: false }),
      ).toMatchObject({ noticed: [{ exchangeId }], unknown: 1 });
    });

    test("a call held on no account is noticed and has nothing to mark", async () => {
      const { who } = await budgeted();
      const exchangeId = crypto.randomUUID();
      await ledgerOf().open({ exchangeId, ...who, reserve: RESERVE });
      await expireLease(exchangeId);
      expect(
        await reconcileProviderExchanges(db, { limit: 10, dryRun: false }),
      ).toMatchObject({ noticed: [{ exchangeId }], unknown: 0 });
      expect(await ledgerOf().renew(exchangeId)).toBe("open");
    });
  });

  describe("a team account between 80% and 100% of its limit", () => {
    // The team's account at 90%: spent directly, as an earlier month's
    // calls would leave it.
    async function teamAt90(rootKind: "none" | "key") {
      const { who } = await budgeted();
      const teamId = crypto.randomUUID();
      await saveBudgetLimit(
        db,
        WORKSPACE,
        { kind: "team", teamId },
        { costUsd: COST * 100, tokens: null },
      );
      const budget: BudgetChoice = {
        rootKind,
        owner: { kind: "team", teamId },
      };
      const warm = crypto.randomUUID();
      await ledgerOf().open({
        exchangeId: warm,
        ...who,
        reserve: RESERVE,
        budget: { rootKind: "key", owner: budget.owner },
      });
      await db
        .update(budgetAccounts)
        .set({ spentCostUsd: Math.round(COST * 89 * 1e6) / 1e6 })
        .where(eq(budgetAccounts.ownerId, teamId));
      return { who, budget };
    }

    test("an open of root kind none is refused; a key's gets in", async () => {
      const none = await teamAt90("none");
      expect(
        await ledgerOf().open({
          exchangeId: crypto.randomUUID(),
          ...none.who,
          reserve: RESERVE,
          budget: none.budget,
        }),
      ).toMatchObject({ outcome: "budget_exceeded", by: "account" });
      const key = await teamAt90("key");
      expect(
        await ledgerOf().open({
          exchangeId: crypto.randomUUID(),
          ...key.who,
          reserve: RESERVE,
          budget: key.budget,
        }),
      ).toEqual({ outcome: "created" });
    });
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
    ).toEqual({
      outcome: "budget_exceeded",
      by: "account",
      accountId: null,
      owner: null,
    });
    expect(await rows()).toEqual([]);
    expect(await reservationOf(exchangeId)).toBeUndefined();
  });

  test("a bill after the release mark was cleaned away still settles the account, once", async () => {
    const { who, userId, budget } = await budgeted();
    const exchangeId = crypto.randomUUID();
    const ledger = ledgerOf();
    await ledger.open({ exchangeId, ...who, reserve: RESERVE, budget });
    await ledger.release({ exchangeId, ...who, reserve: RESERVE });
    await releasedAgo(
      exchangeId,
      (PROVIDER_EXCHANGE_KEEP_DAYS + 1) * 86_400_000,
    );
    expect(
      (await reconcileProviderExchanges(db, { limit: 10, dryRun: false }))
        .deleted,
    ).toBe(1);
    expect(await rows()).toEqual([]);
    // The proxy's release again leaves a fresh mark that names no account.
    expect(await ledger.release({ exchangeId, ...who, reserve: RESERVE })).toBe(
      "released",
    );
    expect((await report(who, exchangeId)).outcome).toBe("recorded");
    const billed = {
      spentCostUsd: 0.0084,
      spentTokens: reservationTokens(USED),
      reservedCostUsd: 0,
      reservedTokens: 0,
    };
    expect(await accountOf(userId)).toMatchObject(billed);
    expect((await report(who, exchangeId)).outcome).toBe("replayed");
    expect(await accountOf(userId)).toMatchObject(billed);
  });

  test("a team account with no limit lets a key's call through and refuses the agent's own", async () => {
    const { who } = await budgeted();
    const teamId = crypto.randomUUID();
    const key = crypto.randomUUID();
    expect(
      await ledgerOf().open({
        exchangeId: key,
        ...who,
        reserve: RESERVE,
        budget: { rootKind: "key", owner: { kind: "team", teamId } },
      }),
    ).toEqual({ outcome: "created" });
    expect(await reservationOf(key)).toMatchObject({
      state: "reserved",
      rootKind: "key",
    });
    // Sayings 10 and 5th round: the agent's own work runs only on a set limit.
    const own = crypto.randomUUID();
    expect(
      await ledgerOf().open({
        exchangeId: own,
        ...who,
        reserve: RESERVE,
        budget: { rootKind: "none", owner: { kind: "team", teamId } },
      }),
    ).toMatchObject({ outcome: "budget_exceeded", by: "account" });
    expect(await reservationOf(own)).toBeUndefined();
    expect((await rows()).map((row) => row.exchangeId)).toEqual([key]);
  });
});

describe("a model nothing prices", () => {
  // No table and no snapshot entry names it: 1,000 tokens a call.
  const UNPRICED: ProviderUsage = {
    ...RESERVE,
    model: "no-table-and-no-snapshot-names-this",
    inputTokens: 600,
    outputTokens: 400,
  };
  const TOKENS = reservationTokens(UNPRICED);
  const used = (model = UNPRICED.model): ProviderUsage => ({
    ...UNPRICED,
    model,
    estimated: false,
  });

  // The session's own limit on tokens of unknown price, and no other limit.
  const limited = (unknownPriceTokens: number) =>
    createProviderExchangeLedger(db, {
      admits: async () =>
        admitsReservations({
          costUsd: 1_000_000,
          tokens: null,
          unknownPriceTokens,
        }),
    });

  // A report priced as the gateway prices it, with what it was asked for.
  function settle(who: Owner, exchangeId: string, usage: ProviderUsage) {
    const asked: { unmetered: boolean; requestModel: string | null }[] = [];
    return createPostgresWorkerUnitOfWork(db)
      .recordProviderUsageAtomic({
        exchangeId,
        ...who,
        usage,
        priceFor: (call) => {
          asked.push(call);
          return priceSettledUsage(usage, call.requestModel);
        },
        priceVersion: PRICE_VERSION,
      })
      .then((result) => ({ result, asked }));
  }

  const settled = (exchangeId: string) =>
    db
      .select({
        model: providerUsage.model,
        requestModel: providerUsage.requestModel,
        pricedBy: providerUsage.pricedBy,
        priceVersion: providerUsage.priceVersion,
        priceUnknown: providerUsage.priceUnknown,
      })
      .from(providerUsage)
      .where(eq(providerUsage.exchangeId, exchangeId));

  test("an open records what priced its reserve and with which price data", async () => {
    const who = await owner();
    const free = await owner();
    await db
      .update(sessions)
      .set({ unmetered: true })
      .where(eq(sessions.id, free.sessionId));
    const ledger = ledgerOf();
    const opens = [
      [who, RESERVE, "table"],
      [who, UNPRICED, "unknown"],
      // Its connection declared the calls free: not of unknown price.
      [free, UNPRICED, "unmetered"],
    ] as const;
    for (const [session, reserve, pricedBy] of opens) {
      const exchangeId = crypto.randomUUID();
      await ledger.open({ exchangeId, ...session, reserve });
      const [row] = await db
        .select({
          pricedBy: providerExchanges.pricedBy,
          priceVersion: providerExchanges.priceVersion,
        })
        .from(providerExchanges)
        .where(eq(providerExchanges.exchangeId, exchangeId));
      expect(row).toEqual({ pricedBy, priceVersion: PRICE_VERSION });
    }
  });

  test("its call opens while the reserve stays under the session's limit on such tokens", async () => {
    const who = await owner();
    expect(
      await limited(TOKENS + 1).open({
        exchangeId: crypto.randomUUID(),
        ...who,
        reserve: UNPRICED,
      }),
    ).toEqual({ outcome: "created" });
  });

  test("the first call is refused when its reserve alone reaches the limit, and nothing is held", async () => {
    const who = await owner();
    expect(
      await limited(TOKENS).open({
        exchangeId: crypto.randomUUID(),
        ...who,
        reserve: UNPRICED,
      }),
    ).toEqual({
      outcome: "budget_exceeded",
      by: "session",
      accountId: null,
      owner: null,
    });
    expect(await rows()).toEqual([]);
  });

  test("the limit counts the session's settled calls marked unknown with its held reserves, and a release gives room back", async () => {
    const who = await owner();
    const ledger = limited(3 * TOKENS);
    const first = crypto.randomUUID();
    await ledger.open({ exchangeId: first, ...who, reserve: UNPRICED });
    await settle(who, first, used());
    // 1,000 settled and this reserve: under 3,000.
    const second = crypto.randomUUID();
    expect(
      await ledger.open({ exchangeId: second, ...who, reserve: UNPRICED }),
    ).toEqual({ outcome: "created" });
    // 1,000 settled, 1,000 held and this reserve reach it.
    const third = {
      exchangeId: crypto.randomUUID(),
      ...who,
      reserve: UNPRICED,
    };
    expect((await ledger.open(third)).outcome).toBe("budget_exceeded");
    // A priced model's call is refused no sooner: it adds none.
    expect(
      await ledger.open({
        exchangeId: crypto.randomUUID(),
        ...who,
        reserve: RESERVE,
      }),
    ).toEqual({ outcome: "created" });
    await ledger.release({ exchangeId: second, ...who, reserve: UNPRICED });
    expect(await ledger.open(third)).toEqual({ outcome: "created" });
    // Another session is judged on its own.
    expect(
      await ledger.open({
        exchangeId: crypto.randomUUID(),
        ...(await owner()),
        reserve: UNPRICED,
      }),
    ).toEqual({ outcome: "created" });
  });

  test("a session with no tokens of unknown price is never refused by it, however low it is set", async () => {
    const who = await owner();
    const ledger = limited(1);
    for (const exchangeId of [crypto.randomUUID(), crypto.randomUUID()]) {
      expect(
        await ledger.open({ exchangeId, ...who, reserve: RESERVE }),
      ).toEqual({ outcome: "created" });
    }
  });

  test("once its settled tokens reach the limit the session opens no call, priced or not", async () => {
    const who = await owner();
    const first = crypto.randomUUID();
    await limited(TOKENS + 1).open({
      exchangeId: first,
      ...who,
      reserve: UNPRICED,
    });
    await settle(who, first, used());
    expect(
      (
        await limited(TOKENS).open({
          exchangeId: crypto.randomUUID(),
          ...who,
          reserve: RESERVE,
        })
      ).outcome,
    ).toBe("budget_exceeded");
  });

  test("calls opened for a priced model whose answers name an unpriced one are marked, and the open after them is refused", async () => {
    const who = await owner();
    const ledger = limited(TOKENS);
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    // Both open: a priced model's reserve adds nothing to the sum, so calls
    // already open can carry the session past the limit by their own tokens.
    for (const exchangeId of [first, second]) {
      expect(
        await ledger.open({ exchangeId, ...who, reserve: RESERVE }),
      ).toEqual({ outcome: "created" });
    }
    await settle(who, first, used());
    await settle(who, second, used());
    expect(await settled(second)).toEqual([
      {
        model: UNPRICED.model,
        requestModel: RESERVE.model,
        pricedBy: "unknown",
        priceVersion: PRICE_VERSION,
        priceUnknown: true,
      },
    ]);
    expect(
      (
        await ledger.open({
          exchangeId: crypto.randomUUID(),
          ...who,
          reserve: RESERVE,
        })
      ).outcome,
    ).toBe("budget_exceeded");
  });

  test("a reserve an older API opened, with no price source on its row, is judged from the reserve itself", async () => {
    const who = await owner();
    const ledger = limited(2 * TOKENS);
    const first = crypto.randomUUID();
    await ledger.open({ exchangeId: first, ...who, reserve: UNPRICED });
    await db
      .update(providerExchanges)
      .set({ pricedBy: null, priceVersion: null })
      .where(eq(providerExchanges.exchangeId, first));
    expect(
      (
        await ledger.open({
          exchangeId: crypto.randomUUID(),
          ...who,
          reserve: UNPRICED,
        })
      ).outcome,
    ).toBe("budget_exceeded");
  });

  test("a report is priced with the model its open reserved for, and the call is marked when either model is unpriced", async () => {
    const who = await owner();
    const ledger = ledgerOf();
    // Asked for an unpriced model; the answer names a priced one.
    const spoofed = crypto.randomUUID();
    await ledger.open({ exchangeId: spoofed, ...who, reserve: UNPRICED });
    const { result, asked } = await settle(who, spoofed, used("gpt-5.5"));
    expect(asked).toEqual([{ unmetered: false, requestModel: UNPRICED.model }]);
    expect(result).toMatchObject({ outcome: "recorded", pricedBy: "unknown" });
    expect(await settled(spoofed)).toEqual([
      {
        model: "gpt-5.5",
        requestModel: UNPRICED.model,
        pricedBy: "unknown",
        priceVersion: PRICE_VERSION,
        priceUnknown: true,
      },
    ]);
    // Asked for and answered by a priced model: not marked.
    const plain = crypto.randomUUID();
    await ledger.open({ exchangeId: plain, ...who, reserve: RESERVE });
    await settle(who, plain, USED);
    expect(await settled(plain)).toEqual([
      {
        model: "gpt-5.5",
        requestModel: "gpt-5.5",
        pricedBy: "table",
        priceVersion: PRICE_VERSION,
        priceUnknown: false,
      },
    ]);
    // The next open's judge is given the marked call's tokens, and no others.
    let seen: HeldSpend | undefined;
    await ledgerOf((held) => {
      seen = held;
      return true;
    }).open({ exchangeId: crypto.randomUUID(), ...who, reserve: RESERVE });
    expect(seen?.unknownPriceTokens).toBe(TOKENS);
  });

  test("a report after its call's release still finds the model the release named", async () => {
    const who = await owner();
    const exchangeId = crypto.randomUUID();
    await ledgerOf().release({ exchangeId, ...who, reserve: UNPRICED });
    const { asked } = await settle(who, exchangeId, used("gpt-5.5"));
    expect(asked).toEqual([{ unmetered: false, requestModel: UNPRICED.model }]);
  });

  test("a report that finds no exchange row of its own is priced by the model that answered alone", async () => {
    const who = await owner();
    // No open at all.
    const unopened = crypto.randomUUID();
    const none = await settle(who, unopened, used("gpt-5.5"));
    expect(none.asked).toEqual([{ unmetered: false, requestModel: null }]);
    expect(await settled(unopened)).toEqual([
      {
        model: "gpt-5.5",
        requestModel: null,
        pricedBy: "table",
        priceVersion: PRICE_VERSION,
        priceUnknown: false,
      },
    ]);
    // A row under the id that another owner holds is not the report's.
    const other = await owner();
    const foreign = crypto.randomUUID();
    await ledgerOf().open({ exchangeId: foreign, ...other, reserve: UNPRICED });
    const theirs = await settle(who, foreign, used("gpt-5.5"));
    expect(theirs.asked).toEqual([{ unmetered: false, requestModel: null }]);
    expect(theirs.result).toMatchObject({ ledgerForeignRow: true });
  });

  test("a call opened with other price data than settles it says which", async () => {
    const who = await owner();
    const ledger = ledgerOf();
    const same = crypto.randomUUID();
    await ledger.open({ exchangeId: same, ...who, reserve: RESERVE });
    expect((await settle(who, same, USED)).result).toEqual({
      outcome: "recorded",
      costUsd: expect.any(Number),
      pricedBy: "table",
    });
    const moved = crypto.randomUUID();
    await ledger.open({ exchangeId: moved, ...who, reserve: RESERVE });
    await db
      .update(providerExchanges)
      .set({ priceVersion: "litellm@an-older-release/r1" })
      .where(eq(providerExchanges.exchangeId, moved));
    expect((await settle(who, moved, USED)).result).toMatchObject({
      outcome: "recorded",
      reservedWithPriceVersion: "litellm@an-older-release/r1",
    });
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { ProviderUsage } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  createProviderExchangeLedger,
  PROVIDER_EXCHANGE_KEEP_DAYS,
  reconcileProviderExchanges,
} from "./provider-exchanges.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  attempts,
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
    const ledger = createProviderExchangeLedger(db);
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
    const ledger = createProviderExchangeLedger(db);
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
    const ledger = createProviderExchangeLedger(db);
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
    const ledger = createProviderExchangeLedger(db);
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

describe("a usage report and the ledger", () => {
  test("a report deletes its own row, and a replay of it changes nothing more", async () => {
    const who = await owner();
    const ledger = createProviderExchangeLedger(db);
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
    const ledger = createProviderExchangeLedger(db);
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
    const exchangeId = crypto.randomUUID();
    await report(who, exchangeId);
    expect(
      await createProviderExchangeLedger(db).open({
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
    const ledger = createProviderExchangeLedger(db);
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
    const ledger = createProviderExchangeLedger(db);
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
    const ledger = createProviderExchangeLedger(db);
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
    await createProviderExchangeLedger(db).open({
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

    await createProviderExchangeLedger(db).renew(exchangeId);
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
    await createProviderExchangeLedger(db).open({
      exchangeId: crypto.randomUUID(),
      ...who,
      reserve: RESERVE,
    });
    expect(
      await reconcileProviderExchanges(db, { limit: 10, dryRun: false }),
    ).toEqual({ settled: 0, noticed: [], deleted: 0 });
    expect(await rows()).toHaveLength(1);
  });

  test("a row expired past the keep period is deleted", async () => {
    const who = await owner();
    const day = 24 * 60 * 60 * 1_000;
    await expiredRow(who, (PROVIDER_EXCHANGE_KEEP_DAYS + 1) * day);
    const kept = await expiredRow(who, (PROVIDER_EXCHANGE_KEEP_DAYS - 1) * day);
    const result = await reconcileProviderExchanges(db, {
      limit: 10,
      dryRun: false,
    });
    expect(result.deleted).toBe(1);
    expect((await rows()).map((row) => row.exchangeId)).toEqual([kept]);
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

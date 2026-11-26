import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { InputLimits } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { findPgError } from "./control-shared.ts";
import {
  INSTALLATION_STORAGE_SCOPE,
  STORAGE_LIMIT_SETTING,
} from "./input-limits.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { storageUsage, turns } from "./schema.ts";
import { fixtureRelease, TEST_MODEL } from "./testing/spec-pins.ts";

/**
 * The storage limit is decided at the commit of an acceptance: the charge
 * trigger adds the message's bytes then, and refuses the commit past the
 * limit the acceptance set for its transaction. PGlite has one connection, so
 * what another acceptance charges between this one's check and its commit is
 * played by a trigger, and "the next transaction on the same pooled
 * connection" is simply the next one.
 */

const MESSAGE = "안녕하세요";
const SIZE = Buffer.byteLength(MESSAGE, "utf8");
const REFUSED = { outcome: "storage_exhausted" } as const;

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  // Made before any count is taken: the release is no part of an acceptance.
  await fixtureRelease(db);
});

afterEach(async () => {
  await client.close();
});

const limitsAt = (storageLimitBytes: number): InputLimits => ({
  queuedInputLimitPerSession: 1_000,
  storageLimitBytes,
});
const roomy = limitsAt(1e15);

async function create(
  ownerId: string,
  limits: InputLimits,
  idempotencyKey: string = crypto.randomUUID(),
) {
  return createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits,
    principal: { ownerId },
    idempotencyKey,
    payloadHash: "hash",
    agentReleaseId: await fixtureRelease(db),
    model: TEST_MODEL,
    repository: {
      id: "sample-app",
      url: "https://example.invalid/app.git",
      branch: "main",
    },
    message: MESSAGE,
  });
}

function append(
  session: { sessionId: string; ownerId: string },
  limits: InputLimits,
  idempotencyKey: string = crypto.randomUUID(),
) {
  return createPostgresSessionUnitOfWork(db).appendInputAtomic({
    limits,
    principal: { ownerId: session.ownerId },
    sessionId: session.sessionId,
    idempotencyKey,
    payloadHash: "hash",
    message: MESSAGE,
  });
}

async function session() {
  const ownerId = crypto.randomUUID();
  const created = await create(ownerId, roomy);
  if (created.outcome !== "accepted") throw new Error(created.outcome);
  return { ownerId, sessionId: created.response.session_id };
}

async function kept(): Promise<number> {
  const [row] = await db
    .select({ bytes: storageUsage.bytes })
    .from(storageUsage)
    .where(eq(storageUsage.scope, INSTALLATION_STORAGE_SCOPE));
  return row?.bytes ?? 0;
}

/** Every table an acceptance writes to, counted whole. */
async function written() {
  const { rows } = await client.query(`
    SELECT (SELECT count(*)::int FROM sessions) AS sessions,
      (SELECT count(*)::int FROM turns) AS turns,
      (SELECT count(*)::int FROM receipts) AS receipts,
      (SELECT count(*)::int FROM idempotency_keys) AS idempotency_keys,
      (SELECT count(*)::int FROM queue_messages) AS queue_messages`);
  return rows[0];
}

/** Another acceptance's charge, landing after this one's check. */
function chargeAfterTheCheck(bytes: number) {
  return client.exec(`
    CREATE FUNCTION test_late_charge() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE storage_usage SET bytes = bytes + ${bytes} WHERE scope = 'installation';
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_late_charge BEFORE INSERT ON turns
      FOR EACH ROW EXECUTE FUNCTION test_late_charge();`);
}

const noLateCharge = () =>
  client.exec("DROP TRIGGER test_late_charge ON turns");

/** Keeps the limit each turn insert ran under, by the turn's message. */
function recordLimits() {
  return client.exec(`
    CREATE TABLE test_limits_seen (message text, cap text);
    CREATE FUNCTION test_record_limit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO test_limits_seen
      VALUES (NEW.message, current_setting('${STORAGE_LIMIT_SETTING}', true));
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_record_limit BEFORE INSERT ON turns
      FOR EACH ROW EXECUTE FUNCTION test_record_limit();`);
}

async function limitsSeen(): Promise<
  { message: string; cap: string | null }[]
> {
  const { rows } = await client.query<{ message: string; cap: string | null }>(
    "SELECT message, cap FROM test_limits_seen ORDER BY ctid",
  );
  return rows;
}

async function settingNow(): Promise<string | null> {
  const { rows } = await client.query<{ cap: string | null }>(
    `SELECT current_setting('${STORAGE_LIMIT_SETTING}', true) AS cap`,
  );
  return rows[0]?.cap ?? null;
}

/** A turn written with no acceptance, as the platform's own turns are. */
function platformTurn(sessionId: string, sequence: number, message: string) {
  return db
    .insert(turns)
    .values({ sessionId, sequence, message, status: "queued" });
}

describe("the storage limit at the commit of an acceptance", () => {
  test("a new session that fit when checked and not when charged is refused, nothing of it is kept, and its key is decided anew", async () => {
    const ownerId = crypto.randomUUID();
    const key = crypto.randomUUID();
    const before = await kept();
    const rows = await written();
    const exact = limitsAt(before + SIZE);
    await chargeAfterTheCheck(1);

    expect(await create(ownerId, exact, key)).toEqual(REFUSED);
    expect(await kept()).toBe(before);
    expect(await written()).toEqual(rows);

    // No record of the refusal answers for it: the same refusal while
    // nothing changed, an acceptance once the message fits.
    expect(await create(ownerId, exact, key)).toEqual(REFUSED);
    await noLateCharge();
    expect((await create(ownerId, exact, key)).outcome).toBe("accepted");
    expect(await kept()).toBe(before + SIZE);
  });

  test("an added message that fit when checked and not when charged is refused, nothing of it is kept, and its key is decided anew", async () => {
    const target = await session();
    const key = crypto.randomUUID();
    const before = await kept();
    const rows = await written();
    const exact = limitsAt(before + SIZE);
    await chargeAfterTheCheck(1);

    expect(await append(target, exact, key)).toEqual(REFUSED);
    expect(await kept()).toBe(before);
    expect(await written()).toEqual(rows);

    expect(await append(target, exact, key)).toEqual(REFUSED);
    await noLateCharge();
    expect((await append(target, exact, key)).outcome).toBe("accepted");
    expect(await kept()).toBe(before + SIZE);
  });

  test("a message that cannot fit is refused before its turn is written", async () => {
    const target = await session();
    const short = limitsAt((await kept()) + SIZE - 1);
    await recordLimits();

    expect(await create(crypto.randomUUID(), short)).toEqual(REFUSED);
    expect(await append(target, short)).toEqual(REFUSED);
    expect(await limitsSeen()).toEqual([]);
  });

  test("another error at commit is thrown as it came", async () => {
    await client.exec(`
      CREATE FUNCTION test_refuse_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'not the storage limit' USING ERRCODE = 'check_violation';
      END $$;
      CREATE CONSTRAINT TRIGGER test_refuse_commit AFTER INSERT ON turns
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION test_refuse_commit();`);

    const failure = await create(crypto.randomUUID(), roomy).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(findPgError(failure, "23514")).toBeDefined();
  });
});

describe("the limit an acceptance sets for its transaction", () => {
  test("a new session and an added message each write their turn under the limit they were given", async () => {
    await recordLimits();
    const ownerId = crypto.randomUUID();
    const created = await create(ownerId, limitsAt(1e15));
    if (created.outcome !== "accepted") throw new Error(created.outcome);
    const added = await append(
      { ownerId, sessionId: created.response.session_id },
      limitsAt(123_456_789),
    );
    expect(added.outcome).toBe("accepted");

    expect(await limitsSeen()).toEqual([
      { message: MESSAGE, cap: "1000000000000000" },
      { message: MESSAGE, cap: "123456789" },
    ]);
  });

  test("is set though the usage row is gone, and the charge makes the row again", async () => {
    await db.delete(storageUsage);
    await recordLimits();

    const exact = limitsAt(SIZE);
    expect((await create(crypto.randomUUID(), exact)).outcome).toBe("accepted");
    expect(await limitsSeen()).toEqual([
      { message: MESSAGE, cap: String(SIZE) },
    ]);
    expect(await kept()).toBe(SIZE);
    expect(await create(crypto.randomUUID(), exact)).toEqual(REFUSED);
  });

  test("does not reach the next transaction on the connection: a turn the platform writes there is charged past the limit and not refused", async () => {
    const target = await session();
    const before = await kept();
    const exact = limitsAt(before + SIZE);
    expect((await append(target, exact)).outcome).toBe("accepted");
    // What is left of the setting on the connection is no limit.
    expect(["", null]).toContain(await settingNow());

    await recordLimits();
    const late = "written by the platform";
    await platformTurn(target.sessionId, 3, late);
    expect(await kept()).toBe(before + SIZE + Buffer.byteLength(late));
    expect((await limitsSeen()).map((seen) => seen.cap || null)).toEqual([
      null,
    ]);
  });

  test("does not outlive a refused commit either", async () => {
    const target = await session();
    const before = await kept();
    await chargeAfterTheCheck(1);
    expect(await append(target, limitsAt(before + SIZE))).toEqual(REFUSED);
    await noLateCharge();
    expect(["", null]).toContain(await settingNow());

    await platformTurn(target.sessionId, 2, MESSAGE);
    expect(await kept()).toBe(before + SIZE);
  });
});

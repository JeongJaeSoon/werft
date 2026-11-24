import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type {
  AuthAttemptKey,
  AuthAttemptStore,
  AuthAttemptWindowRef,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import {
  createPostgresAuthAttemptStore,
  purgeEndedAuthAttemptWindows,
} from "./auth-attempts.ts";

const RULE = { limit: 3, windowMs: 15 * 60 * 1000 };
const KEY = "key-a" as AuthAttemptKey;

describe("createPostgresAuthAttemptStore", () => {
  let client: PGlite;
  let db: Database;
  let store: AuthAttemptStore;

  beforeAll(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    store = createPostgresAuthAttemptStore(db);
  });
  afterAll(async () => {
    await client.close();
  });
  beforeEach(async () => {
    await client.exec("DELETE FROM auth_attempt_windows; DELETE FROM receipts");
  });

  const count = async (key: string = KEY) =>
    (
      await client.query<{ count: number }>(
        "SELECT count FROM auth_attempt_windows WHERE key = $1",
        [key],
      )
    ).rows[0]?.count;
  const age = (hours: number) =>
    client.query(
      `UPDATE auth_attempt_windows SET window_started_at = now() - interval '${hours} hours'`,
    );

  test("admits up to the limit, then closes the window once", async () => {
    const taken = [];
    for (let i = 0; i < 6; i += 1) {
      taken.push(await store.take("account_failure", KEY, RULE));
    }
    expect(taken.map((one) => one.admitted)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(taken.map((one) => (one.admitted ? null : one.closedNow))).toEqual([
      null,
      null,
      null,
      true,
      false,
      false,
    ]);
    const refused = taken[3];
    if (!refused || refused.admitted) throw new Error("expected a refusal");
    expect(refused.retryAfterMs).toBeGreaterThan(RULE.windowMs - 60_000);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(RULE.windowMs);
    // Kinds and keys are separate windows.
    expect((await store.take("ip_failure", KEY, RULE)).admitted).toBe(true);
    expect(
      (await store.take("account_failure", "key-b" as AuthAttemptKey, RULE))
        .admitted,
    ).toBe(true);
  });

  test("a window that ended starts over at one", async () => {
    for (let i = 0; i < 4; i += 1) await store.take("ip_request", KEY, RULE);
    await age(1);
    expect((await store.take("ip_request", KEY, RULE)).admitted).toBe(true);
    expect(await count()).toBe(1);
  });

  test("two replicas on one database share the count", async () => {
    const other = createPostgresAuthAttemptStore(db);
    await store.take("ip_failure", KEY, RULE);
    await other.take("ip_failure", KEY, RULE);
    await store.take("ip_failure", KEY, RULE);
    const fourth = await other.take("ip_failure", KEY, RULE);
    expect(fourth.admitted).toBe(false);
    expect(fourth.admitted ? null : fourth.closedNow).toBe(true);
  });

  test("gives back only an admitted attempt of the same window", async () => {
    const first = await store.take("account_failure", KEY, RULE);
    if (!first.admitted) throw new Error("expected admission");
    await store.take("account_failure", KEY, RULE);
    await store.giveBack("account_failure", KEY, first.window);
    expect(await count()).toBe(1);
    // Another window's reference leaves this window alone.
    await store.giveBack(
      "account_failure",
      KEY,
      "2000-01-01 00:00:00+00" as AuthAttemptWindowRef,
    );
    expect(await count()).toBe(1);
    await store.clear("account_failure", KEY);
    expect(await count()).toBeUndefined();
  });

  test("refusals are not counted: giving back opens a closed window, which reports closing once", async () => {
    const admitted = [];
    for (let i = 0; i < 3; i += 1) {
      admitted.push(await store.take("ip_failure", KEY, RULE));
    }
    // Many refusals while the three are in flight leave the count alone.
    const refused = [];
    for (let i = 0; i < 10; i += 1) {
      refused.push(await store.take("ip_failure", KEY, RULE));
    }
    expect(refused.map((one) => one.admitted)).toEqual(Array(10).fill(false));
    expect(await count()).toBe(3);
    for (const one of admitted) {
      if (one.admitted) await store.giveBack("ip_failure", KEY, one.window);
    }
    expect(await count()).toBe(0);
    for (let i = 0; i < 3; i += 1) {
      expect((await store.take("ip_failure", KEY, RULE)).admitted).toBe(true);
    }
    // Closed again in the same window: not its first refusal.
    expect(await store.take("ip_failure", KEY, RULE)).toMatchObject({
      admitted: false,
      closedNow: false,
    });
  });

  test("writes a lock receipt on each live membership of a live account", async () => {
    const userId = randomUUID();
    const [kept, also, left] = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(schema.users).values({
      id: userId,
      email: "locked@example.com",
      displayName: "Locked",
    });
    await db
      .insert(schema.workspaces)
      .values(
        [kept, also, left].map((id) => ({ id, slug: `w-${id}`, name: id })),
      );
    await db.insert(schema.memberships).values([
      { workspaceId: kept, userId, role: "member" as const },
      { workspaceId: also, userId, role: "owner" as const },
      {
        workspaceId: left,
        userId,
        role: "member" as const,
        disabledAt: new Date(),
      },
    ]);
    const windowStartedAt = new Date("2026-11-24T00:00:00.000Z");
    const recorded = await store.recordAccountLock({
      email: "locked@example.com",
      windowStartedAt,
      windowMs: RULE.windowMs,
      failures: RULE.limit,
    });
    expect(recorded?.userId).toBe(userId);
    const live: string[] = [kept, also].sort();
    expect([...(recorded?.workspaceIds ?? [])].sort()).toEqual(live);
    const rows = await client.query<{
      owner_id: string;
      operation: string;
      target_ref: unknown;
      status: string;
      result: unknown;
    }>(
      "SELECT owner_id, operation, target_ref, status, result FROM receipts ORDER BY owner_id",
    );
    expect(rows.rows).toEqual(
      live.map((workspaceId) => ({
        owner_id: workspaceId,
        operation: "lock_login",
        target_ref: { user_id: userId, workspace_id: workspaceId },
        status: "succeeded",
        result: {
          kind: "account",
          window_started_at: windowStartedAt.toISOString(),
          window_seconds: 900,
          failures: RULE.limit,
        },
      })),
    );

    expect(
      await store.recordAccountLock({
        email: "nobody@example.com",
        windowStartedAt,
        windowMs: RULE.windowMs,
        failures: RULE.limit,
      }),
    ).toBeNull();
    expect((await client.query("SELECT 1 FROM receipts")).rows).toHaveLength(2);
  });

  test("purges windows older than a day, and only counts them on a dry run", async () => {
    await store.take("ip_request", KEY, RULE);
    await age(25);
    await store.take("ip_request", "fresh" as AuthAttemptKey, RULE);
    expect(
      await purgeEndedAuthAttemptWindows(db, { limit: 10, dryRun: true }),
    ).toBe(1);
    expect(await count()).toBe(1);
    expect(
      await purgeEndedAuthAttemptWindows(db, { limit: 10, dryRun: false }),
    ).toBe(1);
    expect(await count()).toBeUndefined();
    expect(await count("fresh")).toBe(1);
  });
});

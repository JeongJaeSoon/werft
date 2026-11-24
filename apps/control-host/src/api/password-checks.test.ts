import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { ApiHttpError } from "./app.ts";
import { AuthAttemptKeys } from "./auth-attempts.ts";
import { PasswordChecks } from "./password-checks.ts";

/**
 * Password checks on the shared Postgres windows, the way every API replica
 * runs them: replicas share counts, a lock writes one receipt per window, and
 * the network window answers the same for any email.
 */
describe("PasswordChecks on Postgres", () => {
  let client: PGlite;
  let db: PgliteDatabase<typeof schema>;
  let sink: MemoryLogSink;
  const secret = randomBytes(32);
  const known = "known@example.com";
  let userId: string;
  let workspaceId: string;

  const replica = (clientIpHeader?: string) =>
    new PasswordChecks({
      store: schema.createPostgresAuthAttemptStore(db),
      keys: new AuthAttemptKeys(secret),
      logger: new StructuredLogger({ sinks: [sink] }),
      ...(clientIpHeader ? { clientIpHeader } : {}),
    });
  const from = (address: string, entries: Record<string, string> = {}) => ({
    env: { clientAddress: address },
    req: { raw: new Request("http://api.test/", { headers: entries }) },
  });
  /** A wrong password: counted, never succeeded. */
  const fail = (checks: PasswordChecks, email: string, address: string) =>
    checks.guess(email, checks.clientOf(from(address)), async () => false);
  const refusal = async (attempt: Promise<unknown>) => {
    const error = await attempt.then(
      () => null,
      (caught: unknown) => caught,
    );
    if (!(error instanceof ApiHttpError)) throw new Error("expected a refusal");
    return error;
  };
  const receipts = async () =>
    (
      await client.query<{ owner_id: string }>(
        "SELECT owner_id FROM receipts WHERE operation = 'lock_login'",
      )
    ).rows;
  const locks = () =>
    sink.records.filter((record) => record.message === "Login locked");

  beforeAll(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema });
    userId = randomUUID();
    workspaceId = randomUUID();
    await db.insert(schema.users).values({
      id: userId,
      email: known,
      displayName: "Known",
    });
    await db
      .insert(schema.workspaces)
      .values({ id: workspaceId, slug: `w-${workspaceId}`, name: "W" });
    await db
      .insert(schema.memberships)
      .values({ workspaceId, userId, role: "member" });
  });
  afterAll(async () => {
    await client.close();
  });
  beforeEach(async () => {
    sink = new MemoryLogSink();
    await client.exec("DELETE FROM auth_attempt_windows; DELETE FROM receipts");
  });

  test("two replicas share one account's failures", async () => {
    const [a, b] = [replica(), replica()];
    for (let i = 0; i < 5; i += 1) {
      await fail(i % 2 ? a : b, known, `203.0.113.${i + 1}`);
    }
    const refused = await refusal(fail(a, known, "198.51.100.1"));
    expect(refused.status).toBe(429);
    expect((await refusal(fail(b, known, "198.51.100.2"))).status).toBe(429);
  });

  test("an account lock writes one receipt per window", async () => {
    const checks = replica();
    for (let i = 0; i < 5; i += 1) await fail(checks, known, "203.0.113.1");
    for (let i = 0; i < 3; i += 1) {
      await refusal(fail(checks, known, "203.0.113.2"));
    }
    expect(await receipts()).toEqual([{ owner_id: workspaceId }]);
    expect(locks()).toHaveLength(1);
    expect(locks()[0]?.fields).toMatchObject({
      kind: "account",
      user_id: userId,
      workspace_ids: [workspaceId],
      window_seconds: 900,
      failures: 5,
    });

    await client.query(
      "UPDATE auth_attempt_windows SET window_started_at = now() - interval '1 hour'",
    );
    for (let i = 0; i < 5; i += 1) await fail(checks, known, "203.0.113.3");
    await refusal(fail(checks, known, "203.0.113.3"));
    expect(await receipts()).toHaveLength(2);
  });

  test("an unknown email's lock writes no receipt and one log line", async () => {
    const checks = replica();
    const unknown = "nobody@example.com";
    for (let i = 0; i < 5; i += 1) await fail(checks, unknown, "203.0.113.1");
    await refusal(fail(checks, unknown, "203.0.113.1"));
    await refusal(fail(checks, unknown, "203.0.113.1"));
    expect(await receipts()).toEqual([]);
    expect(locks()).toHaveLength(1);
    const fields = locks()[0]?.fields ?? {};
    expect(fields).toMatchObject({ kind: "account", failures: 5 });
    expect(typeof fields.key).toBe("string");
    expect(JSON.stringify(sink.records)).not.toContain(unknown);
  });

  test("a locked network answers the same for a known and an unknown email", async () => {
    const checks = replica();
    for (let i = 0; i < 20; i += 1) {
      await fail(checks, `guess${i}@example.com`, "203.0.113.9");
    }
    const [forKnown, forUnknown] = [
      await refusal(fail(checks, known, "203.0.113.9")),
      await refusal(fail(checks, "nobody@example.com", "203.0.113.9")),
    ];
    expect([forKnown.status, forKnown.code, forKnown.message]).toEqual([
      forUnknown.status,
      forUnknown.code,
      forUnknown.message,
    ]);
    expect(
      Math.abs(
        (forKnown.retryAfterSeconds ?? 0) - (forUnknown.retryAfterSeconds ?? 0),
      ),
    ).toBeLessThanOrEqual(1);
    // Neither refusal got as far as the account: no account was locked.
    expect(await receipts()).toEqual([]);
    expect(locks().map((record) => record.fields?.kind)).toEqual(["ip"]);
    // Another network is not held back.
    await fail(checks, known, "198.51.100.1");
  });

  test("a private peer without the header limits no one by network", async () => {
    const checks = replica();
    for (let i = 0; i < 25; i += 1) {
      await fail(checks, `guess${i}@example.com`, "10.0.0.5");
    }
    await fail(checks, known, "10.0.0.5");
    expect(
      sink.records.filter((record) =>
        record.message.startsWith("Per-network sign-in limits skip"),
      ),
    ).toHaveLength(1);
  });

  test("with the header set, the client it names is counted", async () => {
    const checks = replica("cf-connecting-ip");
    const via = (ip: string, email: string) =>
      checks.guess(
        email,
        checks.clientOf(from("10.0.0.5", { "cf-connecting-ip": ip })),
        async () => false,
      );
    for (let i = 0; i < 20; i += 1) {
      await via("198.51.100.7", `guess${i}@example.com`);
    }
    expect((await refusal(via("198.51.100.7", known))).status).toBe(429);
    await via("198.51.100.8", known);
  });

  test("IPv6 clients are counted per /64", async () => {
    const checks = replica();
    for (let i = 0; i < 20; i += 1) {
      await fail(
        checks,
        `guess${i}@example.com`,
        `2001:db8:1:2::${(i + 1).toString(16)}`,
      );
    }
    await refusal(fail(checks, known, "2001:db8:1:2:ffff::1"));
    await fail(checks, known, "2001:db8:1:3::1");
  });

  test("token routes allow 30 requests a minute per network", async () => {
    const checks = replica();
    const client = checks.clientOf(from("203.0.113.4"));
    for (let i = 0; i < 30; i += 1) await checks.admitTokenRequest(client);
    const refused = await refusal(checks.admitTokenRequest(client));
    expect([refused.status, refused.message]).toEqual([
      429,
      "Too many sign-in requests from this network, try again later",
    ]);
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60);
    await checks.admitTokenRequest(checks.clientOf(from("203.0.113.5")));
    // Uncounted (a private peer without the header) is never refused.
    const tunnel = checks.clientOf(from("127.0.0.1"));
    for (let i = 0; i < 31; i += 1) await checks.admitTokenRequest(tunnel);
  });

  test("a right password clears the account and gives the network back", async () => {
    const checks = replica();
    for (let i = 0; i < 4; i += 1) await fail(checks, known, "203.0.113.6");
    const { reservation } = await checks.guess(
      known,
      checks.clientOf(from("203.0.113.6")),
      async () => true,
    );
    await reservation.succeeded();
    for (let i = 0; i < 5; i += 1) await fail(checks, known, "203.0.113.7");
    await refusal(fail(checks, known, "203.0.113.7"));
  });
});

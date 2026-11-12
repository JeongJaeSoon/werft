import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  loginMethods,
  memberships,
  users,
  webSessions,
  workspaces,
} from "../schema.ts";
import {
  createWebSession,
  resolveWebSession,
  signInWithExternalIdentity,
} from "./identity.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const ISSUER = "https://accounts.google.com";
const PASSWORD_HASH = "argon2id$placeholder";

integration("web sessions and the login method that made them", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const workspaceId = randomUUID();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_login_method" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "Acme" });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const newToken = () => createHash("sha256").update(randomUUID()).digest();

  /** A member with a password and its login method row, as 0138 left them. */
  async function passwordUser(name: string) {
    const userId = randomUUID();
    const methodId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${name}@example.com`,
      passwordHash: PASSWORD_HASH,
      displayName: name,
    });
    await db
      .insert(memberships)
      .values({ workspaceId, userId, role: "member" });
    await db
      .insert(loginMethods)
      .values({ id: methodId, userId, kind: "password" });
    return { userId, methodId };
  }

  async function passwordSession(userId: string) {
    const tokenHash = newToken();
    const id = randomUUID();
    const made = await createWebSession(db, {
      id,
      userId,
      verifiedPasswordHash: PASSWORD_HASH,
      tokenHash,
      ttlMs: 60_000,
      userAgent: null,
      maxLive: 5,
    });
    expect(made).not.toBeNull();
    return { id, tokenHash };
  }

  /** A session as the code before this column wrote it: no login method. */
  async function oldSession(userId: string) {
    const tokenHash = newToken();
    await db.insert(webSessions).values({
      id: randomUUID(),
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return tokenHash;
  }

  const externalSignIn = (subject: string, email: string) => {
    const tokenHash = newToken();
    const sessionId = randomUUID();
    return signInWithExternalIdentity(db, {
      kind: "google",
      issuer: ISSUER,
      subject,
      email,
      displayName: subject,
      jitRole: "member",
      ownsEmail: true,
      newUserId: randomUUID(),
      newLoginMethodId: randomUUID(),
      receiptId: randomUUID(),
      session: {
        id: sessionId,
        tokenHash,
        ttlMs: 60_000,
        userAgent: null,
        maxLive: 5,
      },
    }).then((result) => ({ result, tokenHash, sessionId }));
  };

  const methodOf = async (sessionId: string) =>
    (
      await db
        .select({ loginMethodId: webSessions.loginMethodId })
        .from(webSessions)
        .where(eq(webSessions.id, sessionId))
    )[0]?.loginMethodId;

  const linkExternal = (userId: string, subject: string) =>
    db.insert(loginMethods).values({
      id: randomUUID(),
      userId,
      kind: "google",
      issuer: ISSUER,
      subject,
    });

  test("a password login records the user's password method", async () => {
    const { userId, methodId } = await passwordUser("pat");
    const session = await passwordSession(userId);
    expect(await methodOf(session.id)).toBe(methodId);
    expect((await resolveWebSession(db, session.tokenHash))?.userId).toBe(
      userId,
    );
  });

  test("a password account that lost its method row gets it back, so the session still names one", async () => {
    const { userId, methodId } = await passwordUser("lost");
    await db.delete(loginMethods).where(eq(loginMethods.id, methodId));
    const session = await passwordSession(userId);
    const [repaired] = await db
      .select({ id: loginMethods.id })
      .from(loginMethods)
      .where(
        and(eq(loginMethods.userId, userId), eq(loginMethods.kind, "password")),
      );
    expect(repaired).toBeDefined();
    expect(await methodOf(session.id)).toBe(repaired?.id as string);
    // A second login reuses the row.
    await passwordSession(userId);
    expect(
      await db.$count(
        loginMethods,
        and(eq(loginMethods.userId, userId), eq(loginMethods.kind, "password")),
      ),
    ).toBe(1);
  });

  test("an external sign-in records the external method, on the first entry and on every later one", async () => {
    const first = await externalSignIn("sub-jit", "jit@example.com");
    expect(first.result.outcome).toBe("signed_in");
    const [method] = await db
      .select({ id: loginMethods.id, userId: loginMethods.userId })
      .from(loginMethods)
      .where(eq(loginMethods.subject, "sub-jit"));
    expect(method).toBeDefined();
    expect(await methodOf(first.sessionId)).toBe(method?.id as string);

    const again = await externalSignIn("sub-jit", "jit@example.com");
    expect(again.result).toMatchObject({ outcome: "signed_in", via: "linked" });
    expect(await methodOf(again.sessionId)).toBe(method?.id as string);
    expect((await resolveWebSession(db, again.tokenHash))?.userId).toBe(
      method?.userId as string,
    );
  });

  test("an old session of a password-only user still stands", async () => {
    const { userId } = await passwordUser("olive");
    const tokenHash = await oldSession(userId);
    expect((await resolveWebSession(db, tokenHash))?.userId).toBe(userId);
  });

  test("an old session of a user with an external method is not accepted; a new one is", async () => {
    const signedIn = await externalSignIn("sub-ext", "ext@example.com");
    if (signedIn.result.outcome !== "signed_in") {
      throw new Error("external sign-in was refused");
    }
    const { userId } = signedIn.result;
    const old = await oldSession(userId);
    expect(await resolveWebSession(db, old)).toBeNull();
    expect((await resolveWebSession(db, signedIn.tokenHash))?.userId).toBe(
      userId,
    );
  });

  test("an old session of a user with both a password and an external method is not accepted", async () => {
    const { userId } = await passwordUser("both");
    await linkExternal(userId, "sub-both");
    const old = await oldSession(userId);
    expect(await resolveWebSession(db, old)).toBeNull();
    // Signing in again with the password gives a session that stands.
    const fresh = await passwordSession(userId);
    expect((await resolveWebSession(db, fresh.tokenHash))?.userId).toBe(userId);
  });

  test("linking an external method ends the user's old sessions and leaves the recorded ones", async () => {
    const { userId } = await passwordUser("later");
    const old = await oldSession(userId);
    const recorded = await passwordSession(userId);
    expect((await resolveWebSession(db, old))?.userId).toBe(userId);

    await linkExternal(userId, "sub-later");
    expect(await resolveWebSession(db, old)).toBeNull();
    expect((await resolveWebSession(db, recorded.tokenHash))?.userId).toBe(
      userId,
    );
  });

  test("another user's external method does not touch this user's old session", async () => {
    const { userId } = await passwordUser("alone");
    const other = await passwordUser("neighbour");
    await linkExternal(other.userId, "sub-neighbour");
    const old = await oldSession(userId);
    expect((await resolveWebSession(db, old))?.userId).toBe(userId);
  });
});

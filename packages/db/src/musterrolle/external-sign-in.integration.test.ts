import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import type { ExternalSignInInput } from "@werft-ai/platform";
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
  invites,
  loginMethods,
  memberships,
  receipts,
  users,
  workspaces,
} from "../schema.ts";
import { seedLoginProvider } from "../testing/login-provider.ts";
import { signInWithExternalIdentity } from "./identity.ts";
import { createPostgresMemberStore } from "./members.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const ISSUER = "https://accounts.google.com";

integration("external sign-in first-entry rules", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const workspaceId = randomUUID();
  const ownerId = randomUUID();
  let provider: Awaited<ReturnType<typeof seedLoginProvider>>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "external_sign_in" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "acme", name: "Acme" });
    await db.insert(users).values({
      id: ownerId,
      email: "owner@example.com",
      passwordHash: "argon2id$placeholder",
      displayName: "Owner",
    });
    await db
      .insert(memberships)
      .values({ workspaceId, userId: ownerId, role: "owner" });
    provider = await seedLoginProvider(db, { issuer: ISSUER });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const signIn = (
    subject: string,
    email: string,
    options: Partial<Pick<ExternalSignInInput, "jitRole" | "ownsEmail">> = {},
  ) =>
    signInWithExternalIdentity(db, {
      kind: "oidc",
      provider: { id: provider.id, configRevision: provider.configRevision },
      issuer: ISSUER,
      subject,
      email,
      displayName: subject,
      jitRole: null,
      ownsEmail: true,
      ...options,
      newUserId: randomUUID(),
      newLoginMethodId: randomUUID(),
      receiptId: randomUUID(),
      session: {
        id: randomUUID(),
        tokenHash: createHash("sha256").update(randomUUID()).digest(),
        ttlMs: 60_000,
        userAgent: null,
        maxLive: 5,
      },
    });
  const invite = async (email: string, ttlMs = 60_000) => {
    const id = randomUUID();
    await db.insert(invites).values({
      id,
      workspaceId,
      email,
      role: "member",
      tokenHash: createHash("sha256").update(id).digest(),
      invitedBy: ownerId,
      expiresAt: new Date(Date.now() + ttlMs),
    });
    return id;
  };
  const userByEmail = async (email: string) =>
    (await db.select().from(users).where(eq(users.email, email)))[0];

  test("an invite admits a new address as a passwordless user and is accepted", async () => {
    const inviteId = await invite("bob@example.com");
    const result = await signIn("sub-bob", "bob@example.com");
    expect(result).toMatchObject({
      outcome: "signed_in",
      via: "invite",
      workspaceId,
      role: "member",
    });
    expect((await userByEmail("bob@example.com"))?.passwordHash).toBeNull();
    const [accepted] = await db
      .select({ acceptedAt: invites.acceptedAt })
      .from(invites)
      .where(eq(invites.id, inviteId));
    expect(accepted?.acceptedAt).not.toBeNull();
    const written = await db
      .select()
      .from(receipts)
      .where(eq(receipts.operation, "accept_invite"));
    expect(written).toHaveLength(1);
    expect(written[0]?.result).toMatchObject({
      new_account: true,
      login_method: "oidc",
      issuer: ISSUER,
    });
    expect(written[0]?.actor).toMatchObject({
      actor_user_id: result.outcome === "signed_in" ? result.userId : "",
    });
  });

  test("a linked subject signs in as its user whatever address it now reports", async () => {
    const bob = await userByEmail("bob@example.com");
    expect(await signIn("sub-bob", "bob.renamed@example.com")).toMatchObject({
      outcome: "signed_in",
      via: "linked",
      userId: bob?.id,
    });
  });

  test("an address with an account is never joined by email", async () => {
    await invite("owner@example.com");
    expect(
      await signIn("sub-impostor", "owner@example.com", { jitRole: "member" }),
    ).toEqual({ outcome: "link_required" });
    expect(
      await signIn("sub-impostor", "owner@example.com", { ownsEmail: false }),
    ).toEqual({ outcome: "rejected" });
  });

  test("an address the provider no longer vouches for takes no invite", async () => {
    await invite("ivy@example.com");
    expect(
      await signIn("sub-ivy", "ivy@example.com", { ownsEmail: false }),
    ).toEqual({ outcome: "rejected" });
    expect(await userByEmail("ivy@example.com")).toBeUndefined();
  });

  test("JIT joins the workspace with its role; with neither invite nor JIT nobody joins", async () => {
    expect(
      await signIn("sub-dana", "dana@example.com", { jitRole: "member" }),
    ).toMatchObject({ outcome: "signed_in", via: "jit", workspaceId });
    expect(await signIn("sub-nobody", "nobody@example.com")).toEqual({
      outcome: "rejected",
    });
  });

  test("a disabled user is refused, linked or by address", async () => {
    await invite("carol@example.com");
    await signIn("sub-carol", "carol@example.com");
    await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.email, "carol@example.com"));
    expect(await signIn("sub-carol", "carol@example.com")).toEqual({
      outcome: "rejected",
    });
    expect(await signIn("sub-carol-2", "carol@example.com")).toEqual({
      outcome: "rejected",
    });
  });

  test("a passwordless account whose membership is enabled again signs in with its link", async () => {
    await invite("erin@example.com");
    const first = await signIn("sub-erin", "erin@example.com");
    if (first.outcome !== "signed_in") throw new Error(first.outcome);
    const store = createPostgresMemberStore(db);
    const change = (disabled: boolean) =>
      store.setAccess({
        actor: {
          principal: {
            ownerId: workspaceId,
            actor: {
              principal: { kind: "user", id: ownerId },
              userId: ownerId,
              workspaceId,
              apiKeyId: null,
            },
          },
          workspaceId,
          userId: ownerId,
        },
        userId: first.userId,
        scope: "membership",
        disabled,
        reason: null,
        receiptId: randomUUID(),
      });
    expect(await change(true)).toMatchObject({ outcome: "changed" });
    expect(await signIn("sub-erin", "erin@example.com")).toEqual({
      outcome: "rejected",
    });
    expect(await change(false)).toMatchObject({ outcome: "changed" });
    expect(await signIn("sub-erin", "erin@example.com")).toMatchObject({
      outcome: "signed_in",
      via: "linked",
      userId: first.userId,
    });
  });

  test("an invite that expires while another transaction holds it admits nobody", async () => {
    const inviteId = await invite("jo@example.com", 300);
    const holder = await pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM invites WHERE id = $1 FOR UPDATE", [
        inviteId,
      ]);
      const pending = signIn("sub-jo", "jo@example.com");
      await Bun.sleep(600);
      await holder.query("COMMIT");
      expect(await pending).toEqual({ outcome: "rejected" });
    } finally {
      holder.release();
    }
  });

  test("concurrent first logins make one account per subject and per address", async () => {
    await invite("frank@example.com");
    const same = await Promise.all([
      signIn("sub-frank", "frank@example.com"),
      signIn("sub-frank", "frank@example.com"),
    ]);
    expect(same.map((result) => result.outcome)).toEqual([
      "signed_in",
      "signed_in",
    ]);
    expect(
      await db.$count(loginMethods, eq(loginMethods.subject, "sub-frank")),
    ).toBe(1);
    const rival = await Promise.all(
      ["sub-kim-1", "sub-kim-2"].map((subject) =>
        signIn(subject, "kim@example.com", { jitRole: "member" }),
      ),
    );
    expect(rival.map((result) => result.outcome).sort()).toEqual([
      "link_required",
      "signed_in",
    ]);
  });

  test("an external login method needs both issuer and subject", async () => {
    const bob = await userByEmail("bob@example.com");
    const issuerOnly = async () => {
      await db.insert(loginMethods).values({
        id: randomUUID(),
        userId: bob?.id as string,
        kind: "oidc",
        issuer: ISSUER,
        subject: null,
      });
    };
    await expect(issuerOnly()).rejects.toThrow();
    expect(
      await db.$count(
        loginMethods,
        and(
          eq(loginMethods.userId, bob?.id as string),
          eq(loginMethods.kind, "oidc"),
        ),
      ),
    ).toBe(1);
  });
});

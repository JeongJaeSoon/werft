import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import { type Caller, callerFor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  bindCredentialRef,
  createPostgresCredentialBindingStore,
  lockUnboundRefs,
  releaseCredentialRefs,
} from "./musterrolle/credential-bindings.ts";
import * as schema from "./schema.ts";
import {
  agentAdmins,
  agentReleases,
  agents,
  agentVersions,
  credentialBindings,
  memberships,
  receipts,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import {
  releaseSpecColumns,
  sessionPinColumns,
  TEST_CONNECTION_ID,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const BINDERS: readonly WorkspaceRole[] = ["owner", "admin"];

async function refusal(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? String(error);
  }
  return "accepted";
}

integration("credential bindings on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "credential_bindings_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresCredentialBindingStore(db);

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  async function person(workspaceId: string, role: WorkspaceRole) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${role}-${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
  }

  const userOf = (caller: Caller) => caller.actor?.userId ?? "";

  // An agent and one release whose card names `refs`; written raw so the
  // store is tested against the stored shape, not the card schema.
  async function agentWith(workspaceId: string, refs: string[] | undefined) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
    });
    const versionId = randomUUID();
    const capabilities = {
      tools: [],
      mcp: null,
      forbidden: [],
      ...(refs === undefined ? {} : { credential_refs: refs }),
    };
    await db.insert(agentVersions).values({
      id: versionId,
      agentId,
      versionNo: 1,
      card: { role: "r", instructions: "i", model: "m", capabilities },
      contentSha256: "0".repeat(64),
    });
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256: "0".repeat(64),
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: {},
      effectiveTools: [],
    });
    return { agentId, releaseId };
  }

  function bind(
    by: Caller,
    agentId: string,
    credentialRef: string,
    receiptId = randomUUID(),
  ) {
    return store().bind({
      principal: by,
      id: randomUUID(),
      workspaceId: by.ownerId,
      agentId,
      credentialRef,
      boundBy: userOf(by),
      receiptId,
      binderRoles: BINDERS,
    });
  }

  async function unbind(by: Caller, agentId: string, credentialRef: string) {
    const live = (await store().list(by.ownerId, agentId)) ?? [];
    return store().revoke({
      principal: by,
      workspaceId: by.ownerId,
      agentId,
      bindingId:
        live.find((binding) => binding.credentialRef === credentialRef)?.id ??
        randomUUID(),
      receiptId: randomUUID(),
      revokerRoles: BINDERS,
    });
  }

  test("owners, admins and the agent's admins bind; a member does not", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const admin = await person(workspaceId, "admin");
    const member = await person(workspaceId, "member");
    const agentAdmin = await person(workspaceId, "member");
    const { agentId } = await agentWith(workspaceId, ["slack_bot_token"]);
    await db
      .insert(agentAdmins)
      .values({ workspaceId, agentId, userId: userOf(agentAdmin) });

    const receiptId = randomUUID();
    const bound = await bind(owner, agentId, "slack_bot_token", receiptId);
    expect(bound).toMatchObject({
      outcome: "bound",
      binding: {
        agentId,
        credentialRef: "slack_bot_token",
        boundBy: userOf(owner),
        revokedAt: null,
        runningSessions: 0,
      },
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(receipt).toMatchObject({
      operation: "bind_credential",
      status: "succeeded",
      targetRef: { resource: { kind: "agent", id: agentId } },
      result: { credential_ref: "slack_bot_token" },
    });

    // Binding what is bound changes nothing and writes no receipt.
    const again = randomUUID();
    expect(await bind(admin, agentId, "slack_bot_token", again)).toMatchObject({
      outcome: "already_bound",
    });
    expect(
      await db.select().from(receipts).where(eq(receipts.id, again)),
    ).toEqual([]);

    expect(await bind(member, agentId, "mcp-notion")).toEqual({
      outcome: "outranked",
    });
    expect(await bind(agentAdmin, agentId, "mcp-notion")).toMatchObject({
      outcome: "bound",
    });
    expect(
      (await store().list(workspaceId, agentId))?.map((b) => b.credentialRef),
    ).toEqual(["mcp-notion", "slack_bot_token"]);

    // Another workspace's agent has no bindings to list.
    expect(await store().list(workspaceId, randomUUID())).toBeNull();

    // A disabled binder, and another workspace's agent, get nowhere.
    const elsewhere = await agentWith(await workspace(), undefined);
    expect(await bind(owner, elsewhere.agentId, "x")).toEqual({
      outcome: "agent_not_found",
    });
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, userOf(admin)));
    expect(await bind(admin, agentId, "y")).toEqual({
      outcome: "actor_inactive",
    });
  });

  test("a release's unbound names follow binding and revoking", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const { agentId, releaseId } = await agentWith(workspaceId, [
      "mcp-notion",
      "slack_bot_token",
    ]);
    const s = store();
    expect(await s.unboundRefs(workspaceId, releaseId)).toEqual([
      "mcp-notion",
      "slack_bot_token",
    ]);
    await bind(owner, agentId, "slack_bot_token");
    expect(await s.unboundRefs(workspaceId, releaseId)).toEqual(["mcp-notion"]);
    await bind(owner, agentId, "mcp-notion");
    expect(await s.unboundRefs(workspaceId, releaseId)).toEqual([]);

    // Another agent's binding of the same name does not count.
    const other = await agentWith(workspaceId, ["slack_bot_token"]);
    expect(await s.unboundRefs(workspaceId, other.releaseId)).toEqual([
      "slack_bot_token",
    ]);
    // Nor is a release read across workspaces.
    expect(await s.unboundRefs(await workspace(), releaseId)).toEqual([]);

    const revoked = await unbind(owner, agentId, "mcp-notion");
    expect(revoked).toMatchObject({
      outcome: "revoked",
      binding: { credentialRef: "mcp-notion" },
    });
    if (revoked.outcome === "revoked") {
      expect(revoked.binding.revokedAt).not.toBeNull();
    }
    expect(await s.unboundRefs(workspaceId, releaseId)).toEqual(["mcp-notion"]);
    expect(await unbind(owner, agentId, "mcp-notion")).toEqual({
      outcome: "not_found",
    });
    // Bound again after a revoke, it is a new row.
    expect(await bind(owner, agentId, "mcp-notion")).toMatchObject({
      outcome: "bound",
    });

    // A card from before credential names existed names none.
    const old = await agentWith(workspaceId, undefined);
    expect(await s.unboundRefs(workspaceId, old.releaseId)).toEqual([]);
  });

  test("the running count is the agent's open sessions whose card names it", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const { agentId, releaseId } = await agentWith(workspaceId, [
      "slack_bot_token",
    ]);
    const plain = await agentWith(workspaceId, []);
    await bind(owner, agentId, "slack_bot_token");
    const session = async (
      agentReleaseId: string | null,
      admissionState: "active" | "paused" | "closed",
    ) => {
      await db.insert(sessions).values({
        id: randomUUID(),
        ownerId: workspaceId,
        workspaceId,
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
        ...sessionPinColumns(),
        agentReleaseId,
        admissionState,
      });
    };
    await session(releaseId, "active");
    await session(releaseId, "paused");
    await session(releaseId, "closed");
    await session(plain.releaseId, "active");
    await session(null, "active");

    const [listed] = (await store().list(workspaceId, agentId)) ?? [];
    expect(listed?.runningSessions).toBe(2);
    const revoked = await unbind(owner, agentId, "slack_bot_token");
    expect(revoked).toMatchObject({ binding: { runningSessions: 2 } });
  });

  test("a session's acceptance and an unbind serialize on the binding", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const { agentId, releaseId } = await agentWith(workspaceId, [
      "slack_bot_token",
    ]);
    await bind(owner, agentId, "slack_bot_token");
    let locked = () => {};
    let proceed = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const accepting = db.transaction(async (tx) => {
      expect(await lockUnboundRefs(tx, { workspaceId, releaseId })).toEqual([]);
      locked();
      await gate;
      await tx.insert(sessions).values({
        id: randomUUID(),
        ownerId: workspaceId,
        workspaceId,
        repoUrl: "https://example.invalid/app.git",
        branch: "main",
        ...sessionPinColumns(),
        agentReleaseId: releaseId,
      });
    });
    await lockTaken;
    let settled = false;
    const unbinding = unbind(owner, agentId, "slack_bot_token").finally(() => {
      settled = true;
    });
    await Bun.sleep(300);
    expect(settled).toBe(false);
    proceed();
    await accepting;
    // The unbind waited, so the session it let start is counted.
    expect(await unbinding).toMatchObject({
      outcome: "revoked",
      binding: { runningSessions: 1 },
    });
    expect(
      await db.transaction((tx) =>
        lockUnboundRefs(tx, { workspaceId, releaseId }),
      ),
    ).toEqual(["slack_bot_token"]);
  });

  test("an agent identity's credential is never an agent's, either way round", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const { agentId } = await agentWith(workspaceId, undefined);
    const identity = (credentialRef: string) =>
      db.insert(credentialBindings).values({
        id: randomUUID(),
        workspaceId,
        credentialRef,
        target: "agent_identity",
        targetId: randomUUID(),
        boundBy: userOf(owner),
      });

    await identity("slack_bot_token");
    expect(await bind(owner, agentId, "slack_bot_token")).toEqual({
      outcome: "ref_in_use",
    });

    expect(await bind(owner, agentId, "mcp-notion")).toMatchObject({
      outcome: "bound",
    });
    expect(await refusal(identity("mcp-notion"))).toBe(
      "credential_bindings_exclusive_target",
    );
    // A revoked agent binding no longer holds the name.
    await unbind(owner, agentId, "mcp-notion");
    expect(await refusal(identity("mcp-notion"))).toBe("accepted");

    // The same name in another workspace is someone else's.
    const other = await workspace();
    const otherOwner = await person(other, "owner");
    const otherAgent = await agentWith(other, undefined);
    expect(
      await bind(otherOwner, otherAgent.agentId, "slack_bot_token"),
    ).toMatchObject({ outcome: "bound" });
  });

  test("an identity's link binds and releases through the same functions", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const { agentId } = await agentWith(workspaceId, undefined);
    const identityId = randomUUID();
    const link = (credentialRef: string, targetId = identityId) =>
      db.transaction((tx) =>
        bindCredentialRef(tx, {
          id: randomUUID(),
          workspaceId,
          credentialRef,
          target: "agent_identity",
          targetId,
          boundBy: userOf(owner),
        }),
      );

    expect(await link("slack_bot_token")).toMatchObject({ outcome: "bound" });
    expect(await link("slack_bot_token")).toMatchObject({
      outcome: "already_bound",
    });
    // One identity's token is not another identity's either.
    expect(await link("slack_bot_token", randomUUID())).toEqual({
      outcome: "ref_in_use",
    });
    await bind(owner, agentId, "mcp-notion");
    expect(await link("mcp-notion")).toEqual({ outcome: "ref_in_use" });

    expect(
      await db.transaction((tx) =>
        releaseCredentialRefs(tx, {
          workspaceId,
          target: "agent_identity",
          targetId: identityId,
        }),
      ),
    ).toEqual(["slack_bot_token"]);
    expect(await bind(owner, agentId, "slack_bot_token")).toMatchObject({
      outcome: "bound",
    });
  });

  test("names are references, not values", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const { agentId } = await agentWith(workspaceId, undefined);
    for (const credentialRef of ["Slack", "a b", "-x", "x".repeat(129), ""]) {
      expect(
        await refusal(
          db.insert(credentialBindings).values({
            id: randomUUID(),
            workspaceId,
            credentialRef,
            target: "agent",
            targetId: agentId,
            boundBy: userOf(owner),
          }),
        ),
      ).toBe("credential_bindings_ref_check");
    }
  });

  test("contacts are the agent's live admins, else owners and admins", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const admin = await person(workspaceId, "admin");
    const agentAdmin = await person(workspaceId, "member");
    await person(workspaceId, "member");
    const { agentId } = await agentWith(workspaceId, undefined);
    await db
      .insert(agentAdmins)
      .values({ workspaceId, agentId, userId: userOf(agentAdmin) });

    expect(await store().contacts(workspaceId, agentId)).toEqual([
      {
        userId: userOf(agentAdmin),
        displayName: "member",
        email: `member-${userOf(agentAdmin)}@example.invalid`,
      },
    ]);
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, userOf(agentAdmin)),
        ),
      );
    expect(
      (await store().contacts(workspaceId, agentId)).map((c) => c.userId),
    ).toEqual([userOf(admin), userOf(owner)]);
  });
});

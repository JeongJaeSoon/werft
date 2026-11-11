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
import * as schema from "../schema.ts";
import {
  agentAdmins,
  agentIdentities,
  agents,
  credentialBindings,
  memberships,
  receipts,
  surfaceBindings,
  users,
  workspaces,
} from "../schema.ts";
import { createPostgresSlackInstallStore } from "../surface/slack-install-states.ts";
import {
  registerSlackInstallation,
  revokeSlackInstallation,
  verifySlackInstallation,
} from "../surface/slack-installations.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import {
  createPostgresAgentIdentityStore,
  resolveSlackEventAgent,
} from "./agent-identities.ts";
import { bindCredentialRef } from "./credential-bindings.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// binding.manage's roles (design 4.1, "Slack 앱 설치·채널 설정").
const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];

async function refusal(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    return String((error as { cause?: Error }).cause?.message ?? error);
  }
  return "accepted";
}

integration("agent identities on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_identities_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresAgentIdentityStore(db);

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  async function person(
    workspaceId: string,
    role: WorkspaceRole,
  ): Promise<Caller> {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
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

  async function agent(workspaceId: string, admin?: Caller) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${id.slice(0, 8)}`,
      name: "bot",
    });
    if (admin?.actor?.userId) {
      await db
        .insert(agentAdmins)
        .values({ workspaceId, agentId: id, userId: admin.actor.userId });
    }
    return id;
  }

  // Fixture ids shaped like Slack's; no Slack app is involved.
  async function installed(workspaceId: string, botUserId = "B0BOT") {
    const key = {
      appId: `A${randomUUID().slice(0, 8).toUpperCase()}`,
      teamId: `T${randomUUID().slice(0, 8).toUpperCase()}`,
    };
    await registerSlackInstallation(db, { ...key, workspaceId });
    await verifySlackInstallation(db, { ...key, botUserId });
    return key;
  }

  const linkAs = (
    caller: Caller,
    agentId: string,
    key: { appId: string; teamId: string },
    credentialRef = "slack-bot-token",
  ) =>
    store().link({
      principal: caller,
      workspaceId: caller.ownerId,
      agentId,
      key,
      credentialRef,
      managerRoles: MANAGERS,
    });

  const revokeAs = (caller: Caller, agentId: string, identityId: string) =>
    store().revoke({
      principal: caller,
      workspaceId: caller.ownerId,
      agentId,
      identityId,
      managerRoles: MANAGERS,
    });

  test("an event's app and team resolve to the one linked agent", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentId = await agent(workspaceId);
    const key = await installed(workspaceId);

    const linked = await linkAs(owner, agentId, key);

    expect(linked.outcome).toBe("linked");
    if (linked.outcome !== "linked") return;
    expect(linked.identity).toMatchObject({
      agentId,
      provider: "slack_bot",
      appId: key.appId,
      teamId: key.teamId,
      externalPrincipalId: "B0BOT",
      credentialRef: "slack-bot-token",
      status: "active",
      revision: 1,
      createdBy: owner.actor?.userId,
    });
    expect(await resolveSlackEventAgent(db, key)).toEqual({
      status: "resolved",
      workspaceId,
      agentId,
      identity: { id: linked.identity.id, revision: 1 },
      installationId: linked.identity.installationId,
      botUserId: "B0BOT",
      credentialRef: "slack-bot-token",
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, linked.receiptId));
    expect(receipt).toMatchObject({
      ownerId: workspaceId,
      operation: "link_agent_identity",
      requestId: owner.requestId,
      targetRef: {
        resource: { kind: "agent", id: agentId },
        workspace_id: workspaceId,
      },
      result: {
        agent_identity_id: linked.identity.id,
        app_id: key.appId,
        team_id: key.teamId,
        bot_user_id: "B0BOT",
        credential_ref: "slack-bot-token",
        revision: 1,
      },
    });
  });

  test("an install names one agent: a second agent is refused, the same one told it exists", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const first = await agent(workspaceId);
    const second = await agent(workspaceId);
    const key = await installed(workspaceId);

    const linked = await linkAs(owner, first, key);
    expect(linked.outcome).toBe("linked");
    expect((await linkAs(owner, second, key)).outcome).toBe("taken");
    const again = await linkAs(owner, first, key);
    expect(again.outcome).toBe("exists");
    expect(
      linked.outcome === "linked" && again.outcome === "exists"
        ? again.identity.id === linked.identity.id
        : false,
    ).toBe(true);
    const resolved = await resolveSlackEventAgent(db, key);
    expect(resolved.status === "resolved" && resolved.agentId).toBe(first);
  });

  test("two agents racing for one install: exactly one wins", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const contenders = await Promise.all(
      Array.from({ length: 4 }, () => agent(workspaceId)),
    );
    const key = await installed(workspaceId);

    const results = await Promise.all(
      contenders.map((agentId) => linkAs(owner, agentId, key)),
    );

    expect(results.filter((r) => r.outcome === "linked")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "taken")).toHaveLength(3);
    const live = await db
      .select({ id: agentIdentities.id })
      .from(agentIdentities)
      .where(
        and(
          eq(agentIdentities.status, "active"),
          eq(agentIdentities.workspaceId, workspaceId),
        ),
      );
    expect(live).toHaveLength(1);
  });

  test("after a revoke the same event is dropped; linking again makes a new row", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentId = await agent(workspaceId);
    const key = await installed(workspaceId);
    const linked = await linkAs(owner, agentId, key);
    if (linked.outcome !== "linked") throw new Error(linked.outcome);

    const revoked = await revokeAs(owner, agentId, linked.identity.id);

    expect(revoked.outcome).toBe("revoked");
    if (revoked.outcome !== "revoked") return;
    expect(revoked.identity).toMatchObject({ status: "revoked", revision: 2 });
    expect(revoked.identity.revokedAt).toBeInstanceOf(Date);
    expect(await resolveSlackEventAgent(db, key)).toEqual({
      status: "dropped",
      reason: "identity_revoked",
    });
    const [row] = await db
      .select({ revokedBy: agentIdentities.revokedBy })
      .from(agentIdentities)
      .where(eq(agentIdentities.id, linked.identity.id));
    expect(row?.revokedBy).toBe(owner.actor?.userId ?? "");
    const [receipt] = await db
      .select({ operation: receipts.operation, result: receipts.result })
      .from(receipts)
      .where(eq(receipts.id, revoked.receiptId));
    expect(receipt).toMatchObject({
      operation: "revoke_agent_identity",
      result: { agent_identity_id: linked.identity.id, revision: 2 },
    });

    const twice = await revokeAs(owner, agentId, linked.identity.id);
    expect(twice.outcome).toBe("already_revoked");

    // Another agent may take the freed install.
    const next = await agent(workspaceId);
    const relinked = await linkAs(owner, next, key);
    expect(relinked.outcome).toBe("linked");
    if (relinked.outcome !== "linked") return;
    expect(relinked.identity.id).not.toBe(linked.identity.id);
    const resolved = await resolveSlackEventAgent(db, key);
    expect(resolved).toMatchObject({
      status: "resolved",
      agentId: next,
      identity: { id: relinked.identity.id, revision: 1 },
    });
  });

  test("an event is judged from one statement, so install, identity and agent share a snapshot", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentId = await agent(workspaceId);
    const key = await installed(workspaceId);
    expect((await linkAs(owner, agentId, key)).outcome).toBe("linked");

    const statements: string[] = [];
    const counted = drizzle(pool, {
      schema,
      logger: { logQuery: (query) => statements.push(query) },
    });
    expect((await resolveSlackEventAgent(counted, key)).status).toBe(
      "resolved",
    );
    expect(statements).toHaveLength(1);
  });

  test("events from another app, an unverified, revoked or reinstalled app are dropped", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentId = await agent(workspaceId);
    const key = await installed(workspaceId);
    expect((await linkAs(owner, agentId, key)).outcome).toBe("linked");

    expect(
      await resolveSlackEventAgent(db, {
        appId: "A0OTHER",
        teamId: key.teamId,
      }),
    ).toEqual({ status: "dropped", reason: "not_installed" });
    expect(
      await resolveSlackEventAgent(db, { appId: key.appId, teamId: "T0OTHER" }),
    ).toEqual({ status: "dropped", reason: "not_installed" });

    const unlinked = await installed(workspaceId);
    expect(await resolveSlackEventAgent(db, unlinked)).toEqual({
      status: "dropped",
      reason: "unidentified",
    });

    await revokeSlackInstallation(db, key);
    expect(await resolveSlackEventAgent(db, key)).toEqual({
      status: "dropped",
      reason: "installation_revoked",
    });
    // Reinstalled, not yet verified.
    await registerSlackInstallation(db, { ...key, workspaceId });
    expect(await resolveSlackEventAgent(db, key)).toEqual({
      status: "dropped",
      reason: "installation_unverified",
    });
    // Verified as another bot: the pinned identity no longer matches.
    await verifySlackInstallation(db, { ...key, botUserId: "B0NEWBOT" });
    expect(await resolveSlackEventAgent(db, key)).toEqual({
      status: "dropped",
      reason: "bot_mismatch",
    });
    // Verified as the same bot again: the identity resolves once more.
    await verifySlackInstallation(db, { ...key, botUserId: "B0BOT" });
    expect(await resolveSlackEventAgent(db, key)).toMatchObject({
      status: "resolved",
      agentId,
    });
  });

  test("an unverified install, or one in another workspace, cannot be linked", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentId = await agent(workspaceId);
    const pending = {
      appId: `A${randomUUID().slice(0, 8).toUpperCase()}`,
      teamId: "T0PENDING",
    };
    await registerSlackInstallation(db, { ...pending, workspaceId });
    expect((await linkAs(owner, agentId, pending)).outcome).toBe(
      "not_installed",
    );

    const elsewhere = await installed(await workspace());
    expect((await linkAs(owner, agentId, elsewhere)).outcome).toBe(
      "not_installed",
    );
    expect(
      (await linkAs(owner, agentId, { appId: "A0NONE", teamId: "T0NONE" }))
        .outcome,
    ).toBe("not_installed");
  });

  test("the table refuses a row naming another workspace's agent or install", async () => {
    const mine = await workspace();
    const theirs = await workspace();
    const agentId = await agent(mine);
    const key = await installed(theirs);
    const [installation] = await db
      .select({ id: schema.slackInstallations.id })
      .from(schema.slackInstallations)
      .where(eq(schema.slackInstallations.appId, key.appId));

    const message = await refusal(
      db.insert(agentIdentities).values({
        id: randomUUID(),
        workspaceId: mine,
        agentId,
        provider: "slack_bot",
        installationId: installation?.id ?? "",
        externalPrincipalId: "B0BOT",
        credentialRef: "slack-bot-token",
      }),
    );
    expect(message).toContain("agent_identities_installation_fk");

    const ownKey = await installed(mine);
    const [own] = await db
      .select({ id: schema.slackInstallations.id })
      .from(schema.slackInstallations)
      .where(eq(schema.slackInstallations.appId, ownKey.appId));
    expect(
      await refusal(
        db.insert(agentIdentities).values({
          id: randomUUID(),
          workspaceId: mine,
          agentId,
          provider: "slack_bot",
          installationId: own?.id ?? "",
          externalPrincipalId: "B0BOT",
          credentialRef: "Has Spaces",
        }),
      ),
    ).toContain("agent_identities_credential_ref_check");
  });

  test("the bot token's name is the identity's alone, both ways, until it is revoked", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const research = await agent(workspaceId);
    const finance = await agent(workspaceId);
    const bindToAgent = (credentialRef: string) =>
      db.transaction((tx) =>
        bindCredentialRef(tx, {
          id: randomUUID(),
          workspaceId,
          credentialRef,
          target: "agent",
          targetId: finance,
          boundBy: owner.actor?.userId ?? "",
        }),
      );

    // A name an agent already holds cannot become a bot token's.
    expect((await bindToAgent("notion-token")).outcome).toBe("bound");
    const app = await installed(workspaceId);
    expect(await linkAs(owner, research, app, "notion-token")).toEqual({
      outcome: "credential_ref_in_use",
    });
    expect(
      await db
        .select()
        .from(agentIdentities)
        .where(eq(agentIdentities.workspaceId, workspaceId)),
    ).toEqual([]);

    // Nor can another identity's, and a linked one cannot go to an agent.
    const linked = await linkAs(owner, research, app, "slack/research-bot");
    if (linked.outcome !== "linked") throw new Error(linked.outcome);
    const other = await installed(workspaceId, "B0OTHER");
    expect(await linkAs(owner, finance, other, "slack/research-bot")).toEqual({
      outcome: "credential_ref_in_use",
    });
    expect((await bindToAgent("slack/research-bot")).outcome).toBe(
      "ref_in_use",
    );
    const [binding] = await db
      .select({
        target: credentialBindings.target,
        targetId: credentialBindings.targetId,
        boundBy: credentialBindings.boundBy,
      })
      .from(credentialBindings)
      .where(eq(credentialBindings.credentialRef, "slack/research-bot"));
    expect(binding).toEqual({
      target: "agent_identity",
      targetId: linked.identity.id,
      boundBy: owner.actor?.userId ?? "",
    });

    // Revoking the identity frees the name.
    await revokeAs(owner, research, linked.identity.id);
    expect((await bindToAgent("slack/research-bot")).outcome).toBe("bound");
  });

  test("owner, admin and the agent's admin link; another member is outranked", async () => {
    const workspaceId = await workspace();
    const admin = await person(workspaceId, "admin");
    const manager = await person(workspaceId, "member");
    const other = await person(workspaceId, "member");
    const agentId = await agent(workspaceId, manager);

    const refused = await linkAs(other, agentId, await installed(workspaceId));
    expect(refused.outcome).toBe("outranked");

    const byManager = await linkAs(
      manager,
      agentId,
      await installed(workspaceId),
    );
    expect(byManager.outcome).toBe("linked");
    if (byManager.outcome !== "linked") return;
    expect(
      (await revokeAs(other, agentId, byManager.identity.id)).outcome,
    ).toBe("outranked");
    expect(
      (
        await linkAs(
          admin,
          agentId,
          await installed(workspaceId),
          "slack-second-bot-token",
        )
      ).outcome,
    ).toBe("linked");

    // The right is read again inside the transaction: a manager removed
    // after the policy's decision is refused.
    await db
      .delete(agentAdmins)
      .where(
        and(
          eq(agentAdmins.agentId, agentId),
          eq(agentAdmins.userId, manager.actor?.userId ?? ""),
        ),
      );
    expect(
      (await revokeAs(manager, agentId, byManager.identity.id)).outcome,
    ).toBe("outranked");
    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, admin.actor?.userId ?? ""));
    expect(
      (await revokeAs(admin, agentId, byManager.identity.id)).outcome,
    ).toBe("actor_inactive");
  });

  test("an archived agent cannot be linked, and its app's events are dropped", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentId = await agent(workspaceId);
    const key = await installed(workspaceId);
    expect((await linkAs(owner, agentId, key)).outcome).toBe("linked");

    await db
      .update(agents)
      .set({ status: "archived" })
      .where(eq(agents.id, agentId));

    expect(await resolveSlackEventAgent(db, key)).toEqual({
      status: "dropped",
      reason: "agent_archived",
    });
    expect(
      (await linkAs(owner, agentId, await installed(workspaceId))).outcome,
    ).toBe("agent_not_found");
    expect(
      (await linkAs(owner, randomUUID(), await installed(workspaceId))).outcome,
    ).toBe("agent_not_found");
  });

  test("lists an agent's identities, active first, and revokes only within its agent", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const agentId = await agent(workspaceId);
    const otherAgent = await agent(workspaceId);
    const old = await linkAs(owner, agentId, await installed(workspaceId));
    if (old.outcome !== "linked") throw new Error(old.outcome);
    await revokeAs(owner, agentId, old.identity.id);
    const current = await linkAs(owner, agentId, await installed(workspaceId));
    if (current.outcome !== "linked") throw new Error(current.outcome);

    const listed = await store().list(workspaceId, agentId, 50);
    expect(listed.map((row) => [row.id, row.status])).toEqual([
      [current.identity.id, "active"],
      [old.identity.id, "revoked"],
    ]);
    expect(await store().list(workspaceId, otherAgent, 50)).toEqual([]);
    expect(await store().list(await workspace(), agentId, 50)).toEqual([]);
    expect(
      (await revokeAs(owner, otherAgent, current.identity.id)).outcome,
    ).toBe("not_found");
    expect((await revokeAs(owner, agentId, "not-a-uuid")).outcome).toBe(
      "not_found",
    );
  });

  describe("Slack takes the install away (94S-1359)", () => {
    const installs = () => createPostgresSlackInstallStore(db);

    async function linkedAgent() {
      const workspaceId = await workspace();
      const owner = await person(workspaceId, "owner");
      const agentId = await agent(workspaceId);
      const key = await installed(workspaceId);
      const credentialRef = `slack/${randomUUID().slice(0, 8)}`;
      const linked = await linkAs(owner, agentId, key, credentialRef);
      if (linked.outcome !== "linked") throw new Error(linked.outcome);
      return { workspaceId, owner, agentId, key, credentialRef, linked };
    }

    const identityRow = async (id: string) => {
      const [row] = await db
        .select({
          status: agentIdentities.status,
          revision: agentIdentities.revision,
          revokedAt: agentIdentities.revokedAt,
          revokedBy: agentIdentities.revokedBy,
        })
        .from(agentIdentities)
        .where(eq(agentIdentities.id, id));
      return row;
    };

    test("the uninstall event revokes the identity with the install and frees its credential name", async () => {
      const { workspaceId, agentId, key, credentialRef, linked } =
        await linkedAgent();
      const binding = await db
        .insert(surfaceBindings)
        .values({
          id: randomUUID(),
          workspaceId,
          agentId,
          installationId: linked.identity.installationId,
          surfaceKind: "public_channel",
          externalSurfaceId: "C0HOME",
          mode: "on",
          ceilingActions: [],
          ceilingDisclosure: "full",
          home: true,
        })
        .returning({ id: surfaceBindings.id });

      expect(await installs().revokeInstallation(key)).toBe("revoked");

      expect(await identityRow(linked.identity.id)).toMatchObject({
        status: "revoked",
        revision: 2,
        revokedBy: null,
      });
      expect((await identityRow(linked.identity.id))?.revokedAt).toBeInstanceOf(
        Date,
      );
      expect(
        (await store().list(workspaceId, agentId, 10)).map((r) => r.status),
      ).toEqual(["revoked"]);
      const [kept] = await db
        .select({ revokedAt: surfaceBindings.revokedAt })
        .from(surfaceBindings)
        .where(eq(surfaceBindings.id, binding[0]?.id ?? ""));
      expect(kept?.revokedAt).toBeInstanceOf(Date);
      const released = await db
        .select({ revokedAt: credentialBindings.revokedAt })
        .from(credentialBindings)
        .where(eq(credentialBindings.credentialRef, credentialRef));
      expect(released.map((row) => row.revokedAt instanceof Date)).toEqual([
        true,
      ]);
      expect(await resolveSlackEventAgent(db, key)).toEqual({
        status: "dropped",
        reason: "installation_revoked",
      });
    });

    test("a repeated or retried event changes nothing", async () => {
      const { workspaceId, agentId, key, linked } = await linkedAgent();
      await installs().revokeInstallation(key);
      const first = await identityRow(linked.identity.id);

      expect(await installs().revokeInstallation(key)).toBe("revoked");
      expect(await installs().revokeInstallation(key, new Date())).toBe(
        "revoked",
      );

      expect(await identityRow(linked.identity.id)).toEqual(first);
      expect(await store().list(workspaceId, agentId, 10)).toHaveLength(1);
    });

    test("an event sent before a reinstall leaves the new identity active", async () => {
      const { owner, agentId, key, linked } = await linkedAgent();
      const sent = new Date(Date.now() - 60_000);
      await installs().revokeInstallation(key);

      // Reinstall: the same install row reopens, the link makes a new row.
      await registerSlackInstallation(db, {
        ...key,
        workspaceId: owner.ownerId,
      });
      await verifySlackInstallation(db, { ...key, botUserId: "B0BOT" });
      const again = await linkAs(owner, agentId, key, "slack/reinstalled");
      if (again.outcome !== "linked") throw new Error(again.outcome);
      expect(again.identity.id).not.toBe(linked.identity.id);

      // The old event arrives late, and so does its retry.
      expect(await installs().revokeInstallation(key, sent)).toBe("superseded");
      expect(await installs().revokeInstallation(key, sent)).toBe("superseded");

      expect((await identityRow(again.identity.id))?.status).toBe("active");
      expect((await identityRow(linked.identity.id))?.status).toBe("revoked");
      expect(await resolveSlackEventAgent(db, key)).toMatchObject({
        status: "resolved",
        agentId,
        identity: { id: again.identity.id },
      });
      // The newest uninstall still takes it down again.
      expect(await installs().revokeInstallation(key)).toBe("revoked");
      expect((await identityRow(again.identity.id))?.status).toBe("revoked");
    });

    test("a revoke from a failed Slack call leaves an install verified after the call began", async () => {
      const { key, linked } = await linkedAgent();
      // The caller passes the call's start less a second.
      const began = new Date(Date.now() - 1000 - 30_000);
      expect(await installs().revokeInstallation(key, began)).toBe(
        "superseded",
      );
      expect((await identityRow(linked.identity.id))?.status).toBe("active");
      const later = new Date(Date.now() + 5_000);
      expect(await installs().revokeInstallation(key, later)).toBe("revoked");
      expect((await identityRow(linked.identity.id))?.status).toBe("revoked");
    });

    test("a channel binding write holding the identity does not deadlock with the revoke", async () => {
      const { workspaceId, agentId, key, linked } = await linkedAgent();
      let holding: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        holding = resolve;
      });
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // What the binding store does: the identity's share lock first, then
      // the insert, whose foreign key takes the install's key share.
      const binding = db.transaction(async (tx) => {
        await tx
          .select({ id: agentIdentities.id })
          .from(agentIdentities)
          .where(eq(agentIdentities.id, linked.identity.id))
          .for("share");
        holding();
        await gate;
        await tx.insert(surfaceBindings).values({
          id: randomUUID(),
          workspaceId,
          agentId,
          installationId: linked.identity.installationId,
          surfaceKind: "public_channel",
          externalSurfaceId: "C0RACE",
          mode: "on",
          ceilingActions: [],
          ceilingDisclosure: "full",
        });
      });
      await held;
      const revoking = installs().revokeInstallation(key);
      // Let the revoke reach its wait for the identity.
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();

      await binding;
      expect(await revoking).toBe("revoked");
      const rows = await db
        .select({ revokedAt: surfaceBindings.revokedAt })
        .from(surfaceBindings)
        .where(eq(surfaceBindings.externalSurfaceId, "C0RACE"));
      expect(rows.map((row) => row.revokedAt instanceof Date)).toEqual([true]);
    });

    test("an install revoked before this fix gets its identity on the next event", async () => {
      const { key, linked } = await linkedAgent();
      await revokeSlackInstallation(db, key);
      expect((await identityRow(linked.identity.id))?.status).toBe("active");

      expect(await installs().revokeInstallation(key)).toBe("revoked");

      expect((await identityRow(linked.identity.id))?.status).toBe("revoked");
    });

    test("an install that was never there is not found", async () => {
      expect(
        await installs().revokeInstallation({ appId: "A0NONE", teamId: "T0X" }),
      ).toBe("not_found");
    });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_SURFACE_CEILING,
  type SurfaceChannelKind,
  scopesForRole,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import { type Caller, callerFor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createDatabaseAgentAuthority } from "./agent-authority.ts";
import { createPostgresAgentIdentityStore } from "./agent-identities.ts";
import * as schema from "./schema.ts";
import {
  agents,
  memberships,
  receipts,
  surfaceBindings,
  users,
  workspaces,
} from "./schema.ts";
import {
  registerSlackInstallation,
  verifySlackInstallation,
} from "./slack-installations.ts";
import { createPostgresSurfaceBindingStore } from "./surface-bindings.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const MANAGERS: readonly WorkspaceRole[] = ["owner", "admin"];

async function refusal(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    return String((error as { cause?: Error }).cause?.message ?? error);
  }
  return "accepted";
}

integration("surface bindings on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "surface_bindings_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresSurfaceBindingStore(db);

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

  // An agent linked to its own Slack app; fixture ids shaped like Slack's.
  async function slackAgent(owner: Caller) {
    const workspaceId = owner.ownerId;
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "bot",
    });
    const key = {
      appId: `A${randomUUID().slice(0, 8).toUpperCase()}`,
      teamId: `T${randomUUID().slice(0, 8).toUpperCase()}`,
    };
    await registerSlackInstallation(db, { ...key, workspaceId });
    await verifySlackInstallation(db, { ...key, botUserId: "B0BOT" });
    const linked = await createPostgresAgentIdentityStore(db).link({
      principal: owner,
      workspaceId,
      agentId,
      key,
      credentialRef: `slack-bot-${agentId.slice(0, 8)}`,
      managerRoles: MANAGERS,
    });
    if (linked.outcome !== "linked") throw new Error(linked.outcome);
    return {
      agentId,
      key,
      identityId: linked.identity.id,
      installationId: linked.identity.installationId,
    };
  }

  const setAs = (
    caller: Caller,
    agentId: string,
    channel: {
      channelId: string | null;
      channelKind?: SurfaceChannelKind;
      mode?: "off" | "on";
      home?: boolean;
    },
  ) =>
    store().set({
      principal: caller,
      workspaceId: caller.ownerId,
      agentId,
      channelId: channel.channelId,
      channelKind:
        channel.channelKind ??
        (channel.channelId === null ? "dm" : "public_channel"),
      mode: channel.mode ?? "on",
      home: channel.home ?? false,
      ceiling: DEFAULT_SURFACE_CEILING,
      managerRoles: MANAGERS,
    });

  test("a channel's binding is stored, resolved and replaced in place", async () => {
    const owner = await person(await workspace(), "owner");
    const { agentId, installationId } = await slackAgent(owner);

    const first = await setAs(owner, agentId, {
      channelId: "C0TEST",
      home: true,
    });
    expect(first.outcome).toBe("set");
    if (first.outcome !== "set") return;
    expect(first.binding).toMatchObject({
      agentId,
      installationId,
      channelId: "C0TEST",
      channelKind: "public_channel",
      mode: "on",
      home: true,
      ceiling: DEFAULT_SURFACE_CEILING,
      status: "ready",
      revision: 1,
    });
    expect(await store().resolveSlackChannel(installationId, "C0TEST")).toEqual(
      first.binding,
    );

    const off = await setAs(owner, agentId, {
      channelId: "C0TEST",
      mode: "off",
    });
    expect(off).toMatchObject({
      outcome: "set",
      binding: { id: first.binding.id, mode: "off", home: false, revision: 2 },
    });
    const [receipt] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, off.outcome === "set" ? off.receiptId : ""));
    expect(receipt).toMatchObject({
      operation: "set_surface_binding",
      targetRef: {
        resource: { kind: "surface_binding", id: first.binding.id },
      },
      result: { mode: "off", channel_id: "C0TEST", revision: 2 },
    });
  });

  test("agentOf a binding is its agent, and nobody's from another workspace", async () => {
    const owner = await person(await workspace(), "owner");
    const { agentId } = await slackAgent(owner);
    const set = await setAs(owner, agentId, { channelId: "C0AGENT" });
    if (set.outcome !== "set") throw new Error(set.outcome);
    const authority = createDatabaseAgentAuthority(db);
    const resource = { kind: "surface_binding" as const, id: set.binding.id };

    expect(await authority.agentOf(owner.ownerId, resource)).toBe(agentId);
    expect(await authority.agentOf(await workspace(), resource)).toBeNull();
    expect(
      await authority.agentOf(owner.ownerId, {
        kind: "surface_binding",
        id: randomUUID(),
      }),
    ).toBeNull();
  });

  test("a channel and an install's DMs have one live binding each", async () => {
    const owner = await person(await workspace(), "owner");
    const { agentId, installationId } = await slackAgent(owner);
    const row = (externalSurfaceId: string | null) => ({
      id: randomUUID(),
      workspaceId: owner.ownerId,
      agentId,
      installationId,
      externalSurfaceId,
      surfaceKind: (externalSurfaceId === null
        ? "dm"
        : "private_channel") as SurfaceChannelKind,
      mode: "on" as const,
      ceilingActions: ["session.read"],
      ceilingDisclosure: "full" as const,
    });

    await db.insert(surfaceBindings).values(row("C0DUP"));
    expect(
      await refusal(db.insert(surfaceBindings).values(row("C0DUP"))),
    ).toContain("surface_bindings_channel_live_uniq");
    await db.insert(surfaceBindings).values(row(null));
    expect(
      await refusal(db.insert(surfaceBindings).values(row(null))),
    ).toContain("surface_bindings_dm_live_uniq");
    // Through the store the DM row is found again, not added twice.
    const dm = await setAs(owner, agentId, { channelId: null });
    expect(dm).toMatchObject({
      outcome: "set",
      binding: { channelId: null, channelKind: "dm", revision: 2 },
    });
    // A revoked row frees its channel for a new one.
    await db
      .update(surfaceBindings)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(surfaceBindings.externalSurfaceId, "C0DUP"));
    await db.insert(surfaceBindings).values(row("C0DUP"));
  });

  test("an agent has one home: setting another moves it", async () => {
    const owner = await person(await workspace(), "owner");
    const { agentId, installationId } = await slackAgent(owner);
    const first = await setAs(owner, agentId, {
      channelId: "C0HOME1",
      home: true,
    });
    const second = await setAs(owner, agentId, {
      channelId: "C0HOME2",
      home: true,
    });
    expect(second).toMatchObject({ outcome: "set", binding: { home: true } });
    expect(
      await store().resolveSlackChannel(installationId, "C0HOME1"),
    ).toMatchObject({ home: false, revision: 2 });
    const listed = await store().list(owner.ownerId, agentId, 10);
    expect(listed.map((b) => [b.channelId, b.home])).toEqual([
      ["C0HOME2", true],
      ["C0HOME1", false],
    ]);
    // Written around the store, a second home is a unique violation.
    expect(
      await refusal(
        db
          .update(surfaceBindings)
          .set({ home: true })
          .where(
            eq(
              surfaceBindings.id,
              first.outcome === "set" ? first.binding.id : "",
            ),
          ),
      ),
    ).toContain("surface_bindings_home_live_uniq");
    // A DM is nobody's channel, so never home.
    expect(
      await refusal(
        db.insert(surfaceBindings).values({
          id: randomUUID(),
          workspaceId: owner.ownerId,
          agentId: (await slackAgent(owner)).agentId,
          installationId,
          surfaceKind: "dm",
          mode: "on",
          home: true,
          ceilingActions: [],
          ceilingDisclosure: "full",
        }),
      ),
    ).toContain("surface_bindings_dm_check");
  });

  test("a binding needs the agent's live identity and the caller's right", async () => {
    const workspaceId = await workspace();
    const owner = await person(workspaceId, "owner");
    const member = await person(workspaceId, "member");
    const { agentId } = await slackAgent(owner);
    const unlinked = randomUUID();
    await db.insert(agents).values({
      id: unlinked,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${unlinked.slice(0, 8)}`,
      name: "bot",
    });

    expect(await setAs(member, agentId, { channelId: "C0X" })).toEqual({
      outcome: "outranked",
    });
    expect(await setAs(owner, unlinked, { channelId: "C0X" })).toEqual({
      outcome: "not_installed",
    });
    const stranger = await person(await workspace(), "owner");
    expect(await setAs(stranger, agentId, { channelId: "C0X" })).toEqual({
      outcome: "agent_not_found",
    });
  });

  test("an install linked to another agent starts with none of the old agent's channels", async () => {
    const owner = await person(await workspace(), "owner");
    const first = await slackAgent(owner);
    await setAs(owner, first.agentId, { channelId: "C0X", home: true });
    await setAs(owner, first.agentId, { channelId: null });
    const identities = createPostgresAgentIdentityStore(db);
    await identities.revoke({
      principal: owner,
      workspaceId: owner.ownerId,
      agentId: first.agentId,
      identityId: first.identityId,
      managerRoles: MANAGERS,
    });
    expect(
      await store().resolveSlackChannel(first.installationId, "C0X"),
    ).toBeNull();
    expect(await store().list(owner.ownerId, first.agentId, 10)).toEqual([]);

    const next = randomUUID();
    await db.insert(agents).values({
      id: next,
      workspaceId: owner.ownerId,
      managingTeamId: await fixtureTeam(db, owner.ownerId),
      slug: `a-${next.slice(0, 8)}`,
      name: "bot",
    });
    const relinked = await identities.link({
      principal: owner,
      workspaceId: owner.ownerId,
      agentId: next,
      key: first.key,
      credentialRef: `slack-bot-${next.slice(0, 8)}`,
      managerRoles: MANAGERS,
    });
    expect(relinked.outcome).toBe("linked");
    const set = await setAs(owner, next, { channelId: "C0X", mode: "off" });
    expect(set).toMatchObject({
      outcome: "set",
      binding: { agentId: next, mode: "off", revision: 1 },
    });

    // A live row another agent kept from before is never rewritten.
    await db
      .update(surfaceBindings)
      .set({ agentId: first.agentId })
      .where(
        eq(surfaceBindings.id, set.outcome === "set" ? set.binding.id : ""),
      );
    expect(await setAs(owner, next, { channelId: "C0X" })).toEqual({
      outcome: "conflict",
    });
  });

  test("an invite binds an unbound channel once and leaves a bound one as it is", async () => {
    const owner = await person(await workspace(), "owner");
    const { agentId, installationId } = await slackAgent(owner);
    const invited = await store().ensureInvitedChannel(
      installationId,
      "G0INVITE",
      "private_channel",
    );
    expect(invited).toMatchObject({
      agentId,
      channelId: "G0INVITE",
      channelKind: "private_channel",
      status: "pending_approval",
      approvedAt: null,
      mode: "on",
      home: false,
      ceiling: DEFAULT_SURFACE_CEILING,
      membership: { state: "joined" },
      revision: 1,
    });
    expect(
      await store().ensureInvitedChannel(
        installationId,
        "G0INVITE",
        "private_channel",
      ),
    ).toEqual(invited);
    // Nobody set it, so nothing was receipted.
    const written = await db
      .select()
      .from(receipts)
      .where(eq(receipts.operation, "set_surface_binding"));
    expect(
      written.filter(
        (receipt) =>
          (receipt.targetRef as { resource?: { id?: string } }).resource?.id ===
          invited?.id,
      ),
    ).toEqual([]);

    await setAs(owner, agentId, { channelId: "C0OFF", mode: "off" });
    expect(
      await store().ensureInvitedChannel(
        installationId,
        "C0OFF",
        "public_channel",
      ),
    ).toMatchObject({ channelId: "C0OFF", mode: "off", revision: 1 });
    expect(await store().list(owner.ownerId, agentId, 10)).toHaveLength(2);
    expect(
      await store().ensureInvitedChannel(
        randomUUID(),
        "C0NONE",
        "public_channel",
      ),
    ).toBeNull();
  });

  describe("a private channel waits for an owner or admin", () => {
    const approve = (
      caller: Caller,
      agentId: string,
      bindingId: string,
      revision: number,
    ) =>
      store().approve({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        bindingId,
        revision,
        approverRoles: ["owner", "admin"],
      });
    const reject = (
      caller: Caller,
      agentId: string,
      bindingId: string,
      revision: number,
    ) =>
      store().reject({
        principal: caller,
        workspaceId: caller.ownerId,
        agentId,
        bindingId,
        revision,
        approverRoles: ["owner", "admin"],
      });

    async function waiting() {
      const owner = await person(await workspace(), "owner");
      const world = await slackAgent(owner);
      const saved = await setAs(owner, world.agentId, {
        channelId: "G0SECRET",
        channelKind: "private_channel",
      });
      if (saved.outcome !== "set") throw new Error(saved.outcome);
      return { owner, ...world, binding: saved.binding };
    }

    const operations = async (bindingId: string) =>
      (await db.select().from(receipts))
        .filter(
          (receipt) =>
            (receipt.targetRef as { resource?: { id?: string } }).resource
              ?.id === bindingId,
        )
        .map((receipt) => receipt.operation)
        .sort();

    test("a new private channel is saved waiting, with a set and a request receipt, and input does not resolve it", async () => {
      const { installationId, binding } = await waiting();
      expect(binding).toMatchObject({
        status: "pending_approval",
        approvedAt: null,
        channelKind: "private_channel",
        home: false,
        revision: 1,
      });
      expect(await operations(binding.id)).toEqual([
        "request_surface_binding",
        "set_surface_binding",
      ]);
      expect(
        await store().resolveSlackChannel(installationId, "G0SECRET"),
      ).toBeNull();
      expect(
        await store().findPendingApproval(installationId, "G0SECRET"),
      ).toEqual({ id: binding.id, revision: 1 });
      expect(
        await store().findLiveSlackChannel(installationId, "G0SECRET"),
      ).toEqual(binding);
    });

    test("saving a public channel stays ready; a pending one stays pending when edited", async () => {
      const { owner, agentId, installationId, binding } = await waiting();
      const open = await setAs(owner, agentId, { channelId: "C0OPEN" });
      expect(open).toMatchObject({
        outcome: "set",
        binding: { status: "ready" },
      });
      const edited = await setAs(owner, agentId, {
        channelId: "G0SECRET",
        channelKind: "private_channel",
        mode: "off",
      });
      expect(edited).toMatchObject({
        outcome: "set",
        binding: { id: binding.id, status: "pending_approval", revision: 2 },
      });
      expect(await operations(binding.id)).toEqual([
        "request_surface_binding",
        "set_surface_binding",
        "set_surface_binding",
      ]);
      expect(
        await store().resolveSlackChannel(installationId, "C0OPEN"),
      ).not.toBeNull();
    });

    test("a waiting channel cannot be the home, and the refusal leaves the old home alone", async () => {
      const { owner, agentId } = await waiting();
      await setAs(owner, agentId, { channelId: "C0HOME", home: true });
      expect(
        await setAs(owner, agentId, {
          channelId: "G0SECRET",
          channelKind: "private_channel",
          home: true,
        }),
      ).toEqual({ outcome: "pending_home" });
      expect((await store().list(owner.ownerId, agentId, 10))[0]).toMatchObject(
        { channelId: "C0HOME", home: true },
      );
      expect(
        await refusal(
          db
            .update(surfaceBindings)
            .set({ home: true })
            .where(eq(surfaceBindings.externalSurfaceId, "G0SECRET")),
        ),
      ).toContain("surface_bindings_pending_check");
    });

    test("approving makes it ready, stamps approved_at, bumps the revision and receipts the decision", async () => {
      const { owner, agentId, installationId, binding } = await waiting();
      const done = await approve(owner, agentId, binding.id, 1);
      expect(done).toMatchObject({
        outcome: "resolved",
        binding: { status: "ready", revision: 2 },
      });
      if (done.outcome !== "resolved") return;
      expect(done.binding.approvedAt).toBeInstanceOf(Date);
      expect(
        await store().resolveSlackChannel(installationId, "G0SECRET"),
      ).toEqual(done.binding);
      const [receipt] = await db
        .select()
        .from(receipts)
        .where(eq(receipts.id, done.receiptId));
      expect(receipt).toMatchObject({
        operation: "resolve_surface_binding",
        result: {
          decision: "approve",
          requested_by_user_id: owner.actor?.userId,
          revision: 2,
        },
      });
    });

    test("rejecting revokes it, frees the slot, and the bot is not asked to leave", async () => {
      const { owner, agentId, installationId, binding } = await waiting();
      const done = await reject(owner, agentId, binding.id, 1);
      expect(done).toMatchObject({
        outcome: "resolved",
        binding: { status: "revoked", revision: 2 },
      });
      expect(
        await store().findLiveSlackChannel(installationId, "G0SECRET"),
      ).toBeNull();
      const again = await setAs(owner, agentId, {
        channelId: "G0SECRET",
        channelKind: "private_channel",
      });
      expect(again).toMatchObject({
        outcome: "set",
        binding: { status: "pending_approval", revision: 1 },
      });
      if (again.outcome === "set") {
        expect(again.binding.id).not.toBe(binding.id);
      }
    });

    test("the same decision again replays with no new receipt; the other one, or a stale revision, is a conflict", async () => {
      const { owner, agentId, binding } = await waiting();
      const first = await approve(owner, agentId, binding.id, 1);
      expect(first.outcome).toBe("resolved");
      const before = await operations(binding.id);
      expect(await approve(owner, agentId, binding.id, 1)).toMatchObject({
        outcome: "replayed",
        binding: { status: "ready", revision: 2 },
      });
      expect(await operations(binding.id)).toEqual(before);
      expect(await reject(owner, agentId, binding.id, 1)).toEqual({
        outcome: "conflict",
      });
      expect(await approve(owner, agentId, binding.id, 0)).toEqual({
        outcome: "conflict",
      });

      const other = await waiting();
      expect(
        await approve(other.owner, other.agentId, other.binding.id, 7),
      ).toEqual({ outcome: "conflict" });
    });

    test("approve and reject racing take exactly one decision", async () => {
      const { owner, agentId, binding } = await waiting();
      const results = await Promise.all([
        approve(owner, agentId, binding.id, 1),
        reject(owner, agentId, binding.id, 1),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual([
        "conflict",
        "resolved",
      ]);
      expect(
        (await operations(binding.id)).filter(
          (operation) => operation === "resolve_surface_binding",
        ),
      ).toHaveLength(1);
    });

    test("only a workspace owner or admin decides: an agent admin who asked, a member and a stranger cannot", async () => {
      const { owner, agentId, binding } = await waiting();
      const workspaceId = owner.ownerId;
      const member = await person(workspaceId, "member");
      await db
        .insert(schema.agentAdmins)
        .values({ workspaceId, agentId, userId: member.actor?.userId ?? "" });
      expect(await approve(member, agentId, binding.id, 1)).toEqual({
        outcome: "outranked",
      });
      const stranger = await person(await workspace(), "owner");
      expect(
        await store().approve({
          principal: stranger,
          workspaceId,
          agentId,
          bindingId: binding.id,
          revision: 1,
          approverRoles: ["owner", "admin"],
        }),
      ).toEqual({ outcome: "actor_inactive" });
      const admin = await person(workspaceId, "admin");
      expect(await approve(admin, agentId, binding.id, 1)).toMatchObject({
        outcome: "resolved",
      });
    });

    test("an approver demoted after the policy decided is refused when the transaction reads the role", async () => {
      const { owner, agentId, installationId, binding } = await waiting();
      const admin = await person(owner.ownerId, "admin");
      await db
        .update(memberships)
        .set({ role: "member" })
        .where(eq(memberships.userId, admin.actor?.userId ?? ""));
      expect(await approve(admin, agentId, binding.id, 1)).toEqual({
        outcome: "outranked",
      });
      expect(
        await store().findPendingApproval(installationId, "G0SECRET"),
      ).not.toBeNull();
    });

    test("a binding of another agent or workspace, or an unknown id, is not found", async () => {
      const { owner, agentId, binding } = await waiting();
      const elsewhere = await waiting();
      expect(await approve(owner, elsewhere.agentId, binding.id, 1)).toEqual({
        outcome: "not_found",
      });
      expect(await approve(owner, agentId, randomUUID(), 1)).toEqual({
        outcome: "not_found",
      });
      expect(await approve(owner, "not-a-uuid", binding.id, 1)).toEqual({
        outcome: "not_found",
      });
    });

    test("an invite makes a private channel wait, once, with an installation receipt; a bound channel is returned as it is", async () => {
      const owner = await person(await workspace(), "owner");
      const { installationId } = await slackAgent(owner);
      const first = await store().ensureInvitedChannel(
        installationId,
        "G0INVITED",
        "private_channel",
      );
      expect(first).toMatchObject({ status: "pending_approval" });
      const again = await store().ensureInvitedChannel(
        installationId,
        "G0INVITED",
        "private_channel",
      );
      expect(again).toEqual(first);
      const [request] = (await db.select().from(receipts)).filter(
        (receipt) =>
          receipt.operation === "request_surface_binding" &&
          (receipt.targetRef as { resource?: { id?: string } }).resource?.id ===
            first?.id,
      );
      expect(request).toMatchObject({
        actor: { principal: { kind: "installation", id: installationId } },
      });
      expect(await operations(first?.id ?? "")).toEqual([
        "request_surface_binding",
      ]);
      const open = await store().ensureInvitedChannel(
        installationId,
        "C0INVITED",
        "public_channel",
      );
      expect(open).toMatchObject({ status: "ready" });
    });

    test("a ready public channel that Slack calls private waits again, loses its home, and an approved private one is left alone", async () => {
      const owner = await person(await workspace(), "owner");
      const { agentId, installationId } = await slackAgent(owner);
      const open = await setAs(owner, agentId, {
        channelId: "C0TURNED",
        home: true,
      });
      if (open.outcome !== "set") throw new Error(open.outcome);
      const turned = await store().requireApproval(open.binding.id);
      expect(turned).toMatchObject({
        status: "pending_approval",
        channelKind: "private_channel",
        home: false,
        revision: 2,
      });
      expect(
        await store().resolveSlackChannel(installationId, "C0TURNED"),
      ).toBeNull();
      expect(await store().requireApproval(open.binding.id)).toBeNull();
      expect(await operations(open.binding.id)).toContain(
        "request_surface_binding",
      );
    });

    test("saving a channel bound as public with Slack's private kind waits again, whatever the old kind", async () => {
      const owner = await person(await workspace(), "owner");
      const { agentId } = await slackAgent(owner);
      await setAs(owner, agentId, { channelId: "G0KIND" });
      const redo = await setAs(owner, agentId, {
        channelId: "G0KIND",
        channelKind: "private_channel",
      });
      expect(redo).toMatchObject({
        outcome: "set",
        binding: { status: "pending_approval", channelKind: "private_channel" },
      });
    });

    test("an approved private channel keeps its approval through edits and an invite", async () => {
      const { owner, agentId, installationId, binding } = await waiting();
      await approve(owner, agentId, binding.id, 1);
      const edited = await setAs(owner, agentId, {
        channelId: "G0SECRET",
        channelKind: "private_channel",
        home: true,
      });
      expect(edited).toMatchObject({
        outcome: "set",
        binding: { status: "ready", home: true, revision: 3 },
      });
      expect(
        await store().ensureInvitedChannel(
          installationId,
          "G0SECRET",
          "private_channel",
        ),
      ).toMatchObject({ status: "ready", home: true });
    });
  });

  test("migration 0244 puts every live private binding to wait and leaves the others", async () => {
    const owner = await person(await workspace(), "owner");
    const { agentId, installationId } = await slackAgent(owner);
    const migrationSql = (
      await Bun.file(
        `${import.meta.dir}/../migrations/0244_slack_private_approval.sql`,
      ).text()
    )
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .find((statement) => statement.includes('UPDATE "surface_bindings"'));
    expect(migrationSql).toBeDefined();
    await db
      .update(surfaceBindings)
      .set({ status: "ready" })
      .where(eq(surfaceBindings.agentId, agentId));
    const rows = [
      ["G0OLDHOME", "private_channel", true, null],
      ["C0OLDOPEN", "public_channel", false, null],
      ["G0OLDGONE", "private_channel", false, new Date()],
    ] as const;
    await pool.query(
      "ALTER TABLE surface_bindings DROP CONSTRAINT surface_bindings_pending_check",
    );
    try {
      for (const [channelId, kind, home, revokedAt] of rows) {
        await db.insert(surfaceBindings).values({
          id: randomUUID(),
          workspaceId: owner.ownerId,
          agentId,
          surface: "slack",
          installationId,
          externalSurfaceId: channelId,
          surfaceKind: kind,
          mode: "on",
          ceilingActions: [...DEFAULT_SURFACE_CEILING.actions],
          ceilingDisclosure: "full",
          home,
          status: revokedAt === null ? "ready" : "revoked",
          revokedAt,
        });
      }
      await pool.query(migrationSql ?? "");
      const after = Object.fromEntries(
        (await db.select().from(surfaceBindings))
          .filter((row) => row.agentId === agentId)
          .map((row) => [row.externalSurfaceId, row]),
      );
      expect(after.G0OLDHOME).toMatchObject({
        status: "pending_approval",
        home: false,
        revision: 2,
      });
      expect(after.C0OLDOPEN).toMatchObject({ status: "ready", revision: 1 });
      expect(after.G0OLDGONE).toMatchObject({ status: "revoked", revision: 1 });
    } finally {
      await pool.query(
        "DELETE FROM surface_bindings WHERE agent_id = $1 AND external_surface_id IN ('G0OLDHOME','C0OLDOPEN','G0OLDGONE')",
        [agentId],
      );
      await pool.query(
        `ALTER TABLE surface_bindings ADD CONSTRAINT surface_bindings_pending_check CHECK ("status" <> 'pending_approval' OR ("surface" = 'slack' AND "installation_id" IS NOT NULL AND "external_surface_id" IS NOT NULL AND "surface_kind" = 'private_channel' AND NOT "home"))`,
      );
    }
  });

  test("a revoked or off binding is not what a channel resolves to", async () => {
    const owner = await person(await workspace(), "owner");
    const { agentId, installationId } = await slackAgent(owner);
    await setAs(owner, agentId, { channelId: "C0GONE" });
    await db
      .update(surfaceBindings)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(surfaceBindings.externalSurfaceId, "C0GONE"));

    expect(
      await store().resolveSlackChannel(installationId, "C0GONE"),
    ).toBeNull();
    expect(await store().resolveSlackChannel(installationId, null)).toBeNull();
    expect(await store().list(owner.ownerId, agentId, 10)).toEqual([]);
  });
});

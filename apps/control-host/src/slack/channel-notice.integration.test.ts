import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  enqueueSlackChannelNotices,
  SLACK_CHANNEL_NOTICE_LINES,
} from "@werft-ai/chat-slack";
import {
  type SlackNoticeVersionEntry,
  slackNoticeVersionSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentIdentities,
  agents,
  approveSlackNotice,
  channelContexts,
  conversations,
  createPostgresSlackOutboxStore,
  type Database,
  memberships,
  revokeSlackNotice,
  SLACK_CHANNEL_NOTICE_ATTEMPTS,
  setConversationRollout,
  slackApps,
  slackInstallations,
  slackOutbox,
  surfaceBindings,
  unnoticedSlackChannels,
  users,
  workspaces,
} from "@werft-ai/db";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { Pool } from "pg";

// The channel notice's sweep (a1/N4) over the real outbox store: the pass
// the `slack` role's drain runs, given the notice versions it reads.

const TEXT = {
  body: ["notice"],
  policyLink: { label: "policy", href: "https://docs.example.test/data" },
};
const entry = (
  version: number,
  requiresReapproval: boolean,
): SlackNoticeVersionEntry => ({
  version: slackNoticeVersionSchema.parse(version),
  text: { ko: TEXT, ja: TEXT },
  requiresReapproval,
});
const V1 = [entry(1, true)];
/** Version 2 only rewords version 1. */
const V2 = [...V1, entry(2, false)];
/** Version 3 asks for a new approval. */
const V3 = [...V2, entry(3, true)];

const ENGINE = testDatabaseUrl() ? "PostgreSQL" : "PGlite";

describe(`channel notice sweep on ${ENGINE}`, () => {
  let db: Database;
  let close = async () => {};
  let counter = 0;

  beforeAll(async () => {
    if (ENGINE === "PGlite") {
      const client = await migratedPGlite();
      db = drizzle(client, { schema }) as unknown as Database;
      close = () => client.close();
    } else {
      const database = await createTempDatabase({ prefix: "channel_notice" });
      const pool = new Pool({ connectionString: database.url, max: 4 });
      db = drizzlePostgres(pool, { schema }) as unknown as Database;
      close = async () => {
        await pool.end();
        await database.drop();
      };
    }
  }, 120_000);
  afterAll(() => close(), 60_000);

  /** An agent with its app installed in one Slack team, and an admin. */
  async function slackAgent() {
    counter += 1;
    const workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${counter}`, name: "ws" });
    const admin = randomUUID();
    await db.insert(users).values({
      id: admin,
      email: `${admin}@example.invalid`,
      displayName: "admin",
    });
    await db
      .insert(memberships)
      .values({ workspaceId, userId: admin, role: "admin" });
    const teamId = randomUUID();
    await db
      .insert(schema.memberTeams)
      .values({ id: teamId, workspaceId, name: "t" });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: teamId,
      slug: `agent-${counter}`,
      name: "Notes",
      status: "active",
    });
    const appId = `A0NOTICE${counter}`;
    const slackAppId = randomUUID();
    await db.insert(slackApps).values({
      id: slackAppId,
      workspaceId,
      kind: "agent",
      agentId,
      state: "created",
      appId,
      clientId: `${counter}.1`,
      redirectUrl: "https://console.example/cb",
    });
    const slackTeam = `T0NOTICE${counter}`;
    const installationId = randomUUID();
    await db
      .insert(slackInstallations)
      .values({ id: installationId, workspaceId, appId, teamId: slackTeam });
    await db.insert(agentIdentities).values({
      id: randomUUID(),
      workspaceId,
      agentId,
      provider: "slack_bot",
      installationId,
      externalPrincipalId: `U0BOT${counter}`,
      credentialRef: `slack/bot-${counter}`,
    });
    const place = { workspaceId, agentId };
    return {
      ...place,
      slackAppId,
      installationId,
      slackTeam,
      approve: (versions: readonly SlackNoticeVersionEntry[]) =>
        approveSlackNotice(db, { ...place, by: admin, locale: "ko" }, versions),
      revoke: () => revokeSlackNotice(db, { ...place, by: admin }),
      rollout: (
        rollout: "off" | "shadow",
        versions: readonly SlackNoticeVersionEntry[],
      ) =>
        setConversationRollout(
          db,
          { ...place, rollout, by: "operator_cli" },
          versions,
        ),
    };
  }
  type SlackAgent = Awaited<ReturnType<typeof slackAgent>>;

  /** A channel bound `on`, listening `free`, with the bot in it. */
  async function channel(
    agent: SlackAgent,
    overrides: Partial<typeof surfaceBindings.$inferInsert> = {},
  ) {
    counter += 1;
    const id = randomUUID();
    const channelId = `C0NOTICE${counter}`;
    await db.insert(surfaceBindings).values({
      id,
      workspaceId: agent.workspaceId,
      agentId: agent.agentId,
      installationId: agent.installationId,
      externalSurfaceId: channelId,
      surfaceKind: "public_channel",
      mode: "on",
      listen: "free",
      ceilingActions: ["session.read"],
      ceilingDisclosure: "full",
      membership: "joined",
      ...overrides,
    });
    const set = (values: Partial<typeof surfaceBindings.$inferInsert>) =>
      db.update(surfaceBindings).set(values).where(eq(surfaceBindings.id, id));
    return { id, channelId, set };
  }

  /** An agent listening under V1: approved and raised to `shadow`. */
  async function listening() {
    const agent = await slackAgent();
    await agent.approve(V1);
    await agent.rollout("shadow", V1);
    return agent;
  }

  const pass = (versions: readonly SlackNoticeVersionEntry[], limit = 50) => {
    const store = createPostgresSlackOutboxStore(db);
    return enqueueSlackChannelNotices({
      outbox: {
        enqueue: (entry) => store.enqueue(entry),
        unnoticedChannels: (n) =>
          unnoticedSlackChannels(db, { limit: n, versions }),
      },
      limit,
    });
  };

  const noticesOf = (agentId: string) =>
    db
      .select({
        channelId: slackOutbox.channelId,
        threadTs: slackOutbox.threadTs,
        body: slackOutbox.body,
        dedupeKey: slackOutbox.dedupeKey,
        status: slackOutbox.status,
      })
      .from(slackOutbox)
      .where(
        and(
          eq(slackOutbox.agentId, agentId),
          eq(slackOutbox.kind, "channel_notice"),
        ),
      )
      .orderBy(asc(slackOutbox.createdAt), asc(slackOutbox.dedupeKey));

  test("nothing is told before a notice is published", async () => {
    const agent = await listening();
    await channel(agent);
    // Raised by hand: with no notice, no path can raise it.
    await db
      .update(agents)
      .set({ conversationRollout: "shadow" })
      .where(eq(agents.id, agent.agentId));
    expect(
      await unnoticedSlackChannels(db, { limit: 10, versions: [] }),
    ).toEqual([]);
    expect(await noticesOf(agent.agentId)).toEqual([]);
  });

  test("the bot joining a channel it listens to tells it once", async () => {
    const agent = await listening();
    const c = await channel(agent, { membership: "awaiting_invite" });
    await pass(V1);
    expect(await noticesOf(agent.agentId)).toEqual([]);

    await c.set({ membership: "joined" });
    await pass(V1);
    await pass(V1);
    expect(await noticesOf(agent.agentId)).toEqual([
      {
        channelId: c.channelId,
        threadTs: "",
        body: { text: SLACK_CHANNEL_NOTICE_LINES.join("\n") },
        dedupeKey: `channel-notice:${agent.agentId}:${agent.slackTeam}:${c.channelId}:1`,
        status: "pending",
      },
    ] as never);
  });

  test("listening turned to free tells the channel once; off and on again adds nothing", async () => {
    const agent = await listening();
    const c = await channel(agent, { listen: "mention" });
    await pass(V1);
    expect(await noticesOf(agent.agentId)).toHaveLength(0);

    await c.set({ listen: "free" });
    await pass(V1);
    expect(await noticesOf(agent.agentId)).toHaveLength(1);

    await c.set({ listen: "off" });
    await pass(V1);
    await c.set({ listen: "free" });
    await pass(V1);
    expect(await noticesOf(agent.agentId)).toHaveLength(1);
  });

  test("raising the switch first tells every listened channel once; lowering and raising adds nothing", async () => {
    const agent = await slackAgent();
    await agent.approve(V1);
    const a = await channel(agent);
    const b = await channel(agent);
    await pass(V1);
    expect(await noticesOf(agent.agentId)).toHaveLength(0);

    expect((await agent.rollout("shadow", V1)).outcome).toBe("changed");
    await pass(V1);
    expect(
      (await noticesOf(agent.agentId)).map((row) => row.channelId).sort(),
    ).toEqual([a.channelId, b.channelId].sort());

    await agent.rollout("off", V1);
    await agent.rollout("shadow", V1);
    await pass(V1);
    expect(await noticesOf(agent.agentId)).toHaveLength(2);
  });

  test("a private channel is told once it is approved, not while it waits", async () => {
    const agent = await listening();
    const c = await channel(agent, {
      surfaceKind: "private_channel",
      status: "pending_approval",
    });
    await pass(V1);
    expect(await noticesOf(agent.agentId)).toHaveLength(0);

    await c.set({ status: "ready" });
    await pass(V1);
    expect(await noticesOf(agent.agentId)).toHaveLength(1);
  });

  test("a version that only rewords is not told again; one asking for approval is, once approved", async () => {
    const agent = await listening();
    const c = await channel(agent);
    await pass(V1);
    expect(await noticesOf(agent.agentId)).toHaveLength(1);

    // Approved again under the reworded version, or not: no new line.
    await pass(V2);
    await agent.approve(V2);
    await pass(V2);
    expect(await noticesOf(agent.agentId)).toHaveLength(1);

    // Version 3 counts no earlier approval: nothing until it is approved.
    await pass(V3);
    expect(await noticesOf(agent.agentId)).toHaveLength(1);
    await agent.approve(V3);
    await pass(V3);
    await pass(V3);
    expect(
      (await noticesOf(agent.agentId)).map((row) => row.dedupeKey),
    ).toEqual([
      `channel-notice:${agent.agentId}:${agent.slackTeam}:${c.channelId}:1`,
      `channel-notice:${agent.agentId}:${agent.slackTeam}:${c.channelId}:3`,
    ]);
  });

  test("no line where the agent does not read every message", async () => {
    const agent = await listening();
    await channel(agent, { listen: "mention" });
    await channel(agent, { listen: "off" });
    await channel(agent, { mode: "off" });
    // Shared with another organization: listening is held at mention, and
    // even a free row left over is not read.
    await channel(agent, { externalShared: true });
    await channel(agent, {
      surfaceKind: "private_channel",
      status: "left",
      membership: null,
    });
    await channel(agent, { membership: null });
    const archived = await channel(agent);
    await db.insert(channelContexts).values({
      id: randomUUID(),
      workspaceId: agent.workspaceId,
      teamId: agent.slackTeam,
      channelId: archived.channelId,
    });
    await db.insert(conversations).values({
      id: randomUUID(),
      workspaceId: agent.workspaceId,
      agentId: agent.agentId,
      kind: "channel",
      teamId: agent.slackTeam,
      channelId: archived.channelId,
      channelState: "archived",
    });
    await pass(V1);
    expect(await noticesOf(agent.agentId)).toEqual([]);

    // Switch off, never approved, approval revoked.
    const off = await slackAgent();
    await off.approve(V1);
    await channel(off);
    const unapproved = await slackAgent();
    await channel(unapproved);
    await db
      .update(agents)
      .set({ conversationRollout: "shadow" })
      .where(eq(agents.id, unapproved.agentId));
    const revoked = await listening();
    await revoked.revoke();
    await db
      .update(agents)
      .set({ conversationRollout: "shadow" })
      .where(eq(agents.id, revoked.agentId));
    await channel(revoked);
    await pass(V1);
    for (const other of [off, unapproved, revoked]) {
      expect(await noticesOf(other.agentId)).toEqual([]);
    }
  });

  const storeOf = (versions: readonly SlackNoticeVersionEntry[]) =>
    createPostgresSlackOutboxStore(db, { noticeVersions: versions });
  /** Claims what is due and returns the agent's rows among them. */
  const claimOf = async (store: ReturnType<typeof storeOf>, agentId: string) =>
    (await store.claim({ limit: 500, leaseMs: 60_000 })).filter(
      (row) => row.agentId === agentId,
    );

  test("a row whose channel stopped listening is held unsent and goes once it listens again", async () => {
    const agent = await listening();
    const c = await channel(agent);
    const store = storeOf(V1);
    await pass(V1);

    await c.set({ listen: "mention" });
    await store.closeUnaddressed();
    expect(await claimOf(store, agent.agentId)).toEqual([]);
    await c.set({ listen: "free", membership: "awaiting_invite" });
    await store.closeUnaddressed();
    expect(await claimOf(store, agent.agentId)).toEqual([]);
    // Held, it still counts as told: no second row.
    await pass(V1);
    expect((await noticesOf(agent.agentId)).map((row) => row.status)).toEqual([
      "pending",
    ]);

    await c.set({ membership: "joined" });
    const [claimed] = await claimOf(store, agent.agentId);
    if (claimed === undefined) throw new Error("not claimed");
    // Checked again as the send begins.
    await c.set({ externalShared: true });
    expect(await store.beginSend(claimed)).toBe(false);
    await c.set({ externalShared: false });
    expect(await store.beginSend(claimed)).toMatchObject({
      agentName: "Notes",
    });
    await store.settle(claimed, { status: "sent", slackTs: "1.000001" });
    await pass(V1);
    expect((await noticesOf(agent.agentId)).map((row) => row.status)).toEqual([
      "sent",
    ]);
  });

  test("a row waits while another Slack team of the agent has not approved", async () => {
    const agent = await listening();
    await channel(agent);
    const store = storeOf(V1);
    await pass(V1);
    // The app installed in a second team, not approved there yet: the switch
    // stays raised until the reconciler lowers it.
    counter += 1;
    const secondTeam = `T0NOTICE${counter}`;
    const installationId = randomUUID();
    await db.insert(slackInstallations).values({
      id: installationId,
      workspaceId: agent.workspaceId,
      appId: `A0SECOND${counter}`,
      teamId: secondTeam,
    });
    await db.insert(agentIdentities).values({
      id: randomUUID(),
      workspaceId: agent.workspaceId,
      agentId: agent.agentId,
      provider: "slack_bot",
      installationId,
      externalPrincipalId: `U0BOT${counter}`,
      credentialRef: `slack/bot-${counter}`,
    });
    await store.closeUnaddressed();
    expect(await claimOf(store, agent.agentId)).toEqual([]);

    await agent.approve(V1);
    expect(await claimOf(store, agent.agentId)).toHaveLength(1);
  });

  test("a private channel the bot left and was let back into is told once, however often", async () => {
    const agent = await listening();
    const c = await channel(agent, { surfaceKind: "private_channel" });
    const store = storeOf(V1);
    for (let i = 0; i < SLACK_CHANNEL_NOTICE_ATTEMPTS + 2; i += 1) {
      await pass(V1);
      await c.set({ status: "left", membership: null });
      await store.closeUnaddressed();
      expect(await claimOf(store, agent.agentId)).toEqual([]);
      await c.set({ status: "ready", membership: "joined" });
    }
    expect((await noticesOf(agent.agentId)).map((row) => row.status)).toEqual([
      "pending",
    ]);
    expect(await claimOf(store, agent.agentId)).toHaveLength(1);
  });

  /** Claims the agent's row and settles it failed with `code`. */
  async function failOnce(agentId: string, code: string) {
    const store = storeOf(V1);
    const [claimed] = await claimOf(store, agentId);
    if (claimed === undefined) throw new Error("not claimed");
    expect(await store.beginSend(claimed)).toMatchObject({
      agentName: "Notes",
    });
    await store.settle(claimed, { status: "failed", errorCode: code });
  }

  test("a line Slack took without naming its post is not sent again", async () => {
    const agent = await listening();
    await channel(agent);
    await pass(V1);
    await failOnce(agent.agentId, "missing_ts");
    await pass(V1);
    expect((await noticesOf(agent.agentId)).map((row) => row.status)).toEqual([
      "failed",
    ]);
  });

  test(`a line that failed unsent is tried again, up to ${SLACK_CHANNEL_NOTICE_ATTEMPTS} rows`, async () => {
    const agent = await listening();
    const c = await channel(agent);
    const base = `channel-notice:${agent.agentId}:${agent.slackTeam}:${c.channelId}:1`;
    for (let i = 0; i < SLACK_CHANNEL_NOTICE_ATTEMPTS + 2; i += 1) {
      await pass(V1);
      if ((await noticesOf(agent.agentId)).at(-1)?.status === "pending") {
        await failOnce(agent.agentId, "channel_not_found");
      }
    }
    const rows = await noticesOf(agent.agentId);
    expect(rows.map((row) => [row.dedupeKey, row.status])).toEqual(
      Array.from({ length: SLACK_CHANNEL_NOTICE_ATTEMPTS }, (_, n) => [
        n === 0 ? base : `${base}:${n}`,
        "failed",
      ]),
    );
  });

  test("a row of a version that asked for approval anew is closed, and the channel is told under it", async () => {
    const agent = await listening();
    const c = await channel(agent);
    await pass(V1);
    await c.set({ listen: "mention" });
    const store = storeOf(V3);
    await store.closeUnaddressed();
    await agent.approve(V3);
    await c.set({ listen: "free" });
    await pass(V3);
    expect(
      (await noticesOf(agent.agentId)).map((row) => [
        row.dedupeKey,
        row.status,
      ]),
    ).toEqual([
      [
        `channel-notice:${agent.agentId}:${agent.slackTeam}:${c.channelId}:1`,
        "failed",
      ],
      [
        `channel-notice:${agent.agentId}:${agent.slackTeam}:${c.channelId}:3`,
        "pending",
      ],
    ]);
    expect(
      (await claimOf(store, agent.agentId)).map((row) => row.dedupeKey),
    ).toEqual([
      `channel-notice:${agent.agentId}:${agent.slackTeam}:${c.channelId}:3`,
    ]);
  });

  test("many channels go a batch per pass, each once", async () => {
    const agent = await slackAgent();
    await agent.approve(V1);
    for (let i = 0; i < 3; i += 1) await channel(agent);
    await agent.rollout("shadow", V1);
    // Other tests' channels may still be due; this agent's are counted.
    let passes = 0;
    while ((await noticesOf(agent.agentId)).length < 3 && passes < 20) {
      expect(await pass(V1, 2)).toBeLessThanOrEqual(2);
      passes += 1;
    }
    expect(passes).toBeGreaterThanOrEqual(2);
    await pass(V1, 2);
    expect(await noticesOf(agent.agentId)).toHaveLength(3);
  });
});

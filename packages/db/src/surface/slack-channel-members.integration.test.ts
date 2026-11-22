import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SLACK_MEMBER_CACHE_TTL_MS } from "@werft-ai/contracts";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  agentIdentities,
  agents,
  linkedAccounts,
  slackChannelMemberCache,
  users,
  workspaces,
} from "../schema.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import {
  createPostgresChannelMemberStore,
  purgeExpiredSlackChannelMembers,
} from "./slack-channel-members.ts";
import { createPostgresSlackInstallStore } from "./slack-install-states.ts";
import {
  registerSlackInstallation,
  verifySlackInstallation,
} from "./slack-installations.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("slack_channel_member_cache on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_members_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresChannelMemberStore(db);

  // Fixture ids shaped like Slack's; no Slack app is involved.
  async function installedAgent() {
    const workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
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
    const { installation } = await registerSlackInstallation(db, {
      ...key,
      workspaceId,
    });
    await verifySlackInstallation(db, { ...key, botUserId: "U0BOT" });
    await db.insert(agentIdentities).values({
      id: randomUUID(),
      workspaceId,
      agentId,
      provider: "slack_bot",
      installationId: installation.id,
      externalPrincipalId: "U0BOT",
      credentialRef: `ref-${agentId}`,
    });
    // Read times are milliseconds: one in the verify's millisecond is refused.
    await Bun.sleep(2);
    return { workspaceId, agentId, key, installationId: installation.id };
  }

  async function linkedUser(
    workspaceId: string,
    teamId: string,
    slackUserId: string,
    status: "active" | "stale" = "active",
  ) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "person",
    });
    await db.insert(linkedAccounts).values({
      id: randomUUID(),
      workspaceId,
      userId,
      provider: "slack",
      externalTenant: teamId,
      externalUserId: slackUserId,
      status,
      verifiedVia: "slack_oidc",
      verifiedAt: new Date(),
    });
    return userId;
  }

  // Moves the row's times back, as if they had been written `ms` ago.
  const age = (installationId: string, ms: number) =>
    db.execute(sql`
      UPDATE ${slackChannelMemberCache}
      SET fetched_at = fetched_at - make_interval(secs => ${ms / 1000}),
          invalidated_at = invalidated_at - make_interval(secs => ${ms / 1000})
      WHERE installation_id = ${installationId}`);

  test("the subject is the agent's live install and the user's active link in its team", async () => {
    const t = await installedAgent();
    const linked = await linkedUser(t.workspaceId, t.key.teamId, "U0LINKED");
    const stale = await linkedUser(
      t.workspaceId,
      t.key.teamId,
      "U0STALE",
      "stale",
    );
    const elsewhere = await linkedUser(t.workspaceId, "T0OTHER", "U0ELSEWHERE");

    expect(
      await store().subject({
        workspaceId: t.workspaceId,
        agentId: t.agentId,
        userId: linked,
      }),
    ).toEqual({ installationId: t.installationId, slackUserId: "U0LINKED" });
    for (const userId of [stale, elsewhere, randomUUID()]) {
      expect(
        await store().subject({
          workspaceId: t.workspaceId,
          agentId: t.agentId,
          userId,
        }),
      ).toBeNull();
    }
    expect(
      await store().subject({
        workspaceId: t.workspaceId,
        agentId: randomUUID(),
        userId: linked,
      }),
    ).toBeNull();
  });

  test("a list answers for 5 minutes, then not", async () => {
    const t = await installedAgent();
    const first = await store().cached(t.installationId, "G0CHAN");
    expect(first.memberIds).toBeNull();

    await store().remember(
      t.installationId,
      "G0CHAN",
      ["U0A", "U0B"],
      first.checkedAt,
    );
    expect(
      (await store().cached(t.installationId, "G0CHAN")).memberIds,
    ).toEqual(["U0A", "U0B"]);
    expect(
      (await store().cached(t.installationId, "G0OTHER")).memberIds,
    ).toBeNull();

    await age(t.installationId, SLACK_MEMBER_CACHE_TTL_MS);
    expect(
      (await store().cached(t.installationId, "G0CHAN")).memberIds,
    ).toBeNull();
  });

  test("a void wins over a read that began before it, not over one after", async () => {
    const t = await installedAgent();
    const before = await store().cached(t.installationId, "G0CHAN");
    await store().remember(
      t.installationId,
      "G0CHAN",
      ["U0A"],
      before.checkedAt,
    );

    await store().forget(t.installationId, "G0CHAN");
    expect(
      (await store().cached(t.installationId, "G0CHAN")).memberIds,
    ).toBeNull();
    // The read that began before the void comes back late: dropped.
    await store().remember(
      t.installationId,
      "G0CHAN",
      ["U0A"],
      before.checkedAt,
    );
    expect(
      (await store().cached(t.installationId, "G0CHAN")).memberIds,
    ).toBeNull();

    await Bun.sleep(2);
    const after = await store().cached(t.installationId, "G0CHAN");
    await store().remember(
      t.installationId,
      "G0CHAN",
      ["U0B"],
      after.checkedAt,
    );
    expect(
      (await store().cached(t.installationId, "G0CHAN")).memberIds,
    ).toEqual(["U0B"]);
  });

  test("of two reads that began in one millisecond, the reply that comes second is not kept", async () => {
    const t = await installedAgent();
    const read = await store().cached(t.installationId, "G0CHAN");
    expect(
      await store().remember(
        t.installationId,
        "G0CHAN",
        ["U0B"],
        read.checkedAt,
      ),
    ).toBe(true);
    expect(
      await store().remember(
        t.installationId,
        "G0CHAN",
        ["U0A"],
        read.checkedAt,
      ),
    ).toBe(false);
    expect(
      (await store().cached(t.installationId, "G0CHAN")).memberIds,
    ).toEqual(["U0B"]);
  });

  test("a read older than the TTL is not kept, and a forget of an unknown channel stores no list", async () => {
    const t = await installedAgent();
    const old = new Date(Date.now() - SLACK_MEMBER_CACHE_TTL_MS - 60_000);
    await store().remember(t.installationId, "G0CHAN", ["U0A"], old);
    await store().forget(t.installationId, "G0NEW");

    const rows = await db
      .select()
      .from(slackChannelMemberCache)
      .where(eq(slackChannelMemberCache.installationId, t.installationId));
    expect(rows).toEqual([
      expect.objectContaining({
        channelId: "G0NEW",
        memberIds: [],
        fetchedAt: null,
      }),
    ]);
  });

  test("the purge drops rows past the TTL only; a dry run counts them", async () => {
    const t = await installedAgent();
    for (const channel of ["G0OLD", "G0NEW"]) {
      const read = await store().cached(t.installationId, channel);
      await store().remember(
        t.installationId,
        channel,
        ["U0A"],
        read.checkedAt,
      );
    }
    await store().forget(t.installationId, "G0VOID");
    await db.execute(sql`
      UPDATE ${slackChannelMemberCache}
      SET fetched_at = fetched_at - make_interval(secs => 600),
          invalidated_at = invalidated_at - make_interval(secs => 600)
      WHERE installation_id = ${t.installationId} AND channel_id <> 'G0NEW'`);

    expect(
      await purgeExpiredSlackChannelMembers(db, { limit: 100, dryRun: true }),
    ).toBeGreaterThanOrEqual(2);
    await purgeExpiredSlackChannelMembers(db, { limit: 100, dryRun: false });
    const left = await db
      .select({ channelId: slackChannelMemberCache.channelId })
      .from(slackChannelMemberCache)
      .where(eq(slackChannelMemberCache.installationId, t.installationId));
    expect(left).toEqual([{ channelId: "G0NEW" }]);
  });

  test("revoking the install drops its lists", async () => {
    const t = await installedAgent();
    const read = await store().cached(t.installationId, "G0CHAN");
    await store().remember(t.installationId, "G0CHAN", ["U0A"], read.checkedAt);

    expect(
      await createPostgresSlackInstallStore(db).revokeInstallation(t.key, null),
    ).toBe("revoked");
    expect(
      await db
        .select()
        .from(slackChannelMemberCache)
        .where(eq(slackChannelMemberCache.installationId, t.installationId)),
    ).toEqual([]);
  });

  test("a read that began before a revoke, or before the install was verified again, is not kept", async () => {
    const t = await installedAgent();
    const before = await store().cached(t.installationId, "G0CHAN");
    expect(
      await createPostgresSlackInstallStore(db).revokeInstallation(t.key, null),
    ).toBe("revoked");
    expect(
      await store().remember(
        t.installationId,
        "G0CHAN",
        ["U0A"],
        before.checkedAt,
      ),
    ).toBe(false);

    // Installed again under the same row: the old read is still refused.
    await registerSlackInstallation(db, {
      ...t.key,
      workspaceId: t.workspaceId,
    });
    const again = await verifySlackInstallation(db, {
      ...t.key,
      botUserId: "U0BOT",
    });
    expect(again.outcome).toBe("verified");
    expect(
      await store().remember(
        t.installationId,
        "G0CHAN",
        ["U0A"],
        before.checkedAt,
      ),
    ).toBe(false);
    await Bun.sleep(2);
    const after = await store().cached(t.installationId, "G0CHAN");
    expect(
      await store().remember(
        t.installationId,
        "G0CHAN",
        ["U0A"],
        after.checkedAt,
      ),
    ).toBe(true);
    expect(
      (await store().cached(t.installationId, "G0CHAN")).memberIds,
    ).toEqual(["U0A"]);
  });

  test("a write waits for a revoke in flight and is then refused", async () => {
    const t = await installedAgent();
    const before = await store().cached(t.installationId, "G0CHAN");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = () => {};
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // The revoke's lock, status change and delete, held open while the write comes.
    const revoke = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM slack_installations WHERE id = ${t.installationId} FOR NO KEY UPDATE`,
      );
      await tx.execute(
        sql`UPDATE slack_installations SET status = 'revoked', revoked_at = now() WHERE id = ${t.installationId}`,
      );
      await tx
        .delete(slackChannelMemberCache)
        .where(eq(slackChannelMemberCache.installationId, t.installationId));
      locked();
      await held;
    });
    await lockTaken;
    const write = store().remember(
      t.installationId,
      "G0CHAN",
      ["U0A"],
      before.checkedAt,
    );
    await Bun.sleep(200);
    release();
    await revoke;
    expect(await write).toBe(false);
    expect(
      await db
        .select()
        .from(slackChannelMemberCache)
        .where(eq(slackChannelMemberCache.installationId, t.installationId)),
    ).toEqual([]);
  });

  test("the table refuses a list past the member limit", async () => {
    const t = await installedAgent();
    const ids = JSON.stringify(
      Array.from({ length: 10_001 }, (_, i) => `U${i}`),
    );
    const refused = await db
      .execute(sql`
        INSERT INTO ${slackChannelMemberCache} (installation_id, channel_id, member_ids, fetched_at)
        VALUES (${t.installationId}, 'G0BIG', ARRAY(SELECT jsonb_array_elements_text(${ids}::jsonb)), now())`)
      .then(
        () => "accepted",
        (error: { cause?: Error }) => String(error.cause?.message ?? error),
      );
    expect(refused).toContain("slack_channel_member_cache_size_check");
  });
});

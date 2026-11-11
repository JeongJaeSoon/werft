import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { SecretKey, type SlackInboundEventInput } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  agents,
  slackApps,
  slackInboundEvents,
  slackInstallations,
  workspaces,
} from "../schema.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import { createPostgresSlackAppStore } from "./slack-apps.ts";
import { createPostgresSlackInboundEventStore } from "./slack-inbound-events.ts";
import { createPostgresSlackInstallStore } from "./slack-install-states.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("slack_inbound_events on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_inbox_it" });
    pool = new Pool({ connectionString: database.url, max: 6 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const slackId = (prefix: string) =>
    `${prefix}${randomBytes(4).toString("hex").toUpperCase()}`;

  async function agentApp(state: "created" | "deleted" = "created") {
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
      name: "Notes",
    });
    const slackAppId = randomUUID();
    const appId = slackId("A");
    await db.insert(slackApps).values({
      id: slackAppId,
      workspaceId,
      kind: "agent",
      agentId,
      state,
      appId,
      clientId: "1.1",
      redirectUrl: "https://console.example/cb",
    });
    return { workspaceId, agentId, slackAppId, appId };
  }

  const event = (
    app: Awaited<ReturnType<typeof agentApp>>,
    teamId: string,
    eventId: string,
  ) => ({
    workspaceId: app.workspaceId,
    agentId: app.agentId,
    slackAppId: app.slackAppId,
    teamId,
    appId: app.appId,
    eventId,
    eventType: "app_mention",
    eventSubtype: null,
    eventTime: new Date("2026-10-24T10:00:00Z"),
  });

  test("one row per (app_id, event_id), dropped or not", async () => {
    const app = await agentApp();
    const inbox = createPostgresSlackInboundEventStore(db);
    const team = slackId("T");
    const received: SlackInboundEventInput = {
      ...event(app, team, "Ev01"),
      status: "received",
      payload: { type: "event_callback", event_id: "Ev01" },
      conversationKey: null,
    };
    expect(await inbox.seen(app.appId, "Ev01")).toBe(false);
    expect(await inbox.record(received)).toBe("recorded");
    expect(await inbox.seen(app.appId, "Ev01")).toBe(true);
    expect(await inbox.record(received)).toBe("duplicate");
    const dropped: SlackInboundEventInput = {
      ...event(app, team, "Ev02"),
      status: "dropped",
      dropReason: "bot_message",
    };
    expect(await inbox.record(dropped)).toBe("recorded");
    expect(
      await inbox.record({
        ...event(app, team, "Ev02"),
        status: "received",
        payload: {},
        conversationKey: null,
      }),
    ).toBe("duplicate");
    // The same app's event in another team is still its retry.
    expect(await inbox.record({ ...received, teamId: slackId("T") })).toBe(
      "duplicate",
    );
    // Another app of the same team keeps its own copy.
    const other = await agentApp();
    expect(
      await inbox.record({
        ...event(other, team, "Ev01"),
        status: "received",
        payload: {},
        conversationKey: null,
      }),
    ).toBe("recorded");
    expect(await inbox.seen(other.appId, "Ev01")).toBe(true);

    const rows = await db
      .select()
      .from(slackInboundEvents)
      .where(eq(slackInboundEvents.agentId, app.agentId));
    expect(rows).toHaveLength(2);
    const drop = rows.find((row) => row.eventId === "Ev02");
    expect(drop).toMatchObject({
      status: "dropped",
      dropReason: "bot_message",
      payload: null,
    });
  });

  test("two pools claiming at once take every row exactly once", async () => {
    const app = await agentApp();
    const inbox = createPostgresSlackInboundEventStore(db);
    const team = slackId("T");
    const ids = Array.from({ length: 60 }, (_, i) => `EvRACE${i}`);
    for (const [i, eventId] of ids.entries()) {
      await inbox.record({
        ...event(app, team, eventId),
        status: "received",
        payload: {},
        // Each its own thread, so only the lease decides.
        conversationKey: `${app.slackAppId}:C1:${i}`,
      });
    }
    const second = new Pool({ connectionString: database.url, max: 6 });
    try {
      const stores = [
        inbox,
        createPostgresSlackInboundEventStore(drizzle(second, { schema })),
      ];
      const taken: string[] = [];
      const rowIds: string[] = [];
      const worker = async (store: (typeof stores)[number]) => {
        for (;;) {
          const batch = await store.claim({
            limit: 4,
            leaseMs: 60_000,
            maxAttempts: 5,
          });
          if (batch.length === 0) return;
          taken.push(...batch.map((claim) => claim.eventId));
          rowIds.push(...batch.map((claim) => claim.id));
        }
      };
      // Three claimers per pool, all at once.
      await Promise.all(
        stores.flatMap((store) => [1, 2, 3].map(() => worker(store))),
      );
      console.log(
        `contention (PostgreSQL): ${rowIds.length} claims, ${new Set(rowIds).size} distinct rows; ${ids.length} raced`,
      );
      // Other tests' received rows are claimed too, once each as well.
      expect(new Set(rowIds).size).toBe(rowIds.length);
      expect(taken.filter((id) => id.startsWith("EvRACE")).sort()).toEqual(
        [...ids].sort(),
      );
    } finally {
      await second.end();
    }
  });

  test("racing claimers take only each thread's head while it is in flight", async () => {
    const app = await agentApp();
    const inbox = createPostgresSlackInboundEventStore(db);
    const team = slackId("T");
    const threads = 6;
    const perThread = 8;
    for (let n = 0; n < perThread; n += 1) {
      for (let thread = 0; thread < threads; thread += 1) {
        await inbox.record({
          ...event(app, team, `EvHEAD${thread}-${n}`),
          eventTime: new Date(Date.parse("2026-10-24T10:00:00Z") + n * 1000),
          status: "received",
          payload: {},
          conversationKey: `${app.slackAppId}:C2:${thread}`,
        });
      }
    }
    const second = new Pool({ connectionString: database.url, max: 6 });
    try {
      const stores = [
        inbox,
        createPostgresSlackInboundEventStore(drizzle(second, { schema })),
      ];
      const taken: string[] = [];
      // Nobody completes, so each thread's head stays leased throughout.
      const worker = async (store: (typeof stores)[number]) => {
        for (;;) {
          const batch = await store.claim({
            limit: 3,
            leaseMs: 60_000,
            maxAttempts: 5,
          });
          if (batch.length === 0) return;
          taken.push(...batch.map((claim) => claim.eventId));
        }
      };
      await Promise.all(
        stores.flatMap((store) => [1, 2, 3].map(() => worker(store))),
      );
      const mine = taken.filter((id) => id.startsWith("EvHEAD")).sort();
      console.log(
        `thread heads (PostgreSQL): ${mine.length} claimed of ${threads * perThread} rows in ${threads} threads`,
      );
      expect(mine).toEqual(
        Array.from({ length: threads }, (_, thread) => `EvHEAD${thread}-0`),
      );

      // Late retries of older events land while claimers keep racing; the
      // heads are still in flight, so none may run beside them.
      const late = await Promise.all([
        ...Array.from({ length: threads }, (_, thread) =>
          inbox.record({
            ...event(app, team, `EvLATE${thread}`),
            eventTime: new Date("2026-10-24T09:59:00Z"),
            status: "received",
            payload: {},
            conversationKey: `${app.slackAppId}:C2:${thread}`,
          }),
        ),
        ...stores.flatMap((store) =>
          [1, 2, 3].map(async () => {
            const got: string[] = [];
            for (let round = 0; round < 20; round += 1) {
              const batch = await store.claim({
                limit: 3,
                leaseMs: 60_000,
                maxAttempts: 5,
              });
              got.push(...batch.map((claim) => claim.eventId));
            }
            return got;
          }),
        ),
      ]);
      const lateTaken = late
        .flat()
        .filter((id) => id.startsWith("EvHEAD") || id.startsWith("EvLATE"));
      console.log(
        `late retries (PostgreSQL): ${lateTaken.length} claimed beside ${threads} in-flight heads`,
      );
      expect(lateTaken).toEqual([]);
    } finally {
      await second.end();
    }
  });

  test("a claim waits for another claimer's uncommitted lease before judging the thread", async () => {
    const app = await agentApp();
    const inbox = createPostgresSlackInboundEventStore(db);
    const team = slackId("T");
    const key = `${app.slackAppId}:C3:1`;
    await inbox.record({
      ...event(app, team, "EvLOCKHEAD"),
      status: "received",
      payload: {},
      conversationKey: key,
    });
    // Another claimer mid-claim: holds the claim lock and has leased the
    // head, not committed yet.
    const claimer = await pool.connect();
    try {
      await claimer.query("BEGIN");
      await claimer.query(
        "SELECT pg_advisory_xact_lock(hashtext('slack_inbound_events.claim'))",
      );
      await claimer.query(
        `UPDATE slack_inbound_events
         SET claim_token = gen_random_uuid(), lease_expires_at = now() + interval '60 seconds', attempts = attempts + 1
         WHERE event_id = 'EvLOCKHEAD'`,
      );
      await inbox.record({
        ...event(app, team, "EvLOCKEARLY"),
        eventTime: new Date("2026-10-24T09:00:00Z"),
        status: "received",
        payload: {},
        conversationKey: key,
      });
      let settled = false;
      const pending = inbox
        .claim({ limit: 10, leaseMs: 60_000, maxAttempts: 5 })
        .finally(() => {
          settled = true;
        });
      await new Promise((done) => setTimeout(done, 300));
      expect(settled).toBe(false);
      await claimer.query("COMMIT");
      const taken = (await pending).map((claim) => claim.eventId);
      expect(taken).not.toContain("EvLOCKEARLY");
      expect(taken).not.toContain("EvLOCKHEAD");
    } finally {
      claimer.release();
    }
  });

  test("the table refuses a dropped row with a payload or a reason on a kept one", async () => {
    const app = await agentApp();
    const base = {
      id: randomUUID(),
      ...event(app, slackId("T"), "Ev03"),
    };
    // The builder is only thenable; `rejects` wants a promise.
    const insert = (values: typeof slackInboundEvents.$inferInsert) =>
      Promise.resolve(db.insert(slackInboundEvents).values(values));
    await expect(
      insert({
        ...base,
        status: "dropped",
        dropReason: "bot_message",
        payload: {},
      }),
    ).rejects.toThrow();
    await expect(
      insert({
        ...base,
        status: "received",
        dropReason: "bot_message",
        payload: {},
      }),
    ).rejects.toThrow();
    await expect(
      insert({
        ...base,
        status: "dropped",
        dropReason: "not_a_reason" as never,
      }),
    ).rejects.toThrow();
  });

  test("findAgentApp finds only a created agent app, by agent id alone", async () => {
    const apps = createPostgresSlackAppStore(db, key);
    const live = await agentApp();
    const gone = await agentApp("deleted");
    expect((await apps.findAgentApp(live.agentId))?.id).toBe(live.slackAppId);
    expect(await apps.findAgentApp(gone.agentId)).toBeNull();
    expect(await apps.findAgentApp(randomUUID())).toBeNull();
    expect(await apps.findAgentApp("nope")).toBeNull();
    expect(
      await apps.manifestAgent(live.workspaceId, live.agentId),
    ).toMatchObject({ id: live.agentId, name: "Notes" });
    expect(await apps.manifestAgent(randomUUID(), live.agentId)).toBeNull();
  });

  test("revokeInstallation revokes the install and reports a missing one", async () => {
    const app = await agentApp();
    const installs = createPostgresSlackInstallStore(db);
    const teamId = slackId("T");
    await installs.recordInstallation({
      workspaceId: app.workspaceId,
      appId: app.appId,
      teamId,
      botUserId: slackId("U"),
    });
    expect(
      await installs.revokeInstallation({ appId: app.appId, teamId }),
    ).toBe("revoked");
    expect(
      await installs.revokeInstallation({ appId: app.appId, teamId }),
    ).toBe("revoked");
    const [row] = await db
      .select({ status: slackInstallations.status })
      .from(slackInstallations)
      .where(eq(slackInstallations.appId, app.appId));
    expect(row?.status).toBe("revoked");
    expect(
      await installs.revokeInstallation({
        appId: app.appId,
        teamId: slackId("T"),
      }),
    ).toBe("not_found");
  });

  test("revokeInstallation leaves an install verified after the report was sent", async () => {
    const app = await agentApp();
    const installs = createPostgresSlackInstallStore(db);
    const teamId = slackId("T");
    const key = { appId: app.appId, teamId };
    await installs.recordInstallation({
      workspaceId: app.workspaceId,
      ...key,
      botUserId: slackId("U"),
    });
    const before = new Date(Date.now() - 60_000);
    expect(await installs.revokeInstallation(key, before)).toBe("superseded");
    const [kept] = await db
      .select({ status: slackInstallations.status })
      .from(slackInstallations)
      .where(eq(slackInstallations.appId, app.appId));
    expect(kept?.status).toBe("verified");
    const after = new Date(Date.now() + 60_000);
    expect(await installs.revokeInstallation(key, after)).toBe("revoked");
    expect(
      await installs.revokeInstallation(
        { appId: app.appId, teamId: slackId("T") },
        after,
      ),
    ).toBe("not_found");
  });
});

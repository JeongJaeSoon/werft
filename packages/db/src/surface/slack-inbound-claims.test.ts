import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { SLACK_INBOUND_MAX_ATTEMPTS } from "@werft-ai/contracts";
import type { SurfaceInboundEventStore } from "@werft-ai/platform";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "../migrate.ts";
import * as schema from "../schema.ts";
import {
  agents,
  slackApps,
  slackInboundEvents,
  slackInstallations,
  workspaces,
} from "../schema.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import {
  createPostgresSlackInboundEventStore,
  purgeFailedSlackInboundPayloads,
} from "./slack-inbound-events.ts";

const migrations = join(import.meta.dir, "../../migrations");
const LEASE = { leaseMs: 60_000, maxAttempts: SLACK_INBOUND_MAX_ATTEMPTS };

// The store takes the wait and the key as given; the Slack adapter's own
// tests pin how it derives them.
const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000];
const backoffMs = (attempts: number) => BACKOFF_MS[attempts - 1] ?? 300_000;
const conversationKeyOf = (
  slackAppId: string,
  event: { channel: string; ts: string; thread?: string | undefined },
) => `${slackAppId}:${event.channel}:${event.thread ?? event.ts}`;

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let inbox: SurfaceInboundEventStore;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrations });
  inbox = createPostgresSlackInboundEventStore(db);
});

afterAll(async () => {
  await client.close();
});

const slackId = (prefix: string) =>
  `${prefix}${randomBytes(4).toString("hex").toUpperCase()}`;

async function agentApp() {
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
    state: "created",
    appId,
    clientId: "1.1",
    redirectUrl: "https://console.example/cb",
  });
  const teamId = slackId("T");
  await db.insert(slackInstallations).values({
    id: randomUUID(),
    workspaceId,
    appId,
    teamId,
    botUserId: slackId("U"),
    status: "verified",
    verifiedAt: new Date(),
  });
  return { workspaceId, agentId, slackAppId, appId, teamId };
}

type App = Awaited<ReturnType<typeof agentApp>>;

/** A mention in `channel`, in the thread `thread` (its own when omitted). */
async function mention(
  app: App,
  input: { ts: string; thread?: string; channel?: string; at?: number },
) {
  const eventId = slackId("Ev");
  const event = {
    type: "app_mention",
    channel: input.channel ?? "C0MOCK",
    ts: input.ts,
    ...(input.thread === undefined ? {} : { thread_ts: input.thread }),
  };
  await inbox.record({
    workspaceId: app.workspaceId,
    agentId: app.agentId,
    slackAppId: app.slackAppId,
    teamId: app.teamId,
    appId: app.appId,
    eventId,
    eventType: "app_mention",
    eventSubtype: null,
    eventTime: new Date((input.at ?? 1_792_800_000) * 1000),
    status: "received",
    payload: { type: "event_callback", event_id: eventId, event },
    conversationKey: conversationKeyOf(app.slackAppId, {
      channel: event.channel,
      ts: event.ts,
      thread: input.thread,
    }),
  });
  return eventId;
}

/** A received event other than a mention, `event` its fields past `type`. */
async function channelEvent(
  app: App,
  input: {
    type: string;
    event: Record<string, unknown>;
    at: number;
    conversationKey?: string;
  },
) {
  const eventId = slackId("Ev");
  await inbox.record({
    workspaceId: app.workspaceId,
    agentId: app.agentId,
    slackAppId: app.slackAppId,
    teamId: app.teamId,
    appId: app.appId,
    eventId,
    eventType: input.type,
    eventSubtype: null,
    eventTime: new Date(input.at * 1000),
    status: "received",
    payload: {
      type: "event_callback",
      event_id: eventId,
      event: { type: input.type, ...input.event },
    },
    conversationKey: input.conversationKey ?? null,
  });
  return eventId;
}

async function row(eventId: string) {
  const [found] = await db
    .select()
    .from(slackInboundEvents)
    .where(eq(slackInboundEvents.eventId, eventId));
  if (!found) throw new Error(`no row ${eventId}`);
  return found;
}

/** Settles every row still received, so one test's rows leave the next's alone. */
async function settle() {
  await db
    .update(slackInboundEvents)
    .set({ status: "processed", claimToken: null, leaseExpiresAt: null })
    .where(eq(slackInboundEvents.status, "received"));
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Claims `eventId`, alone, and fails it into its first backoff. */
async function backOff(eventId: string) {
  const [claim, ...rest] = await inbox.claim({ limit: 10, ...LEASE });
  expect(claim?.eventId).toBe(eventId);
  expect(rest).toEqual([]);
  if (!claim) throw new Error("not claimed");
  expect(
    await inbox.fail(claim, {
      retryInMs: backoffMs(claim.attempts),
      maxAttempts: SLACK_INBOUND_MAX_ATTEMPTS,
    }),
  ).toBe("retry");
}

/** Its backoff over, as the database clock will see it. */
async function backoffOver(eventId: string) {
  await db
    .update(slackInboundEvents)
    .set({ nextAttemptAt: sql`now() - interval '1 second'` })
    .where(eq(slackInboundEvents.eventId, eventId));
}

/** Each claim hands out the next of `eventIds` alone, completed in turn. */
async function expectTurns(eventIds: string[]) {
  for (const eventId of eventIds) {
    const [claim, ...rest] = await inbox.claim({ limit: 10, ...LEASE });
    expect(claim?.eventId).toBe(eventId);
    expect(rest).toEqual([]);
    if (!claim) throw new Error("not claimed");
    expect(await inbox.complete(claim)).toBe(true);
  }
  expect(await inbox.claim({ limit: 10, ...LEASE })).toEqual([]);
}

describe("claiming the Slack inbox", () => {
  test("two workers claiming at once take every row exactly once", async () => {
    await settle();
    const app = await agentApp();
    const ids: string[] = [];
    for (let i = 0; i < 24; i += 1) {
      ids.push(
        await mention(app, { ts: `1792800000.${1000 + i}`, channel: `C${i}` }),
      );
    }
    const other = createPostgresSlackInboundEventStore(db);
    const taken: string[] = [];
    const worker = async (store: SurfaceInboundEventStore) => {
      for (;;) {
        const batch = await store.claim({ limit: 5, ...LEASE });
        if (batch.length === 0) return;
        taken.push(...batch.map((claim) => claim.eventId));
      }
    };
    await Promise.all([worker(inbox), worker(other)]);
    console.log(
      `contention: ${taken.length} claims, ${new Set(taken).size} distinct of ${ids.length}`,
    );
    expect(taken.sort()).toEqual([...ids].sort());
    for (const id of ids) expect((await row(id)).attempts).toBe(1);
  });

  test("a channel's later event waits for the earlier one; other channels do not", async () => {
    await settle();
    const app = await agentApp();
    const head = await mention(app, { ts: "1792800000.000100", at: 100 });
    const reply = await mention(app, {
      ts: "1792800001.000200",
      thread: "1792800000.000100",
      at: 101,
    });
    const elsewhere = await mention(app, {
      ts: "1792800002.000300",
      channel: "C0OTHER",
      at: 102,
    });
    // The reply arrived first and is still behind the head.
    await db
      .update(slackInboundEvents)
      .set({ receivedAt: sql`now() - interval '1 minute'` })
      .where(eq(slackInboundEvents.eventId, reply));

    const first = await inbox.claim({ limit: 10, ...LEASE });
    expect(first.map((claim) => claim.eventId)).toEqual([head, elsewhere]);
    expect(await inbox.claim({ limit: 10, ...LEASE })).toEqual([]);

    const claimed = first.find((claim) => claim.eventId === head);
    if (!claimed) throw new Error("head not claimed");
    expect(await inbox.complete(claimed)).toBe(true);
    const next = await inbox.claim({ limit: 10, ...LEASE });
    expect(next.map((claim) => claim.eventId)).toEqual([reply]);
    expect(next[0]?.conversationKey).toBe(
      `${app.slackAppId}:C0MOCK:1792800000.000100`,
    );
  });

  test("a late retry of an older event waits while its channel has one in flight", async () => {
    await settle();
    const app = await agentApp();
    const later = await mention(app, { ts: "1792800001.000500", at: 101 });
    const [inFlight] = await inbox.claim({ limit: 10, ...LEASE });
    expect(inFlight?.eventId).toBe(later);

    const older = await mention(app, {
      ts: "1792800000.000600",
      thread: "1792800001.000500",
      at: 100,
    });
    expect(await inbox.claim({ limit: 10, ...LEASE })).toEqual([]);

    if (!inFlight) throw new Error("not claimed");
    expect(await inbox.complete(inFlight)).toBe(true);
    const next = await inbox.claim({ limit: 10, ...LEASE });
    expect(next.map((claim) => claim.eventId)).toEqual([older]);
  });

  test("two threads of one channel take turns: a top-level message waits for the one before it", async () => {
    await settle();
    const app = await agentApp();
    const first = await mention(app, { ts: "1792800000.000700", at: 100 });
    const second = await mention(app, { ts: "1792800001.000800", at: 101 });
    const [claimed, ...rest] = await inbox.claim({ limit: 10, ...LEASE });
    expect(claimed?.eventId).toBe(first);
    expect(rest).toEqual([]);
    if (!claimed) throw new Error("not claimed");
    expect(await inbox.complete(claimed)).toBe(true);
    expect(
      (await inbox.claim({ limit: 10, ...LEASE })).map((c) => c.eventId),
    ).toEqual([second]);
  });

  test("a thread waiting out its backoff holds back only its own later posts; the channel's other threads go on", async () => {
    await settle();
    const app = await agentApp();
    const root = "1792800000.001000";
    const stuck = await mention(app, { ts: root, at: 100 });
    const reply = await mention(app, {
      ts: "1792800001.001100",
      thread: root,
      at: 101,
    });
    const other = await mention(app, { ts: "1792800002.001200", at: 102 });
    await backOff(stuck);
    // Thread 1 waits in its backoff; thread 2 of the same channel does not.
    const [otherClaim, ...rest] = await inbox.claim({ limit: 10, ...LEASE });
    expect(otherClaim?.eventId).toBe(other);
    expect(rest).toEqual([]);
    if (!otherClaim) throw new Error("not claimed");
    expect(await inbox.complete(otherClaim)).toBe(true);
    expect(await inbox.claim({ limit: 10, ...LEASE })).toEqual([]);
    await backoffOver(stuck);
    await expectTurns([stuck, reply]);
  });

  test("a channel event behind a thread in backoff waits for it, and so does the channel behind the event", async () => {
    await settle();
    const app = await agentApp();
    const stuck = await mention(app, { ts: "1792800000.001300", at: 100 });
    const left = await channelEvent(app, {
      type: "member_left_channel",
      event: { user: "U0LEFT", channel: "C0MOCK" },
      at: 101,
    });
    const later = await mention(app, { ts: "1792800002.001400", at: 102 });
    await backOff(stuck);
    expect(await inbox.claim({ limit: 10, ...LEASE })).toEqual([]);
    await backoffOver(stuck);
    await expectTurns([stuck, left, later]);
  });

  test("a member leaving after a mention waits for it, in the mention's channel only", async () => {
    await settle();
    const app = await agentApp();
    const asked = await mention(app, { ts: "1792800000.000900", at: 100 });
    const left = await channelEvent(app, {
      type: "member_left_channel",
      event: { user: "U0LEFT", channel: "C0MOCK" },
      at: 101,
    });
    const renamed = await channelEvent(app, {
      type: "channel_rename",
      event: { channel: { id: "C0MOCK", name: "renamed" } },
      at: 102,
    });
    const elsewhere = await channelEvent(app, {
      type: "member_joined_channel",
      event: { user: "U0JOIN", channel: "C0OTHER" },
      at: 103,
    });
    const first = await inbox.claim({ limit: 10, ...LEASE });
    expect(first.map((c) => c.eventId)).toEqual([asked, elsewhere]);
    const [mentionClaim] = first;
    if (!mentionClaim) throw new Error("not claimed");
    expect(await inbox.complete(mentionClaim)).toBe(true);
    const [leftClaim, ...after] = await inbox.claim({ limit: 10, ...LEASE });
    expect(leftClaim?.eventId).toBe(left);
    expect(after).toEqual([]);
    if (!leftClaim) throw new Error("not claimed");
    expect(await inbox.complete(leftClaim)).toBe(true);
    expect(
      (await inbox.claim({ limit: 10, ...LEASE })).map((c) => c.eventId),
    ).toEqual([renamed]);
  });

  test("a row stored with its thread's key lines up with the channel's newer rows", async () => {
    await settle();
    const app = await agentApp();
    const old = await mention(app, {
      ts: "1792800001.001000",
      thread: "1792800000.000999",
      at: 100,
    });
    const fresh = await channelEvent(app, {
      type: "message",
      event: { channel: "C0MOCK", ts: "1792800002.001100", user: "U1" },
      at: 101,
      conversationKey: `${app.slackAppId}:C0MOCK`,
    });
    expect((await row(old)).conversationKey).not.toBe(
      (await row(fresh)).conversationKey,
    );
    expect(
      (await inbox.claim({ limit: 10, ...LEASE })).map((c) => c.eventId),
    ).toEqual([old]);
  });

  test("events that name no channel each go on their own", async () => {
    await settle();
    const app = await agentApp();
    const a = await channelEvent(app, {
      type: "app_home_opened",
      event: {},
      at: 100,
    });
    const b = await channelEvent(app, {
      type: "app_home_opened",
      event: {},
      at: 101,
    });
    expect(
      (await inbox.claim({ limit: 10, ...LEASE })).map((c) => c.eventId),
    ).toEqual([a, b]);
  });

  test("an expired lease is claimed again with attempts + 1, and the late owner writes nothing", async () => {
    await settle();
    const app = await agentApp();
    const id = await mention(app, { ts: "1792800000.000400" });
    const [lapsed] = await inbox.claim({
      limit: 1,
      leaseMs: 1,
      maxAttempts: SLACK_INBOUND_MAX_ATTEMPTS,
    });
    if (!lapsed) throw new Error("not claimed");
    expect(lapsed.attempts).toBe(1);
    await sleep(20);

    const [again] = await inbox.claim({ limit: 1, ...LEASE });
    expect(again?.eventId).toBe(id);
    expect(again?.attempts).toBe(2);
    expect(again?.claimToken).not.toBe(lapsed.claimToken);

    expect(await inbox.complete(lapsed)).toBe(false);
    expect(await inbox.drop(lapsed, "installation_revoked")).toBe(false);
    expect(
      await inbox.fail(lapsed, {
        retryInMs: 1,
        maxAttempts: SLACK_INBOUND_MAX_ATTEMPTS,
      }),
    ).toBe("lost");
    expect(await row(id)).toMatchObject({
      status: "received",
      claimToken: again?.claimToken,
      attempts: 2,
    });
    if (!again) throw new Error("not claimed again");
    expect(await inbox.complete(again)).toBe(true);
    expect(await row(id)).toMatchObject({
      status: "processed",
      claimToken: null,
      leaseExpiresAt: null,
    });
  });

  test("a failed row waits out its backoff, and the fifth failure ends it failed", async () => {
    await settle();
    const app = await agentApp();
    const id = await mention(app, { ts: "1792800000.000500" });
    for (let attempt = 1; attempt <= SLACK_INBOUND_MAX_ATTEMPTS; attempt += 1) {
      const [claim] = await inbox.claim({ limit: 1, ...LEASE });
      expect(claim?.attempts).toBe(attempt);
      if (!claim) throw new Error(`attempt ${attempt} not claimed`);
      const outcome = await inbox.fail(claim, {
        retryInMs: backoffMs(claim.attempts),
        maxAttempts: SLACK_INBOUND_MAX_ATTEMPTS,
      });
      if (attempt < SLACK_INBOUND_MAX_ATTEMPTS) {
        expect(outcome).toBe("retry");
        expect(await inbox.claim({ limit: 1, ...LEASE })).toEqual([]);
        const waited = await db.execute<{ secs: number }>(
          sql`SELECT round(extract(epoch FROM next_attempt_at - now()))::int AS secs FROM slack_inbound_events WHERE event_id = ${id}`,
        );
        expect(waited.rows[0]?.secs).toBe(backoffMs(attempt) / 1000);
        // Its backoff over, as the database clock will see it.
        await db
          .update(slackInboundEvents)
          .set({ nextAttemptAt: sql`now() - interval '1 second'` })
          .where(eq(slackInboundEvents.eventId, id));
      } else {
        expect(outcome).toBe("failed");
      }
    }
    expect(await row(id)).toMatchObject({
      status: "failed",
      attempts: SLACK_INBOUND_MAX_ATTEMPTS,
      claimToken: null,
      nextAttemptAt: null,
    });
    expect(await inbox.claim({ limit: 1, ...LEASE })).toEqual([]);
  });

  test("a lease that runs out on the last attempt ends the row failed", async () => {
    await settle();
    const app = await agentApp();
    const id = await mention(app, { ts: "1792800000.000600" });
    await db
      .update(slackInboundEvents)
      .set({ attempts: SLACK_INBOUND_MAX_ATTEMPTS - 1 })
      .where(eq(slackInboundEvents.eventId, id));
    const [last] = await inbox.claim({
      limit: 1,
      leaseMs: 1,
      maxAttempts: SLACK_INBOUND_MAX_ATTEMPTS,
    });
    expect(last?.attempts).toBe(SLACK_INBOUND_MAX_ATTEMPTS);
    await sleep(20);
    expect(await inbox.claim({ limit: 1, ...LEASE })).toEqual([]);
    expect((await row(id)).status).toBe("failed");
  });

  test("an install revoked while the event waited drops it without its payload", async () => {
    await settle();
    const app = await agentApp();
    const id = await mention(app, { ts: "1792800000.000700" });
    await db
      .update(slackInstallations)
      .set({ status: "revoked", revokedAt: sql`now()` })
      .where(eq(slackInstallations.appId, app.appId));
    // The drain drops a revoked install's event without calling its handler.
    const [claim] = await inbox.claim({ limit: 10, ...LEASE });
    expect(claim?.installationStatus).toBe("revoked");
    if (!claim) throw new Error("not claimed");
    expect(await inbox.drop(claim, "installation_revoked")).toBe(true);
    expect(await row(id)).toMatchObject({
      status: "dropped",
      dropReason: "installation_revoked",
      payload: null,
      conversationKey: null,
      claimToken: null,
    });
  });

  test("two apps of one team keep one row each for one event_id; a retry is a duplicate", async () => {
    await settle();
    const one = await agentApp();
    const two = { ...(await agentApp()), teamId: one.teamId };
    const input = (app: App) => ({
      workspaceId: app.workspaceId,
      agentId: app.agentId,
      slackAppId: app.slackAppId,
      teamId: app.teamId,
      appId: app.appId,
      eventId: "Ev0SHARED",
      eventType: "app_mention",
      eventSubtype: null,
      eventTime: null,
      status: "received" as const,
      payload: {},
      conversationKey: null,
    });
    expect(await inbox.record(input(one))).toBe("recorded");
    expect(await inbox.record(input(two))).toBe("recorded");
    expect(await inbox.record(input(one))).toBe("duplicate");
    expect(await inbox.seen(two.appId, "Ev0SHARED")).toBe(true);
    const rows = await db
      .select({ appId: slackInboundEvents.appId })
      .from(slackInboundEvents)
      .where(eq(slackInboundEvents.eventId, "Ev0SHARED"));
    expect(rows.map((r) => r.appId).sort()).toEqual(
      [one.appId, two.appId].sort(),
    );
  });

  test("lease judgments read the database clock only", async () => {
    const source = await readFile(
      join(import.meta.dir, "slack-inbound-events.ts"),
      "utf8",
    );
    const appClock = source.match(/Date\.now\(|new Date\(/g) ?? [];
    console.log(
      `app clock reads in slack-inbound-events.ts: ${appClock.length}`,
    );
    expect(appClock).toEqual([]);
    expect(source).toContain("lease_expires_at <= now()");
  });
});

describe("migration 0160 over 0159 rows", () => {
  test("keeps them, keys the received ones, and swaps the unique key", async () => {
    const pg = new PGlite();
    try {
      const files = (await readdir(migrations))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      const apply = async (file: string) => {
        const text = await readFile(join(migrations, file), "utf8");
        for (const statement of text.split("--> statement-breakpoint")) {
          if (statement.trim().length > 0) await pg.exec(statement);
        }
      };
      const target = files.findIndex((name) => name.startsWith("0160_"));
      expect(target).toBeGreaterThan(0);
      for (const file of files.slice(0, target)) await apply(file);

      const ws = randomUUID();
      const agent = randomUUID();
      const app = randomUUID();
      await pg.query(
        `INSERT INTO workspaces (id, slug, name) VALUES ($1, 'ws', 'ws')`,
        [ws],
      );
      await pg.query(
        `INSERT INTO agents (id, workspace_id, slug, name) VALUES ($1, $2, 'a', 'A')`,
        [agent, ws],
      );
      await pg.query(
        `INSERT INTO slack_apps (id, workspace_id, kind, agent_id, state, app_id, client_id, redirect_url)
         VALUES ($1, $2, 'agent', $3, 'created', 'A0ONE', '1.1', 'https://console.example/cb')`,
        [app, ws, agent],
      );
      const insert = (
        eventId: string,
        teamId: string,
        status: string,
        payload: object | null,
      ) =>
        pg.query(
          `INSERT INTO slack_inbound_events (id, workspace_id, agent_id, slack_app_id, team_id, app_id, event_id, event_type, status, drop_reason, payload)
           VALUES ($1, $2, $3, $4, $5, 'A0ONE', $6, 'app_mention', $7, $8, $9)`,
          [
            randomUUID(),
            ws,
            agent,
            app,
            teamId,
            eventId,
            status,
            status === "dropped" ? "bot_message" : null,
            payload === null ? null : JSON.stringify(payload),
          ],
        );
      await insert("Ev1", "T1", "received", {
        event: { channel: "C1", ts: "1.1", thread_ts: "1.0" },
      });
      await insert("Ev2", "T1", "received", {
        event: { channel: "C1", ts: "2.0" },
      });
      await insert("Ev3", "T1", "processed", {
        event: { type: "app_uninstalled" },
      });
      await insert("Ev4", "T1", "dropped", null);
      // Read the way the Slack adapter's slackConversationKey reads them.
      await insert("Ev5", "T1", "received", {
        event: { channel: "C1", ts: "5.0", thread_ts: "" },
      });
      await insert("Ev6", "T1", "received", {
        event: { channel: "", ts: "6.0" },
      });
      await insert("Ev7", "T1", "received", {
        event: { channel: "C1", ts: 7 },
      });

      await apply(files[target] as string);

      const rows = await pg.query<{
        event_id: string;
        status: string;
        conversation_key: string | null;
        attempts: number;
        claim_token: string | null;
      }>(
        `SELECT event_id, status, conversation_key, attempts, claim_token FROM slack_inbound_events ORDER BY event_id`,
      );
      expect(rows.rows).toEqual([
        {
          event_id: "Ev1",
          status: "received",
          conversation_key: `${app}:C1:1.0`,
          attempts: 0,
          claim_token: null,
        },
        {
          event_id: "Ev2",
          status: "received",
          conversation_key: `${app}:C1:2.0`,
          attempts: 0,
          claim_token: null,
        },
        {
          event_id: "Ev3",
          status: "processed",
          conversation_key: null,
          attempts: 0,
          claim_token: null,
        },
        {
          event_id: "Ev4",
          status: "dropped",
          conversation_key: null,
          attempts: 0,
          claim_token: null,
        },
        ...(
          [
            ["Ev5", `${app}:C1:5.0`],
            ["Ev6", null],
            ["Ev7", null],
          ] as const
        ).map(([event_id, conversation_key]) => ({
          event_id,
          status: "received",
          conversation_key,
          attempts: 0,
          claim_token: null,
        })),
      ]);
      // (app_id, event_id) now, not (team_id, event_id); and `failed` is a status.
      await expect(insert("Ev1", "T2", "received", {})).rejects.toThrow();
      await pg.query(
        `UPDATE slack_inbound_events SET status = 'failed' WHERE event_id = 'Ev2'`,
      );
      await expect(
        pg.query(
          `UPDATE slack_inbound_events SET status = 'stuck' WHERE event_id = 'Ev2'`,
        ),
      ).rejects.toThrow();
    } finally {
      await pg.close();
    }
  });
});

describe("the payload of a settled row", () => {
  const DAY_MS = 24 * 60 * 60_000;

  async function failed(app: App, ts: string) {
    const id = await mention(app, { ts });
    await db
      .update(slackInboundEvents)
      .set({ status: "failed" })
      .where(eq(slackInboundEvents.eventId, id));
    return id;
  }

  const receivedDaysAgo = (id: string, days: number) =>
    db
      .update(slackInboundEvents)
      .set({ receivedAt: sql`now() - make_interval(days => ${days})` })
      .where(eq(slackInboundEvents.eventId, id));

  test("migration leaves the payload CHECK in place of the dropped-only one", async () => {
    const found = await db.execute<{ conname: string; convalidated: boolean }>(
      sql`SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'slack_inbound_events'::regclass
          AND conname IN ('slack_inbound_events_payload_check', 'slack_inbound_events_dropped_check')`,
    );
    expect(found.rows).toEqual([
      { conname: "slack_inbound_events_payload_check", convalidated: true },
    ]);
  });

  test("completing a row clears its payload; a retry keeps it", async () => {
    await settle();
    const app = await agentApp();
    const done = await mention(app, { ts: "1792800000.000700" });
    const retried = await mention(app, {
      ts: "1792800000.000800",
      channel: "C0OTHER",
    });
    const claims = await inbox.claim({ limit: 10, ...LEASE });
    const claimOf = (eventId: string) => {
      const claim = claims.find((c) => c.eventId === eventId);
      if (!claim) throw new Error(`${eventId} not claimed`);
      return claim;
    };
    expect(await inbox.complete(claimOf(done))).toBe(true);
    expect(
      await inbox.fail(claimOf(retried), {
        retryInMs: backoffMs(1),
        maxAttempts: SLACK_INBOUND_MAX_ATTEMPTS,
      }),
    ).toBe("retry");
    expect(await row(done)).toMatchObject({
      status: "processed",
      payload: null,
    });
    expect(await row(retried)).toMatchObject({
      status: "received",
      payload: expect.objectContaining({ event_id: retried }),
    });
  });

  test("a failed row loses its payload once received 7 days ago, not before", async () => {
    await settle();
    const app = await agentApp();
    const old = await failed(app, "1792800000.000900");
    const recent = await failed(app, "1792800000.001000");
    const waiting = await mention(app, { ts: "1792800000.001100" });
    await receivedDaysAgo(old, 8);
    await receivedDaysAgo(recent, 6);
    await receivedDaysAgo(waiting, 8);

    expect(
      await purgeFailedSlackInboundPayloads(db, { limit: 100, dryRun: true }),
    ).toBe(1);
    expect((await row(old)).payload).not.toBeNull();
    expect(
      await purgeFailedSlackInboundPayloads(db, { limit: 100, dryRun: false }),
    ).toBe(1);
    expect(await row(old)).toMatchObject({ status: "failed", payload: null });
    expect((await row(recent)).payload).not.toBeNull();
    expect((await row(waiting)).payload).not.toBeNull();
    expect(
      await purgeFailedSlackInboundPayloads(db, { limit: 100, dryRun: false }),
    ).toBe(0);

    // The clock moves on past the recent row's seventh day.
    expect(
      await purgeFailedSlackInboundPayloads(db, {
        limit: 100,
        dryRun: false,
        retentionMs: 5 * DAY_MS,
      }),
    ).toBe(1);
    expect((await row(recent)).payload).toBeNull();
    expect((await row(waiting)).payload).not.toBeNull();
  });

  test("the CHECK takes the previous image's writes and refuses a received row without a payload", async () => {
    await settle();
    const app = await agentApp();
    // The previous image completes a row and keeps the payload.
    const kept = await mention(app, { ts: "1792800000.001200" });
    await db
      .update(slackInboundEvents)
      .set({ status: "processed" })
      .where(eq(slackInboundEvents.eventId, kept));
    expect((await row(kept)).payload).not.toBeNull();

    const refusal = async (write: PromiseLike<unknown>) => {
      try {
        await write;
        return "accepted";
      } catch (error) {
        return String((error as { cause?: unknown }).cause ?? error);
      }
    };
    const waiting = await mention(app, { ts: "1792800000.001300" });
    expect(
      await refusal(
        db
          .update(slackInboundEvents)
          .set({ payload: null })
          .where(eq(slackInboundEvents.eventId, waiting)),
      ),
    ).toContain("slack_inbound_events_payload_check");
    const dropped = await mention(app, { ts: "1792800000.001400" });
    expect(
      await refusal(
        db
          .update(slackInboundEvents)
          .set({
            status: "dropped",
            dropReason: "bot_message",
            conversationKey: null,
          })
          .where(eq(slackInboundEvents.eventId, dropped)),
      ),
    ).toContain("slack_inbound_events_payload_check");
    expect((await row(waiting)).payload).not.toBeNull();
    expect((await row(dropped)).status).toBe("received");
  });
});

describe("deferring a Slack inbox row", () => {
  test("a deferred row is released to wait its time; waits spend no attempt, and a late owner defers nothing", async () => {
    await settle();
    const app = await agentApp();
    const id = await mention(app, {
      ts: "1792800000.000910",
      thread: "1792800000.000900",
    });
    const other = await mention(app, {
      ts: "1792800000.000920",
      at: 1_792_800_001,
    });
    for (let wait = 0; wait <= SLACK_INBOUND_MAX_ATTEMPTS; wait += 1) {
      const [claim, ...rest] = await inbox.claim({ limit: 1, ...LEASE });
      expect(claim?.eventId).toBe(id);
      expect(claim?.attempts).toBe(1);
      expect(rest).toEqual([]);
      if (!claim) throw new Error("not claimed");
      expect(await inbox.defer(claim, { retryInMs: 2_000 })).toBe(true);
      expect(await row(id)).toMatchObject({
        status: "received",
        attempts: 0,
        claimToken: null,
        leaseExpiresAt: null,
      });
      const waited = await db.execute<{ secs: number }>(
        sql`SELECT round(extract(epoch FROM next_attempt_at - now()))::int AS secs FROM slack_inbound_events WHERE event_id = ${id}`,
      );
      expect(waited.rows[0]?.secs).toBe(2);
      // Released already: its claim defers nothing again.
      expect(await inbox.defer(claim, { retryInMs: 2_000 })).toBe(false);
      await backoffOver(id);
    }
    // Its thread waited aside; the channel's other thread was there all along.
    await expectTurns([id, other]);
  });
});

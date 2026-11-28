import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type {
  ConversationTopicId,
  ConversationTurnId,
} from "@werft-ai/contracts";
import type { PendingConversationRoute } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { createPostgresConversationStore } from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import {
  agentReleases,
  memberships,
  sessionShares,
  sessions,
  slackInstallations,
  surfaceBindings,
  users,
} from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";
import { makeFixtureRelease, sessionPinColumns } from "../testing/spec-pins.ts";
import { createPostgresConversationRoutes } from "./conversation-routes.ts";

const integration = testDatabaseUrl() ? test : test.skip;
const SECRET = { current: new Uint8Array(32) } as never;

let database: TempDatabase;
let pool: Pool;
let db: Database;
const ws = randomUUID();
const person = randomUUID();
const installationId = randomUUID();
const dmBinding = randomUUID();
let agentId: string;
let release: string;
let dm: string;
let thread = 0;

beforeAll(async () => {
  if (!testDatabaseUrl()) return;
  database = await createTempDatabase({ prefix: "dm3_unbind" });
  pool = new Pool({ connectionString: database.url, max: 4 });
  db = drizzle(pool, { schema }) as unknown as Database;
  release = await makeFixtureRelease(db, { workspaceId: ws });
  const [row] = await db
    .select({ agentId: agentReleases.agentId })
    .from(agentReleases)
    .where(eq(agentReleases.id, release));
  agentId = row?.agentId as string;
  await db.insert(users).values({
    id: person,
    email: `${person}@example.invalid`,
    passwordHash: "argon2id$placeholder",
    displayName: "person",
  });
  await db
    .insert(memberships)
    .values({ workspaceId: ws, userId: person, role: "member" });
  await db.insert(slackInstallations).values({
    id: installationId,
    workspaceId: ws,
    appId: "A0DM3U",
    teamId: "T0DM3U",
  });
  await db.insert(surfaceBindings).values({
    id: dmBinding,
    workspaceId: ws,
    agentId,
    surface: "slack",
    installationId,
    surfaceKind: "dm",
    mode: "on",
    ceilingActions: [],
    ceilingDisclosure: "summary",
  });
  dm = (
    await createPostgresConversationStore(db).findOrCreateConversation({
      kind: "dm",
      workspaceId: ws,
      agentId,
      personUserId: person,
    })
  ).id;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

async function bound() {
  const sessionId = randomUUID();
  await db.insert(sessions).values({
    id: sessionId,
    ownerId: ws,
    workspaceId: ws,
    repoUrl: "https://example.invalid/repo.git",
    branch: "main",
    createdByUserId: person,
    agentReleaseId: release,
    ...sessionPinColumns(),
  });
  await db.insert(sessionShares).values({
    sessionId,
    ownerId: ws,
    workspaceId: ws,
    scope: "private",
  });
  thread += 1;
  const threadTs = `600.${String(thread).padStart(6, "0")}`;
  const route: PendingConversationRoute = {
    turnId: randomUUID() as ConversationTurnId,
    workspaceId: ws,
    agentId,
    conversationId: dm as PendingConversationRoute["conversationId"],
    topicId: randomUUID() as ConversationTopicId,
    sessionId,
    thread: {
      installationId,
      slackAppId: null,
      teamId: "T0DM3U",
      channelId: "D0DM3U",
      threadTs,
      messageTs: threadTs,
    },
    requesterUserId: person,
    subject: null,
    sources: null,
    dm: { personUserId: person, surfaceBindingId: dmBinding },
  };
  const routes = createPostgresConversationRoutes(db, SECRET);
  expect(await routes.bindStandalone(route)).toBe("bound");
  return { route, routes };
}

const linksOf = async (sessionId: string) =>
  rowsOf<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS n FROM session_links
      WHERE session_id = ${sessionId}::uuid`),
  )[0]?.n;

/** Holds `statement`'s row lock in a transaction of its own until released. */
async function holding(statement: string, id: string) {
  const client: PoolClient = await pool.connect();
  await client.query("BEGIN");
  await client.query(statement, [id]);
  return async () => {
    await client.query("ROLLBACK");
    client.release();
  };
}

const settleWithin = async (
  routes: ReturnType<typeof createPostgresConversationRoutes>,
  route: PendingConversationRoute,
) => {
  const started = Date.now();
  await routes.settle(route, "failed", null, null);
  return Date.now() - started;
};

integration(
  "an unhanded end that finds the session held keeps the bind and does not wait",
  async () => {
    const { route, routes } = await bound();
    // A notice writer's order: the session first.
    const release = await holding(
      "SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE",
      route.sessionId,
    );
    try {
      expect(await settleWithin(routes, route)).toBeLessThan(2_000);
    } finally {
      await release();
    }
    expect(await linksOf(route.sessionId)).toBe(1);
  },
);

integration(
  "an unhanded end that finds the link held keeps the bind and does not wait",
  async () => {
    const { route, routes } = await bound();
    // The outbox's order: the link first.
    const release = await holding(
      "SELECT 1 FROM session_links WHERE session_id = $1 FOR SHARE",
      route.sessionId,
    );
    try {
      expect(await settleWithin(routes, route)).toBeLessThan(2_000);
    } finally {
      await release();
    }
    expect(await linksOf(route.sessionId)).toBe(1);
  },
);

integration(
  "an unhanded end with nothing held takes the bind back",
  async () => {
    const { route, routes } = await bound();
    await routes.settle(route, "failed", null, null);
    expect(await linksOf(route.sessionId)).toBe(0);
    const [session] = await db
      .select({ parent: sessions.parentConversationId })
      .from(sessions)
      .where(eq(sessions.id, route.sessionId));
    expect(session?.parent).toBe(null);
  },
);

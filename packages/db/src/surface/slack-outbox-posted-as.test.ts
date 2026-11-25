import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SurfaceOutboxEntry } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { Pool } from "pg";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

// v1-b/N1: a row's send, as it begins, reads the agent's name and, for a
// task (a session with a Slack link), its session's title, under the locks
// that order it against a Slack delete.

const ENGINE = testDatabaseUrl() ? "PostgreSQL" : "PGlite";

let client: {
  query: <Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: Row[] }>;
  exec: (text: string) => Promise<unknown>;
};
let db: Database;
let close = async () => {};
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const INSTALL = crypto.randomUUID();

beforeAll(async () => {
  if (ENGINE === "PGlite") {
    const pglite = await migratedPGlite();
    client = pglite;
    db = drizzle(pglite, { schema }) as unknown as Database;
    close = () => pglite.close();
  } else {
    const database = await createTempDatabase({ prefix: "posted_as" });
    // One connection, so the session setting below holds for every query.
    const pool = new Pool({ connectionString: database.url, max: 1 });
    client = {
      query: <Row extends Record<string, unknown>>(
        text: string,
        params?: unknown[],
      ) => pool.query<Row>(text, params),
      exec: (text) => pool.query(text),
    };
    db = drizzlePostgres(pool, { schema }) as unknown as Database;
    close = async () => {
      await pool.end();
      await database.drop();
    };
  }
  // The rows a row names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  await client.query(
    "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0APP', 'T0INSTALL')",
    [INSTALL, WORKSPACE],
  );
  await client.query(
    "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'payments', 'Payments Agent', $3)",
    [AGENT, WORKSPACE, crypto.randomUUID()],
  );
}, 60_000);

afterAll(() => close(), 60_000);

async function sessionTitled(
  title: string | null,
  titleSource: "user" | "derived" = "user",
) {
  const sessionId = crypto.randomUUID();
  await client.query(
    "INSERT INTO sessions (id, workspace_id, owner_id, repository_mode, title, title_source) VALUES ($1, $2, 'owner', 'none', $3, $4)",
    [sessionId, WORKSPACE, title, titleSource],
  );
  return sessionId;
}

type Link = { id: string; threadTs: string };

async function linkSession(sessionId: string, closed: boolean): Promise<Link> {
  const id = crypto.randomUUID();
  const threadTs = `${Date.now()}.${id.slice(0, 6)}`;
  await client.query(
    `INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id, surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id, release_id, closed_at, closed_reason)
     VALUES ($1, $2, 'owner', $3, $4, $5, $6, 'C0ROOM', $6, $6, $7, 'release-1', ${closed ? "now(), 'completed'" : "NULL, NULL"})`,
    [id, WORKSPACE, sessionId, INSTALL, crypto.randomUUID(), threadTs, AGENT],
  );
  return { id, threadTs };
}

// The session's first turn came from a Slack message that Slack deleted.
async function firstMessageDeleted(sessionId: string) {
  await markDeleted(await firstTurnFrom(sessionId));
}

let turnCount = 0;

async function firstTurnFrom(sessionId: string) {
  // A Slack ts: seconds, a dot, six digits.
  turnCount += 1;
  const ts = `${Date.now()}.${String(turnCount).padStart(6, "0")}`;
  await client.query(
    "INSERT INTO turns (session_id, sequence, message, status, sources) VALUES ($1, 1, 'summarize the thread', 'completed', $2)",
    [
      sessionId,
      JSON.stringify({
        direct: [{ team_id: "T0INSTALL", channel_id: "C0ROOM", ts }],
        inherited: [],
      }),
    ],
  );
  return ts;
}

async function markDeleted(ts: string) {
  await client.query(
    "INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at) VALUES ($1, 'T0INSTALL', 'C0ROOM', $2, now())",
    [WORKSPACE, ts],
  );
}

// A session's row goes to its link's thread, a new open one unless given.
// The link id on the row is what makes it a task's; a row without it (from
// before the column) is one by its session's link, while that is open.
async function claimedPostedAs(row: {
  sessionId: string | null;
  linked: boolean;
  link?: Link;
}) {
  await client.exec("DELETE FROM slack_outbox");
  const outbox = createPostgresSlackOutboxStore(db);
  const link =
    row.link ??
    (row.sessionId === null ? null : await linkSession(row.sessionId, false));
  const entry: SurfaceOutboxEntry = {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    slackAppId: crypto.randomUUID(),
    installationId: INSTALL,
    kind: "model_notice",
    channelId: "C0ROOM",
    threadTs: link?.threadTs ?? "",
    slackUserId: null,
    sessionId: row.sessionId,
    sessionLinkId: row.linked && link !== null ? link.id : null,
    body: { text: "Done." },
    dedupeKey: crypto.randomUUID(),
  };
  expect(await outbox.enqueue(entry)).toBe("enqueued");
  return { outbox, sessionId: row.sessionId };
}

// Claimed, then begun: who the row goes out as.
async function begunAs(
  outbox: ReturnType<typeof createPostgresSlackOutboxStore>,
) {
  const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
  if (claim === undefined) throw new Error("no claim");
  return outbox.beginSend(claim);
}

describe(`beginning an outbox row's send on ${ENGINE}`, () => {
  test("reads a task's agent name and session title", async () => {
    const { outbox } = await claimedPostedAs({
      sessionId: await sessionTitled("Fix the login"),
      linked: true,
    });
    expect(await begunAs(outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: "Fix the login",
    });
  });

  test("reads the title at the send, not at the enqueue", async () => {
    const { outbox, sessionId } = await claimedPostedAs({
      sessionId: await sessionTitled(null),
      linked: true,
    });
    await client.query(
      "UPDATE sessions SET title = 'Named later' WHERE id = $1",
      [sessionId],
    );
    expect(await begunAs(outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: "Named later",
    });
  });

  test("withholds a title cut from a message Slack deleted, not one a person gave", async () => {
    const derived = await sessionTitled("summarize the thread", "derived");
    await firstMessageDeleted(derived);
    const cut = await claimedPostedAs({ sessionId: derived, linked: true });
    expect(await begunAs(cut.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: null,
    });
    const given = await sessionTitled("Fix the login");
    await firstMessageDeleted(given);
    const kept = await claimedPostedAs({ sessionId: given, linked: true });
    expect(await begunAs(kept.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: "Fix the login",
    });
  });

  test("a title whose message Slack deleted after the claim is left out at the send", async () => {
    const derived = await sessionTitled("summarize the thread", "derived");
    const ts = await firstTurnFrom(derived);
    const { outbox } = await claimedPostedAs({
      sessionId: derived,
      linked: true,
    });
    const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (claim === undefined) throw new Error("no claim");
    await markDeleted(ts);
    expect(await outbox.beginSend(claim)).toEqual({
      agentName: "Payments Agent",
      taskTitle: null,
    });
    const [row] = (
      await client.query<{ status: string }>(
        "SELECT status FROM slack_outbox WHERE id = $1",
        [claim.id],
      )
    ).rows;
    expect(row?.status).toBe("sending");
  });

  test("a title kept until the send begins as it is", async () => {
    const derived = await sessionTitled("summarize the thread", "derived");
    await firstTurnFrom(derived);
    const kept = await claimedPostedAs({ sessionId: derived, linked: true });
    const [claim] = await kept.outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (claim === undefined) throw new Error("no claim");
    expect(await kept.outbox.beginSend(claim)).toEqual({
      agentName: "Payments Agent",
      taskTitle: "summarize the thread",
    });
    // A person's title is theirs, whatever happened to the first message.
    const given = await sessionTitled("Fix the login");
    const ts = await firstTurnFrom(given);
    const named = await claimedPostedAs({ sessionId: given, linked: true });
    const [own] = await named.outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (own === undefined) throw new Error("no claim");
    await markDeleted(ts);
    expect(await named.outbox.beginSend(own)).toEqual({
      agentName: "Payments Agent",
      taskTitle: "Fix the login",
    });
  });

  test("a rename or a closed link after the claim is what the send reads", async () => {
    // Renamed by a person, then the first message deleted: the new title.
    const derived = await sessionTitled("summarize the thread", "derived");
    const ts = await firstTurnFrom(derived);
    const renamed = await claimedPostedAs({ sessionId: derived, linked: true });
    const [claim] = await renamed.outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (claim === undefined) throw new Error("no claim");
    await client.query(
      "UPDATE sessions SET title = 'Fix the login', title_source = 'user' WHERE id = $1",
      [derived],
    );
    await markDeleted(ts);
    expect(await renamed.outbox.beginSend(claim)).toEqual({
      agentName: "Payments Agent",
      taskTitle: "Fix the login",
    });
    // A row from before the link column whose link closed since: no longer
    // a task.
    const open = await sessionTitled("Fix the login");
    const link = await linkSession(open, false);
    const direct = await claimedPostedAs({
      sessionId: open,
      linked: false,
      link,
    });
    const [dm] = await direct.outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (dm === undefined) throw new Error("no claim");
    await client.query(
      "UPDATE session_links SET closed_at = now(), closed_reason = 'completed' WHERE id = $1",
      [link.id],
    );
    expect(await direct.outbox.beginSend(dm)).toEqual({
      agentName: "Payments Agent",
      taskTitle: null,
    });
  });

  test("names the task on a row from before the link column while its link is open", async () => {
    const open = await sessionTitled("Fix the login");
    const direct = await claimedPostedAs({ sessionId: open, linked: false });
    expect(await begunAs(direct.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: "Fix the login",
    });
    const closed = await sessionTitled("Done already");
    const late = await claimedPostedAs({
      sessionId: closed,
      linked: false,
      link: await linkSession(closed, true),
    });
    expect(await begunAs(late.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: null,
    });
  });

  test("gives no title to an untitled task or a row with no link", async () => {
    const untitled = await claimedPostedAs({
      sessionId: await sessionTitled(null),
      linked: true,
    });
    expect(await begunAs(untitled.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: null,
    });
    const sessionless = await claimedPostedAs({
      sessionId: null,
      linked: false,
    });
    expect(await begunAs(sessionless.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: null,
    });
  });
});

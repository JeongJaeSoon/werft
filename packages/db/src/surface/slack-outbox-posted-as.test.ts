import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SurfaceOutboxEntry } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

// v1-b/N1: a claimed row carries the agent's name and, for a task (a row of
// a linked session), its session's title as it is at the claim.

let client: PGlite;
let db: Database;
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const INSTALL = crypto.randomUUID();

beforeAll(async () => {
  client = await migratedPGlite();
  // The rows a row names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
  await client.query(
    "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0APP', 'T0INSTALL')",
    [INSTALL, WORKSPACE],
  );
  await client.query(
    "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'payments', 'Payments Agent', $3)",
    [AGENT, WORKSPACE, crypto.randomUUID()],
  );
}, 60_000);

afterAll(async () => {
  await client.close();
});

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

async function linkSession(sessionId: string, closed: boolean) {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id, surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id, release_id, closed_at, closed_reason)
     VALUES ($1, $2, 'owner', $3, $4, $5, $6, 'C0ROOM', $6, $6, $7, 'release-1', ${closed ? "now(), 'completed'" : "NULL, NULL"})`,
    [
      id,
      WORKSPACE,
      sessionId,
      INSTALL,
      crypto.randomUUID(),
      `${Date.now()}.${id.slice(0, 6)}`,
      AGENT,
    ],
  );
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

// A model notice is sent whatever its link, so the claim reads only what is
// under test; the link id alone is what makes the row a task's.
async function claimedPostedAs(row: {
  sessionId: string | null;
  linked: boolean;
}) {
  await client.exec("DELETE FROM slack_outbox");
  const outbox = createPostgresSlackOutboxStore(db);
  const entry: SurfaceOutboxEntry = {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    slackAppId: crypto.randomUUID(),
    installationId: INSTALL,
    kind: "model_notice",
    channelId: "U0PERSON",
    threadTs: "",
    slackUserId: null,
    sessionId: row.sessionId,
    sessionLinkId: row.linked ? crypto.randomUUID() : null,
    body: { text: "Done." },
    dedupeKey: crypto.randomUUID(),
  };
  expect(await outbox.enqueue(entry)).toBe("enqueued");
  return { outbox, sessionId: row.sessionId };
}

async function claimOne(
  outbox: ReturnType<typeof createPostgresSlackOutboxStore>,
) {
  const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
  return claim?.postedAs;
}

describe("claiming an outbox row", () => {
  test("reads a task's agent name and session title", async () => {
    const { outbox } = await claimedPostedAs({
      sessionId: await sessionTitled("Fix the login"),
      linked: true,
    });
    expect(await claimOne(outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: "Fix the login",
    });
  });

  test("reads the title at the claim, not at the enqueue", async () => {
    const { outbox, sessionId } = await claimedPostedAs({
      sessionId: await sessionTitled(null),
      linked: true,
    });
    await client.query(
      "UPDATE sessions SET title = 'Named later' WHERE id = $1",
      [sessionId],
    );
    expect(await claimOne(outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: "Named later",
    });
  });

  test("withholds a title cut from a message Slack deleted, not one a person gave", async () => {
    const derived = await sessionTitled("summarize the thread", "derived");
    await firstMessageDeleted(derived);
    const cut = await claimedPostedAs({ sessionId: derived, linked: true });
    expect(await claimOne(cut.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: null,
    });
    const given = await sessionTitled("Fix the login");
    await firstMessageDeleted(given);
    const kept = await claimedPostedAs({ sessionId: given, linked: true });
    expect(await claimOne(kept.outbox)).toEqual({
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
    expect(claim.postedAs?.taskTitle).toBe("summarize the thread");
    await markDeleted(ts);
    expect(await outbox.beginSend(claim)).toBe("untitled");
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
    expect(await kept.outbox.beginSend(claim)).toBe(true);
    // A person's title is theirs, whatever happened to the first message.
    const given = await sessionTitled("Fix the login");
    const ts = await firstTurnFrom(given);
    const named = await claimedPostedAs({ sessionId: given, linked: true });
    const [own] = await named.outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (own === undefined) throw new Error("no claim");
    await markDeleted(ts);
    expect(await named.outbox.beginSend(own)).toBe(true);
  });

  test("names the task on a row sent outside its thread while its link is open", async () => {
    const open = await sessionTitled("Fix the login");
    await linkSession(open, false);
    const direct = await claimedPostedAs({ sessionId: open, linked: false });
    expect(await claimOne(direct.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: "Fix the login",
    });
    const closed = await sessionTitled("Done already");
    await linkSession(closed, true);
    const late = await claimedPostedAs({ sessionId: closed, linked: false });
    expect(await claimOne(late.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: null,
    });
  });

  test("gives no title to an untitled task or a row with no link", async () => {
    const untitled = await claimedPostedAs({
      sessionId: await sessionTitled(null),
      linked: true,
    });
    expect(await claimOne(untitled.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: null,
    });
    const unlinked = await claimedPostedAs({
      sessionId: await sessionTitled("Not a task"),
      linked: false,
    });
    expect(await claimOne(unlinked.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: null,
    });
    const sessionless = await claimedPostedAs({
      sessionId: null,
      linked: false,
    });
    expect(await claimOne(sessionless.outbox)).toEqual({
      agentName: "Payments Agent",
      taskTitle: null,
    });
  });
});

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

async function sessionTitled(title: string | null) {
  const sessionId = crypto.randomUUID();
  await client.query(
    "INSERT INTO sessions (id, owner_id, repository_mode, title) VALUES ($1, 'owner', 'none', $2)",
    [sessionId, title],
  );
  return sessionId;
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

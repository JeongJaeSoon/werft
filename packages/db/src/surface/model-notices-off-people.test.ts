import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { sessionLinks, slackOutbox } from "../schema.ts";
import { moveModelNoticesOffPeople } from "./model-notices-off-people.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

let client: PGlite;
let db: Database;
const WORKSPACE = crypto.randomUUID();
const AGENT = crypto.randomUUID();
const INSTALL = crypto.randomUUID();
const APP_ROW = crypto.randomUUID();
const THREAD = "1700000000.000100";

beforeAll(async () => {
  client = await migratedPGlite();
  // The rows a row names are not what is under test; skip their foreign keys.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema }) as unknown as Database;
  await client.query(
    "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0APP', 'T1')",
    [INSTALL, WORKSPACE],
  );
  await client.query(
    "INSERT INTO slack_apps (id, workspace_id, kind, agent_id, state, app_id, redirect_url) VALUES ($1, $2, 'agent', $3, 'creating', 'A0APP', 'https://example.test')",
    [APP_ROW, WORKSPACE, AGENT],
  );
}, 60_000);

afterEach(async () => {
  await client.exec("DELETE FROM slack_outbox; DELETE FROM session_links");
});

afterAll(async () => {
  await client.close();
});

async function threadOf(sessionId: string, flags: { muted?: boolean } = {}) {
  const id = crypto.randomUUID();
  await db.insert(sessionLinks).values({
    id,
    workspaceId: WORKSPACE,
    ownerId: "owner",
    sessionId,
    installationId: INSTALL,
    surfaceBindingId: crypto.randomUUID(),
    surfaceRef: `slack:T1:C0WORK:${id}`,
    channelId: "C0WORK",
    threadId: THREAD,
    openedByTs: THREAD,
    agentId: AGENT,
    releaseId: "release-1",
    muted: flags.muted ?? false,
  });
  return id;
}

let seq = 0;

/** A model notice as a release before 94S-2040 wrote it: a DM to one person. */
async function toPerson(row: {
  sessionId: string | null;
  person: string;
  notice?: string;
  status?: "pending" | "sending" | "sent" | "failed" | "uncertain";
  keyWithoutInstallation?: boolean;
}) {
  seq += 1;
  const notice =
    row.notice ??
    (row.sessionId === null
      ? `model-move:failed:${AGENT}:m-old:m-new:3`
      : `model-not-allowed:${WORKSPACE}:${row.sessionId}`);
  const id = crypto.randomUUID();
  await db.insert(slackOutbox).values({
    id,
    workspaceId: WORKSPACE,
    agentId: AGENT,
    slackAppId: APP_ROW,
    installationId: INSTALL,
    kind: "model_notice",
    channelId: row.person,
    threadTs: "",
    slackUserId: null,
    sessionId: row.sessionId,
    body: { text: `notice ${seq}`, locale: "en" },
    dedupeKey: row.keyWithoutInstallation
      ? `${notice}:${row.person}`
      : `${notice}:${INSTALL}:${row.person}`,
    status: row.status ?? "pending",
    ...(row.status === "sending"
      ? {
          claimToken: crypto.randomUUID(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }
      : {}),
  });
  return id;
}

const rows = () =>
  db
    .select({
      id: slackOutbox.id,
      status: slackOutbox.status,
      channelId: slackOutbox.channelId,
      threadTs: slackOutbox.threadTs,
      sessionLinkId: slackOutbox.sessionLinkId,
      dedupeKey: slackOutbox.dedupeKey,
      body: slackOutbox.body,
    })
    .from(slackOutbox)
    .orderBy(asc(slackOutbox.seq));

// 94S-2040: a model notice goes to its session's thread, never to a person.
describe("moveModelNoticesOffPeople", () => {
  test("a waiting notice goes to its session's thread once; every other DM row is deleted", async () => {
    const told = crypto.randomUUID();
    const link = await threadOf(told);
    const creator = await toPerson({ sessionId: told, person: "UCREATOR" });
    // The same notice for an administrator: one post in the thread is all.
    await toPerson({ sessionId: told, person: "UADMIN" });
    // History of what went, or failed to.
    await toPerson({ sessionId: told, person: "UOLD", status: "sent" });
    await toPerson({ sessionId: told, person: "UGONE", status: "failed" });
    await toPerson({ sessionId: told, person: "ULOST", status: "uncertain" });
    // No thread: the session's history on the web keeps the notice.
    await toPerson({ sessionId: crypto.randomUUID(), person: "UWEB" });
    // An agent's own model move has no session and no thread.
    await toPerson({ sessionId: null, person: "WGRIDADMIN" });
    // A row of the thread itself is no person's.
    await db.insert(slackOutbox).values({
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE,
      agentId: AGENT,
      slackAppId: APP_ROW,
      installationId: INSTALL,
      kind: "reply",
      channelId: "C0WORK",
      threadTs: THREAD,
      slackUserId: null,
      sessionId: told,
      sessionLinkId: link,
      body: { text: "an answer" },
      dedupeKey: "reply:1",
      status: "sent",
    });

    expect(await moveModelNoticesOffPeople(db)).toEqual({
      moved: 1,
      deleted: { pending: 3, sent: 1, failed: 1, uncertain: 1 },
      sending: 0,
      failed: [],
    });
    expect(await rows()).toEqual([
      {
        id: creator,
        status: "pending",
        channelId: "C0WORK",
        threadTs: THREAD,
        sessionLinkId: link,
        dedupeKey: `model-not-allowed:${WORKSPACE}:${told}:${link}`,
        body: { text: "notice 1", locale: "en" },
      },
      expect.objectContaining({ dedupeKey: "reply:1", channelId: "C0WORK" }),
    ]);
    // Of the admin's copy and the no-thread and agent rows, nothing is left.
    expect((await rows()).map((row) => row.channelId)).not.toContainEqual(
      expect.stringMatching(/^[UW]/),
    );
  });

  test("runs again to the same end: nothing left to move", async () => {
    const session = crypto.randomUUID();
    await threadOf(session);
    await toPerson({ sessionId: session, person: "UCREATOR" });
    await toPerson({ sessionId: null, person: "UADMIN" });
    const first = await moveModelNoticesOffPeople(db);
    const after = await rows();
    expect(first.moved).toBe(1);
    expect(await moveModelNoticesOffPeople(db)).toEqual({
      moved: 0,
      deleted: {},
      sending: 0,
      failed: [],
    });
    expect(await rows()).toEqual(after);
  });

  test("a notice the thread was already told of is deleted, not told twice", async () => {
    const session = crypto.randomUUID();
    const link = await threadOf(session);
    await toPerson({ sessionId: session, person: "UCREATOR" });
    await moveModelNoticesOffPeople(db);
    // An earlier image beside this one writes the same notice to a person.
    await toPerson({ sessionId: session, person: "UADMIN" });
    expect(await moveModelNoticesOffPeople(db)).toMatchObject({
      moved: 0,
      deleted: { pending: 1 },
    });
    expect((await rows()).map((row) => row.sessionLinkId)).toEqual([link]);
  });

  test("a key from before installations were in it names the notice too", async () => {
    const session = crypto.randomUUID();
    const link = await threadOf(session);
    await toPerson({
      sessionId: session,
      person: "UCREATOR",
      notice: `runtime-retired:${WORKSPACE}:${session}:4`,
      keyWithoutInstallation: true,
    });
    await moveModelNoticesOffPeople(db);
    expect((await rows()).map((row) => row.dedupeKey)).toEqual([
      `runtime-retired:${WORKSPACE}:${session}:4:${link}`,
    ]);
  });

  test("a muted thread is no thread: the waiting notice is deleted", async () => {
    const session = crypto.randomUUID();
    await threadOf(session, { muted: true });
    await toPerson({ sessionId: session, person: "UCREATOR" });
    expect(await moveModelNoticesOffPeople(db)).toMatchObject({
      moved: 0,
      deleted: { pending: 1 },
    });
    expect(await rows()).toEqual([]);
  });

  test("a row being sent is left for the next start", async () => {
    const session = crypto.randomUUID();
    await threadOf(session);
    const sending = await toPerson({
      sessionId: session,
      person: "UCREATOR",
      status: "sending",
    });
    expect(await moveModelNoticesOffPeople(db)).toMatchObject({
      moved: 0,
      deleted: {},
      sending: 1,
    });
    expect((await rows()).map((row) => row.id)).toEqual([sending]);
  });

  test("a moved row is claimed for its thread, where a DM row was not", async () => {
    const session = crypto.randomUUID();
    const link = await threadOf(session);
    const moved = await toPerson({ sessionId: session, person: "UCREATOR" });
    const outbox = createPostgresSlackOutboxStore(db);
    // Before the pass the claim takes no DM row: it names no link.
    expect(await outbox.claim({ limit: 10, leaseMs: 30_000 })).toEqual([]);
    await moveModelNoticesOffPeople(db);
    const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    expect(claim).toMatchObject({
      id: moved,
      kind: "model_notice",
      channelId: "C0WORK",
      threadTs: THREAD,
      sessionLinkId: link,
    });
  });
});

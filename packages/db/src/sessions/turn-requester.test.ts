import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { queuePushFollowUps } from "../action/push-follow-ups.ts";
import * as schema from "../schema.ts";
import { sessions, turns } from "../schema.ts";
import { createPostgresCommitAttributionLedger } from "./commit-attributions.ts";
import { createPostgresSessionAttributionStore } from "./session-attribution.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  await client.query("SET session_replication_role = replica");
});

afterEach(async () => {
  await client.close();
});

const uuid = () => crypto.randomUUID();

async function person(): Promise<string> {
  const id = uuid();
  await client.query(
    "INSERT INTO users (id, email, password_hash, display_name) VALUES ($1, $2, 'x', 'p')",
    [id, `${id}@example.invalid`],
  );
  return id;
}

async function workspace(): Promise<string> {
  const id = uuid();
  await client.query(
    "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
    [id, `ws-${id.slice(0, 8)}`],
  );
  return id;
}

async function session(workspaceId: string): Promise<string> {
  const id = uuid();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id, channel)
     VALUES ($1, $2::text, 'https://github.com/acme/app.git', 'main', $2::uuid, 'web')`,
    [id, workspaceId],
  );
  return id;
}

async function turn(
  sessionId: string,
  sequence: number,
  actorId: string | null,
  channel: "web" | "slack" | "api" | null,
): Promise<number> {
  const result = await client.query<{ id: number }>(
    `INSERT INTO turns (session_id, sequence, message, status, actor_id, channel)
     VALUES ($1, $2, 'go', 'completed', $3, $4) RETURNING id`,
    [sessionId, sequence, actorId, channel],
  );
  return Number(result.rows[0]?.id);
}

async function pushRequestOf(
  workspaceId: string,
  sessionId: string,
  turnRowId: number | null,
): Promise<string> {
  const id = uuid();
  await client.query(
    `INSERT INTO push_requests (id, owner_id, session_id, repository_id, checkpoint_revision, git_commit, target_branch, state, requested_by, request_receipt_id)
     VALUES ($1::uuid, $2, $3::uuid, 'repo', 1, repeat('a', 40), 'agent/' || $3::text || '-b' || left(replace($1::text, '-', ''), 12), 'requested', '{}', $1::uuid)`,
    [id, workspaceId, sessionId],
  );
  if (turnRowId !== null) {
    await client.query(
      `INSERT INTO push_intents (id, owner_id, session_id, turn_id, attempt_id, repository_id, target_branch, status, pinned_revision, push_request_id, actor)
       VALUES ($1, $2, $3::uuid, $4, 'att', 'repo', 'agent/x', 'requested', 1, $5, '{}')`,
      [uuid(), workspaceId, sessionId, turnRowId, id],
    );
  }
  return id;
}

describe("the requester of a push request", () => {
  test("is the actor and channel of the turn whose intent made it", async () => {
    const ws = await workspace();
    const alice = await person();
    const sessionId = await session(ws);
    await turn(sessionId, 1, null, "web");
    const asked = await turn(sessionId, 2, alice, "slack");
    const request = await pushRequestOf(ws, sessionId, asked);
    const store = createPostgresSessionAttributionStore(db);
    expect(
      await store.requesterOfPushRequest(sessionId.toUpperCase(), request),
    ).toEqual({ userId: alice, channel: "slack" });
  });

  test("is no one for a turn nobody asked, and unknown for a request no intent made", async () => {
    const ws = await workspace();
    const sessionId = await session(ws);
    const platformTurn = await turn(sessionId, 1, null, null);
    const store = createPostgresSessionAttributionStore(db);
    const byAgent = await pushRequestOf(ws, sessionId, platformTurn);
    expect(await store.requesterOfPushRequest(sessionId, byAgent)).toEqual({
      userId: null,
      channel: null,
    });
    const direct = await pushRequestOf(ws, sessionId, null);
    expect(await store.requesterOfPushRequest(sessionId, direct)).toBeNull();
    expect(await store.requesterOfPushRequest(sessionId, uuid())).toBeNull();
  });
});

describe("a person's GitHub link in the session's workspace", () => {
  async function link(workspaceId: string, userId: string, githubId: string) {
    await client.query(
      `INSERT INTO linked_accounts (id, workspace_id, user_id, provider, external_tenant, external_user_id, external_user_name, verified_via, verified_at)
       VALUES ($1, $2, $3, 'github', 'github.com', $4, 'octocat', 'github_oauth', now())`,
      [uuid(), workspaceId, userId, githubId],
    );
  }

  test("is the active link as GitHub named it, none once revoked or in another workspace", async () => {
    const ws = await workspace();
    const other = await workspace();
    const alice = await person();
    const bob = await person();
    const sessionId = await session(ws);
    const store = createPostgresSessionAttributionStore(db);
    expect(await store.githubLinkOf(sessionId, alice)).toBeNull();

    await link(ws, alice, "583231");
    await link(other, bob, "778");
    expect(await store.githubLinkOf(sessionId.toUpperCase(), alice)).toEqual({
      id: "583231",
      login: "octocat",
    });
    expect(await store.githubLinkOf(sessionId, bob)).toBeNull();

    await client.query(
      "UPDATE linked_accounts SET status = 'revoked', revoked_reason = 'unlinked', revoked_at = now() WHERE user_id = $1",
      [alice],
    );
    expect(await store.githubLinkOf(sessionId, alice)).toBeNull();
    expect(await store.githubLinkOf(uuid(), alice)).toBeNull();
  });
});

describe("the follow-up turn the platform queues", () => {
  test("carries the requester of the turn whose intent made the push", async () => {
    const ws = await workspace();
    const alice = await person();
    const sessionId = await session(ws);
    const asked = await turn(sessionId, 1, alice, "slack");
    const request = await pushRequestOf(ws, sessionId, asked);
    await client.query(
      "INSERT INTO push_follow_ups (push_request_id, session_id, message) VALUES ($1, $2, 'note')",
      [request, sessionId],
    );
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (row === undefined) throw new Error("no session");

    expect(await queuePushFollowUps(db, { session: row })).toBe(1);

    const queued = await db
      .select({ actorId: turns.actorId, channel: turns.channel })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(turns.sequence);
    expect(queued).toEqual([
      { actorId: alice, channel: "slack" },
      { actorId: alice, channel: null },
    ]);
  });

  test("names no one when no intent made the push", async () => {
    const ws = await workspace();
    const sessionId = await session(ws);
    await turn(sessionId, 1, await person(), "web");
    const request = await pushRequestOf(ws, sessionId, null);
    await client.query(
      "INSERT INTO push_follow_ups (push_request_id, session_id, message) VALUES ($1, $2, 'note')",
      [request, sessionId],
    );
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (row === undefined) throw new Error("no session");
    await queuePushFollowUps(db, { session: row });
    const queued = await db
      .select({ actorId: turns.actorId })
      .from(turns)
      .where(eq(turns.sessionId, sessionId))
      .orderBy(turns.sequence);
    expect(queued.at(-1)).toEqual({ actorId: null });
  });
});

describe("the issued bundles a turn's co-author adds", () => {
  const BOT = {
    name: "werft-dev[bot]",
    email: "41898282+werft-dev[bot]@users.noreply.github.com",
  };
  const OCTOCAT = {
    name: "octocat",
    email: "583231+octocat@users.noreply.github.com",
  };

  test("copies each issued author and Agent-Session with the new co-author, once", async () => {
    const ws = await workspace();
    const sessionId = await session(ws);
    const ledger = createPostgresCommitAttributionLedger(db);
    await ledger.record(sessionId, {
      author: BOT,
      coAuthor: null,
      agentSession: "https://c/s/1",
    });
    await ledger.recordTurnCoAuthor(sessionId.toUpperCase(), OCTOCAT);
    await ledger.recordTurnCoAuthor(sessionId, OCTOCAT);
    await ledger.recordTurnCoAuthor(sessionId, null);

    expect(await ledger.list(sessionId)).toEqual([
      { author: BOT, coAuthor: null, agentSession: "https://c/s/1" },
      { author: BOT, coAuthor: OCTOCAT, agentSession: "https://c/s/1" },
    ]);
  });

  test("with no bundle issued there is nothing to copy", async () => {
    const ws = await workspace();
    const sessionId = await session(ws);
    const ledger = createPostgresCommitAttributionLedger(db);
    await ledger.recordTurnCoAuthor(sessionId, OCTOCAT);
    expect(await ledger.list(sessionId)).toEqual([]);
  });
});

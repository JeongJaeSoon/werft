import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { ConversationId } from "@werft-ai/contracts";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { fillSessionParents } from "./conversations/session-parents.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import { makeFixtureRelease, TEST_MODEL } from "./testing/spec-pins.ts";

/**
 * The start-time pass gives every linked session its main conversation (a
 * channel thread its channel's, a DM its person's, a closed link's session
 * too), leaves a session with no link empty, finds the DM person on the link
 * and then on the session, and runs again to the same rows.
 */
describe("fillSessionParents", () => {
  let client: PGlite;
  let db: Database;
  const workspaceId = randomUUID();
  const installationId = randomUUID();
  const teamId = "T0001";
  const ada = randomUUID();
  const bea = randomUUID();
  const gone = randomUUID();
  let releaseId: string;
  let agentId: string;
  let dmBinding: string;
  let channelBinding: string;

  const rows = async <T>(sql: string, params: unknown[] = []) =>
    (await client.query<T>(sql, params)).rows;
  const parentOf = async (sessionId: string) =>
    (
      await rows<{ parent_conversation_id: string | null }>(
        "SELECT parent_conversation_id FROM sessions WHERE id = $1",
        [sessionId],
      )
    )[0]?.parent_conversation_id ?? null;
  const conversationOf = async (sessionId: string) =>
    (
      await rows<{
        kind: string;
        team_id: string | null;
        channel_id: string | null;
        person_user_id: string | null;
      }>(
        `SELECT c.kind, c.team_id, c.channel_id, c.person_user_id
         FROM sessions s JOIN conversations c ON c.id = s.parent_conversation_id
         WHERE s.id = $1`,
        [sessionId],
      )
    )[0] ?? null;
  const parents = async () =>
    rows<{ id: string; parent_conversation_id: string | null }>(
      "SELECT id, parent_conversation_id FROM sessions ORDER BY id",
    );
  // What the ticket's done check reads: linked sessions left empty.
  const linkedWithoutParent = async () =>
    Number(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM sessions s
           JOIN session_links l ON l.session_id = s.id
           WHERE s.parent_conversation_id IS NULL`,
        )
      )[0]?.n,
    );

  async function addSession(createdBy: string | null = null) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id, created_by_user_id)
       VALUES ($1, $2::text, 'https://example.invalid/repo.git', $3, $2::uuid, $4)`,
      [id, workspaceId, `session/${id}`, createdBy],
    );
    return id;
  }

  async function addLink(
    sessionId: string,
    link: {
      binding: string;
      channelId: string;
      createdBy?: string | null;
      closed?: boolean;
    },
  ) {
    const thread = `${Math.floor(Math.random() * 1e9)}.000100`;
    await client.query(
      `INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id,
         surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id,
         release_id, created_by, revoked_at, closed_at, closed_reason)
       VALUES ($1, $2::uuid, $2::text, $3, $4, $5, $6, $7, $8, $8, $9, $10, $11,
         $12::timestamptz, $12::timestamptz,
         CASE WHEN $12::timestamptz IS NULL THEN NULL ELSE 'abandoned' END)`,
      [
        randomUUID(),
        workspaceId,
        sessionId,
        installationId,
        link.binding,
        `${link.channelId}:${thread}`,
        link.channelId,
        thread,
        agentId,
        releaseId,
        link.createdBy ?? null,
        link.closed ? new Date().toISOString() : null,
      ],
    );
  }

  async function addBinding(
    kind: "dm" | "public_channel",
    channel: string | null,
  ) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface, installation_id,
         external_surface_id, surface_kind, mode, ceiling_actions, ceiling_disclosure, status)
       VALUES ($1, $2, $3, 'slack', $4, $5, $6, 'on', '{}', 'full', 'ready')`,
      [id, workspaceId, agentId, installationId, channel, kind],
    );
    return id;
  }

  beforeEach(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    releaseId = await makeFixtureRelease(db, {
      workspaceId,
      model: TEST_MODEL,
    });
    agentId = (
      await rows<{ agent_id: string }>(
        "SELECT agent_id FROM agent_releases WHERE id = $1",
        [releaseId],
      )
    )[0]?.agent_id as string;
    for (const id of [ada, bea, gone]) {
      await client.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
        [id, `${id}@example.invalid`],
      );
    }
    // `gone` was never a member, as a person whose membership was removed.
    await client.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member') ON CONFLICT DO NOTHING",
      [workspaceId, ada, bea],
    );
    await client.query(
      "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0001', $3)",
      [installationId, workspaceId, teamId],
    );
    dmBinding = await addBinding("dm", null);
    channelBinding = await addBinding("public_channel", "C0001");
  });

  afterEach(async () => {
    await client.close();
  });

  test("each kind of session gets the parent its link names, and a second run changes nothing", async () => {
    const web = await addSession(ada);
    const channel = await addSession(ada);
    await addLink(channel, {
      binding: channelBinding,
      channelId: "C0001",
      createdBy: ada,
    });
    const dm = await addSession(ada);
    await addLink(dm, {
      binding: dmBinding,
      channelId: "D0001",
      createdBy: ada,
    });
    const closed = await addSession(null);
    await addLink(closed, {
      binding: channelBinding,
      channelId: "C0002",
      closed: true,
    });
    // The requester columns are not filled: rows from before stay null.
    const requesterNull = () =>
      rows<{ n: number }>(
        "SELECT count(*)::int AS n FROM sessions WHERE requester_kind IS NULL",
      );
    const before = await requesterNull();

    expect(await fillSessionParents(db, { batchSize: 2 })).toEqual({
      filled: 3,
      skipped: { no_person: 0, no_membership: 0 },
      failed: [],
    });
    expect(await parentOf(web)).toBeNull();
    expect(await conversationOf(channel)).toEqual({
      kind: "channel",
      team_id: teamId,
      channel_id: "C0001",
      person_user_id: null,
    });
    expect(await conversationOf(dm)).toEqual({
      kind: "dm",
      team_id: null,
      channel_id: null,
      person_user_id: ada,
    });
    expect(await conversationOf(closed)).toEqual({
      kind: "channel",
      team_id: teamId,
      channel_id: "C0002",
      person_user_id: null,
    });
    expect(await linkedWithoutParent()).toBe(0);
    expect(await requesterNull()).toEqual(before);

    const once = await parents();
    expect(await fillSessionParents(db)).toEqual({
      filled: 0,
      skipped: { no_person: 0, no_membership: 0 },
      failed: [],
    });
    expect(await parents()).toEqual(once);
  });

  test("two sessions of one channel share its conversation", async () => {
    const first = await addSession();
    const second = await addSession();
    await addLink(first, { binding: channelBinding, channelId: "C0001" });
    await addLink(second, { binding: channelBinding, channelId: "C0001" });
    await fillSessionParents(db);
    expect(await parentOf(first)).not.toBeNull();
    expect(await parentOf(first)).toBe(await parentOf(second));
  });

  test("a DM's person is the session's opener, else the link's creator, else none", async () => {
    // Ada's link, whose first post gave out, opened by Bea: Bea's DM, as the
    // session's first input is.
    const reopened = await addSession(bea);
    await addLink(reopened, {
      binding: dmBinding,
      channelId: "D0006",
      createdBy: ada,
    });
    const byLink = await addSession(null);
    await addLink(byLink, {
      binding: dmBinding,
      channelId: "D0007",
      createdBy: ada,
    });
    const bySession = await addSession(bea);
    await addLink(bySession, { binding: dmBinding, channelId: "D0002" });
    const notMember = await addSession(bea);
    await addLink(notMember, {
      binding: dmBinding,
      channelId: "D0003",
      createdBy: gone,
    });
    const noOne = await addSession(null);
    await addLink(noOne, { binding: dmBinding, channelId: "D0004" });
    const nobodyMember = await addSession(gone);
    await addLink(nobodyMember, {
      binding: dmBinding,
      channelId: "D0005",
      createdBy: gone,
    });

    expect(await fillSessionParents(db)).toEqual({
      filled: 4,
      skipped: { no_person: 1, no_membership: 1 },
      failed: [],
    });
    expect((await conversationOf(reopened))?.person_user_id).toBe(bea);
    expect((await conversationOf(byLink))?.person_user_id).toBe(ada);
    expect((await conversationOf(bySession))?.person_user_id).toBe(bea);
    expect((await conversationOf(notMember))?.person_user_id).toBe(bea);
    expect(await parentOf(noOne)).toBeNull();
    expect(await parentOf(nobodyMember)).toBeNull();

    // A person who joins later is found by the next start.
    await client.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [workspaceId, gone],
    );
    expect(await fillSessionParents(db)).toEqual({
      filled: 1,
      skipped: { no_person: 1, no_membership: 0 },
      failed: [],
    });
    expect((await conversationOf(nobodyMember))?.person_user_id).toBe(gone);
  });

  test("a run cut short goes on from the sessions still empty", async () => {
    const done = await addSession();
    const left = await addSession();
    await addLink(done, { binding: channelBinding, channelId: "C0001" });
    await addLink(left, { binding: channelBinding, channelId: "C0002" });
    // What a run that died after its first session leaves.
    await fillSessionParents(db);
    const kept = await parentOf(done);
    await client.query(
      "UPDATE sessions SET parent_conversation_id = NULL WHERE id = $1",
      [left],
    );

    expect((await fillSessionParents(db)).filled).toBe(1);
    expect(await parentOf(done)).toBe(kept);
    expect((await conversationOf(left))?.channel_id).toBe("C0002");
  });

  test("one session that cannot be filled does not stop the rest", async () => {
    const bad = await addSession();
    const good = await addSession();
    // Slack never sends such an id; the conversation refuses it.
    await addLink(bad, { binding: channelBinding, channelId: "C 0001" });
    await addLink(good, { binding: channelBinding, channelId: "C0001" });
    const result = await fillSessionParents(db);
    expect(result.filled).toBe(1);
    expect(result.failed.map((f) => f.sessionId)).toEqual([bad]);
    expect(await parentOf(good)).not.toBeNull();
  });

  test("a new session keeps the parent it was accepted with, and none without", async () => {
    const [conversation] = await rows<{ id: string }>(
      `INSERT INTO conversations (id, workspace_id, agent_id, kind, person_user_id)
       VALUES ($1, $2, $3, 'dm', $4) RETURNING id`,
      [randomUUID(), workspaceId, agentId, ada],
    );
    const accept = (parentConversationId?: ConversationId) =>
      createPostgresSessionUnitOfWork(db).acceptInputAtomic({
        limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
        principal: { ownerId: workspaceId },
        idempotencyKey: randomUUID(),
        payloadHash: randomUUID(),
        agentReleaseId: releaseId,
        model: TEST_MODEL,
        repository: "none",
        message: "hello",
        ...(parentConversationId === undefined ? {} : { parentConversationId }),
      });
    const linked = await accept(conversation?.id as ConversationId);
    const standalone = await accept();
    if (linked.outcome !== "accepted" || standalone.outcome !== "accepted") {
      throw new Error(`${linked.outcome} / ${standalone.outcome}`);
    }
    expect(await parentOf(linked.response.session_id)).toBe(
      conversation?.id ?? "",
    );
    expect(await parentOf(standalone.response.session_id)).toBeNull();
    // The response names no parent: the API's answer is as it was.
    expect(Object.keys(linked.response).sort()).toEqual(
      Object.keys(standalone.response).sort(),
    );
  });
});

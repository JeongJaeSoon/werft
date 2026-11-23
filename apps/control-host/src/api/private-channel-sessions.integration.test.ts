import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Database } from "@werft-ai/db";
import * as schema from "@werft-ai/db";
import { makeFixtureRelease, TEST_MODEL } from "@werft-ai/db/testing/spec-pins";
import type { SecretKey } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  PRIVATE_CHANNEL_SESSIONS_EXIT,
  type PrivateChannelSlack,
  runPrivateChannelSessions,
} from "./private-channel-sessions.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("private-channel-sessions on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: Database;
  const workspaceId = randomUUID();
  const creator = randomUUID();
  const named = randomUUID();
  let agentId = "";
  let shared = "";
  let open = "";
  let stale = "";

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "private_channel_cli" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema }) as unknown as Database;
    const releaseId = await makeFixtureRelease(db, {
      workspaceId,
      model: TEST_MODEL,
    });
    agentId = (
      await pool.query<{ agent_id: string }>(
        "SELECT agent_id FROM agent_releases WHERE id = $1",
        [releaseId],
      )
    ).rows[0]?.agent_id as string;
    for (const user of [creator, named]) {
      await pool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
        [user, `${user}@example.invalid`],
      );
      await pool.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
        [workspaceId, user],
      );
    }
    const installationId = randomUUID();
    await pool.query(
      "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, $3, 'T1')",
      [installationId, workspaceId, `A${installationId.slice(0, 8)}`],
    );
    const bindings: Record<string, string> = {};
    for (const [channel, kind] of [
      ["G1", "private_channel"],
      ["G9", "private_channel"],
      // Slack says private now, the binding has not caught up.
      ["G2", "public_channel"],
    ] as const) {
      bindings[channel] = randomUUID();
      await pool.query(
        `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface, installation_id,
           external_surface_id, surface_kind, mode, ceiling_actions, ceiling_disclosure, status)
         VALUES ($1, $2, $3, 'slack', $4, $5, $6, 'on', '{}', 'full', 'ready')`,
        [
          bindings[channel],
          workspaceId,
          agentId,
          installationId,
          channel,
          kind,
        ],
      );
    }
    // A Slack session hangs off the conversation of its channel, which is
    // what the private channel's door reads.
    const parents: Record<string, string> = {};
    for (const channel of ["G1", "G9", "G2"]) {
      parents[channel] = randomUUID();
      await pool.query(
        "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, 'T1', $3)",
        [randomUUID(), workspaceId, channel],
      );
      await pool.query(
        "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id) VALUES ($1, $2, $3, 'channel', 'T1', $4)",
        [parents[channel], workspaceId, agentId, channel],
      );
    }
    let n = 0;
    const session = async (channel: string) => {
      const id = randomUUID();
      n += 1;
      await pool.query(
        `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id, created_by_user_id, parent_conversation_id)
         VALUES ($1, $2::text, 'https://example.invalid/repo.git', $3, $2::uuid, $4, $5)`,
        [id, workspaceId, `session/${id}`, creator, parents[channel]],
      );
      await pool.query(
        `INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id,
           surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id, release_id)
         VALUES ($1, $2::uuid, $2::text, $3, $4, $5, $6, $7, $8, $8, $9, $10)`,
        [
          randomUUID(),
          workspaceId,
          id,
          installationId,
          bindings[channel],
          `${channel}:${n}.1`,
          channel,
          `${n}.1`,
          agentId,
          releaseId,
        ],
      );
      return id;
    };
    open = await session("G1");
    shared = await session("G1");
    await session("G9");
    stale = await session("G2");
    for (const id of [shared, stale]) {
      await pool.query(
        "INSERT INTO session_shares (session_id, owner_id, workspace_id, scope) VALUES ($1, $2::text, $2::uuid, 'people')",
        [id, workspaceId],
      );
      await pool.query(
        "INSERT INTO session_share_targets (id, workspace_id, session_id, user_id) VALUES ($1, $2, $3, $4)",
        [randomUUID(), workspaceId, id, named],
      );
    }
    await pool.query(
      "INSERT INTO turns (session_id, sequence, message, status, requester_kind) VALUES ($1, 1, 'hi', 'completed', 'api_key')",
      [open],
    );
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  // G1 is private and nobody of Werft is in it; G9 cannot be read.
  const slack: PrivateChannelSlack = {
    kindOf: async (place) =>
      place.channelId === "G9"
        ? { unconfirmed: "BACKEND_UNAVAILABLE" }
        : { kind: "private_channel" },
    memberIds: async () => ["U0SOMEONE"],
  };
  const run = async (argv: string[]) => {
    const out: string[] = [];
    const exit = await runPrivateChannelSessions(argv, {
      env: { DATABASE_URL: "postgres://unused.invalid/db" },
      out: (line) => out.push(line),
      err: () => {},
      loadKey: async () => ({}) as SecretKey,
      openDatabase: async () => ({ db, close: async () => {} }),
      openSlack: () => slack,
    });
    expect(out).toHaveLength(1);
    return { exit, line: JSON.parse(out[0] as string) };
  };
  const shares = async () =>
    (
      await pool.query(
        "SELECT session_id, scope, revision FROM session_shares WHERE workspace_id = $1 ORDER BY session_id",
        [workspaceId],
      )
    ).rows;

  test("plan counts who loses each session, writes nothing, and exits 3 for the channel it could not read", async () => {
    const before = await shares();
    const { exit, line } = await run(["plan", "--agent", agentId]);
    expect(exit).toBe(PRIVATE_CHANNEL_SESSIONS_EXIT.incomplete);
    expect(line.outcome).toBe("planned");
    const bySession = Object.fromEntries(
      (line.sessions as { session_id: string }[]).map((row) => [
        row.session_id,
        row,
      ]),
    );
    // G1's binding already says private, so the channel door hides both
    // sessions from non-members before the move: no one newly loses them.
    expect(bySession[shared]).toMatchObject({
      from: "people",
      to: "private_channel",
      people_losing: 0,
      key_turns: 0,
      members_unconfirmed: false,
    });
    // G2's binding still says public: its creator and the person it names both
    // lose the people share.
    expect(bySession[stale]).toMatchObject({
      from: "people",
      to: "private_channel",
      people_losing: 2,
    });
    expect(bySession[open]).toMatchObject({ from: "workspace", key_turns: 1 });
    expect(line.unconfirmed_channels).toEqual([
      { agent_id: agentId, channel_id: "G9", reason: "BACKEND_UNAVAILABLE" },
    ]);
    expect(await shares()).toEqual(before);
  });

  test("apply moves the readable channel's sessions once; the unread channel stays as it was", async () => {
    const first = await run(["apply", "--workspace", workspaceId]);
    expect(first.exit).toBe(PRIVATE_CHANNEL_SESSIONS_EXIT.incomplete);
    expect(
      (first.line.moved as { session_id: string }[])
        .map((row) => row.session_id)
        .sort(),
    ).toEqual([open, shared, stale].sort());
    const after = await shares();
    expect(after.map((row) => row.scope)).toEqual([
      "private_channel",
      "private_channel",
      "private_channel",
    ]);
    const second = await run(["apply", "--workspace", workspaceId]);
    expect(second.line.moved).toEqual([]);
    expect(second.line.unchanged).toBe(3);
    expect(await shares()).toEqual(after);
  });
});

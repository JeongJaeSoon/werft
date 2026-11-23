import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { createSlackChannelConversionHandler } from "@werft-ai/chat-slack";
import type { Database } from "@werft-ai/db";
import * as schema from "@werft-ai/db";
import { createPostgresSurfaceBindingStore } from "@werft-ai/db";
import { makeFixtureRelease, TEST_MODEL } from "@werft-ai/db/testing/spec-pins";
import type { SecretKey, SurfaceInboundClaim } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  PRIVATE_CHANNEL_SESSIONS_EXIT,
  type PrivateChannelSlack,
  runPrivateChannelSessions,
} from "./private-channel-sessions.ts";

// Who may see a session is what a channel's change of kind changes, so each
// session moved gets a receipt, written with the move: no receipt, no move.

let client: PGlite;
let db: Database;
const workspaceId = randomUUID();
const installationId = randomUUID();
let agentId = "";
const bindingIds: Record<string, string> = {};
const sessionIds: Record<string, string[]> = { C1: [], C2: [] };

// C1 was bound as public and is private now; C2 is still public.
const slack: PrivateChannelSlack = {
  kindOf: async (place) => ({
    kind: place.channelId === "C1" ? "private_channel" : "public_channel",
  }),
  memberIds: async () => [],
};

async function run() {
  const out: string[] = [];
  const err: string[] = [];
  const exit = await runPrivateChannelSessions(["apply", "--agent", agentId], {
    env: { DATABASE_URL: "postgres://unused.invalid/db" },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    loadKey: async () => ({}) as SecretKey,
    openDatabase: async () => ({ db, close: async () => {} }),
    openSlack: () => slack,
  });
  return { exit, err, out };
}

const scopes = async () =>
  (
    await client.query<{ session_id: string; scope: string }>(
      "SELECT session_id, scope FROM session_shares WHERE workspace_id = $1 ORDER BY session_id",
      [workspaceId],
    )
  ).rows;

const binding = async (channel: string) =>
  (
    await client.query<{ surface_kind: string; status: string }>(
      "SELECT surface_kind, status FROM surface_bindings WHERE id = $1",
      [bindingIds[channel]],
    )
  ).rows[0];

const receiptRows = async () =>
  (
    await client.query<{
      owner_id: string;
      operation: string;
      target_ref: Record<string, unknown>;
      actor: unknown;
      result: Record<string, unknown>;
    }>(
      `SELECT owner_id, operation, target_ref, actor, result FROM receipts
       WHERE operation IN ('share_session', 'request_surface_binding')
       ORDER BY operation, target_ref->>'session_id'`,
    )
  ).rows;

beforeAll(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  const releaseId = await makeFixtureRelease(db, {
    workspaceId,
    model: TEST_MODEL,
  });
  agentId = (
    await client.query<{ agent_id: string }>(
      "SELECT agent_id FROM agent_releases WHERE id = $1",
      [releaseId],
    )
  ).rows[0]?.agent_id as string;
  const creator = randomUUID();
  await client.query(
    "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
    [creator, `${creator}@example.invalid`],
  );
  await client.query(
    "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
    [workspaceId, creator],
  );
  await client.query(
    "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, $3, 'T1')",
    [installationId, workspaceId, `A${installationId.slice(0, 8)}`],
  );
  let n = 0;
  for (const channel of ["C1", "C2"]) {
    const bindingId = randomUUID();
    bindingIds[channel] = bindingId;
    await client.query(
      `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface, installation_id,
         external_surface_id, surface_kind, mode, ceiling_actions, ceiling_disclosure, status)
       VALUES ($1, $2, $3, 'slack', $4, $5, 'public_channel', 'on', '{}', 'full', 'ready')`,
      [bindingId, workspaceId, agentId, installationId, channel],
    );
    const parent = randomUUID();
    await client.query(
      "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, 'T1', $3)",
      [randomUUID(), workspaceId, channel],
    );
    await client.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id) VALUES ($1, $2, $3, 'channel', 'T1', $4)",
      [parent, workspaceId, agentId, channel],
    );
    for (const _ of [1, 2]) {
      n += 1;
      const id = randomUUID();
      sessionIds[channel]?.push(id);
      await client.query(
        `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id, created_by_user_id, parent_conversation_id)
         VALUES ($1, $2::text, 'https://example.invalid/repo.git', $3, $2::uuid, $4, $5)`,
        [id, workspaceId, `session/${id}`, creator, parent],
      );
      await client.query(
        `INSERT INTO session_links (id, workspace_id, owner_id, session_id, installation_id,
           surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts, agent_id, release_id)
         VALUES ($1, $2::uuid, $2::text, $3, $4, $5, $6, $7, $8, $8, $9, $10)`,
        [
          randomUUID(),
          workspaceId,
          id,
          installationId,
          bindingId,
          `${channel}:${n}.1`,
          channel,
          `${n}.1`,
          agentId,
          releaseId,
        ],
      );
    }
    sessionIds[channel]?.sort();
  }
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe("private-channel-sessions apply receipts", () => {
  test("a receipt that cannot be written leaves the sessions and the binding as they were", async () => {
    await client.exec(`
      CREATE FUNCTION refuse_share_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.operation = 'share_session' THEN
          RAISE EXCEPTION 'share_session receipt refused';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER refuse_share_receipt BEFORE INSERT ON receipts
        FOR EACH ROW EXECUTE FUNCTION refuse_share_receipt();`);
    try {
      const { exit, out, err } = await run();
      expect(exit).toBe(PRIVATE_CHANNEL_SESSIONS_EXIT.unexpected);
      expect(out).toEqual([]);
      expect(err).toEqual([
        "private-channel-sessions: unexpected error: Error",
      ]);
    } finally {
      await client.exec(`
        DROP TRIGGER refuse_share_receipt ON receipts;
        DROP FUNCTION refuse_share_receipt();`);
    }
    expect(await scopes()).toEqual([]);
    expect(await binding("C1")).toEqual({
      surface_kind: "public_channel",
      status: "ready",
    });
    expect(await receiptRows()).toEqual([]);
  });

  test("each moved session gets one receipt, linked to the binding's by the run id", async () => {
    const { exit, out } = await run();
    expect(exit).toBe(PRIVATE_CHANNEL_SESSIONS_EXIT.ok);
    const line = JSON.parse(out[0] as string);
    expect(line).toMatchObject({
      outcome: "moved",
      sessions_moved: 2,
      bindings_changed: 1,
      bindings: [
        { agent_id: agentId, channel_id: "C1", binding: "now_private" },
      ],
    });
    expect(line.run_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(await binding("C1")).toEqual({
      surface_kind: "private_channel",
      status: "pending_approval",
    });
    const rows = await receiptRows();
    expect(rows.slice(0, 1)).toEqual([
      expect.objectContaining({
        operation: "request_surface_binding",
        result: expect.objectContaining({
          surface_binding_id: bindingIds.C1,
          reason: "channel_now_private",
          run_id: line.run_id,
        }),
      }),
    ]);
    // The creator sees them before and is no listed member of C1: one loses each.
    expect(rows.slice(1)).toEqual(
      (sessionIds.C1 ?? []).map((sessionId) => ({
        owner_id: workspaceId,
        operation: "share_session",
        target_ref: { session_id: sessionId, turn_id: null, request_id: null },
        actor: null,
        result: {
          scope: "private_channel",
          previous_scope: "workspace",
          reason: "operator_private_channel_migration",
          no_install: false,
          people_losing: 1,
          run_id: line.run_id,
          by: "operator_cli",
        },
      })),
    );
  });

  test("an apply that moves nothing is unchanged, exits 0 and writes no receipt", async () => {
    const before = await receiptRows();
    const { exit, out } = await run();
    expect(exit).toBe(PRIVATE_CHANNEL_SESSIONS_EXIT.ok);
    const line = JSON.parse(out[0] as string);
    expect(line).toMatchObject({
      outcome: "unchanged",
      sessions_moved: 0,
      bindings_changed: 0,
      moved: [],
      bindings: [],
    });
    expect(await receiptRows()).toEqual(before);
  });
});

describe("a Slack conversion to private", () => {
  test("leaves one share_session receipt per session moved, naming the event", async () => {
    const handle = createSlackChannelConversionHandler({
      agents: {
        resolveSlackEvent: async () => ({
          status: "resolved",
          workspaceId,
          agentId,
          installationId,
          identityId: "identity-1",
          botUserId: "U0BOT",
        }),
      } as never,
      bindings: createPostgresSurfaceBindingStore(db),
      slack: { channelKind: async () => "private_channel" },
      botToken: async () => "bot-credential",
      logger: { info: () => {} },
      next: async () => {},
    });
    await handle({
      id: randomUUID(),
      workspaceId,
      agentId,
      appId: "A1",
      slackAppId: "app-1",
      teamId: "T1",
      eventId: "Ev0CONVERT",
      eventType: "message",
      eventTime: null,
      payload: {
        event: {
          type: "message",
          subtype: "channel_convert_to_private",
          channel: "C2",
          user: "U0P",
          ts: "9.1",
        },
      },
    } as unknown as SurfaceInboundClaim);
    const rows = (await receiptRows()).filter(
      (row) =>
        row.result.event_id === "Ev0CONVERT" &&
        row.operation === "share_session",
    );
    expect(rows).toEqual(
      (sessionIds.C2 ?? []).map((sessionId) => ({
        owner_id: workspaceId,
        operation: "share_session",
        target_ref: { session_id: sessionId, turn_id: null, request_id: null },
        actor: null,
        result: {
          scope: "private_channel",
          previous_scope: "workspace",
          reason: "slack_channel_converted",
          no_install: false,
          people_losing: null,
          event_id: "Ev0CONVERT",
          by: "slack_event",
        },
      })),
    );
  });
});

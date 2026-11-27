import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationTopicId,
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
} from "@werft-ai/contracts";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresConversationStore } from "../conversations/conversation-store.ts";
import { holdBufferedInput } from "../conversations/judgment-buffer.ts";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import {
  conversationGate,
  setConversationRollout,
} from "./conversation-rollout.ts";
import { unnoticedSlackChannels } from "./slack-channel-notices.ts";

const TEAM = "T0ROLLOUT";
const CHANNEL = "C0ROLLOUT";

let client: PGlite;
let db: Database;
let ws: { id: string; owner: string; admin: string; member: string };
let agentId: string;
let topicId: ConversationTopicId;
let tsSeq = 0;

async function user(workspaceId: string, role: string) {
  const id = randomUUID();
  await client.query(
    "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
    [id, `u-${id.slice(0, 8)}@example.invalid`],
  );
  await client.query(
    "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)",
    [workspaceId, id, role],
  );
  return id;
}

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  const id = randomUUID();
  await client.query(
    "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
    [id, `ws-${id.slice(0, 8)}`],
  );
  ws = {
    id,
    owner: await user(id, "owner"),
    admin: await user(id, "admin"),
    member: await user(id, "member"),
  };
  agentId = randomUUID();
  await client.query(
    "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, 'listener', 'listener', 'active')",
    [agentId, id, await fixtureTeamSql(client, id)],
  );
  const installationId = randomUUID();
  await client.query(
    "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0ROLLOUT', $3)",
    [installationId, id, TEAM],
  );
  await client.query(
    `INSERT INTO agent_identities
       (id, workspace_id, agent_id, provider, installation_id, external_principal_id, credential_ref)
     VALUES ($1, $2, $3, 'slack_bot', $4, 'U0ROLLOUT', 'slack/rollout-bot')`,
    [randomUUID(), id, agentId, installationId],
  );
  await client.query(
    `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface,
      installation_id, external_surface_id, surface_kind, mode, listen,
      ceiling_actions, ceiling_disclosure, status)
     VALUES ($1, $2, $3, 'slack', $4, $5, 'public_channel', 'on', 'free',
      '{}', 'full', 'ready')`,
    [randomUUID(), id, agentId, installationId, CHANNEL],
  );
  const store = createPostgresConversationStore(db);
  const conversation = await store.findOrCreateConversation({
    kind: "channel",
    workspaceId: id,
    agentId,
    teamId: TEAM,
    channelId: CHANNEL,
  });
  const topic = await store.findOrCreateThreadTopic(conversation.id, {
    teamId: TEAM,
    channelId: CHANNEL,
    threadTs: "100.000000",
  });
  topicId = topic.id as ConversationTopicId;
});

afterEach(async () => {
  await client.close();
});

const place = () => ({ workspaceId: ws.id, agentId });

const set = (
  rollout: "off" | "shadow" | "on",
  by: "operator_cli" | { userId: string } = { userId: ws.admin },
) => setConversationRollout(db, { ...place(), rollout, by });

/** Puts the switch where only SQL can, today: `on` is not settable yet. */
async function forceRollout(rollout: "off" | "shadow" | "on") {
  await client.query(
    "UPDATE agents SET conversation_rollout = $2 WHERE id = $1",
    [agentId, rollout],
  );
}

async function rolloutNow(): Promise<string> {
  const { rows } = await client.query<{ r: string }>(
    "SELECT conversation_rollout AS r FROM agents WHERE id = $1",
    [agentId],
  );
  return rows[0]?.r ?? "";
}

/** An approval row as the retired approval wrote them; nothing reads it now. */
async function storedApproval(revoked: boolean) {
  await client.query(
    `INSERT INTO slack_notice_approvals
       (id, workspace_id, agent_id, slack_team_id, notice_version, approved_by,
        revoked_at, revoked_by)
     VALUES ($1, $2, $3, $4, 1, $5,
       CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN $5::uuid END)`,
    [randomUUID(), ws.id, agentId, TEAM, ws.admin, revoked],
  );
}

/** Holds one unmentioned message for the agent; returns whether it was held. */
async function post(): Promise<string> {
  const ts = `200.${String(++tsSeq).padStart(6, "0")}`;
  const held = await db.transaction((tx) =>
    holdBufferedInput(
      tx,
      { workspaceId: ws.id, agentId, teamId: TEAM },
      {
        topicId,
        channelId: CHANNEL,
        ts,
        buffered: { slackUserId: "U0PERSON", body: "chatter" },
      },
      JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
    ),
  );
  return held.outcome;
}

async function buffered(): Promise<number> {
  const { rows } = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM conversation_inputs WHERE agent_id = $1 AND buffer_expires_at IS NOT NULL",
    [agentId],
  );
  return rows[0]?.count ?? 0;
}

async function rolloutReceipts() {
  const { rows } = await client.query<{
    result: Record<string, unknown>;
    actor: Record<string, unknown> | null;
  }>(
    `SELECT result, actor FROM receipts
     WHERE operation = 'set_conversation_rollout'
       AND target_ref->'resource'->>'id' = $1
     ORDER BY created_at, id`,
    [agentId],
  );
  return rows;
}

// docs/architecture/state-machines.md, 4. rollout 스위치: one test per row.
describe("the conversation switch", () => {
  test("off → shadow needs no approval: no row, none live, or a stored one alike", async () => {
    expect(await set("shadow")).toEqual({
      outcome: "changed",
      before: "off",
      after: "shadow",
      bufferedDropped: 0,
    });
    expect(await rolloutReceipts()).toHaveLength(1);
    await set("off");
    await storedApproval(true);
    expect((await set("shadow", "operator_cli")).outcome).toBe("changed");
    await set("off");
    await storedApproval(false);
    expect((await set("shadow")).outcome).toBe("changed");
  });

  test("off → shadow needs no live Slack install either", async () => {
    await client.query(
      "UPDATE agent_identities SET status = 'revoked', revoked_at = now() WHERE agent_id = $1",
      [agentId],
    );
    expect((await set("shadow")).outcome).toBe("changed");
  });

  test("shadow → off empties the buffer and holds nothing new", async () => {
    await set("shadow");
    expect(await post()).toBe("held");
    expect(await post()).toBe("held");
    expect(await set("off")).toEqual({
      outcome: "changed",
      before: "shadow",
      after: "off",
      bufferedDropped: 2,
    });
    expect(await buffered()).toBe(0);
    expect(await post()).toBe("not_held");
  });

  test("off → on is refused, from the web and the operator CLI, and changes nothing", async () => {
    expect(await set("on")).toEqual({ outcome: "on_unavailable" });
    expect(await set("on", "operator_cli")).toEqual({
      outcome: "on_unavailable",
    });
    expect(await rolloutNow()).toBe("off");
    expect(await rolloutReceipts()).toEqual([]);
  });

  test("shadow → on is refused until W1 opens it", async () => {
    await set("shadow");
    expect(await set("on")).toEqual({ outcome: "on_unavailable" });
    expect(await rolloutNow()).toBe("shadow");
    expect(await rolloutReceipts()).toHaveLength(1);
  });

  test("on → shadow and on → off are taken, for a switch SQL left on", async () => {
    await forceRollout("on");
    expect(await set("shadow")).toMatchObject({
      outcome: "changed",
      before: "on",
      after: "shadow",
    });
    await forceRollout("on");
    expect(await set("off", "operator_cli")).toMatchObject({
      outcome: "changed",
      before: "on",
      after: "off",
    });
  });

  test("the value it holds changes nothing and writes no receipt", async () => {
    expect(await set("off")).toEqual({
      outcome: "unchanged",
      before: "off",
      after: "off",
      bufferedDropped: 0,
    });
    await set("shadow");
    expect((await set("shadow")).outcome).toBe("unchanged");
    expect(await rolloutReceipts()).toHaveLength(1);
  });

  test("owners and admins change it; a member is not an admin; another workspace's agent is not found", async () => {
    expect((await set("shadow", { userId: ws.owner })).outcome).toBe("changed");
    expect(await set("off", { userId: ws.member })).toEqual({
      outcome: "not_admin",
    });
    expect(
      await setConversationRollout(db, {
        workspaceId: randomUUID(),
        agentId,
        rollout: "off",
        by: "operator_cli",
      }),
    ).toEqual({ outcome: "not_found" });
    expect(await rolloutNow()).toBe("shadow");
  });

  test("each change writes one receipt in its transaction, reason always null", async () => {
    await set("shadow");
    expect(await post()).toBe("held");
    await set("off", "operator_cli");
    expect(await rolloutReceipts()).toEqual([
      {
        result: {
          agent_id: agentId,
          before: "off",
          after: "shadow",
          by: "web",
          reason: null,
          buffered_dropped: 0,
        },
        actor: {
          principal: { kind: "user", id: ws.admin },
          actor_user_id: ws.admin,
          agent_id: null,
        },
      },
      {
        result: {
          agent_id: agentId,
          before: "shadow",
          after: "off",
          by: "operator_cli",
          reason: null,
          buffered_dropped: 1,
        },
        actor: null,
      },
    ]);
  });
});

describe("the conversation gate", () => {
  test("it follows the switch alone", async () => {
    const gate = () => conversationGate(db, place());
    expect(await gate()).toEqual({ open: false, reason: "rollout_off" });
    await set("shadow");
    expect(await gate()).toEqual({ open: true, rollout: "shadow" });
    await forceRollout("on");
    expect(await gate()).toEqual({ open: true, rollout: "on" });
    await client.query(
      "UPDATE agents SET status = 'archived', deleted_at = now(), deleted_by = $2 WHERE id = $1",
      [agentId, ws.owner],
    );
    expect(await gate()).toEqual({ open: false, reason: "agent_not_found" });
  });
});

// What a deploy of this change does to agents as they stand: the switch is
// read as stored, and nothing lowers or raises it by itself any more.
describe("agents as the retired approval left them", () => {
  test("an agent at off, approved or not, stays off and does not listen", async () => {
    for (const approval of [null, true, false] as const) {
      if (approval !== null) await storedApproval(approval);
      expect(await rolloutNow()).toBe("off");
      expect(await conversationGate(db, place())).toEqual({
        open: false,
        reason: "rollout_off",
      });
      expect(await post()).toBe("not_held");
      expect(await unnoticedSlackChannels(db, { limit: 10 })).toEqual([]);
    }
    expect(await rolloutReceipts()).toEqual([]);
  });

  test("an approved agent at shadow stays at shadow and keeps listening", async () => {
    await storedApproval(false);
    await forceRollout("shadow");
    expect(await conversationGate(db, place())).toEqual({
      open: true,
      rollout: "shadow",
    });
    expect(await post()).toBe("held");
    expect(await rolloutNow()).toBe("shadow");
    expect(await rolloutReceipts()).toEqual([]);
  });

  test("a revoked approval no longer lowers the switch", async () => {
    await set("shadow");
    await storedApproval(true);
    expect(await rolloutNow()).toBe("shadow");
    expect((await conversationGate(db, place())).open).toBe(true);
  });
});

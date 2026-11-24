import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import {
  type ConversationTopicId,
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
  type SlackNoticeVersionEntry,
  slackNoticeVersionSchema,
} from "@werft-ai/contracts";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresConversationStore } from "../conversations/conversation-store.ts";
import { holdBufferedInput } from "../conversations/judgment-buffer.ts";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import {
  approveSlackNotice,
  conversationGate,
  lowerUnapprovedRollouts,
  revokeSlackNotice,
  setConversationRollout,
} from "./slack-notice-approvals.ts";

const TEXT = {
  body: ["notice"],
  policyLink: { label: "policy", href: "https://docs.example.test/data" },
};
const entry = (
  version: number,
  requiresReapproval: boolean,
): SlackNoticeVersionEntry => ({
  version: slackNoticeVersionSchema.parse(version),
  text: { ko: TEXT, ja: TEXT },
  requiresReapproval,
});
const V1 = [entry(1, true)];
/** Version 2 only rewords version 1. */
const REWORDED = [...V1, entry(2, false)];
/** Version 2 asks for a new approval. */
const ASKS_AGAIN = [...V1, entry(2, true)];

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

const approve = (versions: readonly SlackNoticeVersionEntry[] = V1) =>
  approveSlackNotice(db, { ...place(), by: ws.admin, locale: "ko" }, versions);

const set = (
  rollout: "off" | "shadow" | "on",
  by: "operator_cli" | { userId: string } = { userId: ws.admin },
  versions: readonly SlackNoticeVersionEntry[] = V1,
) => setConversationRollout(db, { ...place(), rollout, by }, versions);

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

describe("the conversation switch", () => {
  test("it leaves off only for an agent approved now, and never for on", async () => {
    expect(await set("shadow")).toEqual({
      outcome: "not_approved",
      reason: "not_approved",
    });
    expect(await set("shadow", { userId: ws.admin }, [])).toEqual({
      outcome: "not_approved",
      reason: "no_notice",
    });
    await approve();
    expect(await set("on")).toEqual({ outcome: "on_unavailable" });
    expect(await set("on", "operator_cli")).toEqual({
      outcome: "on_unavailable",
    });
    expect(await set("shadow")).toEqual({
      outcome: "changed",
      before: "off",
      after: "shadow",
      bufferedDropped: 0,
    });
    expect(await rolloutReceipts()).toHaveLength(1);
  });

  test("an agent with no live Slack install is refused as not installed", async () => {
    await approve();
    await client.query(
      "UPDATE agent_identities SET status = 'revoked', revoked_at = now() WHERE agent_id = $1",
      [agentId],
    );
    expect(await set("shadow")).toEqual({
      outcome: "not_approved",
      reason: "not_installed",
    });
  });

  test("owners and admins change it; a member is not an admin; another workspace's agent is not found", async () => {
    await approve();
    expect((await set("shadow", { userId: ws.owner })).outcome).toBe("changed");
    expect(await set("off", { userId: ws.member })).toEqual({
      outcome: "not_admin",
    });
    const otherWorkspace = randomUUID();
    expect(
      await setConversationRollout(
        db,
        {
          workspaceId: otherWorkspace,
          agentId,
          rollout: "off",
          by: "operator_cli",
        },
        V1,
      ),
    ).toEqual({ outcome: "not_found" });
    expect(await conversationGate(db, place(), { versions: V1 })).toMatchObject(
      { open: true, rollout: "shadow" },
    );
  });

  test("each change writes one receipt in its transaction; the same value writes none", async () => {
    await approve();
    await set("shadow");
    await set("shadow");
    expect(await post()).toBe("held");
    expect(await set("off", "operator_cli")).toEqual({
      outcome: "changed",
      before: "shadow",
      after: "off",
      bufferedDropped: 1,
    });
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

  test("off empties the agent's buffer and holds nothing new", async () => {
    await approve();
    await set("shadow");
    expect(await post()).toBe("held");
    expect(await post()).toBe("held");
    expect(await buffered()).toBe(2);
    await set("off");
    expect(await buffered()).toBe(0);
    expect(await post()).toBe("not_held");
    expect(await buffered()).toBe(0);
  });

  test("a revoke lowers a raised switch and empties the buffer; one already off records no change", async () => {
    await approve();
    await set("shadow");
    expect(await post()).toBe("held");
    const revoked = await revokeSlackNotice(db, { ...place(), by: ws.owner });
    expect(revoked.outcome).toBe("revoked");
    expect(await buffered()).toBe(0);
    expect((await rolloutReceipts()).at(-1)).toEqual({
      result: {
        agent_id: agentId,
        before: "shadow",
        after: "off",
        by: "web",
        reason: "notice_revoked",
        buffered_dropped: 1,
      },
      actor: {
        principal: { kind: "user", id: ws.owner },
        actor_user_id: ws.owner,
        agent_id: null,
      },
    });
    expect(await conversationGate(db, place(), { versions: V1 })).toEqual({
      open: false,
      reason: "rollout_off",
    });
    await approve();
    await revokeSlackNotice(db, { ...place(), by: ws.owner });
    expect(await rolloutReceipts()).toHaveLength(2);
  });
});

describe("the conversation gate", () => {
  test("it is open only with the switch raised and the agent approved now", async () => {
    const gate = (versions: readonly SlackNoticeVersionEntry[] = V1) =>
      conversationGate(db, place(), { versions });
    expect(await gate()).toEqual({ open: false, reason: "rollout_off" });
    expect((await approve()).outcome).toBe("approved");
    expect(await gate()).toEqual({ open: false, reason: "rollout_off" });
    await set("shadow");
    expect(await gate()).toEqual({
      open: true,
      rollout: "shadow",
      approvals: [
        {
          approvalId: expect.any(String),
          version: 1,
          slackTeamId: TEAM,
        },
      ] as never,
    });
    // Before any pass lowers the switch, the gate already answers no.
    expect(await gate(ASKS_AGAIN)).toEqual({
      open: false,
      reason: "not_approved",
    });
    expect((await gate(REWORDED)).open).toBe(true);
    expect(await gate([])).toEqual({ open: false, reason: "no_notice" });
    await client.query(
      "UPDATE agents SET status = 'archived', deleted_at = now(), deleted_by = $2 WHERE id = $1",
      [agentId, ws.owner],
    );
    expect(await gate()).toEqual({ open: false, reason: "agent_not_found" });
  });
});

describe("the pass that lowers unapproved switches", () => {
  test("a version that asks anew lowers the switch with a receipt and an empty buffer; a rewording leaves it", async () => {
    await approve();
    await set("shadow");
    expect(await post()).toBe("held");
    expect(
      await lowerUnapprovedRollouts(db, {
        dryRun: false,
        limit: 10,
        versions: REWORDED,
      }),
    ).toEqual([]);
    expect(
      await lowerUnapprovedRollouts(db, {
        dryRun: true,
        limit: 10,
        versions: ASKS_AGAIN,
      }),
    ).toEqual([agentId]);
    expect(await buffered()).toBe(1);
    expect(await rolloutReceipts()).toHaveLength(1);
    expect(
      await lowerUnapprovedRollouts(db, {
        dryRun: false,
        limit: 10,
        versions: ASKS_AGAIN,
      }),
    ).toEqual([agentId]);
    expect(await buffered()).toBe(0);
    expect((await rolloutReceipts()).at(-1)).toEqual({
      result: {
        agent_id: agentId,
        before: "shadow",
        after: "off",
        by: "reconciler",
        reason: "not_approved",
        buffered_dropped: 1,
      },
      actor: null,
    });
    expect(await set("shadow", { userId: ws.admin }, ASKS_AGAIN)).toMatchObject(
      { outcome: "not_approved" },
    );
    // Approved again, it may be raised again; the pass leaves it then.
    await approve(ASKS_AGAIN);
    expect(
      (await set("shadow", { userId: ws.admin }, ASKS_AGAIN)).outcome,
    ).toBe("changed");
    expect(
      await lowerUnapprovedRollouts(db, {
        dryRun: false,
        limit: 10,
        versions: ASKS_AGAIN,
      }),
    ).toEqual([]);
  });

  test("an app gone from its Slack team is lowered as not installed", async () => {
    await approve();
    await set("shadow");
    await client.query(
      "UPDATE agent_identities SET status = 'revoked', revoked_at = now() WHERE agent_id = $1",
      [agentId],
    );
    expect(
      await lowerUnapprovedRollouts(db, {
        dryRun: false,
        limit: 10,
        versions: V1,
      }),
    ).toEqual([agentId]);
    expect((await rolloutReceipts()).at(-1)?.result).toMatchObject({
      by: "reconciler",
      reason: "not_installed",
    });
  });
});

import {
  type SessionShareScope,
  slackScopeSegmentSchema,
} from "@werft-ai/contracts";
import type {
  ChannelKindNow,
  ChannelScopePlan,
  ChannelSessionPlace,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import { UUID } from "../control-shared.ts";
import { createPostgresConversationStore } from "../conversations/index.ts";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/** A session of a channel, as its scope is read now (no share row: workspace). */
export type ChannelSessionRow = {
  sessionId: string;
  ownerId: string;
  workspaceId: string | null;
  scope: SessionShareScope;
  parentConversationId: string | null;
  /** Turns an API key asked for: a poller of the session loses it. */
  keyTurns: number;
};

const lower = (value: string) => value.toLowerCase();

/**
 * The channels whose linked sessions a scope pass looks at, revoked and
 * closed links and bindings included, narrowed to one workspace or agent.
 */
export async function channelSessionPlaces(
  db: Database,
  filter: { workspaceId?: string; agentId?: string } = {},
): Promise<ChannelSessionPlace[]> {
  for (const id of [filter.workspaceId, filter.agentId]) {
    if (id !== undefined && !UUID.test(id)) return [];
  }
  const rows = rowsOf<{
    workspace_id: string;
    agent_id: string;
    installation_id: string;
    team_id: string;
    channel_id: string;
  }>(
    await db.execute(sql`
      SELECT DISTINCT l.workspace_id, l.agent_id, l.installation_id,
        i.team_id, l.channel_id
      FROM session_links l
      JOIN surface_bindings b ON b.id = l.surface_binding_id
      JOIN slack_installations i ON i.id = l.installation_id
      WHERE l.session_id IS NOT NULL
        AND b.surface_kind IN ('public_channel', 'private_channel')
        ${filter.workspaceId === undefined ? sql`` : sql`AND l.workspace_id = ${lower(filter.workspaceId)}::uuid`}
        ${filter.agentId === undefined ? sql`` : sql`AND l.agent_id = ${lower(filter.agentId)}::uuid`}
      ORDER BY l.workspace_id, l.agent_id, l.channel_id, l.installation_id`),
  );
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    installationId: row.installation_id,
    teamId: row.team_id,
    channelId: row.channel_id,
  }));
}

/** The sessions linked from the place's channel threads, each once. */
export async function channelSessions(
  db: Database,
  place: ChannelSessionPlace,
): Promise<ChannelSessionRow[]> {
  const rows = rowsOf<{
    session_id: string;
    owner_id: string;
    workspace_id: string | null;
    scope: SessionShareScope;
    parent_conversation_id: string | null;
    key_turns: string | number;
  }>(
    await db.execute(sql`
      SELECT s.id AS session_id, s.owner_id, s.workspace_id,
        coalesce(sh.scope, 'workspace') AS scope, s.parent_conversation_id,
        (SELECT count(*) FROM turns t WHERE t.session_id = s.id
          AND t.requester_kind = 'api_key') AS key_turns
      FROM sessions s
      LEFT JOIN session_shares sh ON sh.session_id = s.id
      WHERE s.id IN (
        SELECT l.session_id FROM session_links l
        JOIN surface_bindings b ON b.id = l.surface_binding_id
        WHERE l.installation_id = ${lower(place.installationId)}::uuid
          AND l.channel_id = ${place.channelId}
          AND l.agent_id = ${lower(place.agentId)}::uuid
          AND b.surface_kind IN ('public_channel', 'private_channel'))
      ORDER BY s.id`),
  );
  return rows.map((row) => ({
    sessionId: row.session_id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    parentConversationId: row.parent_conversation_id,
    keyTurns: Number(row.key_turns),
  }));
}

const channelKey = (place: ChannelSessionPlace) => ({
  kind: "channel" as const,
  workspaceId: lower(place.workspaceId),
  agentId: lower(place.agentId),
  teamId: place.teamId,
  channelId: place.channelId,
});

const usableChannel = (place: ChannelSessionPlace) =>
  slackScopeSegmentSchema.safeParse(place.teamId).success &&
  slackScopeSegmentSchema.safeParse(place.channelId).success;

async function channelConversationId(
  db: Database,
  place: ChannelSessionPlace,
): Promise<string | null> {
  const [row] = rowsOf<{ id: string }>(
    await db.execute(sql`
      SELECT id FROM conversations
      WHERE agent_id = ${lower(place.agentId)}::uuid AND kind = 'channel'
        AND team_id = ${place.teamId} AND channel_id = ${place.channelId}`),
  );
  return row?.id ?? null;
}

/**
 * What moving the place's sessions to match the channel's kind would do,
 * read alone: a private channel's sessions go to `private_channel` (a
 * `private` one stays), a public channel's `private_channel` ones to
 * `workspace`. A session whose parent is empty is moved once it is filled
 * with the channel's conversation; one whose parent is another
 * conversation is skipped.
 */
export function planChannelScope(
  rows: readonly ChannelSessionRow[],
  kind: ChannelKindNow,
  channel: { usable: boolean; conversationId: string | null },
): ChannelScopePlan {
  const plan: ChannelScopePlan = {
    moves: [],
    keptPrivate: [],
    unchanged: [],
    skipped: [],
  };
  for (const row of rows) {
    if (kind === "public_channel") {
      if (row.scope === "private_channel") {
        plan.moves.push({
          sessionId: row.sessionId,
          from: row.scope,
          to: "workspace",
        });
      } else {
        plan.unchanged.push(row.sessionId);
      }
      continue;
    }
    if (row.scope === "private_channel") {
      plan.unchanged.push(row.sessionId);
    } else if (row.scope === "private") {
      plan.keptPrivate.push(row.sessionId);
    } else if (row.workspaceId === null) {
      plan.skipped.push({ sessionId: row.sessionId, reason: "no_workspace" });
    } else if (
      !channel.usable ||
      (row.parentConversationId !== null &&
        row.parentConversationId !== channel.conversationId)
    ) {
      plan.skipped.push({
        sessionId: row.sessionId,
        reason: "no_channel_conversation",
      });
    } else {
      plan.moves.push({
        sessionId: row.sessionId,
        from: row.scope,
        to: "private_channel",
      });
    }
  }
  return plan;
}

/** The plan for a place, read without writing anything. */
export async function readChannelScopePlan(
  db: Database,
  place: ChannelSessionPlace,
  kind: ChannelKindNow,
): Promise<{ rows: ChannelSessionRow[]; plan: ChannelScopePlan }> {
  const rows = await channelSessions(db, place);
  const usable = usableChannel(place);
  const conversationId = usable ? await channelConversationId(db, place) : null;
  return {
    rows,
    plan: planChannelScope(rows, kind, { usable, conversationId }),
  };
}

/**
 * Moves the place's sessions to match the channel's kind, in the caller's
 * transaction: an empty parent is filled with the channel's conversation
 * first (found or made), so the channel's members find the session. Named
 * share rows stay; under `private_channel` they take no effect. Running it
 * again moves nothing more.
 */
export async function moveChannelSessionScope(
  tx: Database,
  place: ChannelSessionPlace,
  kind: ChannelKindNow,
): Promise<ChannelScopePlan> {
  const rows = await channelSessions(tx, place);
  const usable = usableChannel(place);
  let conversationId = usable ? await channelConversationId(tx, place) : null;
  const plan = planChannelScope(rows, kind, { usable, conversationId });
  if (kind === "private_channel" && usable && plan.moves.length > 0) {
    conversationId ??= (
      await createPostgresConversationStore(tx).findOrCreateConversation(
        channelKey(place),
      )
    ).id;
  }
  for (const move of plan.moves) {
    const row = rows.find(
      (candidate) => candidate.sessionId === move.sessionId,
    );
    if (row === undefined || row.workspaceId === null) continue;
    if (move.to === "private_channel") {
      await tx.execute(sql`
        UPDATE sessions SET parent_conversation_id = ${conversationId}::uuid
        WHERE id = ${row.sessionId}::uuid AND parent_conversation_id IS NULL`);
    }
    // Only from the scope the plan read: a share changed meanwhile wins.
    await tx.execute(sql`
      INSERT INTO session_shares (session_id, owner_id, workspace_id, scope,
        updated_by, updated_at, revision)
      VALUES (${row.sessionId}::uuid, ${row.ownerId},
        ${row.workspaceId}::uuid, ${move.to}, NULL, ${DB_NOW}, 1)
      ON CONFLICT (session_id) DO UPDATE
        SET scope = EXCLUDED.scope, updated_by = NULL,
          updated_at = EXCLUDED.updated_at,
          revision = session_shares.revision + 1
        WHERE session_shares.scope = ${move.from}`);
  }
  return plan;
}

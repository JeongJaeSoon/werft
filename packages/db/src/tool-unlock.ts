import { randomUUID } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import type { Database } from "./queries.ts";

const rows = async <T>(db: Database, query: SQL): Promise<T[]> =>
  rowsOf<T>(await db.execute(query));

/** One agent with an active release, as the one-time tool unlock reads it. */
export type ToolUnlockFact = {
  workspace_id: string;
  agent_id: string;
  name: string;
  tracking: "follow" | "pinned";
  activation_revision: number;
  behavior_revision: number;
  active_release_id: string;
  profile_id: string;
  card: unknown;
  tools: string[];
  mcp_tools: string[];
};

/** Every agent with an active release, `pinned` ones included. */
export async function readToolUnlockFacts(
  db: Database,
): Promise<ToolUnlockFact[]> {
  const found = await rows<{
    workspace_id: string;
    agent_id: string;
    name: string;
    tracking: string;
    activation_revision: number;
    behavior_revision: number;
    active_release_id: string;
    profile_id: string;
    card: unknown;
    effective_tools: { tools?: string[]; mcp?: string[] };
  }>(
    db,
    sql`SELECT a.workspace_id, a.id AS agent_id, a.name,
        a.profile_tracking AS tracking,
        a.activation_revision, a.behavior_revision,
        r.id AS active_release_id, r.runtime_profile_id AS profile_id,
        v.card, r.effective_tools
      FROM agents a
      JOIN agent_releases r ON r.id = a.active_release_id
      JOIN agent_versions v ON v.id = r.version_id
      ORDER BY a.workspace_id, a.id`,
  );
  return found.map((row) => ({
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    name: row.name,
    tracking: row.tracking === "pinned" ? "pinned" : "follow",
    activation_revision: row.activation_revision,
    behavior_revision: row.behavior_revision,
    active_release_id: row.active_release_id,
    profile_id: row.profile_id,
    card: row.card,
    tools: row.effective_tools.tools ?? [],
    mcp_tools: row.effective_tools.mcp ?? [],
  }));
}

/**
 * The `tool_unlock` rollout of a profile version, made once: the rollout
 * table holds one row per (target, kind). `createdBy` is the live owner that
 * runs it. Null for a profile that is not a stored row (a rollout row
 * references one); those agents are unlocked without an item.
 */
export async function openToolUnlockRollout(
  db: Database,
  input: { profileId: string; createdBy: string },
): Promise<string | null> {
  await db.execute(
    sql`INSERT INTO profile_rollouts (id, kind, target_profile_id, created_by)
      SELECT ${randomUUID()}::uuid, 'tool_unlock', p.id, ${input.createdBy}::uuid
      FROM installation_profiles p WHERE p.id = ${input.profileId}
      ON CONFLICT (target_profile_id, kind) DO NOTHING`,
  );
  const [row] = await rows<{ id: string }>(
    db,
    sql`SELECT id FROM profile_rollouts
      WHERE kind = 'tool_unlock' AND target_profile_id = ${input.profileId}`,
  );
  return row?.id ?? null;
}

/**
 * The result of one agent's unlock. Written straight to its end state, never
 * `pending`, so no runner takes it. An `applied` item stays: a late
 * `superseded` or `failed` from a racing run does not overwrite it.
 */
export async function recordToolUnlockItem(
  tx: Database,
  input: {
    rolloutId: string;
    agentId: string;
    generation: number;
    result:
      | { status: "applied" | "superseded" }
      | {
          status: "failed";
          reason: string;
        };
  },
): Promise<void> {
  const { result } = input;
  await tx.execute(
    sql`INSERT INTO profile_rollout_items
        (rollout_id, agent_id, generation, status, reason_code)
      VALUES (${input.rolloutId}, ${input.agentId}, ${input.generation},
        ${result.status}, ${result.status === "failed" ? result.reason : null})
      ON CONFLICT (rollout_id, agent_id, generation) DO UPDATE
        SET status = EXCLUDED.status, reason_code = EXCLUDED.reason_code,
            locked_by = NULL, locked_until = NULL, updated_at = now()
        WHERE profile_rollout_items.status <> 'applied'`,
  );
}

import type { AdminDenyEntry } from "@werft-ai/contracts";
import {
  type RestrictionFact,
  type RestrictionResolver,
  restrictionOf,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import { rowsOf } from "./control-unit-of-work.ts";
import type { Database } from "./queries.ts";

/** Every agent that is not archived, with what a copy reads. */
export async function readRestrictionFacts(
  executor: Database,
  only?: { agentId: string },
): Promise<RestrictionFact[]> {
  const found = rowsOf<{
    workspace_id: string;
    agent_id: string;
    name: string;
    release_id: string | null;
    runtime_profile_id: string | null;
    snapshot: unknown;
    release_ids: string[];
    existing: unknown;
  }>(
    await executor.execute(
      sql`SELECT a.workspace_id, a.id AS agent_id, a.name,
          r.id AS release_id, r.runtime_profile_id,
          r.runtime_config_snapshot AS snapshot,
          COALESCE((SELECT array_agg(x.id ORDER BY x.id)
                      FROM agent_releases x WHERE x.agent_id = a.id), '{}') AS release_ids,
          COALESCE(e.admin_deny, '[]'::jsonb) AS existing
        FROM agents a
        LEFT JOIN agent_releases r ON r.id = a.active_release_id
        LEFT JOIN agent_engine_settings e ON e.agent_id = a.id
        WHERE a.status <> 'archived'
          ${only === undefined ? sql`` : sql`AND a.id = ${only.agentId}`}
        ORDER BY a.workspace_id, a.id`,
    ),
  );
  return found.map((row) => {
    const tools = (row.snapshot as { tools?: unknown } | null)?.tools;
    return {
      workspace_id: row.workspace_id,
      agent_id: row.agent_id,
      name: row.name,
      release:
        row.release_id === null || row.runtime_profile_id === null
          ? null
          : {
              id: row.release_id,
              runtime_profile_id: row.runtime_profile_id,
              // A snapshot this image cannot read allows no tool, as a claim does.
              tools:
                Array.isArray(tools) &&
                tools.every((tool) => typeof tool === "string")
                  ? (tools as string[])
                  : [],
            },
      release_ids: row.release_ids,
      existing: row.existing,
    };
  });
}

export type RestrictionWriteResult =
  | { status: "written" }
  | { status: "skipped_existing" }
  | { status: "gate_closed" }
  | { status: "changed_since_report"; reason: string };

const sameRules = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((rule, index) => rule === b[index]);

/**
 * Appends one agent's entry if the agent still reads as the report says.
 * The agent row is locked as an activation locks it, so the list of releases
 * the entry exempts is the one that exists when the entry lands; the values
 * are worked out again inside the lock and a different result writes nothing.
 * The gate is read under a share lock: a closed gate refuses.
 */
export async function writeRestrictionEntry(
  db: Database,
  input: {
    workspaceId: string;
    agentId: string;
    expected: { permissions_deny: string[]; mcp_deny: string[] };
    resolve: RestrictionResolver;
  },
): Promise<RestrictionWriteResult> {
  return db.transaction(async (tx) => {
    const [gate] = rowsOf<{ writes_open: boolean }>(
      await tx.execute(
        sql`SELECT writes_open FROM engine_settings_gate WHERE id = 1 FOR SHARE`,
      ),
    );
    if (gate?.writes_open !== true) return { status: "gate_closed" } as const;
    const [held] = rowsOf<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM agents WHERE id = ${input.agentId} AND workspace_id = ${input.workspaceId} FOR UPDATE`,
      ),
    );
    if (held === undefined) {
      return { status: "changed_since_report", reason: "agent_gone" } as const;
    }
    // The next statement, not the lock's: the list is read after the lock is held.
    const [fact] = await readRestrictionFacts(tx, { agentId: input.agentId });
    if (fact === undefined) {
      return { status: "changed_since_report", reason: "agent_gone" } as const;
    }
    const now = restrictionOf(fact, input.resolve);
    if (now.reason === "already_covered") {
      return { status: "skipped_existing" } as const;
    }
    if (
      now.decision !== "write" ||
      now.entry === null ||
      !sameRules(now.permissions_deny, input.expected.permissions_deny) ||
      !sameRules(now.mcp_deny, input.expected.mcp_deny)
    ) {
      return {
        status: "changed_since_report",
        reason: now.reason ?? "values_changed",
      } as const;
    }
    const entry: AdminDenyEntry = now.entry;
    await tx.execute(
      sql`INSERT INTO agent_engine_settings (agent_id, workspace_id, admin_deny)
          VALUES (${input.agentId}, ${input.workspaceId}, ${JSON.stringify([entry])}::jsonb)
          ON CONFLICT (agent_id) DO UPDATE
            SET admin_deny = agent_engine_settings.admin_deny || ${JSON.stringify([entry])}::jsonb,
                revision = agent_engine_settings.revision + 1,
                -- The row changed by an operator, not by whoever edited last.
                updated_by = NULL,
                updated_at = now()`,
    );
    return { status: "written" } as const;
  });
}

/** Opens or closes the write gate; returns the state before and after. */
export async function setEngineSettingsGate(
  db: Database,
  open: boolean,
): Promise<{ before: boolean; after: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = rowsOf<{ writes_open: boolean }>(
      await tx.execute(
        sql`SELECT writes_open FROM engine_settings_gate WHERE id = 1 FOR UPDATE`,
      ),
    );
    if (row === undefined) throw new Error("engine_settings_gate has no row");
    if (row.writes_open !== open) {
      await tx.execute(
        sql`UPDATE engine_settings_gate SET writes_open = ${open}, changed_at = now(), changed_by = NULL WHERE id = 1`,
      );
    }
    return { before: row.writes_open, after: open };
  });
}

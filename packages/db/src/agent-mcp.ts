import { randomUUID } from "node:crypto";
import type {
  AgentMcpRelease,
  AgentMcpRow,
  AgentMcpStore,
  McpMigrationEntry,
  McpMigrationFact,
  McpMigrationPlan,
} from "@werft-ai/platform";
import {
  copyValuesOf,
  mcpValuesOfCard,
  planMcpSettingsMigration,
} from "@werft-ai/platform";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { lockAgentToChange } from "./agents.ts";
import { receiptActorOf } from "./control-shared.ts";
import { rowsOf } from "./control-unit-of-work.ts";
import type { Database } from "./queries.ts";
import {
  agentMcpSettings,
  agents,
  credentialBindings,
  receipts,
  workspaces,
} from "./schema.ts";

type Values = Pick<AgentMcpRow, "server" | "allowedTools" | "credentialRefs">;

/** The columns a person edits, as the receipt records them: names only. */
const valuesOf = (row: Values) => ({
  server: row.server,
  allowed_tools: row.allowedTools,
  credential_refs: row.credentialRefs,
});

const sameValues = (a: Values, b: Values) =>
  JSON.stringify(valuesOf(a)) === JSON.stringify(valuesOf(b));

const rowOf = (found: typeof agentMcpSettings.$inferSelect): AgentMcpRow => ({
  server: found.server,
  allowedTools: found.allowedTools,
  credentialRefs: found.credentialRefs,
  revision: found.revision,
  updatedBy: found.updatedBy,
});

export async function agentMcpRowOf(
  executor: Database,
  agentId: string,
): Promise<AgentMcpRow | null> {
  const [found] = await executor
    .select()
    .from(agentMcpSettings)
    .where(eq(agentMcpSettings.agentId, agentId.toLowerCase()))
    .limit(1);
  return found === undefined ? null : rowOf(found);
}

async function releaseOf(
  executor: Database,
  releaseId: string | null,
): Promise<AgentMcpRelease | null> {
  if (releaseId === null) return null;
  const [release] = await rowsOf<{
    id: string;
    card: unknown;
    policy_pins: unknown;
  }>(
    await executor.execute(
      sql`SELECT r.id, v.card, r.policy_pins
        FROM agent_releases r
        JOIN agent_versions v ON v.id = r.version_id
        WHERE r.id = ${releaseId}`,
    ),
  );
  return release === undefined
    ? null
    : { id: release.id, card: release.card, policyPins: release.policy_pins };
}

export function createPostgresAgentMcpStore(db: Database): AgentMcpStore {
  return {
    async agent(workspaceId, agentId) {
      const [found] = await db
        .select({
          releaseId: agents.activeReleaseId,
          workspaceSlug: workspaces.slug,
        })
        .from(agents)
        .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            eq(agents.id, agentId.toLowerCase()),
          ),
        )
        .limit(1);
      if (found === undefined) return null;
      return {
        workspaceSlug: found.workspaceSlug,
        activeRelease: await releaseOf(db, found.releaseId),
      };
    },

    row: (agentId) => agentMcpRowOf(db, agentId),

    async boundRefs(workspaceId, agentId, refs) {
      if (refs.length === 0) return [];
      const found = await db
        .selectDistinct({ ref: credentialBindings.credentialRef })
        .from(credentialBindings)
        .where(
          and(
            eq(credentialBindings.workspaceId, workspaceId),
            eq(credentialBindings.target, "agent"),
            eq(credentialBindings.targetId, agentId.toLowerCase()),
            inArray(credentialBindings.credentialRef, [...refs]),
            isNull(credentialBindings.revokedAt),
          ),
        );
      return found.map((row) => row.ref).sort();
    },

    put(input) {
      return db.transaction(async (tx) => {
        const agentId = input.agentId.toLowerCase();
        // Agent row first, then its settings: the order a session start takes.
        const locked = await lockAgentToChange(tx, input, agentId);
        if ("outcome" in locked) return locked;
        const [held] = await tx
          .select()
          .from(agentMcpSettings)
          .where(eq(agentMcpSettings.agentId, agentId))
          .for("update");
        const heldRevision = held?.revision ?? null;
        if (heldRevision !== input.expectedRevision) {
          return { outcome: "conflict" as const, revision: heldRevision };
        }
        const current = held === undefined ? null : rowOf(held);
        // Read under the agent lock: an activation cannot move it now.
        const [agentNow] = await tx
          .select({ releaseId: agents.activeReleaseId })
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1);
        const release = await releaseOf(tx, agentNow?.releaseId ?? null);
        input.check(
          current,
          release === null
            ? null
            : mcpValuesOfCard(release.card, release.policyPins).server,
        );
        const next = {
          server: input.settings.server,
          allowedTools: input.settings.allowed_tools,
          credentialRefs: input.settings.credential_refs,
        };
        // A row an operator copied has no `updated_by`; saving it, even
        // unchanged, is what makes it a person's (design 3.7), so it counts.
        if (
          current !== null &&
          current.updatedBy !== null &&
          sameValues(current, next)
        ) {
          return {
            outcome: "saved" as const,
            revision: current.revision,
            receiptId: null,
          };
        }
        let revision: number;
        if (current === null) {
          const [inserted] = await tx
            .insert(agentMcpSettings)
            .values({
              agentId,
              workspaceId: input.workspaceId,
              ...next,
              revision: 1,
              updatedBy: input.userId,
            })
            .onConflictDoNothing({ target: agentMcpSettings.agentId })
            .returning({ revision: agentMcpSettings.revision });
          if (inserted === undefined) {
            return { outcome: "conflict" as const, revision: null };
          }
          revision = inserted.revision;
        } else {
          const [updated] = await tx
            .update(agentMcpSettings)
            .set({
              ...next,
              revision: sql`${agentMcpSettings.revision} + 1`,
              updatedBy: input.userId,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(agentMcpSettings.agentId, agentId),
                eq(agentMcpSettings.revision, current.revision),
              ),
            )
            .returning({ revision: agentMcpSettings.revision });
          if (updated === undefined) {
            return { outcome: "conflict" as const, revision: current.revision };
          }
          revision = updated.revision;
        }
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.principal.ownerId,
          actor: receiptActorOf(input.principal),
          operation: "set_agent_mcp",
          targetRef: {
            resource: { kind: "agent", id: agentId },
            workspace_id: input.workspaceId,
          },
          status: "succeeded",
          result: {
            agent_id: agentId,
            change: "settings",
            agent_settings_revision: revision,
            before: current === null ? null : valuesOf(current),
            after: valuesOf(next),
          },
        });
        return { outcome: "saved" as const, revision, receiptId };
      });
    },
  };
}

// The one-time copy of release values into settings rows (the operator's
// CLI). A row it writes has `updated_by` NULL and `revision` 1, which is how
// `--revert` tells it from a person's row: nothing else may write that pair,
// so the person's write above takes a user id and this one takes none.

/** Every agent that is not archived, with the values a copy reads. */
export async function readMcpMigrationFacts(
  executor: Database,
  only?: { agentId: string },
): Promise<McpMigrationFact[]> {
  const found = rowsOf<{
    workspace_id: string;
    agent_id: string;
    name: string;
    has_row: boolean;
    active_card: unknown;
    active_pins: unknown;
    has_active: boolean;
    draft_card: unknown;
  }>(
    await executor.execute(
      sql`SELECT a.workspace_id, a.id AS agent_id, a.name,
          EXISTS (SELECT 1 FROM agent_mcp_settings m WHERE m.agent_id = a.id) AS has_row,
          av.card AS active_card, r.policy_pins AS active_pins,
          (r.id IS NOT NULL) AS has_active,
          (SELECT v.card FROM agent_versions v WHERE v.agent_id = a.id
             ORDER BY v.version_no DESC LIMIT 1) AS draft_card
        FROM agents a
        LEFT JOIN agent_releases r ON r.id = a.active_release_id
        LEFT JOIN agent_versions av ON av.id = r.version_id
        WHERE a.status <> 'archived'
          ${only === undefined ? sql`` : sql`AND a.id = ${only.agentId}`}
        ORDER BY a.workspace_id, a.id`,
    ),
  );
  return found.map((row) => ({
    workspace_id: row.workspace_id,
    agent_id: row.agent_id,
    name: row.name,
    has_row: row.has_row,
    active: row.has_active
      ? { card: row.active_card, policy_pins: row.active_pins }
      : null,
    draft_card: row.draft_card,
  }));
}

export type McpCopyResult =
  | { status: "copied" }
  | { status: "skipped_existing" }
  | { status: "changed_since_report"; reason: string };

/**
 * Writes one agent's copy row if the agent still reads as the report says.
 * The agent row is locked, as an activation or a save locks it, and its
 * values are read again inside the lock; a row that has appeared is never
 * touched.
 */
export async function copyMcpSettingsRow(
  db: Database,
  input: { entry: McpMigrationEntry; includeDrafts: boolean },
): Promise<McpCopyResult> {
  const { entry } = input;
  return db.transaction(async (tx) => {
    const [held] = rowsOf<{ id: string }>(
      await tx.execute(
        sql`SELECT id FROM agents WHERE id = ${entry.agent_id} AND workspace_id = ${entry.workspace_id} FOR UPDATE`,
      ),
    );
    if (held === undefined) {
      return { status: "changed_since_report", reason: "agent_gone" } as const;
    }
    const facts = await readMcpMigrationFacts(tx, { agentId: entry.agent_id });
    const now = planMcpSettingsMigration({
      facts,
      includeDrafts: input.includeDrafts,
    }).agents[0];
    if (now === undefined) {
      return { status: "changed_since_report", reason: "agent_gone" } as const;
    }
    if (now.skip_reason === "has_row") {
      return { status: "skipped_existing" } as const;
    }
    if (now.decision !== "copy" || copyValuesOf(now) !== copyValuesOf(entry)) {
      return {
        status: "changed_since_report",
        reason: now.skip_reason ?? "values_changed",
      } as const;
    }
    const inserted = await tx
      .insert(agentMcpSettings)
      .values({
        agentId: entry.agent_id,
        workspaceId: entry.workspace_id,
        server: entry.server,
        allowedTools: entry.allowed_tools,
        credentialRefs: entry.credential_refs,
        revision: 1,
        updatedBy: null,
      })
      .onConflictDoNothing({ target: agentMcpSettings.agentId })
      .returning({ agentId: agentMcpSettings.agentId });
    return inserted.length === 0
      ? ({ status: "skipped_existing" } as const)
      : ({ status: "copied" } as const);
  });
}

/** Copy rows nobody has saved since: the only rows `--revert` may touch. */
export async function listMcpCopyCandidates(
  db: Database,
): Promise<{ agent_id: string; workspace_id: string }[]> {
  return rowsOf<{ agent_id: string; workspace_id: string }>(
    await db.execute(
      sql`SELECT agent_id, workspace_id FROM agent_mcp_settings
        WHERE updated_by IS NULL AND revision = 1 ORDER BY workspace_id, agent_id`,
    ),
  );
}

/** Rows a person has saved: kept by `--revert` and reported. */
export async function listMcpEditedRows(
  db: Database,
): Promise<{ agent_id: string; revision: number }[]> {
  return rowsOf<{ agent_id: string; revision: number }>(
    await db.execute(
      sql`SELECT agent_id, revision FROM agent_mcp_settings
        WHERE updated_by IS NOT NULL OR revision > 1 ORDER BY agent_id`,
    ),
  );
}

export type McpRevertResult =
  | { status: "reverted" }
  | { status: "left"; reason: string };

/**
 * Removes one copy row, only when removing it takes nothing away: the agent
 * row is locked first and then the settings row, so a session start or a
 * save is either before this or after it; and the checks are made under
 * those locks.
 */
export async function revertMcpCopyRow(
  db: Database,
  input: { agentId: string; workspaceId: string },
): Promise<McpRevertResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM agents WHERE id = ${input.agentId} AND workspace_id = ${input.workspaceId} FOR UPDATE`,
    );
    const [row] = await tx
      .select()
      .from(agentMcpSettings)
      .where(eq(agentMcpSettings.agentId, input.agentId))
      .for("update");
    if (row === undefined)
      return { status: "left", reason: "row_gone" } as const;
    if (row.updatedBy !== null || row.revision !== 1) {
      return { status: "left", reason: "edited_since" } as const;
    }
    // A session that started with this row's snapshot would lose its MCP.
    const [open] = rowsOf<{ n: number }>(
      await tx.execute(
        sql`SELECT count(*)::int AS n FROM sessions s
          JOIN agent_releases r ON r.id = s.agent_release_id
          WHERE r.agent_id = ${input.agentId}
            AND s.mcp_start IS NOT NULL AND s.admission_state <> 'closed'`,
      ),
    );
    if ((open?.n ?? 0) > 0) {
      return { status: "left", reason: "open_session_with_snapshot" } as const;
    }
    // The row must still be the copy of what the agent's release says now.
    const facts = await readMcpMigrationFacts(tx, { agentId: input.agentId });
    const [fact] = facts;
    if (fact === undefined)
      return { status: "left", reason: "agent_gone" } as const;
    const [now] = planMcpSettingsMigration({
      facts: [{ ...fact, has_row: false }],
      includeDrafts: true,
    }).agents;
    const rowValues = JSON.stringify([
      row.server,
      row.allowedTools,
      row.credentialRefs,
    ]);
    if (now === undefined || copyValuesOf(now) !== rowValues) {
      return { status: "left", reason: "changed" } as const;
    }
    // Every release of the agent must carry what the row says, so a session
    // of any of them keeps its access once the row is gone.
    const releases = rowsOf<{ card: unknown; policy_pins: unknown }>(
      await tx.execute(
        sql`SELECT v.card, r.policy_pins FROM agent_releases r
          JOIN agent_versions v ON v.id = r.version_id
          WHERE r.agent_id = ${input.agentId}`,
      ),
    );
    const carries = releases.every((release) => {
      const values = mcpValuesOfCard(release.card, release.policy_pins);
      return (
        values.server === row.server &&
        row.allowedTools.every((tool) => values.allowedTools.includes(tool)) &&
        row.credentialRefs.every((ref) => values.credentialRefs.includes(ref))
      );
    });
    if (!carries) {
      return { status: "left", reason: "release_does_not_carry" } as const;
    }
    await tx
      .delete(agentMcpSettings)
      .where(
        and(
          eq(agentMcpSettings.agentId, input.agentId),
          isNull(agentMcpSettings.updatedBy),
          eq(agentMcpSettings.revision, 1),
        ),
      );
    return { status: "reverted" } as const;
  });
}

export type { McpMigrationPlan };

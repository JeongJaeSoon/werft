import { randomUUID } from "node:crypto";
import type {
  AgentMcpRelease,
  AgentMcpRow,
  AgentMcpStore,
} from "@werft-ai/platform";
import { mcpDenyOf, mcpValuesOfCard, receiptActorOf } from "@werft-ai/platform";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { lockAgentToChange } from "../agents.ts";
import type { Database } from "../queries.ts";
import {
  agentMcpSettings,
  agents,
  credentialBindings,
  receipts,
  workspaces,
} from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";

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

async function agentMcpRowOf(
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
    runtime_config_snapshot: unknown;
  }>(
    await executor.execute(
      sql`SELECT r.id, v.card, r.policy_pins, r.runtime_config_snapshot
        FROM agent_releases r
        JOIN agent_versions v ON v.id = r.version_id
        WHERE r.id = ${releaseId}`,
    ),
  );
  return release === undefined
    ? null
    : {
        id: release.id,
        card: release.card,
        policyPins: release.policy_pins,
        mcpDeny: mcpDenyOf(release.runtime_config_snapshot),
      };
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
          release?.mcpDeny ?? [],
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

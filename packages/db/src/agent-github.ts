import { randomUUID } from "node:crypto";
import type { AgentGitHubStore } from "@werft-ai/platform";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { lockAgentToChange } from "./agents.ts";
import { receiptActorOf } from "./control-shared.ts";
import {
  agentGitHubSettingsOf,
  ensureRepositoryCeilingWhenUnset,
  workspaceRepositoryCeiling,
} from "./github-settings.ts";
import { receiptFromRow } from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import {
  agentGitHubSettings,
  agentReleases,
  agents,
  receipts,
  sessions,
} from "./schema.ts";
import { sessionVisibleTo } from "./session-shares.ts";

/**
 * Receipts naming the agent; a release or activation only when it moved
 * `github`. A save of the agent's MCP settings is listed too: it makes no
 * release, so this list is where the Releases tab finds it.
 */
const AGENT_OPERATIONS = [
  "set_agent_github",
  "set_agent_mcp",
  "create_agent_release",
  "activate_agent",
] as const;
/** The gate's and the work service's receipts, which name a session. */
const SESSION_OPERATIONS = [
  "mint_github_token",
  "review_pull_request",
  "dispatch_workflow",
  "rerun_workflow",
] as const;

type SettingsValues = {
  repositories: unknown;
  pushApproval: boolean;
  features: unknown;
  actionsAllow: unknown;
  startRepositoryId: string | null;
  pushAttached: string | null;
};

/** The columns a person edits, as the receipt records them. */
const valuesOf = (row: SettingsValues) => ({
  repositories: row.repositories,
  push_approval: row.pushApproval,
  features: row.features,
  actions_allow: row.actionsAllow,
  start_repository_id: row.startRepositoryId,
  push_attached: row.pushAttached,
});

// jsonb returns keys in its own order, so the comparison sorts them.
const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, sorted(entry)]),
        )
      : value;

const canonical = (row: SettingsValues) =>
  JSON.stringify(sorted(valuesOf(row)));

export function createPostgresAgentGitHubStore(db: Database): AgentGitHubStore {
  return {
    settings: (agentId) => agentGitHubSettingsOf(db, agentId),
    repositoryCeiling: (workspaceId) =>
      workspaceRepositoryCeiling(db, workspaceId),

    async enabled(workspaceId, agentId) {
      const [row] = await db
        .select({ enabled: agents.githubEnabled })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            eq(agents.id, agentId.toLowerCase()),
          ),
        )
        .limit(1);
      return row?.enabled ?? null;
    },

    setEnabled(input) {
      return db.transaction(async (tx) => {
        const agentId = input.agentId.toLowerCase();
        const locked = await lockAgentToChange(tx, input, agentId);
        if ("outcome" in locked) return locked;
        const [held] = await tx
          .select({ enabled: agents.githubEnabled })
          .from(agents)
          .where(eq(agents.id, agentId));
        if (held === undefined) return { outcome: "not_found" as const };
        if (held.enabled === input.enabled) {
          return { outcome: "saved" as const, receiptId: null };
        }
        await tx
          .update(agents)
          .set({ githubEnabled: input.enabled })
          .where(eq(agents.id, agentId));
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.principal.ownerId,
          actor: receiptActorOf(input.principal),
          operation: "set_agent_github",
          targetRef: {
            resource: { kind: "agent", id: agentId },
            workspace_id: input.workspaceId,
          },
          status: "succeeded",
          result: { agent_id: agentId, enabled: input.enabled },
        });
        return { outcome: "saved" as const, receiptId };
      });
    },

    putSettings(input) {
      return db.transaction(async (tx) => {
        const agentId = input.agentId.toLowerCase();
        // Agent row first, then its settings: the order a session start takes.
        const locked = await lockAgentToChange(tx, input, agentId);
        if ("outcome" in locked) return locked;
        const [held] = await tx
          .select()
          .from(agentGitHubSettings)
          .where(eq(agentGitHubSettings.agentId, agentId))
          .for("update");
        const heldRevision = held?.revision ?? null;
        if (heldRevision !== input.expectedRevision) {
          return { outcome: "conflict" as const, revision: heldRevision };
        }
        // First use of a workspace without a ceiling writes the default one,
        // after the agent and its settings are locked (design 3.2). Judged
        // against what is stored now, in this transaction.
        const ceiling = await ensureRepositoryCeilingWhenUnset(
          tx,
          input.workspaceId,
        );
        input.check(held ?? null, ceiling);
        const next = {
          repositories: input.settings.repositories,
          pushApproval: input.settings.push_approval,
          features: input.settings.features,
          actionsAllow: input.settings.actions_allow,
          startRepositoryId: input.startRepositoryId,
          // Left out: a first save is `allow` (owner decision D6), a later
          // one keeps what the row holds, which for a row from before the
          // column is null and keeps asking a person.
          pushAttached:
            input.pushAttached ??
            (held === undefined ? "allow" : held.pushAttached),
        };
        // A row a migration wrote has no `updated_by`; saving it, even
        // unchanged, is what makes it a person's (design 3.7), so it counts.
        if (
          held !== undefined &&
          held.updatedBy !== null &&
          canonical(held) === canonical(next)
        ) {
          return {
            outcome: "saved" as const,
            revision: held.revision,
            receiptId: null,
          };
        }
        let revision: number;
        if (held === undefined) {
          const [inserted] = await tx
            .insert(agentGitHubSettings)
            .values({
              agentId,
              workspaceId: input.workspaceId,
              ...next,
              revision: 1,
              updatedBy: input.userId,
            })
            .onConflictDoNothing({ target: agentGitHubSettings.agentId })
            .returning({ revision: agentGitHubSettings.revision });
          if (inserted === undefined) {
            return { outcome: "conflict" as const, revision: null };
          }
          revision = inserted.revision;
        } else {
          const [updated] = await tx
            .update(agentGitHubSettings)
            .set({
              ...next,
              revision: sql`${agentGitHubSettings.revision} + 1`,
              updatedBy: input.userId,
              updatedAt: sql`now()`,
            })
            .where(
              and(
                eq(agentGitHubSettings.agentId, agentId),
                eq(agentGitHubSettings.revision, held.revision),
              ),
            )
            .returning({ revision: agentGitHubSettings.revision });
          if (updated === undefined) {
            return { outcome: "conflict" as const, revision: held.revision };
          }
          revision = updated.revision;
        }
        const receiptId = randomUUID();
        await tx.insert(receipts).values({
          id: receiptId,
          ownerId: input.principal.ownerId,
          actor: receiptActorOf(input.principal),
          operation: "set_agent_github",
          targetRef: {
            resource: { kind: "agent", id: agentId },
            workspace_id: input.workspaceId,
          },
          status: "succeeded",
          result: {
            agent_id: agentId,
            change: "settings",
            agent_settings_revision: revision,
            before: held === undefined ? null : valuesOf(held),
            after: valuesOf(next),
          },
        });
        return { outcome: "saved" as const, revision, receiptId };
      });
    },

    async activity(workspaceId, agentId, viewer, limit) {
      const id = agentId.toLowerCase();
      const agentTarget = and(
        inArray(receipts.operation, [...AGENT_OPERATIONS]),
        sql`${receipts.targetRef} -> 'resource' = ${JSON.stringify({ kind: "agent", id })}::jsonb`,
        or(
          inArray(receipts.operation, ["set_agent_github", "set_agent_mcp"]),
          sql`${receipts.result} -> 'github_changed' = 'true'::jsonb`,
        ),
      );
      // Filtered before the limit, so sessions the caller cannot see never
      // take a place among the latest.
      const visibleSession = and(
        inArray(receipts.operation, [...SESSION_OPERATIONS]),
        sql`EXISTS (SELECT 1 FROM ${sessions} JOIN ${agentReleases} ON ${agentReleases.id} = ${sessions.agentReleaseId} WHERE ${sessions.id}::text = ${receipts.targetRef} ->> 'session_id' AND ${agentReleases.agentId} = ${id} AND ${sessionVisibleTo(db, viewer)})`,
      );
      const rows = await db
        .select()
        .from(receipts)
        .where(
          and(
            eq(receipts.ownerId, workspaceId),
            or(agentTarget, visibleSession),
          ),
        )
        .orderBy(desc(receipts.createdAt), desc(receipts.id))
        .limit(limit);
      return rows.map(receiptFromRow);
    },
  };
}

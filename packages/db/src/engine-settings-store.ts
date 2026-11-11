import { randomUUID } from "node:crypto";
import {
  type StoredEngineSettings,
  storedEngineSettingsSchema,
} from "@werft-ai/contracts";
import type {
  EngineSettingsStore,
  PutEngineSettingsInput,
  PutEngineSettingsResult,
  SavedEngineSettings,
} from "@werft-ai/platform";
import { receiptActorOf } from "@werft-ai/platform";
import { and, eq, sql } from "drizzle-orm";
import { lockAgentToChange } from "./agents.ts";
import type { Database } from "./queries.ts";
import {
  agentEngineSettings,
  agents,
  receipts,
  workspaceEngineSettings,
  workspaces,
} from "./schema.ts";
import { lockManager } from "./workspace-settings.ts";

/** The two jsonb columns for a rule set: lists that hold something, no gaps. */
function columnsOf(settings: StoredEngineSettings): {
  permissions: Record<string, string[]>;
  autoMode: Record<string, string[]>;
} {
  const kept = (lists: Record<string, string[] | undefined>) =>
    Object.fromEntries(
      Object.entries(lists).filter(
        (entry): entry is [string, string[]] =>
          entry[1] !== undefined && entry[1].length > 0,
      ),
    );
  return {
    permissions: kept(settings.permissions),
    autoMode: kept(settings.auto_mode),
  };
}

const NO_RULES: StoredEngineSettings = { permissions: {}, auto_mode: {} };

const bytesOf = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

const countsOf = (lists: Record<string, string[] | undefined>) =>
  Object.fromEntries(
    Object.entries(lists).map(([key, list]) => [key, list?.length ?? 0]),
  );

/**
 * What a receipt says of a save: how many rules of each kind and how many
 * bytes. A rule's text is never written there; the row holds the current
 * rules, and the receipts give who changed them and when.
 */
const summaryOf = (settings: StoredEngineSettings) => ({
  permissions: countsOf(settings.permissions),
  auto_mode: countsOf(settings.auto_mode),
  bytes: {
    permissions: bytesOf(settings.permissions),
    auto_mode: bytesOf(settings.auto_mode),
  },
});

/**
 * Lists in the order they were saved, empty ones dropped, so two spellings of
 * the same rules compare equal.
 */
const normalized = (settings: StoredEngineSettings) =>
  JSON.stringify(columnsOf(settings));

const savedOf = (row: {
  permissions: unknown;
  autoMode: unknown;
  revision: number;
}): SavedEngineSettings => ({
  settings: storedEngineSettingsSchema.parse({
    permissions: row.permissions,
    auto_mode: row.autoMode,
  }),
  revision: row.revision,
});

export function createPostgresEngineSettingsStore(
  db: Database,
): EngineSettingsStore {
  return {
    async workspace(workspaceId) {
      const [row] = await db
        .select()
        .from(workspaceEngineSettings)
        .where(eq(workspaceEngineSettings.workspaceId, workspaceId))
        .limit(1);
      return row === undefined
        ? { settings: NO_RULES, revision: null }
        : savedOf(row);
    },

    async agent(workspaceId, agentId) {
      const id = agentId.toLowerCase();
      const [row] = await db
        .select()
        .from(agentEngineSettings)
        .where(
          and(
            eq(agentEngineSettings.agentId, id),
            eq(agentEngineSettings.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (row === undefined) {
        const [exists] = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
          .limit(1);
        if (exists === undefined) return null;
        return { settings: NO_RULES, revision: null };
      }
      return savedOf(row);
    },

    putWorkspace(input) {
      return db.transaction(async (tx) => {
        if (!(await lockManager(tx, input.workspaceId, input.userId))) {
          return { outcome: "actor_inactive" as const };
        }
        const [workspace] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, input.workspaceId))
          .for("update");
        if (workspace === undefined) return { outcome: "not_found" as const };
        const [held] = await tx
          .select()
          .from(workspaceEngineSettings)
          .where(eq(workspaceEngineSettings.workspaceId, input.workspaceId))
          .for("update");
        return await save(tx, input, {
          operation: "set_workspace_engine_settings",
          target: { kind: "workspace", id: input.workspaceId },
          held: held === undefined ? null : savedOf(held),
          write: async (next, current) => {
            if (current === null) {
              const [inserted] = await tx
                .insert(workspaceEngineSettings)
                .values({
                  workspaceId: input.workspaceId,
                  ...columnsOf(next),
                  revision: 1,
                  updatedBy: input.userId,
                })
                .onConflictDoNothing({
                  target: workspaceEngineSettings.workspaceId,
                })
                .returning({ revision: workspaceEngineSettings.revision });
              return inserted?.revision ?? null;
            }
            const [updated] = await tx
              .update(workspaceEngineSettings)
              .set({
                ...columnsOf(next),
                revision: sql`${workspaceEngineSettings.revision} + 1`,
                updatedBy: input.userId,
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(workspaceEngineSettings.workspaceId, input.workspaceId),
                  eq(workspaceEngineSettings.revision, current),
                ),
              )
              .returning({ revision: workspaceEngineSettings.revision });
            return updated?.revision ?? null;
          },
        });
      });
    },

    putAgent(input) {
      return db.transaction(async (tx) => {
        const agentId = input.agentId.toLowerCase();
        // Account, membership, agent, then the right to manage it: the order a
        // session start and the MCP save take.
        const locked = await lockAgentToChange(tx, input, agentId);
        if ("outcome" in locked) return locked;
        const [held] = await tx
          .select()
          .from(agentEngineSettings)
          .where(eq(agentEngineSettings.agentId, agentId))
          .for("update");
        return await save(tx, input, {
          operation: "set_agent_engine_settings",
          target: { kind: "agent", id: agentId },
          held: held === undefined ? null : savedOf(held),
          write: async (next, current) => {
            if (current === null) {
              const [inserted] = await tx
                .insert(agentEngineSettings)
                .values({
                  agentId,
                  workspaceId: input.workspaceId,
                  ...columnsOf(next),
                  revision: 1,
                  updatedBy: input.userId,
                })
                .onConflictDoNothing({ target: agentEngineSettings.agentId })
                .returning({ revision: agentEngineSettings.revision });
              return inserted?.revision ?? null;
            }
            const [updated] = await tx
              .update(agentEngineSettings)
              .set({
                ...columnsOf(next),
                revision: sql`${agentEngineSettings.revision} + 1`,
                updatedBy: input.userId,
                updatedAt: sql`now()`,
              })
              .where(
                and(
                  eq(agentEngineSettings.agentId, agentId),
                  eq(agentEngineSettings.revision, current),
                ),
              )
              .returning({ revision: agentEngineSettings.revision });
            return updated?.revision ?? null;
          },
        });
      });
    },
  };
}

/**
 * The part of a save both scopes share, run with the rows already locked:
 * compare the revision, skip a save that changes nothing, write, and record the
 * receipt. `write` gets the new rules and the revision it replaces (null: no
 * row) and returns the new revision, or null if the row moved.
 */
async function save(
  tx: Database,
  input: PutEngineSettingsInput,
  step: {
    operation: "set_workspace_engine_settings" | "set_agent_engine_settings";
    target: { kind: "workspace" | "agent"; id: string };
    held: SavedEngineSettings | null;
    write: (
      next: StoredEngineSettings,
      current: number | null,
    ) => Promise<number | null>;
  },
): Promise<PutEngineSettingsResult> {
  const heldRevision = step.held?.revision ?? null;
  if (heldRevision !== input.expectedRevision) {
    return { outcome: "conflict", revision: heldRevision };
  }
  if (
    step.held !== null &&
    normalized(step.held.settings) === normalized(input.settings)
  ) {
    return {
      outcome: "saved",
      revision: step.held.revision ?? 0,
      receiptId: null,
    };
  }
  const revision = await step.write(input.settings, heldRevision);
  if (revision === null) return { outcome: "conflict", revision: heldRevision };
  const receiptId = randomUUID();
  await tx.insert(receipts).values({
    id: receiptId,
    ownerId: input.principal.ownerId,
    actor: receiptActorOf(input.principal),
    operation: step.operation,
    targetRef: {
      resource: step.target,
      workspace_id: input.workspaceId,
    },
    status: "succeeded",
    result: {
      scope: step.target.kind,
      target_id: step.target.id,
      revision_before: heldRevision,
      revision_after: revision,
      before: summaryOf(step.held?.settings ?? NO_RULES),
      after: summaryOf(input.settings),
    },
  });
  return { outcome: "saved", revision, receiptId };
}

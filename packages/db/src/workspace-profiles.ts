import {
  type PermissionMode,
  type RepositoryMode,
  workspaceProfileId,
} from "@werft-ai/contracts";
import type {
  TeamActor,
  WorkspaceProfileRecord,
  WorkspaceProfileStore,
} from "@werft-ai/platform";
import { and, asc, eq, max, sql } from "drizzle-orm";
import { findPgError, lockPeople, receiptActorOf } from "./control-shared.ts";
import { assertProfileTablesWritable } from "./profile-freeze.ts";
import type { Database } from "./queries.ts";
import { receipts, workspaceProfiles, workspaces } from "./schema.ts";

const PROFILE_MANAGERS = ["owner", "admin"];

function recordOf(
  row: typeof workspaceProfiles.$inferSelect,
): WorkspaceProfileRecord {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    version: row.version,
    base_profile_id: row.baseProfileId,
    base_fingerprint: row.baseFingerprint,
    model: row.model,
    models: row.models,
    tools: row.tools,
    permission_mode: row.permissionMode as PermissionMode,
    base_runtime_version: row.baseRuntimeVersion,
    base_billing: row.baseBilling as "metered" | "none",
    base_repository_mode: row.baseRepositoryMode as RepositoryMode,
    deny: row.deny,
    tool_catalog_id: row.toolCatalogId,
    created_by: row.createdBy,
    created_at: row.createdAt,
    retired_by: row.retiredBy,
    retired_at: row.retiredAt,
  };
}

async function actorManages(tx: Database, actor: TeamActor) {
  const [me] = await lockPeople(tx, actor.workspaceId, [actor.userId]);
  return me?.live === true && PROFILE_MANAGERS.includes(me.role);
}

async function writeReceipt(
  tx: Database,
  actor: TeamActor,
  input: {
    id: string;
    operation: "create_workspace_profile" | "retire_workspace_profile";
    record: WorkspaceProfileRecord;
    previousDenyDrift?: boolean | undefined;
  },
) {
  await tx.insert(receipts).values({
    id: input.id,
    ownerId: actor.principal.ownerId,
    actor: receiptActorOf(actor.principal),
    operation: input.operation,
    targetRef: {
      resource: { kind: "workspace", id: actor.workspaceId },
      workspace_id: actor.workspaceId,
    },
    result: {
      profile_id: input.record.id,
      name: input.record.name,
      version: input.record.version,
      base_profile_id: input.record.base_profile_id,
      ...(input.operation === "create_workspace_profile"
        ? {
            deny: input.record.deny ?? null,
            tool_catalog_id: input.record.tool_catalog_id ?? null,
            ...(input.previousDenyDrift ? { previous_deny_drift: true } : {}),
          }
        : {}),
    },
    status: "succeeded",
    requestId: actor.principal.requestId ?? null,
  });
}

function isVersionTaken(error: unknown): boolean {
  const constraint = findPgError(error, "23505")?.constraint;
  return (
    constraint === "workspace_profiles_version_key" ||
    constraint === "workspace_profiles_pkey"
  );
}

export function createPostgresWorkspaceProfileStore(
  db: Database,
): WorkspaceProfileStore {
  return {
    async listAll() {
      const rows = await db
        .select()
        .from(workspaceProfiles)
        .orderBy(asc(workspaceProfiles.id));
      return rows.map(recordOf);
    },

    async create(input) {
      const { actor } = input;
      try {
        return await db.transaction(async (tx) => {
          await assertProfileTablesWritable(tx);
          if (!(await actorManages(tx, actor))) {
            return { outcome: "actor_inactive" as const };
          }
          const [workspace] = await tx
            .select({ id: workspaces.id, slug: workspaces.slug })
            .from(workspaces)
            .where(eq(workspaces.id, actor.workspaceId));
          if (!workspace) return { outcome: "actor_inactive" as const };
          const [latest] = await tx
            .select({ version: max(workspaceProfiles.version) })
            .from(workspaceProfiles)
            .where(
              and(
                eq(workspaceProfiles.workspaceId, actor.workspaceId),
                eq(workspaceProfiles.name, input.name),
              ),
            );
          if (
            input.previousVersion !== undefined &&
            (latest?.version ?? null) !== input.previousVersion
          ) {
            return { outcome: "version_taken" as const };
          }
          const version = (latest?.version ?? 0) + 1;
          const [row] = await tx
            .insert(workspaceProfiles)
            .values({
              id: workspaceProfileId(workspace, input.name, version),
              workspaceId: actor.workspaceId,
              name: input.name,
              version,
              baseProfileId: input.baseProfileId,
              baseFingerprint: input.base.fingerprint,
              baseRuntimeVersion: input.base.runtimeVersion,
              baseBilling: input.base.billing,
              baseRepositoryMode: input.base.repositoryMode,
              model: input.narrowing.model,
              models: input.narrowing.models,
              tools: input.narrowing.tools,
              deny: input.deny,
              toolCatalogId: input.toolCatalogId,
              permissionMode: input.narrowing.permission_mode,
              createdBy: actor.userId,
            })
            .returning();
          if (!row) throw new Error("workspace profile insert returned no row");
          const record = recordOf(row);
          await writeReceipt(tx, actor, {
            id: input.receiptId,
            operation: "create_workspace_profile",
            record,
            previousDenyDrift: input.previousDenyDrift,
          });
          return { outcome: "created" as const, record };
        });
      } catch (error) {
        if (isVersionTaken(error)) return { outcome: "version_taken" };
        throw error;
      }
    },

    async retire(input) {
      const { actor } = input;
      return db.transaction(async (tx) => {
        await assertProfileTablesWritable(tx);
        if (!(await actorManages(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const [row] = await tx
          .select()
          .from(workspaceProfiles)
          .where(
            and(
              eq(workspaceProfiles.id, input.profileId),
              eq(workspaceProfiles.workspaceId, actor.workspaceId),
            ),
          )
          .for("update");
        if (!row) return { outcome: "not_found" as const };
        if (row.retiredAt !== null) {
          return { outcome: "unchanged" as const, record: recordOf(row) };
        }
        const [retired] = await tx
          .update(workspaceProfiles)
          .set({ retiredAt: sql`now()`, retiredBy: actor.userId })
          .where(eq(workspaceProfiles.id, row.id))
          .returning();
        if (!retired)
          throw new Error("workspace profile update returned no row");
        const record = recordOf(retired);
        await writeReceipt(tx, actor, {
          id: input.receiptId,
          operation: "retire_workspace_profile",
          record,
        });
        return { outcome: "retired" as const, record };
      });
    },
  };
}

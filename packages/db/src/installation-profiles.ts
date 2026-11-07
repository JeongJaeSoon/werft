import { randomUUID } from "node:crypto";
import {
  installationProfileId,
  type PermissionMode,
} from "@werft-ai/contracts";
import {
  type InstallationProfileRecord,
  type InstallationProfileStore,
  sameExecutionForm,
  type TeamActor,
} from "@werft-ai/platform";
import { and, asc, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { lockPeople, receiptActorOf } from "./control-shared.ts";
import { lockSettingsGeneration } from "./installation-settings.ts";
import { writeProfileRollout } from "./profile-rollouts.ts";
import type { Database } from "./queries.ts";
import { installationProfiles, receipts } from "./schema.ts";

// Imports and console saves take the same lock, so a version number and an
// id are decided by one writer at a time.
export const lockWrites = async (tx: Database) => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('profiles:import'))`,
  );
  await lockSettingsGeneration(tx);
};

async function actorRole(tx: Database, actor: TeamActor) {
  const [me] = await lockPeople(tx, actor.workspaceId, [actor.userId]);
  return me?.live === true ? me.role : null;
}

async function actorOperates(tx: Database, actor: TeamActor) {
  return (await actorRole(tx, actor)) === "owner";
}

async function writeReceipt(
  tx: Database,
  actor: TeamActor,
  input: {
    id: string;
    operation:
      | "create_installation_profile"
      | "retire_installation_profile"
      | "block_installation_profile"
      | "unblock_installation_profile";
    result: Record<string, unknown>;
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
    result: input.result,
    status: "succeeded",
    requestId: actor.principal.requestId ?? null,
  });
}

export function recordOf(
  row: typeof installationProfiles.$inferSelect,
): InstallationProfileRecord {
  const scope = row.repositoryScope;
  // Null says nothing about repositories; any other value this image does
  // not know is unknown.
  const knownScope =
    scope === null || scope === "profile" || scope === "workspace";
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    origin: row.origin as InstallationProfileRecord["origin"],
    definition: row.definition,
    permission_mode: row.permissionMode as PermissionMode,
    fingerprint: row.fingerprint,
    repository_ids: row.repositoryIds,
    github_app_repositories:
      row.githubAppRepositories === "installed" ? "installed" : "listed",
    repository_scope: knownScope ? scope : "profile",
    derived_from: row.derivedFrom,
    workspace_id: row.workspaceId,
    display_name: row.displayName,
    deny: row.deny,
    tool_catalog_id: row.toolCatalogId,
    previous_id: row.previousId,
    created_by: row.createdBy,
    created_at: row.createdAt,
    retired_at: row.retiredAt,
    retired_by: row.retiredBy,
    // Neither ceiling can be said to judge a scope this image does not know
    // (either could be the wider), so the profile does not run.
    blocked_at: knownScope ? row.blockedAt : (row.blockedAt ?? row.createdAt),
    blocked_by: row.blockedBy,
  };
}

export function createPostgresInstallationProfileStore(
  db: Database,
): InstallationProfileStore {
  return {
    async listAll() {
      const rows = await db
        .select()
        .from(installationProfiles)
        .orderBy(asc(installationProfiles.id));
      return rows.map(recordOf);
    },

    async seedCatalog(input) {
      return db.transaction(async (tx) => {
        await lockWrites(tx);
        const [any] = await tx
          .select({ id: installationProfiles.id })
          .from(installationProfiles)
          .limit(1);
        const entries = any ? [] : await input.entries();
        const seeded =
          entries.length === 0
            ? []
            : await tx
                .insert(installationProfiles)
                .values(
                  entries.map((entry) => ({
                    id: entry.id,
                    name: null,
                    version: 1,
                    origin: "catalog",
                    definition: entry.definition as Record<string, unknown>,
                    permissionMode: entry.permission_mode,
                    fingerprint: entry.fingerprint,
                    // An imported document names its repositories, and the
                    // workspace ceiling that would replace them is not
                    // written yet: keep what it says.
                    repositoryIds: input.repositoryIdsOf(entry.id),
                  })),
                )
                .returning({ id: installationProfiles.id });
        const unmigrated = await tx
          .select({ id: installationProfiles.id })
          .from(installationProfiles)
          // A row with no scope names no repository on purpose: filling it
          // would write the repositories it leaves to the workspace.
          .where(
            and(
              isNull(installationProfiles.repositoryIds),
              isNotNull(installationProfiles.repositoryScope),
            ),
          )
          .orderBy(asc(installationProfiles.id));
        for (const { id } of unmigrated) {
          await tx
            .update(installationProfiles)
            .set({ repositoryIds: input.repositoryIdsOf(id) })
            .where(eq(installationProfiles.id, id));
        }
        return {
          seeded: seeded.map((row) => row.id).sort(),
          migrated: unmigrated.map((row) => row.id),
        };
      });
    },

    async create(input) {
      const { actor, scope } = input;
      const workspaceId = scope.kind === "workspace" ? scope.workspaceId : null;
      return db.transaction(async (tx) => {
        await lockWrites(tx);
        // The role is read again under the lock: an admin writes only a
        // profile of its own workspace, an owner either kind.
        const role = await actorRole(tx, actor);
        if (
          role === null ||
          (scope.kind === "installation" && role !== "owner") ||
          (scope.kind === "workspace" &&
            (scope.workspaceId !== actor.workspaceId ||
              (role !== "owner" && role !== "admin")))
        ) {
          return { outcome: "actor_inactive" as const };
        }
        const [latest] = await tx
          .select()
          .from(installationProfiles)
          .where(
            and(
              eq(installationProfiles.origin, "console"),
              workspaceId === null
                ? and(
                    eq(installationProfiles.name, input.name),
                    isNull(installationProfiles.workspaceId),
                  )
                : and(
                    eq(installationProfiles.workspaceId, workspaceId),
                    eq(installationProfiles.displayName, input.name),
                  ),
            ),
          )
          .orderBy(desc(installationProfiles.version))
          .limit(1);
        // A new profile under a name that has versions is a clash, not a
        // save that raced another one.
        if (latest && input.previousId === null) {
          return { outcome: "name_taken" as const };
        }
        if (latest && input.previousId !== latest.id) {
          return { outcome: "stale_previous" as const, latestId: latest.id };
        }
        // A saved profile that runs the same changes nothing, unless the
        // latest one is retired or blocked (the save then brings it back).
        if (
          latest &&
          latest.retiredAt === null &&
          latest.blockedAt === null &&
          sameExecutionForm(
            latest.definition,
            input.definition as Record<string, unknown>,
          )
        ) {
          return { outcome: "unchanged" as const, record: recordOf(latest) };
        }
        let derivedFrom: string | null = null;
        if (scope.kind === "workspace") {
          derivedFrom = latest ? latest.derivedFrom : scope.derivedFrom;
          if (derivedFrom === null) {
            return { outcome: "unknown_previous" as const };
          }
        }
        // The source is read again here: one retired or blocked on another
        // replica after the service looked is refused like one that is gone.
        // A block on any ancestor stops everything below it, so the whole
        // chain is read, not only the direct source.
        const seen = new Set<string>();
        for (
          let next: string | null = derivedFrom, depth = 0;
          next !== null;
          depth += 1
        ) {
          // A chain that loops back ends the walk rather than the save.
          if (seen.has(next)) break;
          seen.add(next);
          const [source] = await tx
            .select({
              retiredAt: installationProfiles.retiredAt,
              blockedAt: installationProfiles.blockedAt,
              derivedFrom: installationProfiles.derivedFrom,
            })
            .from(installationProfiles)
            .where(eq(installationProfiles.id, next));
          if (
            !source ||
            (depth === 0 && source.retiredAt !== null) ||
            source.blockedAt !== null
          )
            return { outcome: "unknown_previous" as const };
          next = source.derivedFrom;
        }
        // A named row must exist, and an admin's lineage sees nothing of
        // another workspace.
        for (const named of [
          latest ? null : input.previousId,
          latest ? null : derivedFrom,
        ]) {
          if (named === null) continue;
          const [found] = await tx
            .select({ workspaceId: installationProfiles.workspaceId })
            .from(installationProfiles)
            .where(eq(installationProfiles.id, named));
          if (
            !found ||
            (workspaceId !== null &&
              found.workspaceId !== null &&
              found.workspaceId !== workspaceId) ||
            (workspaceId === null && found.workspaceId !== null)
          ) {
            return { outcome: "unknown_previous" as const };
          }
        }
        if (!latest) {
          // What the author calls it must be new to the workspace that sees
          // it; an owner's installation-wide name also to every workspace.
          const [clash] = await tx
            .select({ id: installationProfiles.id })
            .from(installationProfiles)
            .where(
              and(
                or(
                  and(
                    eq(installationProfiles.origin, "console"),
                    eq(installationProfiles.name, input.name),
                    isNull(installationProfiles.workspaceId),
                  ),
                  and(
                    eq(installationProfiles.origin, "catalog"),
                    eq(installationProfiles.id, input.name),
                  ),
                  workspaceId === null
                    ? eq(installationProfiles.displayName, input.name)
                    : and(
                        eq(installationProfiles.workspaceId, workspaceId),
                        eq(installationProfiles.displayName, input.name),
                      ),
                ),
              ),
            )
            .limit(1);
          if (clash) return { outcome: "name_taken" as const };
        }
        const version = (latest?.version ?? 0) + 1;
        // A workspace lineage's key is the server's; a clash is a second
        // draw, never a join onto another lineage.
        let key = latest?.name ?? input.name;
        let id = installationProfileId(key, version);
        for (let attempt = 0; ; attempt += 1) {
          if (workspaceId !== null && !latest) {
            key = `wl_${randomUUID()}`;
            id = installationProfileId(key, version);
          }
          const [taken] = await tx
            .select({ id: installationProfiles.id })
            .from(installationProfiles)
            .where(eq(installationProfiles.id, id));
          if (!taken) break;
          if (workspaceId === null || latest || attempt >= 1) {
            return { outcome: "id_taken" as const, id };
          }
        }
        const [row] = await tx
          .insert(installationProfiles)
          .values({
            id,
            name: key,
            version,
            origin: "console",
            definition: input.definition as Record<string, unknown>,
            permissionMode: input.permission_mode,
            fingerprint: input.fingerprint,
            // A new row names no repository: the three columns say so
            // outright rather than by the table's defaults.
            repositoryIds: null,
            githubAppRepositories: null,
            repositoryScope: null,
            derivedFrom,
            workspaceId,
            displayName: workspaceId === null ? null : input.name,
            deny: input.deny,
            toolCatalogId: input.toolCatalogId,
            previousId: input.previousId,
            createdBy: actor.userId,
          })
          .returning();
        if (!row)
          throw new Error("installation profile insert returned no row");
        const record = recordOf(row);
        if (latest) {
          await writeProfileRollout(tx, {
            profileId: record.id,
            previous: { definition: latest.definition },
            definition: row.definition,
            createdBy: actor.userId,
          });
        }
        await writeReceipt(tx, actor, {
          id: input.receiptId,
          operation: "create_installation_profile",
          result: {
            profile_id: record.id,
            name: record.name,
            display_name: record.display_name ?? null,
            workspace_id: record.workspace_id ?? null,
            derived_from: record.derived_from ?? null,
            version: record.version,
            previous_id: record.previous_id,
            fingerprint: record.fingerprint,
            permission_mode: record.permission_mode,
            connection_id: input.connectionId,
            deny: record.deny ?? null,
            tool_catalog_id: record.tool_catalog_id ?? null,
            ...(input.previousDenyDrift ? { previous_deny_drift: true } : {}),
          },
        });
        return { outcome: "created" as const, record };
      });
    },

    async retire(input) {
      const { actor } = input;
      return db.transaction(async (tx) => {
        await lockSettingsGeneration(tx);
        if (!(await actorOperates(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const [row] = await tx
          .select()
          .from(installationProfiles)
          .where(eq(installationProfiles.id, input.profileId))
          .for("update");
        if (!row) return { outcome: "not_found" as const };
        if (row.retiredAt !== null) {
          return { outcome: "unchanged" as const, record: recordOf(row) };
        }
        const [retired] = await tx
          .update(installationProfiles)
          .set({ retiredAt: sql`now()`, retiredBy: actor.userId })
          .where(eq(installationProfiles.id, row.id))
          .returning();
        if (!retired) {
          throw new Error("installation profile update returned no row");
        }
        const record = recordOf(retired);
        await writeReceipt(tx, actor, {
          id: input.receiptId,
          operation: "retire_installation_profile",
          result: { profile_id: record.id },
        });
        return { outcome: "retired" as const, record };
      });
    },

    async setBlocked(input) {
      const { actor } = input;
      return db.transaction(async (tx) => {
        await lockSettingsGeneration(tx);
        if (!(await actorOperates(tx, actor))) {
          return { outcome: "actor_inactive" as const };
        }
        const [row] = await tx
          .select()
          .from(installationProfiles)
          .where(eq(installationProfiles.id, input.profileId))
          .for("update");
        if (!row) return { outcome: "not_found" as const };
        if ((row.blockedAt !== null) === input.blocked) {
          return { outcome: "unchanged" as const, record: recordOf(row) };
        }
        const [changed] = await tx
          .update(installationProfiles)
          .set(
            input.blocked
              ? { blockedAt: sql`now()`, blockedBy: actor.userId }
              : { blockedAt: null, blockedBy: null },
          )
          .where(eq(installationProfiles.id, row.id))
          .returning();
        if (!changed) {
          throw new Error("installation profile update returned no row");
        }
        const record = recordOf(changed);
        await writeReceipt(tx, actor, {
          id: input.receiptId,
          operation: input.blocked
            ? "block_installation_profile"
            : "unblock_installation_profile",
          result: { profile_id: record.id },
        });
        return { outcome: "changed" as const, record };
      });
    },
  };
}

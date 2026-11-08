import { randomUUID } from "node:crypto";
import { repositoryCeilingOf } from "@werft-ai/contracts";
import {
  type CeilingAddition,
  type MigrationAgentFact,
  type MigrationCopyFact,
  type MigrationInput,
  type MigrationRepositoryFact,
  type MigrationSessionFact,
  type MigrationWorkspaceFact,
  type Principal,
  type ProfileCopyPlan,
  receiptActorOf,
  sameExecutionForm,
} from "@werft-ai/platform";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { lockPeople } from "./control-shared.ts";
import { rowsOf } from "./control-unit-of-work.ts";
import { lockWrites } from "./installation-profiles.ts";
import { writeProfileRollout } from "./profile-rollouts.ts";
import type { Database } from "./queries.ts";
import {
  agentGitHubSettings,
  agentReleases,
  agents,
  catalogRepositories,
  checkpoints,
  githubWorkspaceSettings,
  installationProfiles,
  memberships,
  receipts,
  sessions,
  users,
  workspaceProfiles,
  workspaces,
} from "./schema.ts";

type Facts = Omit<MigrationInput, "now" | "catalog" | "newId" | "migrationId">;

const principalOf = (workspaceId: string, userId: string): Principal => ({
  ownerId: workspaceId,
  actor: {
    principal: { kind: "user", id: userId },
    userId,
    workspaceId,
    apiKeyId: null,
  },
});

export async function acquireMigrationLock(
  pool: Pool,
): Promise<{ release(): Promise<void> } | null> {
  const client = await pool.connect();
  const { rows } = await client.query<{ ok: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext('profiles:migration')) AS ok",
  );
  if (rows[0]?.ok !== true) {
    client.release();
    return null;
  }
  return {
    async release() {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext('profiles:migration'))",
        );
      } finally {
        client.release();
      }
    },
  };
}

export async function readMigrationFacts(
  db: Database,
  now: string,
): Promise<Facts> {
  const recentFrom = new Date(Date.parse(now) - 30 * 86_400_000);
  const workspaceRows = await db
    .select({
      id: workspaces.id,
      ceiling: githubWorkspaceSettings.repositoryCeiling,
    })
    .from(workspaces)
    .leftJoin(
      githubWorkspaceSettings,
      eq(githubWorkspaceSettings.workspaceId, workspaces.id),
    )
    .orderBy(asc(workspaces.id));
  const ownerRows = await db
    .select({
      workspaceId: memberships.workspaceId,
      userId: memberships.userId,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.role, "owner"),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    )
    .orderBy(asc(memberships.userId));
  const workspaceFacts: MigrationWorkspaceFact[] = workspaceRows.map((row) => ({
    id: row.id,
    ceiling: repositoryCeilingOf(row.ceiling),
    owners: ownerRows
      .filter((owner) => owner.workspaceId === row.id)
      .map((owner) => owner.userId),
  }));

  const agentRows = await db
    .select({
      id: agents.id,
      workspaceId: agents.workspaceId,
      activeReleaseId: agents.activeReleaseId,
      activationRevision: agents.activationRevision,
      behaviorRevision: agents.behaviorRevision,
      tracking: agents.profileTracking,
      modelSource: agents.modelSource,
      draftVersionId: agents.draftVersionId,
      profileId: agentReleases.runtimeProfileId,
      repositoryId: agentReleases.repositoryId,
      pins: agentReleases.policyPins,
      tools: agentReleases.effectiveTools,
      settings: agentGitHubSettings.agentId,
      settingsRepositories: agentGitHubSettings.repositories,
    })
    .from(agents)
    .leftJoin(agentReleases, eq(agentReleases.id, agents.activeReleaseId))
    .leftJoin(agentGitHubSettings, eq(agentGitHubSettings.agentId, agents.id))
    .orderBy(asc(agents.id));
  const agentFacts: MigrationAgentFact[] = agentRows.map((row) => {
    const pins = row.pins as { github?: { repositories?: unknown } } | null;
    const listed = pins?.github?.repositories;
    return {
      agentId: row.id,
      workspaceId: row.workspaceId,
      activeReleaseId: row.activeReleaseId,
      activeProfileId: row.profileId ?? null,
      activationRevision: row.activationRevision,
      behaviorRevision: row.behaviorRevision,
      tracking: row.tracking === "pinned" ? "pinned" : "follow",
      modelSource: row.modelSource === "profile" ? "profile" : "fixed",
      draftVersionId: row.draftVersionId,
      hasSettingsRow: row.settings !== null,
      settingsRepositories: Array.isArray(row.settingsRepositories)
        ? row.settingsRepositories.map(String)
        : [],
      releaseRepositoryId: row.repositoryId ?? null,
      pinnedRepositories: Array.isArray(listed) ? listed.map(String) : [],
      toolsBefore: Array.isArray((row.tools as { tools?: unknown })?.tools)
        ? ((row.tools as { tools: string[] }).tools ?? [])
        : [],
    };
  });

  const repositoryRows = await db
    .select({
      id: catalogRepositories.id,
      authKind: catalogRepositories.authKind,
      removedAt: catalogRepositories.removedAt,
    })
    .from(catalogRepositories)
    .orderBy(asc(catalogRepositories.id));
  const repositories: MigrationRepositoryFact[] = repositoryRows.map((row) => ({
    id: row.id,
    authKind: row.authKind,
    removed: row.removedAt !== null,
  }));

  const sessionRows = await db
    .select({
      workspaceId: sessions.workspaceId,
      profileId: sessions.profileId,
      releaseId: sessions.agentReleaseId,
      policySource: sessions.githubPolicySource,
      status: sessions.status,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .where(
      and(
        isNotNull(sessions.workspaceId),
        sql`(${sessions.status} NOT IN ('failed', 'stopped') OR ${sessions.createdAt} >= ${recentFrom.toISOString()}::timestamptz)`,
      ),
    );
  const sessionFacts: MigrationSessionFact[] = sessionRows.map((row) => ({
    workspaceId: row.workspaceId as string,
    profileId: row.profileId,
    hasAgent: row.releaseId !== null,
    policySource: row.policySource,
    active: row.status !== "failed" && row.status !== "stopped",
    createdAt: row.createdAt.toISOString(),
  }));

  const releaseCountRows = await db
    .select({
      profileId: agentReleases.runtimeProfileId,
      count: sql<number>`count(*)::int`,
    })
    .from(agentReleases)
    .groupBy(agentReleases.runtimeProfileId);
  const releaseCounts = new Map(
    releaseCountRows.map((row) => [row.profileId, row.count]),
  );
  const checkpointCountRows = await db
    .select({
      profileId: checkpoints.profileId,
      count: sql<number>`count(*)::int`,
    })
    .from(checkpoints)
    .where(
      and(isNotNull(checkpoints.profileId), isNull(checkpoints.collectedAt)),
    )
    .groupBy(checkpoints.profileId);
  const checkpointCounts = new Map(
    checkpointCountRows.flatMap((row) =>
      row.profileId === null ? [] : [[row.profileId, row.count] as const],
    ),
  );

  const profileRows = await db
    .select({
      id: installationProfiles.id,
      name: installationProfiles.name,
      origin: installationProfiles.origin,
      version: installationProfiles.version,
      workspaceId: installationProfiles.workspaceId,
      displayName: installationProfiles.displayName,
      migratedFrom: installationProfiles.migratedFrom,
      derivedFrom: installationProfiles.derivedFrom,
      definition: installationProfiles.definition,
      deny: installationProfiles.deny,
      retiredAt: installationProfiles.retiredAt,
    })
    .from(installationProfiles);
  const copies: MigrationCopyFact[] = profileRows.flatMap((row) =>
    row.migratedFrom === null
      ? []
      : [
          {
            id: row.id,
            migratedFrom: row.migratedFrom,
            name: row.name ?? row.id,
            displayName: row.displayName,
            workspaceId: row.workspaceId,
            version: row.version,
            derivedFrom: row.derivedFrom,
            definition: row.definition,
            deny: row.deny,
            retired: row.retiredAt !== null,
          },
        ],
  );
  const takenNames = new Map<string, Set<string | null>>();
  const take = (name: string, scope: string | null) => {
    const scopes = takenNames.get(name) ?? new Set<string | null>();
    scopes.add(scope);
    takenNames.set(name, scopes);
  };
  for (const row of profileRows) {
    if (row.workspaceId !== null && row.displayName !== null) {
      take(row.displayName, row.workspaceId);
    } else if (row.origin === "catalog") take(row.id, null);
    else if (row.name !== null && !row.name.startsWith("wl_")) {
      take(row.name, null);
    }
  }
  return {
    workspaces: workspaceFacts,
    agents: agentFacts,
    repositories,
    sessions: sessionFacts,
    copies,
    releaseCounts,
    checkpointCounts,
    takenNames,
  };
}

async function liveOwner(tx: Database, workspaceId: string, userId: string) {
  const [me] = await lockPeople(tx, workspaceId, [userId]);
  return me?.live === true && me.role === "owner";
}

export type CopyResult =
  | { outcome: "created" | "exists"; id: string }
  | {
      outcome: "refused";
      reason:
        | "actor_inactive"
        | "source_changed"
        | "previous_mismatch"
        | "id_taken"
        | "name_taken"
        | "lineage_in_use"
        | "copy_unusable";
    };

export async function writeProfileCopy(
  db: Database,
  input: {
    migrationId: string;
    actorUserId: string;
    plan: ProfileCopyPlan;
  },
): Promise<CopyResult> {
  const { plan, actorUserId, migrationId } = input;
  const target = plan.target;
  if (target === null || plan.decision === "skip") {
    return { outcome: "refused", reason: "source_changed" };
  }
  const workspaceId = plan.workspace_id;
  return db.transaction(async (tx) => {
    await lockWrites(tx);
    if (!(await liveOwner(tx, workspaceId, actorUserId))) {
      return { outcome: "refused" as const, reason: "actor_inactive" as const };
    }
    const [existing] = await tx
      .select()
      .from(installationProfiles)
      .where(eq(installationProfiles.migratedFrom, plan.source_id));
    if (existing !== undefined) {
      return existing.retiredAt === null &&
        existing.workspaceId === workspaceId &&
        sameExecutionForm(existing, target)
        ? { outcome: "exists" as const, id: existing.id }
        : { outcome: "refused" as const, reason: "copy_unusable" as const };
    }
    const [source] = await tx
      .select({
        retiredAt: workspaceProfiles.retiredAt,
        base: workspaceProfiles.baseProfileId,
        workspaceId: workspaceProfiles.workspaceId,
      })
      .from(workspaceProfiles)
      .where(eq(workspaceProfiles.id, plan.source_id));
    const [base] = await tx
      .select({
        blockedAt: installationProfiles.blockedAt,
        retiredAt: installationProfiles.retiredAt,
        fingerprint: installationProfiles.fingerprint,
      })
      .from(installationProfiles)
      .where(eq(installationProfiles.id, source?.base ?? ""));
    if (
      source === undefined ||
      source.retiredAt !== null ||
      source.workspaceId !== workspaceId ||
      base === undefined ||
      base.blockedAt !== null ||
      base.retiredAt !== null ||
      base.fingerprint !== target.base_fingerprint
    ) {
      return { outcome: "refused" as const, reason: "source_changed" as const };
    }
    const lineage = await tx
      .select({
        id: installationProfiles.id,
        version: installationProfiles.version,
        definition: installationProfiles.definition,
        deny: installationProfiles.deny,
        retiredAt: installationProfiles.retiredAt,
      })
      .from(installationProfiles)
      .where(
        and(
          eq(installationProfiles.workspaceId, workspaceId),
          eq(installationProfiles.displayName, target.display_name),
        ),
      )
      .orderBy(asc(installationProfiles.version));
    const last = lineage[lineage.length - 1];
    if ((last?.id ?? null) !== target.previous_id) {
      return {
        outcome: "refused" as const,
        reason: "previous_mismatch" as const,
      };
    }
    if (last !== undefined) {
      const [inUse] = await tx
        .select({ id: agents.id })
        .from(agents)
        .innerJoin(agentReleases, eq(agentReleases.id, agents.activeReleaseId))
        .where(
          and(
            // A pinned agent stays where it is when a version is added; a
            // follower would be rolled out onto it.
            eq(agents.profileTracking, "follow"),
            sql`${agentReleases.runtimeProfileId} IN (${sql.join(
              lineage.map((row) => sql`${row.id}`),
              sql`, `,
            )})`,
          ),
        )
        .limit(1);
      if (inUse !== undefined) {
        return {
          outcome: "refused" as const,
          reason: "lineage_in_use" as const,
        };
      }
    } else {
      const [clash] = await tx
        .select({ id: installationProfiles.id })
        .from(installationProfiles)
        .where(
          sql`(${installationProfiles.origin} = 'console' AND ${installationProfiles.name} = ${target.display_name} AND ${installationProfiles.workspaceId} IS NULL)
            OR (${installationProfiles.origin} = 'catalog' AND ${installationProfiles.id} = ${target.display_name})
            OR ${installationProfiles.displayName} = ${target.display_name} AND ${installationProfiles.workspaceId} = ${workspaceId}`,
        )
        .limit(1);
      if (clash !== undefined) {
        return { outcome: "refused" as const, reason: "name_taken" as const };
      }
    }
    const [taken] = await tx
      .select({ id: installationProfiles.id })
      .from(installationProfiles)
      .where(eq(installationProfiles.id, target.id));
    if (taken !== undefined) {
      return { outcome: "refused" as const, reason: "id_taken" as const };
    }
    const createdBy = plan.created_by ?? actorUserId;
    await tx.insert(installationProfiles).values({
      id: target.id,
      name: target.lineage_name,
      version: target.lineage_version,
      origin: "console",
      definition: target.definition,
      permissionMode: target.permission_mode,
      fingerprint: target.fingerprint,
      repositoryIds: null,
      githubAppRepositories: null,
      repositoryScope: null,
      derivedFrom: target.derived_from,
      workspaceId,
      displayName: target.display_name,
      migratedFrom: plan.source_id,
      deny: target.deny === null ? null : [...target.deny],
      toolCatalogId: target.tool_catalog_id,
      previousId: target.previous_id,
      createdBy,
    });
    if (last !== undefined) {
      await writeProfileRollout(tx, {
        profileId: target.id,
        previous: last,
        definition: target.definition,
        deny: target.deny,
        createdBy,
      });
    }
    await tx.insert(receipts).values({
      id: randomUUID(),
      ownerId: workspaceId,
      actor: receiptActorOf(principalOf(workspaceId, actorUserId)),
      operation: "create_installation_profile",
      targetRef: {
        resource: { kind: "workspace", id: workspaceId },
        workspace_id: workspaceId,
      },
      status: "succeeded",
      result: {
        profile_id: target.id,
        name: target.lineage_name,
        display_name: target.display_name,
        workspace_id: workspaceId,
        derived_from: target.derived_from,
        version: target.lineage_version,
        previous_id: target.previous_id,
        fingerprint: target.fingerprint,
        permission_mode: target.permission_mode,
        migration_id: migrationId,
        migrated_from: plan.source_id,
      },
    });
    return { outcome: "created" as const, id: target.id };
  });
}

export type CeilingResult =
  | { outcome: "widened" | "unchanged"; added: string[] }
  | {
      outcome: "refused";
      reason: "actor_inactive" | "no_ceiling" | "repository_changed";
    };

export async function topUpCeiling(
  db: Database,
  input: {
    migrationId: string;
    actorUserId: string;
    workspaceId: string;
    additions: readonly CeilingAddition[];
  },
): Promise<CeilingResult> {
  const { workspaceId, actorUserId, migrationId, additions } = input;
  return db.transaction(async (tx) => {
    if (!(await liveOwner(tx, workspaceId, actorUserId))) {
      return { outcome: "refused" as const, reason: "actor_inactive" as const };
    }
    const [held] = await tx
      .select({
        ceiling: githubWorkspaceSettings.repositoryCeiling,
        revision: githubWorkspaceSettings.revision,
      })
      .from(githubWorkspaceSettings)
      .where(eq(githubWorkspaceSettings.workspaceId, workspaceId))
      .for("update");
    const current = repositoryCeilingOf(held?.ceiling);
    if (held === undefined || current === null) {
      return { outcome: "refused" as const, reason: "no_ceiling" as const };
    }
    const present = new Set(current.repository_ids);
    const missing = additions.filter((a) => !present.has(a.repository_id));
    if (missing.length === 0) {
      return { outcome: "unchanged" as const, added: [] };
    }
    for (const addition of missing) {
      const [row] = await tx
        .select({
          authKind: catalogRepositories.authKind,
          removedAt: catalogRepositories.removedAt,
        })
        .from(catalogRepositories)
        .where(eq(catalogRepositories.id, addition.repository_id))
        .for("share");
      if (
        row === undefined ||
        row.removedAt !== null ||
        row.authKind !== "github_app_explicit"
      ) {
        return {
          outcome: "refused" as const,
          reason: "repository_changed" as const,
        };
      }
    }
    const after = {
      repository_ids: [
        ...new Set([
          ...current.repository_ids,
          ...missing.map((a) => a.repository_id),
        ]),
      ].sort(),
      github_app_repositories: current.github_app_repositories,
    };
    const revision = held.revision + 1;
    await tx
      .update(githubWorkspaceSettings)
      .set({
        repositoryCeiling: after,
        revision,
        updatedBy: actorUserId,
        updatedAt: sql`now()`,
      })
      .where(eq(githubWorkspaceSettings.workspaceId, workspaceId));
    await tx.insert(receipts).values({
      id: randomUUID(),
      ownerId: workspaceId,
      actor: receiptActorOf(principalOf(workspaceId, actorUserId)),
      operation: "set_github_ceiling",
      targetRef: {
        resource: { kind: "workspace", id: workspaceId },
        workspace_id: workspaceId,
      },
      status: "succeeded",
      result: {
        before: current,
        after,
        revision,
        migration_id: migrationId,
        added: missing,
      },
    });
    return {
      outcome: "widened" as const,
      added: missing.map((a) => a.repository_id),
    };
  });
}

export type MigrationRecord = {
  copies: Array<{ profile_id: string; workspace_id: string }>;
  agents: Array<{
    agent_id: string;
    workspace_id: string;
    release_id: string;
    previous_release_id: string | null;
    activation_revision: number;
    tracking_before: "follow" | "pinned";
    tracking_after: "follow" | "pinned";
    behavior_revision: number;
    model_source: "fixed" | "profile";
  }>;
};

export async function readMigrationRecord(
  db: Database,
  migrationId: string,
): Promise<MigrationRecord> {
  const copyRows = rowsOf<{ result: Record<string, unknown> }>(
    await db.execute(
      sql`SELECT result FROM receipts
        WHERE operation = 'create_installation_profile'
          AND result->>'migration_id' = ${migrationId}
        ORDER BY created_at, id`,
    ),
  );
  const activationRows = rowsOf<{
    target_ref: { resource?: { id?: string }; workspace_id?: string };
    result: Record<string, unknown> & { migration: Record<string, unknown> };
  }>(
    await db.execute(
      sql`SELECT target_ref, result FROM receipts
        WHERE operation = 'activate_agent'
          AND result->'migration'->>'id' = ${migrationId}
          AND COALESCE(result->'migration'->>'revert', 'false') <> 'true'
        ORDER BY created_at, id`,
    ),
  );
  return {
    copies: copyRows.map((row) => ({
      profile_id: String(row.result.profile_id),
      workspace_id: String(row.result.workspace_id),
    })),
    agents: activationRows.map((row) => ({
      agent_id: String(row.target_ref.resource?.id),
      workspace_id: String(row.target_ref.workspace_id),
      release_id: String(row.result.release_id),
      previous_release_id:
        typeof row.result.previous_release_id === "string"
          ? row.result.previous_release_id
          : null,
      activation_revision: Number(row.result.activation_revision),
      tracking_before:
        row.result.migration.tracking_before === "pinned" ? "pinned" : "follow",
      tracking_after:
        row.result.migration.tracking_after === "pinned" ? "pinned" : "follow",
      behavior_revision: Number(row.result.migration.behavior_revision),
      model_source:
        row.result.migration.model_source === "profile" ? "profile" : "fixed",
    })),
  };
}

export async function retireMigrationCopy(
  db: Database,
  input: {
    migrationId: string;
    actorUserId: string;
    workspaceId: string;
    profileId: string;
  },
): Promise<"retired" | "unchanged" | "refused"> {
  const { workspaceId, actorUserId, profileId, migrationId } = input;
  return db.transaction(async (tx) => {
    await lockWrites(tx);
    if (!(await liveOwner(tx, workspaceId, actorUserId))) return "refused";
    const [row] = await tx
      .select({
        retiredAt: installationProfiles.retiredAt,
        migratedFrom: installationProfiles.migratedFrom,
        workspaceId: installationProfiles.workspaceId,
      })
      .from(installationProfiles)
      .where(eq(installationProfiles.id, profileId))
      .for("update");
    if (
      row === undefined ||
      row.migratedFrom === null ||
      row.workspaceId !== workspaceId
    ) {
      return "refused";
    }
    if (row.retiredAt !== null) return "unchanged";
    await tx
      .update(installationProfiles)
      .set({ retiredAt: sql`now()`, retiredBy: actorUserId })
      .where(eq(installationProfiles.id, profileId));
    await tx.insert(receipts).values({
      id: randomUUID(),
      ownerId: workspaceId,
      actor: receiptActorOf(principalOf(workspaceId, actorUserId)),
      operation: "retire_installation_profile",
      targetRef: {
        resource: { kind: "workspace", id: workspaceId },
        workspace_id: workspaceId,
      },
      status: "succeeded",
      result: { profile_id: profileId, migration_id: migrationId },
    });
    return "retired";
  });
}

export async function liveOwnerOf(
  db: Database,
  workspaceId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.role, "owner"),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    )
    .orderBy(asc(memberships.userId))
    .limit(1);
  return row?.userId ?? null;
}

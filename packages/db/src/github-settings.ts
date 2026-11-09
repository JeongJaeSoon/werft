import { randomUUID } from "node:crypto";
import {
  type AgentGitHubSettingsRow,
  type EffectiveGitHubPolicy,
  effectiveGitHubPolicy,
  GITHUB_CEILING_NONE,
  GITHUB_POLICY_CLOSED,
  type GitHubCeiling,
  type GitHubFeatures,
  type GitHubPolicyStart,
  githubCeilingSchema,
  newSessionGitHubPolicy,
  type RepositoryCeiling,
  repositoryCeilingOf,
} from "@werft-ai/contracts";
import type {
  GitHubGateStore,
  GitHubSettingsStore,
  GitHubWorkStore,
} from "@werft-ai/platform";
import { and, desc, eq, sql } from "drizzle-orm";
import { queueAchievementJudgment } from "./achievement-judgments.ts";
import { lockedRole } from "./api-keys.ts";
import type { Database } from "./queries.ts";
import {
  agentGitHubSettings,
  agentReleases,
  agents,
  githubApps,
  githubWorkflowDispatches,
  githubWorkspaceSettings,
  pullRequests,
  receipts,
  sessionOutcomes,
  sessions,
  turns,
} from "./schema.ts";

/** No row reads all false; a row a later image wrote in another shape, too. */
function ceilingOf(stored: unknown): GitHubCeiling {
  const parsed = githubCeilingSchema.safeParse(stored);
  return parsed.success ? parsed.data : GITHUB_CEILING_NONE;
}

async function readSettings(db: Database, workspaceId: string) {
  const [row] = await db
    .select({
      ceiling: githubWorkspaceSettings.ceiling,
      repositoryCeiling: githubWorkspaceSettings.repositoryCeiling,
      revision: githubWorkspaceSettings.revision,
    })
    .from(githubWorkspaceSettings)
    .where(eq(githubWorkspaceSettings.workspaceId, workspaceId))
    .limit(1);
  return row === undefined
    ? { ceiling: GITHUB_CEILING_NONE, repositoryCeiling: null, revision: 0 }
    : {
        ceiling: ceilingOf(row.ceiling),
        repositoryCeiling: repositoryCeilingOf(row.repositoryCeiling),
        revision: row.revision,
      };
}

/**
 * What `githubPolicyOfRow` reads off a session. The query joins
 * `agentGitHubSettings` on the agent of the session's release.
 */
export const agentSettingsColumns = {
  settingsRepositories: agentGitHubSettings.repositories,
  settingsPushApproval: agentGitHubSettings.pushApproval,
  settingsFeatures: agentGitHubSettings.features,
  settingsActionsAllow: agentGitHubSettings.actionsAllow,
  settingsStartRepositoryId: agentGitHubSettings.startRepositoryId,
  settingsPushAttached: agentGitHubSettings.pushAttached,
  settingsRevision: agentGitHubSettings.revision,
  settingsUpdatedBy: agentGitHubSettings.updatedBy,
};

const agentPolicyColumns = {
  releasePin: sql<unknown>`${agentReleases.policyPins} -> 'github'`,
  ...agentSettingsColumns,
};

export const githubPolicyColumns = {
  githubPolicySource: sessions.githubPolicySource,
  githubPolicyStart: sessions.githubPolicyStart,
  attachedRepositoryIds: sessions.attachedRepositoryIds,
  ...agentPolicyColumns,
};

export function agentGitHubSettingsRowOf(row: {
  settingsRepositories: unknown;
  settingsPushApproval: boolean | null;
  settingsFeatures: unknown;
  settingsActionsAllow: unknown;
  settingsStartRepositoryId: string | null;
  settingsPushAttached: string | null;
  settingsRevision: number | null;
  settingsUpdatedBy: string | null;
}): AgentGitHubSettingsRow | null {
  if (row.settingsRevision === null || row.settingsPushApproval === null) {
    return null;
  }
  return {
    repositories: row.settingsRepositories,
    pushApproval: row.settingsPushApproval,
    features: row.settingsFeatures,
    actionsAllow: row.settingsActionsAllow,
    startRepositoryId: row.settingsStartRepositoryId,
    pushAttached: row.settingsPushAttached,
    revision: row.settingsRevision,
    updatedBy: row.settingsUpdatedBy,
  };
}

export function githubPolicyOfRow(
  row: Parameters<typeof agentGitHubSettingsRowOf>[0] & {
    githubPolicySource: unknown;
    githubPolicyStart: unknown;
    /** Required, so a caller cannot forget the list the policy depends on. */
    attachedRepositoryIds: string[] | null;
    releasePin: unknown;
  },
): EffectiveGitHubPolicy {
  return effectiveGitHubPolicy({
    source: row.githubPolicySource,
    releasePin: row.releasePin,
    agentRow: agentGitHubSettingsRowOf(row),
    start: row.githubPolicyStart,
    attachedRepositoryIds: row.attachedRepositoryIds,
  });
}

/** What `createSession` reads to pick a new session's policy. */
export function newSessionGitHubReaders(db: Database) {
  return {
    agentGitHubSettings: (agentId: string) =>
      agentGitHubSettingsOf(db, agentId),
    repositoryCeiling: (workspaceId: string) =>
      workspaceRepositoryCeiling(db, workspaceId),
  };
}

export async function workspaceRepositoryCeiling(
  db: Database,
  workspaceId: string,
): Promise<RepositoryCeiling | null> {
  return (await readSettings(db, workspaceId)).repositoryCeiling;
}

/**
 * Writes the workspace's repository ceiling as "every repository the console
 * App reaches", plus any explicit ids, without taking away what it holds:
 * ids already listed stay, and a ceiling that already says this changes
 * nothing, so a repeat is a no-op. A ceiling that is null or unreadable
 * (which allow nothing) becomes this one; that is the only widening it makes.
 */
export async function ensureInstalledRepositoryCeiling(
  db: Database,
  workspaceId: string,
  repositoryIds: readonly string[] = [],
): Promise<{ changed: boolean }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(githubWorkspaceSettings)
      .values({ workspaceId, ceiling: GITHUB_CEILING_NONE })
      .onConflictDoNothing();
    const [held] = await tx
      .select({ repositoryCeiling: githubWorkspaceSettings.repositoryCeiling })
      .from(githubWorkspaceSettings)
      .where(eq(githubWorkspaceSettings.workspaceId, workspaceId))
      .limit(1)
      .for("update");
    const current = repositoryCeilingOf(held?.repositoryCeiling);
    const heldIds = new Set(current?.repository_ids ?? []);
    const ids = [...new Set([...heldIds, ...repositoryIds])];
    // A stored list may repeat an id, so compare membership, not length.
    if (
      current !== null &&
      current.github_app_repositories === "installed" &&
      repositoryIds.every((id) => heldIds.has(id))
    ) {
      return { changed: false };
    }
    await tx
      .update(githubWorkspaceSettings)
      .set({
        repositoryCeiling: {
          repository_ids: ids,
          github_app_repositories: "installed",
        } satisfies RepositoryCeiling,
        revision: sql`${githubWorkspaceSettings.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(githubWorkspaceSettings.workspaceId, workspaceId));
    return { changed: true };
  });
}

/**
 * First use of a workspace that has no repository ceiling yet (a null or
 * unreadable one allows nothing): writes the default one and returns it.
 * A ceiling that reads is returned as it is, never widened.
 */
export async function ensureRepositoryCeilingWhenUnset(
  db: Database,
  workspaceId: string,
): Promise<RepositoryCeiling> {
  return db.transaction(async (tx) => {
    await tx
      .insert(githubWorkspaceSettings)
      .values({ workspaceId, ceiling: GITHUB_CEILING_NONE })
      .onConflictDoNothing();
    // Judged under the row lock, so a ceiling written meanwhile is kept.
    const [held] = await tx
      .select({ repositoryCeiling: githubWorkspaceSettings.repositoryCeiling })
      .from(githubWorkspaceSettings)
      .where(eq(githubWorkspaceSettings.workspaceId, workspaceId))
      .limit(1)
      .for("update");
    const current = repositoryCeilingOf(held?.repositoryCeiling);
    if (current !== null) return current;
    const written: RepositoryCeiling = {
      repository_ids: [],
      github_app_repositories: "installed",
    };
    await tx
      .update(githubWorkspaceSettings)
      .set({
        repositoryCeiling: written,
        revision: sql`${githubWorkspaceSettings.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(githubWorkspaceSettings.workspaceId, workspaceId));
    return written;
  });
}

/**
 * The snapshot an `agent` session starts with, read inside the transaction
 * that creates it. The settings row is locked FOR SHARE, so a save waits for
 * the session to exist instead of landing between the read and the insert.
 * A row that is gone or cannot be read yields a closed snapshot.
 */
export async function captureGitHubPolicyStart(
  tx: Database,
  releaseId: string,
): Promise<GitHubPolicyStart> {
  const closed: GitHubPolicyStart = {
    enabled: false,
    revision: 0,
    settings: GITHUB_POLICY_CLOSED,
  };
  // The agent row first, then its settings: the order lockAgentUse already
  // takes, so a switch change waits for the session to exist, as a save does.
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agentReleases)
    .innerJoin(agents, eq(agents.id, agentReleases.agentId))
    .where(eq(agentReleases.id, releaseId))
    .limit(1)
    .for("share", { of: agents });
  if (agent === undefined) return closed;
  const [row] = await tx
    .select({ enabled: agents.githubEnabled, ...agentPolicyColumns })
    .from(agentReleases)
    .innerJoin(agents, eq(agents.id, agentReleases.agentId))
    .innerJoin(agentGitHubSettings, eq(agentGitHubSettings.agentId, agents.id))
    .where(eq(agentReleases.id, releaseId))
    .limit(1)
    .for("share", { of: agentGitHubSettings });
  if (row === undefined) return closed;
  const read = newSessionGitHubPolicy(agentGitHubSettingsRowOf(row), null);
  if (
    read.settings === null ||
    read.settings === "invalid" ||
    read.agentSettingsRevision === null
  ) {
    return closed;
  }
  return {
    enabled: row.enabled,
    revision: read.agentSettingsRevision,
    settings: read.settings,
    push_attached: read.pushAttached,
  };
}

/** The settings a new session of the agent would start under. */
export async function agentGitHubSettingsOf(
  db: Database,
  agentId: string,
): Promise<AgentGitHubSettingsRow | null> {
  const [row] = await db
    .select({
      repositories: agentGitHubSettings.repositories,
      pushApproval: agentGitHubSettings.pushApproval,
      features: agentGitHubSettings.features,
      actionsAllow: agentGitHubSettings.actionsAllow,
      startRepositoryId: agentGitHubSettings.startRepositoryId,
      pushAttached: agentGitHubSettings.pushAttached,
      revision: agentGitHubSettings.revision,
      updatedBy: agentGitHubSettings.updatedBy,
    })
    .from(agentGitHubSettings)
    .where(eq(agentGitHubSettings.agentId, agentId))
    .limit(1);
  return row ?? null;
}

const sessionTarget = (sessionId: string) => ({
  session_id: sessionId,
  turn_id: null,
  request_id: null,
});

/** What the GitHub gate and the work service read and write. */
export function createPostgresGitHubGateStore(
  db: Database,
): GitHubGateStore & GitHubWorkStore {
  return {
    async context(rawSessionId) {
      const sessionId = rawSessionId.toLowerCase();
      const [row] = await db
        .select({
          ownerId: sessions.ownerId,
          sessionWorkspaceId: sessions.workspaceId,
          repositoryId: sessions.repositoryId,
          profileId: sessions.profileId,
          repoUrl: sessions.repoUrl,
          branch: sessions.branch,
          // Turn 1's actor, else the creator: the session-shares rule.
          startedBy: sql<
            string | null
          >`coalesce((SELECT t.actor_id FROM ${turns} t WHERE t.session_id = ${sessions.id} AND t.sequence = 1), ${sessions.createdByUserId})`,
          agentId: agents.id,
          workspaceId: agents.workspaceId,
          githubEnabled: agents.githubEnabled,
          releaseId: agentReleases.id,
          ...githubPolicyColumns,
        })
        .from(sessions)
        .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .leftJoin(agents, eq(agents.id, agentReleases.agentId))
        .leftJoin(
          agentGitHubSettings,
          eq(agentGitHubSettings.agentId, agents.id),
        )
        .where(eq(sessions.id, sessionId))
        .limit(1);
      if (row === undefined) return null;
      const workspaceId = row.workspaceId ?? row.sessionWorkspaceId;
      const settings =
        workspaceId === null ? null : await readSettings(db, workspaceId);
      const policy = githubPolicyOfRow(row);
      return {
        ownerId: row.ownerId,
        sessionId,
        repositoryId: row.repositoryId,
        profileId: row.profileId,
        attachedRepositoryIds: row.attachedRepositoryIds,
        repository:
          row.repoUrl === null || row.branch === null
            ? null
            : { url: row.repoUrl, branch: row.branch },
        startedBy: row.startedBy,
        agent:
          row.agentId === null ||
          row.workspaceId === null ||
          row.githubEnabled === null
            ? null
            : {
                id: row.agentId,
                workspaceId: row.workspaceId,
                // Off now, or off as the session started: both close it.
                githubEnabled: row.githubEnabled && policy.enabledAtStart,
              },
        release: row.releaseId === null ? null : { id: row.releaseId },
        policy,
        ceiling:
          row.workspaceId === null || settings === null
            ? GITHUB_CEILING_NONE
            : settings.ceiling,
        repositoryCeiling: settings?.repositoryCeiling ?? null,
        ceilingRevision: settings?.revision ?? 0,
      };
    },

    async findDispatch(repositoryId, runId) {
      const [row] = await db
        .select({
          runId: githubWorkflowDispatches.runId,
          repositoryId: githubWorkflowDispatches.repositoryId,
          workflow: githubWorkflowDispatches.workflow,
          ref: githubWorkflowDispatches.ref,
        })
        .from(githubWorkflowDispatches)
        .where(
          and(
            eq(githubWorkflowDispatches.repositoryId, repositoryId),
            eq(githubWorkflowDispatches.runId, runId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async recordReceipt(input) {
      const id = randomUUID();
      await db.insert(receipts).values({
        id,
        ownerId: input.ownerId,
        operation: input.operation,
        targetRef: sessionTarget(input.sessionId),
        status: input.status,
        result: input.result,
        error: input.error,
        actor: input.actor,
      });
      return id;
    },

    recordDispatch(input) {
      return db.transaction(async (tx) => {
        const id = randomUUID();
        await tx.insert(receipts).values({
          id,
          ownerId: input.context.ownerId,
          operation: "dispatch_workflow",
          targetRef: sessionTarget(input.context.sessionId),
          status: "succeeded",
          result: input.result,
          error: null,
          actor: input.actor,
        });
        if (input.run !== null) {
          await tx.insert(githubWorkflowDispatches).values({
            runId: input.run.id,
            repositoryId: input.context.repositoryId,
            sessionId: input.context.sessionId,
            agentReleaseId: input.context.agentReleaseId,
            workflow: input.run.workflow,
            ref: input.run.ref,
            receiptId: id,
          });
        }
        return id;
      });
    },

    recordReview(input) {
      return db.transaction(async (tx) => {
        const id = randomUUID();
        await tx.insert(receipts).values({
          id,
          ownerId: input.context.ownerId,
          operation: "review_pull_request",
          targetRef: sessionTarget(input.context.sessionId),
          status: "succeeded",
          result: input.result,
          error: null,
          actor: input.actor,
        });
        const now = new Date();
        const inserted = await tx
          .insert(sessionOutcomes)
          .values({
            id: randomUUID(),
            ownerId: input.context.ownerId,
            sessionId: input.context.sessionId,
            agentReleaseId: input.context.agentReleaseId,
            agentId: input.context.agentId,
            type: "github_review",
            url: input.review.url,
            repositoryId: input.context.repositoryId,
            externalId: String(input.review.id),
            state: "submitted",
            stateChangedAt: now,
            metadata: input.metadata,
            receiptId: id,
            createdAt: now,
          })
          .onConflictDoNothing({
            target: [
              sessionOutcomes.sessionId,
              sessionOutcomes.type,
              sessionOutcomes.url,
            ],
          })
          .returning({ id: sessionOutcomes.id });
        if (inserted.length > 0) {
          await queueAchievementJudgment(tx, input.context.sessionId);
        }
        return id;
      });
    },

    async pullRequestOpener(ownerId, repositoryId, number) {
      const [row] = await db
        .select({
          sessionId: pullRequests.sessionId,
          agentId: agentReleases.agentId,
        })
        .from(pullRequests)
        .innerJoin(sessions, eq(sessions.id, pullRequests.sessionId))
        .leftJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
        .where(
          and(
            eq(sessions.ownerId, ownerId),
            eq(pullRequests.repositoryId, repositoryId),
            eq(pullRequests.number, number),
          ),
        )
        .orderBy(desc(pullRequests.createdAt))
        .limit(1);
      return row?.sessionId == null
        ? null
        : { sessionId: row.sessionId, agentId: row.agentId ?? null };
    },
  };
}

const FEATURES: readonly (keyof GitHubFeatures)[] = [
  "workflows",
  "actions",
  "checks",
  "issues",
  "review",
];

export function createPostgresGitHubSettingsStore(
  db: Database,
): GitHubSettingsStore {
  return {
    async get(workspaceId) {
      const { ceiling, revision } = await readSettings(db, workspaceId);
      return { ceiling, revision };
    },

    async agentsUsing(workspaceId) {
      const rows = await db
        .select(agentPolicyColumns)
        .from(agents)
        .innerJoin(agentReleases, eq(agentReleases.id, agents.activeReleaseId))
        .leftJoin(
          agentGitHubSettings,
          eq(agentGitHubSettings.agentId, agents.id),
        )
        .where(
          and(
            eq(agents.workspaceId, workspaceId),
            eq(agents.githubEnabled, true),
          ),
        );
      const policies = rows.map(
        (row) =>
          newSessionGitHubPolicy(agentGitHubSettingsRowOf(row), row.releasePin)
            .settings,
      );
      return Object.fromEntries(
        FEATURES.map((name) => [
          name,
          policies.filter(
            (settings) =>
              settings !== null &&
              settings !== "invalid" &&
              settings.features[name],
          ).length,
        ]),
      ) as Record<keyof GitHubFeatures, number>;
    },

    async appPermissions(workspaceId) {
      const rows = await db
        .select({ role: githubApps.role, permissions: githubApps.permissions })
        .from(githubApps)
        .where(eq(githubApps.workspaceId, workspaceId));
      const of = (role: "author" | "reviewer") => {
        const held = rows.filter((row) => row.role === role);
        const found = held.length === 1 ? held[0] : undefined;
        return found === undefined
          ? null
          : {
              permissions:
                (found.permissions as Record<
                  string,
                  "read" | "write" | "admin"
                > | null) ?? null,
            };
      };
      return { author: of("author"), reviewer: of("reviewer") };
    },

    putCeiling(input) {
      return db.transaction(async (tx) => {
        // A demotion or disable committed after the policy's check wins.
        const role = await lockedRole(tx, input.workspaceId, input.updatedBy);
        if (role !== "owner" && role !== "admin") {
          return { outcome: "actor_inactive" as const };
        }
        const [held] = await tx
          .select({
            ceiling: githubWorkspaceSettings.ceiling,
            revision: githubWorkspaceSettings.revision,
          })
          .from(githubWorkspaceSettings)
          .where(eq(githubWorkspaceSettings.workspaceId, input.workspaceId))
          .limit(1)
          .for("update");
        if ((held?.revision ?? 0) !== input.revision) {
          return { outcome: "revision_conflict" as const };
        }
        const revision = input.revision + 1;
        if (held === undefined) {
          // Two first writes both read no row; the second finds the key.
          const [inserted] = await tx
            .insert(githubWorkspaceSettings)
            .values({
              workspaceId: input.workspaceId,
              ceiling: input.ceiling,
              revision,
              updatedBy: input.updatedBy,
            })
            .onConflictDoNothing()
            .returning({ revision: githubWorkspaceSettings.revision });
          if (inserted === undefined) {
            return { outcome: "revision_conflict" as const };
          }
        } else {
          await tx
            .update(githubWorkspaceSettings)
            .set({
              ceiling: input.ceiling,
              revision,
              updatedBy: input.updatedBy,
              updatedAt: sql`now()`,
            })
            .where(eq(githubWorkspaceSettings.workspaceId, input.workspaceId));
        }
        await tx.insert(receipts).values({
          id: randomUUID(),
          ownerId: input.workspaceId,
          actor: input.actor,
          operation: "set_github_ceiling",
          targetRef: {
            resource: { kind: "workspace", id: input.workspaceId },
            workspace_id: input.workspaceId,
          },
          status: "succeeded",
          result: {
            before: held === undefined ? null : ceilingOf(held.ceiling),
            after: input.ceiling,
            revision,
          },
        });
        return {
          outcome: "stored" as const,
          settings: { ceiling: input.ceiling, revision },
        };
      });
    },
  };
}

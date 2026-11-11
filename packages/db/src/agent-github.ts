import { randomUUID } from "node:crypto";
import {
  agentGitHubSettingsSchema,
  GITHUB_FEATURES_NONE,
  GITHUB_GATE_RECEIPT_OPERATION_VALUES,
} from "@werft-ai/contracts";
import type {
  AgentGitHubStore,
  SetAgentGitHubRepositoryResult,
} from "@werft-ai/platform";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { lockAgentToChange } from "./agents.ts";
import {
  createPostgresCatalogRepositoryStore,
  lockCatalogWrites,
} from "./catalog-repositories.ts";
import { receiptActorOf } from "./control-shared.ts";
import { lockGitHubApps } from "./github/github-apps.ts";
import { createPostgresGitHubPinStore } from "./github/github-pins.ts";
import {
  agentGitHubSettingsOf,
  ensureRepositoryCeilingWhenUnset,
  workspaceRepositoryCeiling,
} from "./github-settings.ts";
import { sessionVisibleTo } from "./musterrolle/session-shares.ts";
import { receiptFromRow } from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import {
  agentGitHubSettings,
  agentReleases,
  agents,
  catalogRepositories,
  receipts,
  sessions,
} from "./schema.ts";

const AGENT_OPERATIONS = [
  "set_agent_github",
  "set_agent_mcp",
  "create_agent_release",
  "activate_agent",
] as const;
/**
 * The gate's and the work service's receipts, which name a session. A merge
 * receipt is not part of the agent's activity.
 */
const SESSION_OPERATIONS = GITHUB_GATE_RECEIPT_OPERATION_VALUES.filter(
  (operation) => operation !== "merge_pull_request",
);

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

/** Thrown inside a transaction to roll it back and answer with `result`. */
class Abort extends Error {
  constructor(readonly result: SetAgentGitHubRepositoryResult) {
    super(result.outcome);
  }
}

type RepositorySettings = {
  repositories: string[];
  pushApproval: boolean;
  features: typeof agentGitHubSettings.$inferInsert.features;
  actionsAllow: unknown[];
  startRepositoryId: string | null;
  pushAttached: string | null;
};

// The columns were validated when they were written.
const settingsOf = (row: SettingsValues): RepositorySettings => ({
  repositories: Array.isArray(row.repositories)
    ? row.repositories.filter((id): id is string => typeof id === "string")
    : [],
  pushApproval: row.pushApproval,
  features: row.features as RepositorySettings["features"],
  actionsAllow: Array.isArray(row.actionsAllow) ? row.actionsAllow : [],
  startRepositoryId: row.startRepositoryId,
  pushAttached: row.pushAttached,
});

/**
 * What an agent with no settings row starts from: its active release's GitHub
 * pins, as the tab shows them, read again under the agent's lock. Null with
 * no active release or pins this image cannot read; a release with no pin
 * starts from the tab's defaults for it.
 */
async function seedOf(
  tx: Database,
  releaseId: string | null,
): Promise<RepositorySettings | null> {
  if (releaseId === null) return null;
  const [release] = await tx
    .select({
      github: sql<unknown>`${agentReleases.policyPins} -> 'github'`,
      repositoryId: agentReleases.repositoryId,
    })
    .from(agentReleases)
    .where(eq(agentReleases.id, releaseId));
  if (release === undefined) return null;
  const github =
    release.github === null || release.github === undefined
      ? {
          repositories: [] as string[],
          push_approval: false,
          features: { ...GITHUB_FEATURES_NONE },
          actions_allow: [] as unknown[],
        }
      : agentGitHubSettingsSchema.safeParse(release.github).data;
  if (github === undefined) return null;
  return {
    repositories: [...github.repositories],
    pushApproval: github.push_approval,
    features: github.features,
    actionsAllow: github.actions_allow,
    // The row would otherwise lose the release's repository, which a session
    // naming none starts on.
    startRepositoryId:
      release.repositoryId !== null &&
      github.repositories.includes(release.repositoryId)
        ? release.repositoryId
        : null,
    // As a first save of settings writes it.
    pushAttached: "allow",
  };
}

export function createPostgresAgentGitHubStore(db: Database): AgentGitHubStore {
  const catalogStore = createPostgresCatalogRepositoryStore(db);
  const pinStore = createPostgresGitHubPinStore(db);
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

    async setRepository(input) {
      const agentId = input.agentId.toLowerCase();
      try {
        return await db.transaction(async (tx) => {
          // Lock order, which every other writer of these also follows:
          // catalog writes, the App lock, then the agent, its settings and the
          // workspace's settings. App changes take theirs before the
          // workspace's settings.
          const pick = input.target.kind === "github" ? input.target : null;
          if (pick !== null) {
            await lockCatalogWrites(tx);
            if (pick.pin !== null) await lockGitHubApps(tx, input.workspaceId);
          }
          const locked = await lockAgentToChange(tx, input, agentId);
          if ("outcome" in locked) return locked;
          const [held] = await tx
            .select()
            .from(agentGitHubSettings)
            .where(eq(agentGitHubSettings.agentId, agentId))
            .for("update");
          const heldRevision = held?.revision ?? null;
          if (
            input.expectedRevision !== undefined &&
            heldRevision !== input.expectedRevision
          ) {
            return { outcome: "conflict" as const, revision: heldRevision };
          }
          const ceiling = await ensureRepositoryCeilingWhenUnset(
            tx,
            input.workspaceId,
          );

          let repository: { id: string; owner: string; name: string };
          let githubRepositoryId: number | null;
          let authKind: string;
          let catalogReceiptId: string | null = null;
          // Turning off may name a repository the catalog dropped or never
          // held, when the settings still list it: the console shows it.
          let offAfterCatalog = false;
          if (pick === null) {
            const wanted =
              input.target.kind === "catalog" ? input.target.id : "";
            const [row] = await tx
              .select({
                id: catalogRepositories.id,
                owner: catalogRepositories.owner,
                name: catalogRepositories.name,
                githubRepositoryId: catalogRepositories.githubRepositoryId,
                authKind: catalogRepositories.authKind,
                removedAt: catalogRepositories.removedAt,
              })
              .from(catalogRepositories)
              .where(eq(catalogRepositories.id, wanted));
            const active = row !== undefined && row.removedAt === null;
            if (!active && input.enabled) {
              throw new Abort({ outcome: "repository_not_found" });
            }
            offAfterCatalog = !active;
            repository = row ?? { id: wanted, owner: "", name: wanted };
            authKind = row?.authKind ?? "none";
            githubRepositoryId = row?.githubRepositoryId ?? null;
          } else {
            const actor = receiptActorOf(input.principal);
            // A pick is made by a person; nobody behind the principal means
            // the right it rests on is gone.
            if (actor === null) throw new Abort({ outcome: "actor_inactive" });
            const resolved = await catalogStore.resolve(
              {
                workspaceId: input.workspaceId,
                userId: input.userId,
                actor,
                requestId: null,
                agentId,
                managerRoles: input.managerRoles,
                ...pick.resolve,
              },
              tx,
            );
            if (resolved.outcome === "name_held") {
              throw new Abort({ outcome: "name_held", id: resolved.id });
            }
            if (resolved.outcome !== "resolved") {
              throw new Abort({ outcome: resolved.outcome });
            }
            // `resolve` only matches the console App's rows.
            authKind = "github_app";
            githubRepositoryId = resolved.repository.github_repository_id;
            repository = resolved.repository;
            if (resolved.changed) catalogReceiptId = pick.resolve.receiptId;
          }

          const current = held === undefined ? null : settingsOf(held);
          const base =
            current ?? (await seedOf(tx, locked.agent.activeReleaseId));
          if (base === null) throw new Abort({ outcome: "seed_unavailable" });
          // The response schema wants a non-empty string, and a catalog row
          // can hold an empty owner or name.
          const label =
            repository.owner !== "" && repository.name !== ""
              ? `${repository.owner}/${repository.name}`
              : repository.id;
          const has = base.repositories.includes(repository.id);
          // A typo or a long-gone id that nothing lists has nothing to turn off.
          if (offAfterCatalog && !has) {
            throw new Abort({ outcome: "repository_not_found" });
          }
          if (input.enabled && !has) {
            input.check(
              {
                id: repository.id,
                authKind,
                via: pick === null ? "catalog" : "github",
              },
              ceiling,
            );
          }
          const repositories = input.enabled
            ? has
              ? base.repositories
              : [...base.repositories, repository.id]
            : base.repositories.filter((id) => id !== repository.id);
          const next = {
            repositories,
            pushApproval: base.pushApproval,
            features: base.features,
            actionsAllow: base.actionsAllow,
            // The CHECK `repositories ? start_repository_id`.
            startRepositoryId:
              base.startRepositoryId !== null &&
              repositories.includes(base.startRepositoryId)
                ? base.startRepositoryId
                : null,
            pushAttached: base.pushAttached,
          };

          let revision: number;
          let receiptId: string | null = null;
          if (held !== undefined && has === input.enabled) {
            revision = held.revision;
          } else {
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
                throw new Abort({ outcome: "conflict", revision: null });
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
                throw new Abort({
                  outcome: "conflict",
                  revision: held.revision,
                });
              }
              revision = updated.revision;
            }
            receiptId = randomUUID();
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
                change: "repository",
                agent_settings_revision: revision,
                repository_id: repository.id,
                repository: label,
                github_repository_id: githubRepositoryId,
                enabled: input.enabled,
                before: held === undefined ? null : valuesOf(held),
                after: valuesOf(next),
              },
            });
          }

          const pinActor = receiptActorOf(input.principal);
          if (pick?.pin != null && pinActor !== null) {
            const pinned = await pinStore.pinFirst(
              {
                repositoryId: repository.id,
                role: "author",
                connectionId: pick.pin.connectionId,
                appId: pick.pin.appId,
                pinnedBy: "selection",
                audit: {
                  ownerId: input.workspaceId,
                  actor: pinActor,
                  receiptId: pick.pin.receiptId,
                },
              },
              tx,
            );
            // Null: the App is gone, so enabling would leave no pin behind.
            if (pinned.pin === null) throw new Abort({ outcome: "app_gone" });
          }
          return {
            outcome: "saved" as const,
            revision,
            receiptId: receiptId ?? catalogReceiptId,
            repository: {
              id: repository.id,
              owner: repository.owner,
              name: repository.name,
              label,
            },
            catalogChanged: catalogReceiptId !== null,
          };
        });
      } catch (error) {
        if (error instanceof Abort) return error.result;
        throw error;
      }
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

    async repositoryNames(ids) {
      if (ids.length === 0) return new Map();
      const rows = await db
        .select({
          id: catalogRepositories.id,
          owner: catalogRepositories.owner,
          name: catalogRepositories.name,
        })
        .from(catalogRepositories)
        .where(inArray(catalogRepositories.id, [...ids]));
      return new Map(rows.map((row) => [row.id, `${row.owner}/${row.name}`]));
    },
  };
}

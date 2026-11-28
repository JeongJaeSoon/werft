import { randomUUID } from "node:crypto";
import {
  SKILL_REPOSITORY_SYNC_RESULT_VALUES,
  SKILL_REPOSITORY_TRIGGER_VALUES,
  type SkillRepositorySyncResult,
  type SkillRepositoryTriggerKind,
} from "@werft-ai/contracts";
import type {
  SkillListingEntry,
  SkillRepository,
  SkillRepositoryStore,
  SkillRepositorySync,
  SkillRepositoryTrigger,
} from "@werft-ai/platform";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { DB_NOW, fromDbNow } from "../db-clock.ts";
import { lockedRole } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import {
  extensionBundles,
  skillRepositories,
  skillRepositorySkills,
} from "../schema.ts";
import { writeSucceededReceipt } from "../succeeded-receipt.ts";

type Row = typeof skillRepositories.$inferSelect;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const triggerJson = (trigger: SkillRepositoryTrigger) => ({
  kind: trigger.kind,
  user_id: trigger.userId,
});

/** A kind a later host wrote reads as a person's check. */
function triggerOf(value: unknown): SkillRepositoryTrigger {
  const json = record(value);
  return {
    kind: (SKILL_REPOSITORY_TRIGGER_VALUES as readonly unknown[]).includes(
      json.kind,
    )
      ? (json.kind as SkillRepositoryTriggerKind)
      : "manual",
    userId: typeof json.user_id === "string" ? json.user_id : null,
  };
}

const issuesOf = (value: unknown): SkillListingEntry["issues"] =>
  Array.isArray(value)
    ? value.map((issue) => {
        const one = record(issue);
        return {
          path: String(one.path ?? ""),
          code: String(one.code ?? ""),
          message: String(one.message ?? ""),
        };
      })
    : [];

const syncJson = (sync: SkillRepositorySync) => ({
  at: sync.at.toISOString(),
  trigger: triggerJson(sync.trigger),
  commit: sync.commit,
  result: sync.result,
  issues: sync.issues,
});

/** A result a later host wrote reads as GitHub not answering. */
function syncOf(value: unknown): SkillRepositorySync | null {
  if (value === null || value === undefined) return null;
  const json = record(value);
  return {
    at: new Date(String(json.at)),
    trigger: triggerOf(json.trigger),
    commit: typeof json.commit === "string" ? json.commit : null,
    result: (
      SKILL_REPOSITORY_SYNC_RESULT_VALUES as readonly unknown[]
    ).includes(json.result)
      ? (json.result as SkillRepositorySyncResult)
      : "github_unavailable",
    issues: issuesOf(json.issues),
  };
}

function repositoryOf(row: Row, skillCount: number): SkillRepository {
  return {
    workspaceId: row.workspaceId,
    id: row.id,
    repositoryId: row.repositoryId,
    repository: row.repository,
    ref: row.ref,
    access: "public",
    connectionId: row.connectionId,
    installationId: row.installationId,
    ownerId: row.ownerId,
    license: row.license,
    generation: row.generation,
    lastCommit: row.lastCommit,
    lastSync: syncOf(row.lastSync),
    skillCount,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    removedBy: row.removedBy,
    removedAt: row.removedAt,
  };
}

const ofWorkspace = (workspaceId: string, id: string) =>
  and(
    eq(skillRepositories.workspaceId, workspaceId),
    eq(skillRepositories.id, id),
  );

/** How many directories of each repository the last listing found. */
async function skillCounts(
  tx: Database,
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({
      id: skillRepositorySkills.skillRepositoryId,
      count: sql<number>`count(*)::int`,
    })
    .from(skillRepositorySkills)
    .where(
      and(
        inArray(skillRepositorySkills.skillRepositoryId, [...ids]),
        eq(skillRepositorySkills.present, true),
      ),
    )
    .groupBy(skillRepositorySkills.skillRepositoryId);
  return new Map(rows.map((row) => [row.id, row.count]));
}

async function withCount(tx: Database, row: Row): Promise<SkillRepository> {
  return repositoryOf(row, (await skillCounts(tx, [row.id])).get(row.id) ?? 0);
}

/**
 * Writes what a listing found: a directory it names is written over the row
 * of that path, switch untouched, and every other row is marked gone.
 */
async function writeListing(
  tx: Database,
  repositoryId: string,
  entries: readonly SkillListingEntry[],
): Promise<void> {
  if (entries.length > 0) {
    await tx
      .insert(skillRepositorySkills)
      .values(
        entries.map((entry) => ({
          id: randomUUID(),
          skillRepositoryId: repositoryId,
          path: entry.path,
          name: entry.name,
          description: entry.description,
          license: entry.license,
          treeSha: entry.treeSha,
          fileCount: entry.fileCount,
          totalBytes: entry.totalBytes,
          hasScripts: entry.hasScripts,
          listingIssues: entry.issues,
        })),
      )
      .onConflictDoUpdate({
        target: [
          skillRepositorySkills.skillRepositoryId,
          skillRepositorySkills.path,
        ],
        set: {
          name: sql`excluded.name`,
          description: sql`excluded.description`,
          license: sql`excluded.license`,
          treeSha: sql`excluded.tree_sha`,
          fileCount: sql`excluded.file_count`,
          totalBytes: sql`excluded.total_bytes`,
          hasScripts: sql`excluded.has_scripts`,
          listingIssues: sql`excluded.listing_issues`,
          present: true,
          updatedAt: DB_NOW,
        },
      });
  }
  await tx
    .update(skillRepositorySkills)
    .set({ present: false, updatedAt: DB_NOW })
    .where(
      and(
        eq(skillRepositorySkills.skillRepositoryId, repositoryId),
        eq(skillRepositorySkills.present, true),
        entries.length === 0
          ? undefined
          : notInArray(
              skillRepositorySkills.path,
              entries.map((entry) => entry.path),
            ),
      ),
    );
}

/** The actor's live role, or why the write is refused. */
async function managerOf(
  tx: Database,
  input: Parameters<SkillRepositoryStore["remove"]>[0],
): Promise<{ userId: string } | { outcome: "actor_inactive" | "outranked" }> {
  const userId = input.principal.actor?.userId;
  if (!userId) return { outcome: "actor_inactive" };
  const role = await lockedRole(tx, input.workspaceId, userId);
  if (role === null) return { outcome: "actor_inactive" };
  if (!input.managerRoles.includes(role)) return { outcome: "outranked" };
  return { userId };
}

async function locked(
  tx: Database,
  workspaceId: string,
  id: string,
): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(skillRepositories)
    .where(ofWorkspace(workspaceId, id))
    .limit(1)
    .for("update");
  return row;
}

const LEASE_FREE = {
  checkingUntil: null,
  checkingToken: null,
  checkAgain: null,
} as const;

export function createPostgresSkillRepositoryStore(
  db: Database,
): SkillRepositoryStore {
  return {
    async list(workspaceId) {
      const rows = await db
        .select()
        .from(skillRepositories)
        .where(eq(skillRepositories.workspaceId, workspaceId))
        .orderBy(asc(skillRepositories.createdAt), asc(skillRepositories.id));
      const counts = await skillCounts(
        db,
        rows.map((row) => row.id),
      );
      return rows.map((row) => repositoryOf(row, counts.get(row.id) ?? 0));
    },

    async find(workspaceId, id) {
      const [row] = await db
        .select()
        .from(skillRepositories)
        .where(ofWorkspace(workspaceId, id))
        .limit(1);
      return row ? withCount(db, row) : null;
    },

    async skills(workspaceId, id) {
      const rows = await db
        .select({ skill: skillRepositorySkills })
        .from(skillRepositorySkills)
        .innerJoin(
          skillRepositories,
          eq(skillRepositories.id, skillRepositorySkills.skillRepositoryId),
        )
        .where(ofWorkspace(workspaceId, id))
        .orderBy(asc(skillRepositorySkills.path));
      const names = [...new Set(rows.flatMap(({ skill }) => skill.name ?? []))];
      const [owners, sameName] =
        names.length === 0
          ? [[], []]
          : await Promise.all([
              db
                .selectDistinct({
                  name: extensionBundles.name,
                  source: extensionBundles.source,
                })
                .from(extensionBundles)
                .where(
                  and(
                    eq(extensionBundles.workspaceId, workspaceId),
                    inArray(extensionBundles.name, names),
                  ),
                ),
              // Listed now, in this repository or another the workspace
              // still follows.
              db
                .select({
                  id: skillRepositorySkills.id,
                  name: skillRepositorySkills.name,
                })
                .from(skillRepositorySkills)
                .innerJoin(
                  skillRepositories,
                  eq(
                    skillRepositories.id,
                    skillRepositorySkills.skillRepositoryId,
                  ),
                )
                .where(
                  and(
                    eq(skillRepositories.workspaceId, workspaceId),
                    or(
                      isNull(skillRepositories.removedAt),
                      eq(skillRepositories.id, id),
                    ),
                    eq(skillRepositorySkills.present, true),
                    inArray(skillRepositorySkills.name, names),
                  ),
                ),
            ]);
      const ownerOf = new Map(owners.map((row) => [row.name, row.source]));
      return rows.map(({ skill }) => ({
        id: skill.id,
        path: skill.path,
        name: skill.name,
        description: skill.description,
        license: skill.license,
        treeSha: skill.treeSha,
        fileCount: skill.fileCount,
        totalBytes: skill.totalBytes,
        hasScripts: skill.hasScripts,
        issues: issuesOf(skill.listingIssues),
        present: skill.present,
        enabled: skill.enabled,
        nameOwner:
          skill.name === null || !ownerOf.has(skill.name)
            ? null
            : ownerOf.get(skill.name) === "github"
              ? "github"
              : "upload",
        nameShared: sameName.some(
          (other) => other.name === skill.name && other.id !== skill.id,
        ),
      }));
    },

    register(input) {
      return db.transaction(async (tx) => {
        const manager = await managerOf(tx, input);
        if ("outcome" in manager) return manager;
        // One registration of a GitHub repository at a time, so two cannot
        // both find no row.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`skill_repositories:${input.workspaceId}:${input.github.repositoryId}`}, 0))`,
        );
        const [existing] = await tx
          .select()
          .from(skillRepositories)
          .where(
            and(
              eq(skillRepositories.workspaceId, input.workspaceId),
              eq(skillRepositories.repositoryId, input.github.repositoryId),
            ),
          )
          .limit(1)
          .for("update");
        if (existing && existing.removedAt === null) {
          return {
            outcome: "already_registered",
            repository: await withCount(tx, existing),
          };
        }
        const read = {
          repository: input.github.repository,
          ref: input.ref,
          connectionId: input.connectionId,
          installationId: input.installationId,
          ownerId: input.github.ownerId,
          license: input.read.license,
          lastCommit: input.read.commit,
          lastSync: syncJson({
            at: input.at,
            trigger: { kind: "register", userId: manager.userId },
            commit: input.read.commit,
            result: "listed",
            issues: [],
          }),
          lastCheckedAt: input.at,
        };
        let row: Row | undefined;
        if (existing) {
          [row] = await tx
            .update(skillRepositories)
            .set({
              ...read,
              ...LEASE_FREE,
              generation: existing.generation + 1,
              removedAt: null,
              removedBy: null,
              updatedAt: DB_NOW,
            })
            .where(eq(skillRepositories.id, existing.id))
            .returning();
          // A repository comes back with every switch off.
          await tx
            .update(skillRepositorySkills)
            .set({
              enabled: false,
              enabledBy: null,
              enabledAt: null,
              enableGrantId: null,
              updatedAt: DB_NOW,
            })
            .where(eq(skillRepositorySkills.skillRepositoryId, existing.id));
        } else {
          [row] = await tx
            .insert(skillRepositories)
            .values({
              ...read,
              id: input.id,
              workspaceId: input.workspaceId,
              repositoryId: input.github.repositoryId,
              createdBy: manager.userId,
            })
            .returning();
        }
        if (!row) throw new Error("skill repository vanished in its tx");
        await writeListing(tx, row.id, input.read.entries);
        await writeSucceededReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "register_skill_repository",
          resource: { kind: "workspace", id: input.workspaceId },
          workspaceId: input.workspaceId,
          result: {
            action: existing ? "restore" : "register",
            skill_repository_id: row.id,
            url: input.url,
            repository_id: row.repositoryId,
            repository: row.repository,
            owner_id: row.ownerId,
            ref: row.ref,
            commit: input.read.commit,
            license: row.license,
            generation: row.generation,
            skills: input.read.entries.length,
          },
        });
        return {
          outcome: existing ? "restored" : "registered",
          repository: repositoryOf(row, input.read.entries.length),
          receiptId: input.receiptId,
        };
      });
    },

    remove(input) {
      return db.transaction(async (tx) => {
        const manager = await managerOf(tx, input);
        if ("outcome" in manager) return manager;
        const row = await locked(tx, input.workspaceId, input.id);
        if (!row) return { outcome: "not_found" };
        if (row.removedAt !== null) {
          return { outcome: "unchanged", repository: await withCount(tx, row) };
        }
        const [removed] = await tx
          .update(skillRepositories)
          .set({
            ...LEASE_FREE,
            generation: row.generation + 1,
            removedAt: DB_NOW,
            removedBy: manager.userId,
            updatedAt: DB_NOW,
          })
          .where(eq(skillRepositories.id, row.id))
          .returning();
        if (!removed) throw new Error("skill repository vanished in its tx");
        const repository = await withCount(tx, removed);
        await writeSucceededReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "remove_skill_repository",
          resource: { kind: "workspace", id: input.workspaceId },
          workspaceId: input.workspaceId,
          result: {
            skill_repository_id: removed.id,
            repository_id: removed.repositoryId,
            repository: removed.repository,
            generation: removed.generation,
            skills: repository.skillCount,
          },
        });
        return { outcome: "removed", repository, receiptId: input.receiptId };
      });
    },

    setRef(input) {
      return db.transaction(async (tx) => {
        const manager = await managerOf(tx, input);
        if ("outcome" in manager) return manager;
        const row = await locked(tx, input.workspaceId, input.id);
        if (!row || row.removedAt !== null) return { outcome: "not_found" };
        if (row.ref === input.ref) {
          return { outcome: "unchanged", repository: await withCount(tx, row) };
        }
        // The ref was resolved against the row as it was then.
        if (row.generation !== input.generation) return { outcome: "changed" };
        const [updated] = await tx
          .update(skillRepositories)
          .set({
            ref: input.ref,
            generation: row.generation + 1,
            updatedAt: DB_NOW,
          })
          .where(eq(skillRepositories.id, row.id))
          .returning();
        if (!updated) throw new Error("skill repository vanished in its tx");
        await writeSucceededReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "update_skill_repository_ref",
          resource: { kind: "workspace", id: input.workspaceId },
          workspaceId: input.workspaceId,
          result: {
            skill_repository_id: updated.id,
            repository_id: updated.repositoryId,
            from: row.ref,
            to: updated.ref,
            generation: updated.generation,
          },
        });
        return {
          outcome: "updated",
          repository: await withCount(tx, updated),
          receiptId: input.receiptId,
        };
      });
    },

    begin(workspaceId, id, trigger, leaseMs) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            removedAt: skillRepositories.removedAt,
            busy: sql<boolean>`${skillRepositories.checkingUntil} IS NOT NULL AND ${skillRepositories.checkingUntil} > clock_timestamp()`,
          })
          .from(skillRepositories)
          .where(ofWorkspace(workspaceId, id))
          .limit(1)
          .for("update");
        if (!row || row.removedAt !== null) {
          return { outcome: "not_found" as const };
        }
        if (row.busy) {
          await tx
            .update(skillRepositories)
            .set({ checkAgain: triggerJson(trigger) })
            .where(ofWorkspace(workspaceId, id));
          return { outcome: "queued" as const };
        }
        // A trigger kept for a listing whose replica died stays, so the new
        // holder runs it once more.
        const lease = randomUUID();
        await tx
          .update(skillRepositories)
          .set({ checkingUntil: fromDbNow(leaseMs), checkingToken: lease })
          .where(ofWorkspace(workspaceId, id));
        return { outcome: "started" as const, token: lease };
      });
    },

    finish(workspaceId, id, leaseMs, lease) {
      return db.transaction(async (tx) => {
        const row = await locked(tx, workspaceId, id);
        if (!row || row.checkingToken !== lease) return null;
        const kept =
          row.checkAgain === null || row.checkAgain === undefined
            ? null
            : triggerOf(row.checkAgain);
        await tx
          .update(skillRepositories)
          .set({
            checkingUntil: kept === null ? null : fromDbNow(leaseMs),
            checkingToken: kept === null ? null : lease,
            checkAgain: null,
          })
          .where(eq(skillRepositories.id, row.id));
        return kept;
      });
    },

    record(input) {
      return db.transaction(async (tx) => {
        const row = await locked(tx, input.workspaceId, input.id);
        if (
          !row ||
          row.removedAt !== null ||
          row.checkingToken !== input.token ||
          row.generation !== input.generation
        ) {
          return false;
        }
        await tx
          .update(skillRepositories)
          .set({
            lastSync: syncJson(input.sync),
            lastCheckedAt: input.sync.at,
            ...(input.read === null
              ? {}
              : {
                  lastCommit: input.read.commit,
                  license: input.read.license,
                }),
            updatedAt: DB_NOW,
          })
          .where(eq(skillRepositories.id, row.id));
        if (input.read !== null) {
          await writeListing(tx, row.id, input.read.entries);
        }
        return true;
      });
    },
  };
}

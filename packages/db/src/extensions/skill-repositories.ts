import { randomUUID } from "node:crypto";
import {
  SKILL_REPOSITORY_CHECK_RESULT_VALUES,
  SKILL_REPOSITORY_SYNC_RESULT_VALUES,
  SKILL_REPOSITORY_TRIGGER_VALUES,
  type SkillRepositoryCheckResult,
  type SkillRepositorySyncResult,
  type SkillRepositoryTriggerKind,
} from "@werft-ai/contracts";
import type {
  SkillGateFindingRecord,
  SkillListingEntry,
  SkillRepository,
  SkillRepositorySkillCheck,
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
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { DB_NOW, fromDbNow } from "../db-clock.ts";
import { lockedRole } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import {
  extensionBundles,
  skillGitSources,
  skillRepositories,
  skillRepositorySkills,
} from "../schema.ts";
import { writeSucceededReceipt } from "../succeeded-receipt.ts";
import { recordCheckInTx } from "./skill-git-sources.ts";

/** A 40-character commit never moves, so the daily pass leaves it alone. */
const COMMIT_REF = "^[0-9a-f]{40}$";

type Row = typeof skillRepositories.$inferSelect;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

const triggerJson = (trigger: SkillRepositoryTrigger) => ({
  kind: trigger.kind,
  user_id: trigger.userId,
});

/**
 * Which kept trigger a new one may replace: a person's check is not turned
 * into the daily pass's.
 */
const RANK: Record<SkillRepositoryTriggerKind, number> = {
  daily: 0,
  register: 1,
  manual: 1,
  ref: 1,
  enable: 1,
};

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

const texts = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one) => typeof one === "string") : [];

const findingsOf = (value: unknown): SkillGateFindingRecord[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const one = record(entry);
        return typeof one.rule === "string"
          ? [
              {
                rule: one.rule,
                paths: texts(one.paths),
                samples: texts(one.samples),
              },
            ]
          : [];
      })
    : [];

export const skillCheckJson = (check: SkillRepositorySkillCheck) => ({
  at: check.at.toISOString(),
  trigger: triggerJson(check.trigger),
  commit: check.commit,
  result: check.result,
  version_id: check.versionId,
  issues: check.issues,
  blocks: check.blocks,
  warnings: check.warnings,
  notices: check.notices,
});

/** A result a later host wrote reads as the gate not answering: never a pass. */
function skillCheckOf(value: unknown): SkillRepositorySkillCheck | null {
  if (value === null || value === undefined) return null;
  const json = record(value);
  return {
    at: new Date(String(json.at)),
    trigger: triggerOf(json.trigger),
    commit: typeof json.commit === "string" ? json.commit : null,
    result: (
      SKILL_REPOSITORY_CHECK_RESULT_VALUES as readonly unknown[]
    ).includes(json.result)
      ? (json.result as SkillRepositoryCheckResult)
      : "gate_unavailable",
    versionId: typeof json.version_id === "string" ? json.version_id : null,
    issues: issuesOf(json.issues),
    blocks: findingsOf(json.blocks),
    warnings: findingsOf(json.warnings),
    notices: findingsOf(json.notices),
  };
}

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
  repository: Pick<Row, "id" | "workspaceId" | "repositoryId" | "repository">,
  entries: readonly SkillListingEntry[],
  sync: Pick<SkillRepositorySync, "at" | "trigger" | "commit">,
): Promise<void> {
  const repositoryId = repository.id;
  await switchOffRenamed(tx, repository, entries, sync);
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

/**
 * A directory switched on that has no version yet takes the name its
 * SKILL.md gives when its first version is written. Whoever switched it on
 * saw the name it had then: when a listing reads another, the switch goes
 * off, and it is switched on again under the name it shows. One with a
 * version keeps its name, and its check refuses the renamed content.
 */
async function switchOffRenamed(
  tx: Database,
  repository: Pick<Row, "id" | "workspaceId" | "repositoryId" | "repository">,
  entries: readonly SkillListingEntry[],
  sync: Pick<SkillRepositorySync, "at" | "trigger" | "commit">,
): Promise<void> {
  const on = await tx
    .select({
      id: skillRepositorySkills.id,
      path: skillRepositorySkills.path,
      name: skillRepositorySkills.name,
    })
    .from(skillRepositorySkills)
    .where(
      and(
        eq(skillRepositorySkills.skillRepositoryId, repository.id),
        eq(skillRepositorySkills.enabled, true),
      ),
    )
    .for("update");
  const nameAt = new Map(entries.map((entry) => [entry.path, entry.name]));
  const renamed = on.flatMap((skill) => {
    const now = nameAt.get(skill.path);
    return typeof now === "string" && skill.name !== null && now !== skill.name
      ? [{ ...skill, name: skill.name, now }]
      : [];
  });
  if (renamed.length === 0) return;
  const versioned = new Set(
    (
      await tx
        .select({ path: skillGitSources.path })
        .from(skillGitSources)
        .where(eq(skillGitSources.repositorySourceId, repository.id))
    ).map((row) => row.path),
  );
  for (const skill of renamed) {
    if (versioned.has(skill.path)) continue;
    await tx
      .update(skillRepositorySkills)
      .set({
        ...SWITCH_OFF,
        lastGate: skillCheckJson({
          at: sync.at,
          trigger: sync.trigger,
          commit: sync.commit,
          result: "rejected",
          versionId: null,
          issues: [
            {
              path: "SKILL.md",
              code: "name_changed",
              message: `It was switched on as "${skill.name}" and now names "${skill.now}"; switch it on again under that name.`,
            },
          ],
          blocks: [],
          warnings: [],
          notices: [],
        }),
        updatedAt: DB_NOW,
      })
      .where(eq(skillRepositorySkills.id, skill.id));
    await writeSucceededReceipt(
      tx,
      { ownerId: repository.workspaceId },
      {
        operation: "set_skill_repository_switch",
        resource: { kind: "workspace", id: repository.workspaceId },
        workspaceId: repository.workspaceId,
        result: {
          action: "off",
          by: "sync",
          reason: "name_changed",
          skill_repository_id: repository.id,
          repository_id: repository.repositoryId,
          repository: repository.repository,
          skill_id: skill.id,
          path: skill.path,
          name: skill.name,
          renamed_to: skill.now,
        },
      },
    );
  }
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

/** The repository row under a shared lock: what a switch and a version's write read it under. */
async function lockedShared(
  tx: Database,
  workspaceId: string,
  id: string,
): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(skillRepositories)
    .where(ofWorkspace(workspaceId, id))
    .limit(1)
    .for("share");
  return row;
}

const LEASE_FREE = {
  checkingUntil: null,
  checkingToken: null,
  checkAgain: null,
} as const;

/** A switch off: no grant, so a check that read it on writes nothing more. */
export const SWITCH_OFF = {
  enabled: false,
  enabledBy: null,
  enabledAt: null,
  enableGrantId: null,
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
      // The skills these directories are, each under the name its first
      // version took, and their current versions.
      const own = await db
        .select({ name: skillGitSources.name, path: skillGitSources.path })
        .from(skillGitSources)
        .where(
          and(
            eq(skillGitSources.workspaceId, workspaceId),
            eq(skillGitSources.repositorySourceId, id),
          ),
        );
      const current =
        own.length === 0
          ? []
          : await db
              .select({ id: extensionBundles.id, name: extensionBundles.name })
              .from(extensionBundles)
              .where(
                and(
                  eq(extensionBundles.workspaceId, workspaceId),
                  inArray(
                    extensionBundles.name,
                    own.map((row) => row.name),
                  ),
                  eq(extensionBundles.current, true),
                ),
              );
      const skillAt = new Map(own.map((row) => [row.path, row.name]));
      const currentOf = new Map(current.map((row) => [row.name, row.id]));
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
        grantId: skill.enableGrantId,
        skillName: skillAt.get(skill.path) ?? null,
        currentVersionId: currentOf.get(skillAt.get(skill.path) ?? "") ?? null,
        lastCheck: skillCheckOf(skill.lastGate),
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
            .set({ ...SWITCH_OFF, updatedAt: DB_NOW })
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
        await writeListing(tx, row, input.read.entries, {
          at: input.at,
          trigger: { kind: "register", userId: manager.userId },
          commit: input.read.commit,
        });
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
            again: skillRepositories.checkAgain,
          })
          .from(skillRepositories)
          .where(ofWorkspace(workspaceId, id))
          .limit(1)
          .for("update");
        if (!row || row.removedAt !== null) {
          return { outcome: "not_found" as const };
        }
        if (row.busy) {
          const kept =
            row.again === null || row.again === undefined
              ? null
              : triggerOf(row.again);
          if (kept === null || RANK[trigger.kind] >= RANK[kept.kind]) {
            await tx
              .update(skillRepositories)
              .set({ checkAgain: triggerJson(trigger) })
              .where(ofWorkspace(workspaceId, id));
          }
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
          await writeListing(tx, row, input.read.entries, input.sync);
        }
        return true;
      });
    },

    setSwitch(input) {
      return db.transaction(async (tx) => {
        const manager = await managerOf(tx, input);
        if ("outcome" in manager) return manager;
        // The repository row shared, then the directory's row: the order a
        // version's write takes them in, so the two never cross. A removal,
        // a restore, a ref change and a listing's write wait behind the
        // shared lock.
        const repository = await lockedShared(tx, input.workspaceId, input.id);
        if (!repository) return { outcome: "not_found" };
        if (repository.removedAt !== null) return { outcome: "removed" };
        const [skill] = await tx
          .select()
          .from(skillRepositorySkills)
          .where(
            and(
              eq(skillRepositorySkills.skillRepositoryId, repository.id),
              eq(skillRepositorySkills.id, input.skillId),
            ),
          )
          .limit(1)
          .for("update");
        if (!skill) return { outcome: "not_found" };
        if (skill.enabled === input.enabled) return { outcome: "unchanged" };
        if (input.enabled) {
          if (!skill.present) return { outcome: "missing" };
          const name = skill.name;
          if (name === null || issuesOf(skill.listingIssues).length > 0) {
            return { outcome: "unavailable" };
          }
          // Shown before any file is read. The version's write decides again
          // under the name's lock, which this does not hold.
          const [source] = await tx
            .select({
              repositorySourceId: skillGitSources.repositorySourceId,
              path: skillGitSources.path,
            })
            .from(skillGitSources)
            .where(
              and(
                eq(skillGitSources.workspaceId, input.workspaceId),
                eq(skillGitSources.name, name),
              ),
            )
            .limit(1);
          if (source) {
            if (
              source.repositorySourceId !== repository.id ||
              source.path !== skill.path
            ) {
              return { outcome: "name_conflict", owner: "github" };
            }
          } else {
            const [held] = await tx
              .select({ source: extensionBundles.source })
              .from(extensionBundles)
              .where(
                and(
                  eq(extensionBundles.workspaceId, input.workspaceId),
                  eq(extensionBundles.name, name),
                ),
              )
              .limit(1);
            if (held) {
              return {
                outcome: "name_conflict",
                owner: held.source === "github" ? "github" : "upload",
              };
            }
          }
        }
        await tx
          .update(skillRepositorySkills)
          .set(
            input.enabled
              ? {
                  enabled: true,
                  enabledBy: manager.userId,
                  enabledAt: DB_NOW,
                  // The receipt is the grant: a check that read the switch
                  // under another writes nothing.
                  enableGrantId: input.receiptId,
                  lastGate: null,
                  updatedAt: DB_NOW,
                }
              : { ...SWITCH_OFF, updatedAt: DB_NOW },
          )
          .where(eq(skillRepositorySkills.id, skill.id));
        await writeSucceededReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "set_skill_repository_switch",
          resource: { kind: "workspace", id: input.workspaceId },
          workspaceId: input.workspaceId,
          result: {
            action: input.enabled ? "on" : "off",
            skill_repository_id: repository.id,
            repository_id: repository.repositoryId,
            repository: repository.repository,
            generation: repository.generation,
            skill_id: skill.id,
            path: skill.path,
            name: skill.name,
            ...(input.enabled
              ? {
                  ref: repository.ref,
                  commit: repository.lastCommit,
                  tree_sha: skill.treeSha,
                  license: {
                    repository: repository.license,
                    skill: skill.license,
                  },
                }
              : {}),
          },
        });
        return { outcome: "updated", receiptId: input.receiptId };
      });
    },

    recordSkillCheck(input) {
      return db.transaction(async (tx) => {
        // The skill's source row first, as a version's write takes it before
        // the repository's and the directory's.
        const [listed] = await tx
          .select({ path: skillRepositorySkills.path })
          .from(skillRepositorySkills)
          .where(
            and(
              eq(skillRepositorySkills.skillRepositoryId, input.id),
              eq(skillRepositorySkills.id, input.skillId),
            ),
          )
          .limit(1);
        if (!listed) return false;
        const [source] = await tx
          .select({ name: skillGitSources.name })
          .from(skillGitSources)
          .where(
            and(
              eq(skillGitSources.workspaceId, input.workspaceId),
              eq(skillGitSources.repositorySourceId, input.id),
              eq(skillGitSources.path, listed.path),
            ),
          )
          .limit(1)
          .for("update");
        const repository = await lockedShared(tx, input.workspaceId, input.id);
        if (
          !repository ||
          repository.removedAt !== null ||
          repository.checkingToken !== input.token ||
          repository.generation !== input.generation
        ) {
          return false;
        }
        const written = await tx
          .update(skillRepositorySkills)
          .set({ lastGate: skillCheckJson(input.check), updatedAt: DB_NOW })
          .where(
            and(
              eq(skillRepositorySkills.skillRepositoryId, repository.id),
              eq(skillRepositorySkills.id, input.skillId),
              eq(skillRepositorySkills.enabled, true),
              eq(skillRepositorySkills.enableGrantId, input.grantId),
            ),
          )
          .returning({ id: skillRepositorySkills.id });
        if (written.length === 0) return false;
        if (source && input.sourceCheck !== null) {
          await recordCheckInTx(tx, input.workspaceId, source.name, {
            at: input.check.at,
            trigger: input.sourceCheck.trigger,
            commit: input.check.commit,
            result: input.sourceCheck.result,
            versionId: null,
            issues: input.sourceCheck.issues,
            autoApproval: null,
          });
        }
        return true;
      });
    },

    async extend(workspaceId, id, leaseMs, token) {
      const held = await db
        .update(skillRepositories)
        .set({ checkingUntil: fromDbNow(leaseMs) })
        .where(
          and(
            ofWorkspace(workspaceId, id),
            eq(skillRepositories.checkingToken, token),
          ),
        )
        .returning({ id: skillRepositories.id });
      return held.length > 0;
    },

    async due(before, limit, claimMs) {
      // Claimed as a skill's source is: the last check moves to `claimMs`
      // past `before`, so another replica's pass leaves it and one that died
      // before checking it lets it go then; a recorded check overwrites it.
      const claimed = new Date(before.getTime() + claimMs);
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            workspaceId: skillRepositories.workspaceId,
            id: skillRepositories.id,
          })
          .from(skillRepositories)
          .where(
            and(
              isNull(skillRepositories.removedAt),
              sql`${skillRepositories.ref} !~ ${COMMIT_REF}`,
              or(
                isNull(skillRepositories.lastCheckedAt),
                lt(skillRepositories.lastCheckedAt, before),
              ),
            ),
          )
          .orderBy(sql`${skillRepositories.lastCheckedAt} ASC NULLS FIRST`)
          .limit(limit)
          .for("update", { skipLocked: true });
        for (const row of rows) {
          await tx
            .update(skillRepositories)
            .set({ lastCheckedAt: claimed })
            .where(eq(skillRepositories.id, row.id));
        }
        return rows;
      });
    },
  };
}

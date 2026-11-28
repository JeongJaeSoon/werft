import { randomUUID } from "node:crypto";
import {
  ENDED_SESSION_STATUSES,
  type SkillAvailability,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  BundleManifest,
  ExtensionBundle,
  ExtensionBundleReview,
  ExtensionBundleSource,
  ExtensionBundleStore,
  ExtensionMode,
  GitVersionInput,
  Principal,
  RegisterExtensionBundleResult,
  RepositoryApprovalInput,
  SkillAutoApproval,
  SkillRepositorySkillCheck,
} from "@werft-ai/platform";
import {
  and,
  asc,
  desc,
  eq,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { lockAgentToChange } from "../agents.ts";
import { UUID } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import { lockedRole } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import {
  extensionAttachments,
  extensionBundles,
  sessions,
  skillGitSources,
  skillRepositories,
  skillRepositorySkills,
} from "../schema.ts";
import { writeSucceededReceipt } from "../succeeded-receipt.ts";
import {
  autoApproveOn,
  gitVersionJson,
  gitVersionOf,
  lockedManagers,
  lockedSource,
  recordCheckInTx,
} from "./skill-git-sources.ts";
import { SWITCH_OFF, skillCheckJson } from "./skill-repositories.ts";

type Row = typeof extensionBundles.$inferSelect;

function bundleOf(row: Row): ExtensionBundle {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    digest: row.digest,
    label: row.label,
    source: row.source as ExtensionBundleSource,
    sizeBytes: row.sizeBytes,
    manifest: row.manifest as BundleManifest,
    review: row.review as ExtensionBundleReview,
    registeredBy: row.registeredBy,
    git: gitVersionOf(row.git),
    registeredAt: row.registeredAt,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    version: row.version,
    archivedAt: row.archivedAt,
    current: row.current,
  };
}

const ofSkill = (workspaceId: string, name: string) =>
  and(
    eq(extensionBundles.workspaceId, workspaceId),
    eq(extensionBundles.name, name),
  );

/**
 * One change of a skill's versions at a time: its name's lock, then its Git source row's, as a registration takes.
 */
async function lockSkill(tx: Database, workspaceId: string, name: string) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`extension_bundles:${workspaceId}:${name}`}, 0))`,
  );
  return lockedSource(tx, workspaceId, name);
}

async function currentOf(
  tx: Database,
  workspaceId: string,
  name: string,
): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(extensionBundles)
    .where(and(ofSkill(workspaceId, name), eq(extensionBundles.current, true)))
    .limit(1);
  return row;
}

/** The highest approved, not archived version below `below`. */
async function previousApproved(
  tx: Database,
  workspaceId: string,
  name: string,
  below: number,
): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(extensionBundles)
    .where(
      and(
        ofSkill(workspaceId, name),
        eq(extensionBundles.review, "approved"),
        isNull(extensionBundles.archivedAt),
        lt(extensionBundles.version, below),
      ),
    )
    .orderBy(desc(extensionBundles.version))
    .limit(1);
  return row;
}

/**
 * Closes the skill's not archived versions below `version` still awaiting
 * review: a newer one is approved or current, so they leave the review list.
 * `by` is who approved or moved it; null under the sync's auto-approve.
 */
async function supersedeBelow(
  tx: Database,
  workspaceId: string,
  name: string,
  version: number,
  by: string | null,
): Promise<{ id: string; version: number }[]> {
  const rows = await tx
    .update(extensionBundles)
    .set({ review: "superseded", reviewedBy: by, reviewedAt: DB_NOW })
    .where(
      and(
        ofSkill(workspaceId, name),
        eq(extensionBundles.review, "pending"),
        isNull(extensionBundles.archivedAt),
        lt(extensionBundles.version, version),
      ),
    )
    .returning({ id: extensionBundles.id, version: extensionBundles.version });
  return rows
    .map((row) => ({ id: row.id, version: row.version as number }))
    .sort((a, b) => a.version - b.version);
}

/** Makes `id` the skill's current version, or leaves it none on null. */
async function makeCurrent(
  tx: Database,
  workspaceId: string,
  name: string,
  id: string | null,
) {
  await tx
    .update(extensionBundles)
    .set({ current: false })
    .where(and(ofSkill(workspaceId, name), eq(extensionBundles.current, true)));
  if (id !== null) {
    await tx
      .update(extensionBundles)
      .set({ current: true })
      .where(eq(extensionBundles.id, id));
  }
}

async function reread(tx: Database, id: string): Promise<Row> {
  const [row] = await tx
    .select()
    .from(extensionBundles)
    .where(eq(extensionBundles.id, id))
    .limit(1);
  if (!row) throw new Error("extension bundle vanished in its tx");
  return row;
}

/** A version a session that has not ended was started with. */
async function liveSessionRuns(
  tx: Database,
  workspaceId: string,
  bundleId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.ownerId, workspaceId),
        notInArray(sessions.status, [...ENDED_SESSION_STATUSES]),
        sql`${sessions.extensions} @> ${JSON.stringify([{ bundle_id: bundleId }])}::jsonb`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The skills of registered repositories, by name, and whether a new session
 * takes each: `withdrawn` once the repository is removed, `hidden` while
 * the switch of the directory the skill's source names is off. A source
 * whose directory the listing does not hold is hidden too. A name absent is
 * no repository's skill.
 */
async function repositorySkills(
  tx: Database,
  workspaceId: string,
  name?: string,
): Promise<Map<string, SkillAvailability>> {
  const skills = new Map<string, SkillAvailability>();
  if (!UUID.test(workspaceId)) return skills;
  const rows = await tx
    .select({
      name: skillGitSources.name,
      removedAt: skillRepositories.removedAt,
      enabled: skillRepositorySkills.enabled,
    })
    .from(skillGitSources)
    .innerJoin(
      skillRepositories,
      and(
        eq(skillRepositories.id, skillGitSources.repositorySourceId),
        eq(skillRepositories.workspaceId, skillGitSources.workspaceId),
      ),
    )
    .leftJoin(
      skillRepositorySkills,
      and(
        eq(skillRepositorySkills.skillRepositoryId, skillRepositories.id),
        eq(skillRepositorySkills.path, skillGitSources.path),
      ),
    )
    .where(
      and(
        eq(skillGitSources.workspaceId, workspaceId),
        name === undefined ? undefined : eq(skillGitSources.name, name),
      ),
    );
  for (const row of rows) {
    skills.set(
      row.name,
      row.removedAt !== null
        ? "withdrawn"
        : row.enabled === true
          ? "ok"
          : "hidden",
    );
  }
  return skills;
}

/** The actor's role when it may manage bundles; otherwise why not. */
async function managerCheck(
  tx: Database,
  workspaceId: string,
  principal: Principal,
  roles: readonly WorkspaceRole[],
  /** Also whether another manager exists, for the self-review rule. */
  others = false,
): Promise<
  { userId: string; another: boolean } | "actor_inactive" | "outranked"
> {
  const userId = principal.actor?.userId;
  if (!userId) return "actor_inactive";
  const { role, another } = others
    ? await lockedManagers(tx, workspaceId, userId, roles)
    : { role: await lockedRole(tx, workspaceId, userId), another: false };
  if (role === null) return "actor_inactive";
  return roles.includes(role) ? { userId, another } : "outranked";
}

async function writeReceipt(
  tx: Database,
  principal: Principal,
  input: {
    id: string;
    operation:
      | "register_extension"
      | "approve_extension"
      | "attach_extension"
      | "detach_extension"
      | "archive_extension"
      | "revert_extension";
    target: { kind: "extension_bundle" | "agent" | "skill"; id: string };
    result: Record<string, unknown>;
  },
) {
  await writeSucceededReceipt(tx, principal, {
    id: input.id,
    operation: input.operation,
    resource: input.target,
    workspaceId: principal.ownerId,
    result: input.result,
  });
}

/**
 * A version of a registered repository's skill: written approved and
 * current, or not at all. Registering the repository approved it and the
 * gate passed this content, so no person stands behind the version; what
 * stands instead is read again here, under the locks every writer of it
 * takes in this order: the skill's name, its source row, the repository's
 * row (shared) and the listed directory's. A removal, a restore, a ref
 * change, a check taken over, the switch turned off or on again: any of
 * them since the check read GitHub, and nothing is written.
 */
async function registerRepositoryVersion(
  tx: Database,
  input: Parameters<ExtensionBundleStore["register"]>[0],
  git: GitVersionInput,
  basis: RepositoryApprovalInput,
): Promise<RegisterExtensionBundleResult> {
  const { workspaceId, name } = input;
  const source = await lockSkill(tx, workspaceId, name);
  const [repository] = await tx
    .select()
    .from(skillRepositories)
    .where(
      and(
        eq(skillRepositories.workspaceId, workspaceId),
        eq(skillRepositories.id, basis.skillRepositoryId),
      ),
    )
    .limit(1)
    .for("share");
  if (
    !repository ||
    repository.removedAt !== null ||
    repository.generation !== basis.generation
  ) {
    return { outcome: "stale" };
  }
  if (repository.checkingToken !== basis.leaseToken) {
    return { outcome: "lease_lost" };
  }
  const [skill] = await tx
    .select()
    .from(skillRepositorySkills)
    .where(
      and(
        eq(skillRepositorySkills.skillRepositoryId, repository.id),
        eq(skillRepositorySkills.id, basis.skillId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !skill ||
    !skill.enabled ||
    skill.enableGrantId !== basis.grantId ||
    skill.path !== git.location.path
  ) {
    return { outcome: "stale" };
  }
  // What the gate found is kept only with the version it passed.
  const lastGate = (
    result: SkillRepositorySkillCheck["result"],
    versionId: string | null,
  ) =>
    skillCheckJson({
      at: git.checkedAt,
      trigger: basis.trigger,
      commit: git.location.commit,
      result,
      versionId,
      issues: [],
      blocks: [],
      warnings: result === "passed" ? (basis.gate?.warnings ?? []) : [],
      notices: result === "passed" ? (basis.gate?.notices ?? []) : [],
    });
  const checked = (
    result: SkillRepositorySkillCheck["result"],
    versionId: string | null,
  ) =>
    tx
      .update(skillRepositorySkills)
      .set({
        lastGate: lastGate(result, versionId),
        ...(result === "passed" ? { passedTreeSha: basis.treeSha } : {}),
        updatedAt: DB_NOW,
      })
      .where(eq(skillRepositorySkills.id, skill.id));

  // The name is this directory's when its source row says so, and free when
  // nothing of the workspace carries it. Anything else is another skill's:
  // an upload, a GitHub skill, another repository's or directory's.
  const named = await tx
    .select({ version: extensionBundles.version })
    .from(extensionBundles)
    .where(ofSkill(workspaceId, name));
  const taken =
    source === undefined
      ? named.length > 0
      : source.repositorySourceId !== repository.id ||
        source.path !== skill.path;
  if (taken) {
    await tx
      .update(skillRepositorySkills)
      .set({
        ...SWITCH_OFF,
        lastGate: lastGate("name_conflict", null),
        updatedAt: DB_NOW,
      })
      .where(eq(skillRepositorySkills.id, skill.id));
    await writeSucceededReceipt(tx, input.principal, {
      operation: "set_skill_repository_switch",
      resource: { kind: "workspace", id: workspaceId },
      workspaceId,
      result: {
        action: "off",
        by: "sync",
        reason: "name_conflict",
        skill_repository_id: repository.id,
        repository_id: repository.repositoryId,
        repository: repository.repository,
        generation: repository.generation,
        skill_id: skill.id,
        path: skill.path,
        name,
      },
    });
    return { outcome: "name_conflict" };
  }

  /** Whether the last approved version below `below` (null: of all) is `id`. */
  const baselineIs = async (below: number | null, id: string | null) => {
    const [row] = await tx
      .select({ id: extensionBundles.id })
      .from(extensionBundles)
      .where(
        and(
          ofSkill(workspaceId, name),
          eq(extensionBundles.review, "approved"),
          below === null ? undefined : lt(extensionBundles.version, below),
        ),
      )
      .orderBy(desc(extensionBundles.version))
      .limit(1);
    return (row?.id ?? null) === id;
  };
  const sourceChecked = (result: "created" | "unchanged", versionId: string) =>
    recordCheckInTx(tx, workspaceId, name, {
      at: git.checkedAt,
      trigger: git.trigger,
      commit: git.location.commit,
      result,
      versionId,
      issues: [],
      autoApproval: null,
    });
  /** Approves `row` where it is not, and makes it the current version where it is not. */
  const promote = async (row: Row, from: string | null) => {
    const version = row.version as number;
    if (row.review !== "approved") {
      await tx
        .update(extensionBundles)
        .set({ review: "approved", reviewedBy: null, reviewedAt: DB_NOW })
        .where(eq(extensionBundles.id, row.id));
    }
    const before = await currentOf(tx, workspaceId, name);
    const moved = before?.id !== row.id;
    if (moved) await makeCurrent(tx, workspaceId, name, row.id);
    const superseded = await supersedeBelow(
      tx,
      workspaceId,
      name,
      version,
      null,
    );
    await writeReceipt(tx, input.principal, {
      id: randomUUID(),
      operation: "approve_extension",
      target: { kind: "extension_bundle", id: row.id },
      result: {
        digest: row.digest,
        from,
        review: "approved",
        by: "sync",
        basis: "repository",
        skill_repository_id: repository.id,
        repository_id: repository.repositoryId,
        commit: git.location.commit,
        // Rule names and how many files, never a file's content.
        warnings: (basis.gate?.warnings ?? []).map((finding) => ({
          rule: finding.rule,
          paths: finding.paths.length,
        })),
        license: { repository: repository.license, skill: skill.license },
        ...(moved
          ? { current: { from: before?.version ?? null, to: version } }
          : {}),
        ...(superseded.length > 0 ? { superseded } : {}),
      },
    });
    return reread(tx, row.id);
  };

  const [existing] = await tx
    .select()
    .from(extensionBundles)
    .where(
      and(
        eq(extensionBundles.workspaceId, workspaceId),
        eq(extensionBundles.digest, input.digest),
      ),
    )
    .limit(1);
  if (existing) {
    // A digest covers the skill's directory name, so it is this skill's.
    if (existing.name !== name || existing.version === null) {
      throw new Error("a repository skill's digest names another bundle");
    }
    // What a manager rejected or archived stays out, whatever upstream holds.
    if (existing.review === "rejected" || existing.archivedAt !== null) {
      await checked("withheld", existing.id);
      await sourceChecked("unchanged", existing.id);
      return { outcome: "withheld", bundle: bundleOf(existing) };
    }
    if (existing.review === "approved") {
      // Already current, or an earlier version upstream went back to.
      const bundle = existing.current
        ? existing
        : await promote(existing, "approved");
      await checked("passed", existing.id);
      await sourceChecked("unchanged", existing.id);
      return { outcome: "already_registered", bundle: bundleOf(bundle) };
    }
    // Still waiting: written by a host from before repositories, or left
    // behind by one. Only this gate's pass against the same baseline
    // approves it; otherwise it stays as it is, out of every session.
    if (
      basis.gate === null ||
      !(await baselineIs(existing.version, basis.gate.baselineId))
    ) {
      await checked("baseline_changed", null);
      return { outcome: "baseline_changed" };
    }
    const bundle = await promote(existing, existing.review);
    await checked("passed", existing.id);
    await sourceChecked("unchanged", existing.id);
    return { outcome: "already_registered", bundle: bundleOf(bundle) };
  }

  // New content: the gate must have passed it against the version that is
  // the last approved one now.
  if (basis.gate === null || !(await baselineIs(null, basis.gate.baselineId))) {
    await checked("baseline_changed", null);
    return { outcome: "baseline_changed" };
  }
  const version = Math.max(0, ...named.map((row) => row.version as number)) + 1;
  // Who turned the switch on stands for the skill's first version.
  const by = skill.enabledBy ?? repository.createdBy;
  if (source === undefined) {
    await tx.insert(skillGitSources).values({
      workspaceId,
      name,
      connectionId: repository.connectionId,
      installationId: repository.installationId,
      access: "public",
      repositoryId: repository.repositoryId,
      repository: repository.repository,
      path: skill.path,
      ref: git.location.ref,
      // Never true for a repository's skill: the daily pass and the
      // auto-approve of a host from before repositories read this column.
      syncEnabled: false,
      repositorySourceId: repository.id,
      createdBy: by,
    });
  } else {
    // A restored repository may read through another connection, and a ref
    // change moves every skill of it.
    await tx
      .update(skillGitSources)
      .set({
        connectionId: repository.connectionId,
        installationId: repository.installationId,
        repository: repository.repository,
        ref: git.location.ref,
        updatedAt: DB_NOW,
      })
      .where(
        and(
          eq(skillGitSources.workspaceId, workspaceId),
          eq(skillGitSources.name, name),
        ),
      );
  }
  const [inserted] = await tx
    .insert(extensionBundles)
    .values({
      id: input.id,
      workspaceId,
      name,
      digest: input.digest,
      label: input.label,
      source: input.source,
      sizeBytes: input.sizeBytes,
      manifest: input.manifest,
      registeredBy: source === undefined ? by : null,
      git: gitVersionJson(git.location, git.trigger),
      version,
      review: "approved",
      reviewedAt: DB_NOW,
    })
    .returning();
  if (!inserted) throw new Error("extension bundle vanished in its tx");
  await writeReceipt(tx, input.principal, {
    id: input.receiptId,
    operation: "register_extension",
    target: { kind: "extension_bundle", id: inserted.id },
    result: {
      name: inserted.name,
      digest: inserted.digest,
      source: inserted.source,
      size_bytes: inserted.sizeBytes,
      skills: input.manifest.skills.map((one) => one.name),
      version,
      by: "sync",
      basis: "repository",
      skill_repository_id: repository.id,
      git: gitVersionJson(git.location, git.trigger),
    },
  });
  const bundle = await promote(inserted, null);
  await checked("passed", inserted.id);
  await sourceChecked("created", inserted.id);
  return {
    outcome: "registered",
    bundle: bundleOf(bundle),
    receiptId: input.receiptId,
  };
}

export function createPostgresExtensionBundleStore(
  db: Database,
): ExtensionBundleStore {
  async function byId(tx: Database, workspaceId: string, id: string) {
    if (!UUID.test(id) || !UUID.test(workspaceId)) return undefined;
    const [row] = await tx
      .select()
      .from(extensionBundles)
      .where(
        and(
          eq(extensionBundles.workspaceId, workspaceId),
          eq(extensionBundles.id, id.toLowerCase()),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * How a review or an archive opens: the manager, the skill's lock when the
   * bundle is a version, then the row FOR UPDATE, which an attach of the
   * version holds FOR SHARE.
   */
  async function lockBundleForManager(
    tx: Database,
    input: {
      workspaceId: string;
      principal: Principal;
      managerRoles: readonly WorkspaceRole[];
      bundleId: string;
    },
  ): Promise<
    | { outcome: "actor_inactive" | "outranked" | "not_found" }
    | {
        actor: { userId: string; another: boolean };
        row: Row;
        /** Whether the bundle is a version of a registered repository's skill. */
        repositorySkill: boolean;
      }
  > {
    const actor = await managerCheck(
      tx,
      input.workspaceId,
      input.principal,
      input.managerRoles,
      true,
    );
    if (typeof actor === "string") return { outcome: actor };
    const found = await byId(tx, input.workspaceId, input.bundleId);
    if (!found) return { outcome: "not_found" };
    const source =
      found.version === null
        ? undefined
        : await lockSkill(tx, input.workspaceId, found.name);
    const [row] = await tx
      .select()
      .from(extensionBundles)
      .where(
        and(
          eq(extensionBundles.workspaceId, input.workspaceId),
          eq(extensionBundles.id, input.bundleId.toLowerCase()),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) return { outcome: "not_found" };
    return {
      actor,
      row,
      repositorySkill:
        source !== undefined && source.repositorySourceId !== null,
    };
  }

  return {
    async find(workspaceId, id) {
      const row = await byId(db, workspaceId, id);
      return row ? bundleOf(row) : null;
    },

    async findByDigest(workspaceId, digest) {
      const [row] = await db
        .select()
        .from(extensionBundles)
        .where(
          and(
            eq(extensionBundles.workspaceId, workspaceId),
            eq(extensionBundles.digest, digest),
          ),
        )
        .limit(1);
      return row ? bundleOf(row) : null;
    },

    async list(workspaceId) {
      const rows = await db
        .select()
        .from(extensionBundles)
        .where(eq(extensionBundles.workspaceId, workspaceId))
        .orderBy(asc(extensionBundles.registeredAt), asc(extensionBundles.id));
      return rows.map(bundleOf);
    },

    async mayManage(input) {
      return db.transaction(async (tx) => {
        const actor = await managerCheck(
          tx,
          input.workspaceId,
          input.principal,
          input.managerRoles,
        );
        return typeof actor === "string" ? actor : "ok";
      });
    },

    register(input) {
      return db.transaction(async (tx) => {
        const git = input.git;
        if (git?.repository !== undefined) {
          if (
            input.skill !== true ||
            git.newSource !== undefined ||
            git.auto !== undefined
          ) {
            throw new Error(
              "a repository skill's version is a skill version with no new source and no auto-approve",
            );
          }
          return registerRepositoryVersion(tx, input, git, git.repository);
        }
        // A version the Git sync made has no person behind it; its source
        // row, read again under its lock below, says whether it may.
        const synced = git !== undefined && git.newSource === undefined;
        if (git !== undefined && input.skill !== true) {
          throw new Error("a GitHub version must be registered as a skill");
        }
        let userId: string | null = null;
        if (!synced) {
          const actor = await managerCheck(
            tx,
            input.workspaceId,
            input.principal,
            input.managerRoles,
          );
          if (typeof actor === "string") return { outcome: actor };
          userId = actor.userId;
        }
        const checked = async (
          result: "created" | "unchanged" | "paused",
          versionId: string | null,
          autoApproval: SkillAutoApproval | null = null,
        ) => {
          if (git === undefined) return;
          await recordCheckInTx(tx, input.workspaceId, input.name, {
            at: git.checkedAt,
            trigger: git.trigger,
            commit: git.location.commit,
            result,
            versionId,
            issues: [],
            autoApproval,
          });
        };
        let source: Awaited<ReturnType<typeof lockSkill>>;
        // Auto-approve of a pending version of this skill: only for the
        // sync, only while sync and auto-approve are both still on under the
        // source row's lock, with no settings change since the check read
        // them. The fixed-rule checks hold it back, and so does a baseline
        // other than the one they ran against: their findings are then
        // about another version and are not kept.
        const judge = async (
          version: number,
        ): Promise<SkillAutoApproval | null> => {
          const auto = git?.auto;
          if (
            !synced ||
            auto === undefined ||
            source?.syncEnabled !== true ||
            !autoApproveOn(source) ||
            source.autoApproveGrantId !== auto.grantId
          ) {
            return null;
          }
          const [baseline] = await tx
            .select({ id: extensionBundles.id })
            .from(extensionBundles)
            .where(
              and(
                ofSkill(input.workspaceId, input.name),
                eq(extensionBundles.review, "approved"),
                lt(extensionBundles.version, version),
              ),
            )
            .orderBy(desc(extensionBundles.version))
            .limit(1);
          if ((baseline?.id ?? null) !== auto.checks.baselineId) {
            return {
              result: "pending",
              reason: "baseline_changed",
              checks: [],
            };
          }
          return auto.checks.findings.length > 0
            ? {
                result: "pending",
                reason: "checks_failed",
                checks: auto.checks.findings,
              }
            : { result: "approved", reason: null, checks: [] };
        };
        const approveBySync = async (row: Row, version: number) => {
          await tx
            .update(extensionBundles)
            .set({ review: "approved", reviewedAt: DB_NOW })
            .where(eq(extensionBundles.id, row.id));
          const before = await currentOf(tx, input.workspaceId, input.name);
          const advances =
            before === undefined || (before.version ?? 0) < version;
          if (advances) {
            await makeCurrent(tx, input.workspaceId, input.name, row.id);
          }
          const superseded = await supersedeBelow(
            tx,
            input.workspaceId,
            input.name,
            version,
            null,
          );
          await writeReceipt(tx, input.principal, {
            id: randomUUID(),
            operation: "approve_extension",
            target: { kind: "extension_bundle", id: row.id },
            result: {
              digest: row.digest,
              from: "pending",
              review: "approved",
              by: "sync",
              auto_approve: {
                enabled_by: source?.autoApproveConsentedBy ?? null,
              },
              commit: git?.location.commit,
              ...(advances
                ? { current: { from: before?.version ?? null, to: version } }
                : {}),
              ...(superseded.length > 0 ? { superseded } : {}),
            },
          });
          return reread(tx, row.id);
        };
        const sameDigest = async () => {
          const [existing] = await tx
            .select()
            .from(extensionBundles)
            .where(
              and(
                eq(extensionBundles.workspaceId, input.workspaceId),
                eq(extensionBundles.digest, input.digest),
              ),
            )
            .limit(1);
          return existing;
        };
        let version: number | null = null;
        if (input.skill === true) {
          // One registration of a name at a time, so two uploads of new
          // content cannot both take the same next version. A skill's
          // source is fixed by its first registration.
          source = await lockSkill(tx, input.workspaceId, input.name);
          // A registered repository's skill takes versions from its
          // repository's checks alone (above): not an upload, not another
          // registration, not the per-skill sync.
          if (source && source.repositorySourceId !== null) {
            return { outcome: "source_mismatch" };
          }
          if ((git === undefined || git.newSource) && source) {
            return { outcome: "source_mismatch" };
          }
          if (synced && !source) return { outcome: "source_mismatch" };
          if (synced && source?.checkingToken !== git?.leaseToken) {
            return { outcome: "lease_lost" };
          }
          // Only "지금 확인" runs while paused.
          if (
            synced &&
            git !== undefined &&
            source &&
            !source.syncEnabled &&
            git.trigger.kind !== "manual"
          ) {
            await checked("paused", null);
            return { outcome: "paused" };
          }
          const named = await tx
            .select({ version: extensionBundles.version })
            .from(extensionBundles)
            .where(
              and(
                eq(extensionBundles.workspaceId, input.workspaceId),
                eq(extensionBundles.name, input.name),
              ),
            );
          if (named.some((row) => row.version === null)) {
            return { outcome: "name_taken" };
          }
          if (git?.newSource && named.length > 0) {
            return { outcome: "source_mismatch" };
          }
          const existing = await sameDigest();
          if (existing) {
            // A version still waiting is judged as a new one would be.
            const waiting =
              existing.name === input.name &&
              existing.review === "pending" &&
              existing.archivedAt === null
                ? existing.version
                : null;
            const approval = waiting === null ? null : await judge(waiting);
            await checked("unchanged", existing.id, approval);
            return {
              outcome: "already_registered",
              bundle: bundleOf(
                waiting !== null && approval?.result === "approved"
                  ? await approveBySync(existing, waiting)
                  : existing,
              ),
            };
          }
          version =
            Math.max(0, ...named.map((row) => row.version as number)) + 1;
          if (git?.newSource && userId !== null) {
            await tx.insert(skillGitSources).values({
              workspaceId: input.workspaceId,
              name: input.name,
              connectionId: git.newSource.connectionId,
              installationId: git.newSource.installationId,
              access: git.newSource.access,
              repositoryId: git.newSource.repositoryId,
              repository: git.newSource.repository,
              path: git.location.path,
              ref: git.location.ref,
              createdBy: userId,
            });
          }
        }
        const [inserted] = await tx
          .insert(extensionBundles)
          .values({
            id: input.id,
            workspaceId: input.workspaceId,
            name: input.name,
            digest: input.digest,
            label: input.label,
            source: input.source,
            sizeBytes: input.sizeBytes,
            manifest: input.manifest,
            registeredBy: userId,
            git:
              git === undefined
                ? null
                : gitVersionJson(git.location, git.trigger),
            version,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) {
          const existing = await sameDigest();
          if (!existing) throw new Error("extension bundle vanished in its tx");
          await checked("unchanged", existing.id);
          return { outcome: "already_registered", bundle: bundleOf(existing) };
        }
        const approval = version === null ? null : await judge(version);
        await checked("created", inserted.id, approval);
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "register_extension",
          target: { kind: "extension_bundle", id: inserted.id },
          result: {
            name: inserted.name,
            digest: inserted.digest,
            source: inserted.source,
            size_bytes: inserted.sizeBytes,
            skills: input.manifest.skills.map((skill) => skill.name),
            ...(version === null ? {} : { version }),
            ...(git === undefined
              ? {}
              : {
                  // The sync is the subject of a version it made; the
                  // trigger names the delivery, the daily check or the
                  // person who pressed.
                  by: synced ? "sync" : "user",
                  git: gitVersionJson(git.location, git.trigger),
                }),
          },
        });
        return {
          outcome: "registered",
          bundle: bundleOf(
            version !== null && approval?.result === "approved"
              ? await approveBySync(inserted, version)
              : inserted,
          ),
          receiptId: input.receiptId,
        };
      });
    },

    revert(input) {
      return db.transaction(async (tx) => {
        const actor = await managerCheck(
          tx,
          input.workspaceId,
          input.principal,
          input.managerRoles,
        );
        if (typeof actor === "string") return { outcome: actor };
        const source = await lockSkill(tx, input.workspaceId, input.name);
        const [any] = await tx
          .select({ id: extensionBundles.id })
          .from(extensionBundles)
          .where(ofSkill(input.workspaceId, input.name))
          .limit(1);
        if (!any) return { outcome: "not_found" };
        // Its repository decides the current version: the next check would
        // put back what a step down took away.
        if (source && source.repositorySourceId !== null) {
          return { outcome: "repository_skill" };
        }
        const from = await currentOf(tx, input.workspaceId, input.name);
        const to =
          from?.version == null
            ? undefined
            : await previousApproved(
                tx,
                input.workspaceId,
                input.name,
                from.version,
              );
        if (!from || !to) return { outcome: "no_previous_version" };
        await makeCurrent(tx, input.workspaceId, input.name, to.id);
        const superseded = await supersedeBelow(
          tx,
          input.workspaceId,
          input.name,
          to.version as number,
          actor.userId,
        );
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "revert_extension",
          target: { kind: "extension_bundle", id: to.id },
          result: {
            name: input.name,
            from: { id: from.id, version: from.version, digest: from.digest },
            to: { id: to.id, version: to.version, digest: to.digest },
            ...(superseded.length > 0 ? { superseded } : {}),
          },
        });
        return {
          outcome: "reverted",
          from: bundleOf(await reread(tx, from.id)),
          to: bundleOf(await reread(tx, to.id)),
          receiptId: input.receiptId,
        };
      });
    },

    review(input) {
      return db.transaction(async (tx) => {
        const locked = await lockBundleForManager(tx, input);
        if ("outcome" in locked) return locked;
        const { actor, row } = locked;
        if (row.archivedAt !== null) return { outcome: "archived" };
        if (row.review === input.review) {
          return { outcome: "unchanged", bundle: bundleOf(row) };
        }
        // Only the gate approves a registered repository's version: a person
        // could otherwise approve one it never passed (left waiting by a host
        // from before repositories) or one a manager took back.
        if (locked.repositorySkill && input.review === "approved") {
          return { outcome: "repository_skill" };
        }
        const selfReview = row.registeredBy === actor.userId;
        if (selfReview && actor.another) return { outcome: "self_review" };
        const before =
          row.version === null
            ? undefined
            : await currentOf(tx, input.workspaceId, row.name);
        const [updated] = await tx
          .update(extensionBundles)
          .set({
            review: input.review,
            reviewedBy: actor.userId,
            reviewedAt: DB_NOW,
            current: false,
          })
          .where(eq(extensionBundles.id, row.id))
          .returning();
        if (!updated) throw new Error("extension bundle vanished in its tx");
        // The current version moves forward only to a higher approved one;
        // rejecting the current one falls back a step.
        // Undefined: no current version after this; null: unchanged.
        let after: Row | undefined | null = null;
        if (row.version !== null) {
          if (
            input.review === "approved" &&
            (before === undefined || (before.version ?? 0) < row.version)
          ) {
            after = updated;
          } else if (input.review === "rejected" && row.current) {
            after = await previousApproved(
              tx,
              input.workspaceId,
              row.name,
              row.version,
            );
          }
          if (after !== null) {
            await makeCurrent(
              tx,
              input.workspaceId,
              row.name,
              after?.id ?? null,
            );
          }
        }
        const moved = after !== null;
        const superseded =
          input.review === "approved" && row.version !== null
            ? await supersedeBelow(
                tx,
                input.workspaceId,
                row.name,
                row.version,
                actor.userId,
              )
            : [];
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "approve_extension",
          target: { kind: "extension_bundle", id: row.id },
          result: {
            digest: row.digest,
            from: row.review,
            review: input.review,
            ...(selfReview ? { self_review: "sole_manager" } : {}),
            ...(moved
              ? {
                  current: {
                    from: before?.version ?? null,
                    to: after?.version ?? null,
                  },
                }
              : {}),
            ...(superseded.length > 0 ? { superseded } : {}),
          },
        });
        return {
          outcome: "reviewed",
          bundle: bundleOf(await reread(tx, row.id)),
          receiptId: input.receiptId,
          selfReview,
        };
      });
    },

    recordAttachment(input) {
      return db.transaction(async (tx) => {
        const scope = input.scope ?? "agent";
        let agentId: string | null = null;
        let userId: string;
        if (scope === "agent") {
          if (!input.agentId || !UUID.test(input.agentId)) {
            return { outcome: "agent_not_found" };
          }
          // The agent's own managers pass as well as the workspace roles.
          const locked = await lockAgentToChange(
            tx,
            {
              principal: input.principal,
              workspaceId: input.workspaceId,
              managerRoles: input.managerRoles,
            },
            input.agentId.toLowerCase(),
          );
          if ("outcome" in locked) {
            return {
              outcome:
                locked.outcome === "not_found"
                  ? "agent_not_found"
                  : locked.outcome,
            };
          }
          const actorId = input.principal.actor?.userId;
          if (!actorId) return { outcome: "actor_inactive" };
          userId = actorId;
          agentId = locked.agent.id;
        } else {
          const actor = await managerCheck(
            tx,
            input.workspaceId,
            input.principal,
            input.managerRoles,
          );
          if (typeof actor === "string") return { outcome: actor };
          userId = actor.userId;
        }
        if (!UUID.test(input.bundleId)) return { outcome: "bundle_not_found" };
        // FOR SHARE: an archive of this version waits for the attach.
        const [bundle] = await tx
          .select()
          .from(extensionBundles)
          .where(
            and(
              eq(extensionBundles.workspaceId, input.workspaceId),
              eq(extensionBundles.id, input.bundleId.toLowerCase()),
            ),
          )
          .limit(1)
          .for("share");
        if (!bundle) return { outcome: "bundle_not_found" };
        const mode = input.mode ?? "optional";
        const follow = input.follow === true;
        // A bundle from before skills has no current version to follow.
        if (follow && (bundle.version === null || mode === "forbidden")) {
          return { outcome: "bundle_not_found" };
        }
        if (input.kind === "attach") {
          const availability = (
            await repositorySkills(tx, input.workspaceId, bundle.name)
          ).get(bundle.name);
          // Every agent would get it, chosen by no one who sets them up.
          if (scope === "workspace" && availability !== undefined) {
            return { outcome: "repository_skill_workspace" };
          }
          if (
            availability !== undefined &&
            availability !== "ok" &&
            mode !== "forbidden"
          ) {
            return { outcome: "unavailable", availability };
          }
        }
        if (input.kind === "attach" && !follow) {
          if (bundle.archivedAt !== null) return { outcome: "archived" };
          // Forbidding a name needs no approved content behind it.
          if (mode !== "forbidden" && bundle.review !== "approved") {
            return { outcome: "not_approved" };
          }
        }
        const target = and(
          eq(extensionAttachments.workspaceId, input.workspaceId),
          eq(extensionAttachments.scope, scope),
          agentId === null
            ? isNull(extensionAttachments.agentId)
            : eq(extensionAttachments.agentId, agentId),
          eq(extensionAttachments.name, bundle.name),
        );
        // Delete-then-insert alone lets two attaches of one name both pass the
        // delete and collide on the unique index; serialize per target.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`extension_attachments:${input.workspaceId}:${scope}:${agentId ?? ""}:${bundle.name}`}, 0))`,
        );
        if (input.kind === "attach") {
          await tx.delete(extensionAttachments).where(target);
          await tx.insert(extensionAttachments).values({
            id: randomUUID(),
            workspaceId: input.workspaceId,
            scope,
            agentId,
            bundleId: follow ? null : bundle.id,
            follows: follow,
            name: bundle.name,
            mode,
            createdBy: userId,
          });
        } else {
          const removed = await tx
            .delete(extensionAttachments)
            .where(
              and(
                target,
                follow
                  ? eq(extensionAttachments.follows, true)
                  : eq(extensionAttachments.bundleId, bundle.id),
              ),
            )
            .returning({ id: extensionAttachments.id });
          if (removed.length === 0) return { outcome: "not_attached" };
        }
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation:
            input.kind === "attach" ? "attach_extension" : "detach_extension",
          target:
            agentId !== null
              ? { kind: "agent", id: agentId }
              : follow
                ? { kind: "skill", id: bundle.name }
                : { kind: "extension_bundle", id: bundle.id },
          result: follow
            ? {
                name: bundle.name,
                follows: true,
                scope,
                ...(input.kind === "attach" ? { mode } : {}),
              }
            : {
                bundle_id: bundle.id,
                digest: bundle.digest,
                scope,
                ...(input.kind === "attach" ? { mode } : {}),
              },
        });
        return { outcome: "recorded", receiptId: input.receiptId };
      });
    },

    archive(input) {
      return db.transaction(async (tx) => {
        const locked = await lockBundleForManager(tx, input);
        if ("outcome" in locked) return locked;
        const { actor, row } = locked;
        if (row.archivedAt !== null) {
          return { outcome: "unchanged", bundle: bundleOf(row) };
        }
        if (row.registeredBy === actor.userId && actor.another) {
          return { outcome: "self_review" };
        }
        const [attached] = await tx
          .select({ id: extensionAttachments.id })
          .from(extensionAttachments)
          .where(eq(extensionAttachments.bundleId, row.id))
          .limit(1);
        if (attached) return { outcome: "attached" };
        // Following attachments point at it; revert or reject it first.
        if (row.current) return { outcome: "current" };
        if (await liveSessionRuns(tx, input.workspaceId, row.id)) {
          return { outcome: "in_use" };
        }
        const [updated] = await tx
          .update(extensionBundles)
          .set({ archivedAt: DB_NOW, archivedBy: actor.userId })
          .where(eq(extensionBundles.id, row.id))
          .returning();
        if (!updated) throw new Error("extension bundle vanished in its tx");
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "archive_extension",
          target: { kind: "extension_bundle", id: row.id },
          result: {
            name: row.name,
            digest: row.digest,
            ...(row.version === null ? {} : { version: row.version }),
            ...(row.registeredBy === actor.userId
              ? { self_review: "sole_manager" }
              : {}),
          },
        });
        return {
          outcome: "archived",
          bundle: bundleOf(updated),
          receiptId: input.receiptId,
        };
      });
    },

    async listAttachments(input) {
      if (!UUID.test(input.workspaceId)) return [];
      if (input.agentId !== undefined && !UUID.test(input.agentId)) return [];
      const current = alias(extensionBundles, "current_bundle");
      const rows = await db
        .select({
          scope: extensionAttachments.scope,
          mode: extensionAttachments.mode,
          name: extensionAttachments.name,
          follows: extensionAttachments.follows,
          bundle: extensionBundles,
          current,
        })
        .from(extensionAttachments)
        .leftJoin(
          extensionBundles,
          eq(extensionBundles.id, extensionAttachments.bundleId),
        )
        .leftJoin(
          current,
          and(
            eq(extensionAttachments.follows, true),
            eq(current.workspaceId, extensionAttachments.workspaceId),
            eq(current.name, extensionAttachments.name),
            eq(current.current, true),
          ),
        )
        .where(
          and(
            eq(extensionAttachments.workspaceId, input.workspaceId),
            or(
              eq(extensionAttachments.scope, "workspace"),
              input.agentId === undefined
                ? undefined
                : eq(extensionAttachments.agentId, input.agentId),
            ),
          ),
        )
        .orderBy(asc(extensionAttachments.name));
      const skills = await repositorySkills(db, input.workspaceId);
      return rows.map((row) => {
        const bundle = row.follows ? row.current : row.bundle;
        return {
          scope: row.scope as "workspace" | "agent",
          mode: row.mode as ExtensionMode,
          name: row.name,
          follows: row.follows,
          bundle: bundle === null ? null : bundleOf(bundle),
          availability: skills.get(row.name) ?? "ok",
        };
      });
    },

    repositorySkills(workspaceId) {
      return repositorySkills(db, workspaceId);
    },
  };
}

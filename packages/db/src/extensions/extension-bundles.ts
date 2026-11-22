import { randomUUID } from "node:crypto";
import {
  ENDED_SESSION_STATUSES,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  BundleManifest,
  ExtensionBundle,
  ExtensionBundleReview,
  ExtensionBundleSource,
  ExtensionBundleStore,
  ExtensionMode,
  Principal,
  SkillAutoApproval,
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
} from "../schema.ts";
import { writeSucceededReceipt } from "../succeeded-receipt.ts";
import {
  gitVersionJson,
  gitVersionOf,
  lockedManagers,
  lockedSource,
  recordCheckInTx,
} from "./skill-git-sources.ts";

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
            await checked("unchanged", existing.id);
            return {
              outcome: "already_registered",
              bundle: bundleOf(existing),
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
        // Auto-approve: only a version the
        // sync made, only while sync and auto-approve are both still on
        // under the source row's lock, with no settings change since GitHub
        // was read, and only on what GitHub showed.
        const auto =
          synced &&
          source?.syncEnabled === true &&
          source.autoApprove === "on" &&
          git?.protection !== undefined &&
          source.autoApproveGrantId === git.protection.grantId
            ? git.protection.evidence
            : null;
        let autoApproval: SkillAutoApproval | null = null;
        let registered = inserted;
        if (auto !== null && !auto.met) {
          autoApproval = {
            result: "pending",
            reason: auto.reason,
            rule: null,
            pullRequest: null,
          };
        }
        await checked(
          "created",
          inserted.id,
          auto?.met === true
            ? {
                result: "approved",
                reason: null,
                rule: auto.rule,
                pullRequest: auto.pullRequest,
              }
            : autoApproval,
        );
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
        if (auto?.met === true && source && version !== null) {
          await tx
            .update(extensionBundles)
            .set({ review: "approved", reviewedAt: DB_NOW })
            .where(eq(extensionBundles.id, inserted.id));
          const before = await currentOf(tx, input.workspaceId, input.name);
          const advances =
            before === undefined || (before.version ?? 0) < version;
          if (advances) {
            await makeCurrent(tx, input.workspaceId, input.name, inserted.id);
          }
          registered = await reread(tx, inserted.id);
          await writeReceipt(tx, input.principal, {
            id: randomUUID(),
            operation: "approve_extension",
            target: { kind: "extension_bundle", id: inserted.id },
            result: {
              digest: inserted.digest,
              from: "pending",
              review: "approved",
              by: "sync",
              auto_approve: {
                requested_by: source.autoApproveRequestedBy,
                consented_by: source.autoApproveConsentedBy,
              },
              commit: git?.location.commit,
              pull_request: auto.pullRequest,
              rule: {
                kind: auto.rule.kind,
                required_reviews: auto.rule.requiredReviews,
              },
              ...(advances
                ? { current: { from: before?.version ?? null, to: version } }
                : {}),
            },
          });
        }
        return {
          outcome: "registered",
          bundle: bundleOf(registered),
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
        await lockSkill(tx, input.workspaceId, input.name);
        const [any] = await tx
          .select({ id: extensionBundles.id })
          .from(extensionBundles)
          .where(ofSkill(input.workspaceId, input.name))
          .limit(1);
        if (!any) return { outcome: "not_found" };
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
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "revert_extension",
          target: { kind: "extension_bundle", id: to.id },
          result: {
            name: input.name,
            from: { id: from.id, version: from.version, digest: from.digest },
            to: { id: to.id, version: to.version, digest: to.digest },
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
        if (found.version !== null) {
          await lockSkill(tx, input.workspaceId, found.name);
        }
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
        if (row.archivedAt !== null) return { outcome: "archived" };
        if (row.review === input.review) {
          return { outcome: "unchanged", bundle: bundleOf(row) };
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
        if (found.version !== null) {
          await lockSkill(tx, input.workspaceId, found.name);
        }
        // FOR UPDATE: an attach of this version holds it FOR SHARE.
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
      return rows.map((row) => {
        const bundle = row.follows ? row.current : row.bundle;
        return {
          scope: row.scope as "workspace" | "agent",
          mode: row.mode as ExtensionMode,
          name: row.name,
          follows: row.follows,
          bundle: bundle === null ? null : bundleOf(bundle),
        };
      });
    },
  };
}

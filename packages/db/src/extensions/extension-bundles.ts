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
import { lockAgentToChange } from "../agents.ts";
import { UUID } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import { lockedRole } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import {
  extensionAttachments,
  extensionBundles,
  memberships,
  sessions,
  users,
} from "../schema.ts";
import { writeSucceededReceipt } from "../succeeded-receipt.ts";

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
    registeredAt: row.registeredAt,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    version: row.version,
    archivedAt: row.archivedAt,
  };
}

/**
 * Whether a manager other than the registrant could act instead (decision
 * skills-and-mcp.md 3). The managers' rows are held FOR SHARE, so none of
 * them loses the role before this transaction commits.
 */
async function anotherManager(
  tx: Database,
  workspaceId: string,
  userId: string,
  roles: readonly WorkspaceRole[],
): Promise<boolean> {
  const rows = await tx
    .select({ userId: memberships.userId })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        inArray(memberships.role, [...roles]),
        isNull(memberships.disabledAt),
        isNull(users.disabledAt),
      ),
    )
    .for("share", { of: memberships });
  return rows.some((row) => row.userId !== userId);
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
): Promise<{ userId: string } | "actor_inactive" | "outranked"> {
  const userId = principal.actor?.userId;
  if (!userId) return "actor_inactive";
  const role = await lockedRole(tx, workspaceId, userId);
  if (role === null) return "actor_inactive";
  return roles.includes(role) ? { userId } : "outranked";
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
      | "archive_extension";
    target: { kind: "extension_bundle" | "agent"; id: string };
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
        const actor = await managerCheck(
          tx,
          input.workspaceId,
          input.principal,
          input.managerRoles,
        );
        if (typeof actor === "string") return { outcome: actor };
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
          // content cannot both take the same next version.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`extension_bundles:${input.workspaceId}:${input.name}`}, 0))`,
          );
          const existing = await sameDigest();
          if (existing) {
            return {
              outcome: "already_registered",
              bundle: bundleOf(existing),
            };
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
          version =
            Math.max(0, ...named.map((row) => row.version as number)) + 1;
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
            registeredBy: actor.userId,
            version,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) {
          const existing = await sameDigest();
          if (!existing) throw new Error("extension bundle vanished in its tx");
          return { outcome: "already_registered", bundle: bundleOf(existing) };
        }
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
          },
        });
        return {
          outcome: "registered",
          bundle: bundleOf(inserted),
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
        );
        if (typeof actor === "string") return { outcome: actor };
        if (!UUID.test(input.bundleId)) return { outcome: "not_found" };
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
        if (
          selfReview &&
          (await anotherManager(
            tx,
            input.workspaceId,
            actor.userId,
            input.managerRoles,
          ))
        ) {
          return { outcome: "self_review" };
        }
        const [updated] = await tx
          .update(extensionBundles)
          .set({
            review: input.review,
            reviewedBy: actor.userId,
            reviewedAt: DB_NOW,
          })
          .where(eq(extensionBundles.id, row.id))
          .returning();
        if (!updated) throw new Error("extension bundle vanished in its tx");
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "approve_extension",
          target: { kind: "extension_bundle", id: row.id },
          result: {
            digest: row.digest,
            from: row.review,
            review: input.review,
            ...(selfReview ? { self_review: "sole_manager" } : {}),
          },
        });
        return {
          outcome: "reviewed",
          bundle: bundleOf(updated),
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
        if (input.kind === "attach") {
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
            bundleId: bundle.id,
            name: bundle.name,
            mode,
            createdBy: userId,
          });
        } else {
          const removed = await tx
            .delete(extensionAttachments)
            .where(and(target, eq(extensionAttachments.bundleId, bundle.id)))
            .returning({ id: extensionAttachments.id });
          if (removed.length === 0) return { outcome: "not_attached" };
        }
        await writeReceipt(tx, input.principal, {
          id: input.receiptId,
          operation:
            input.kind === "attach" ? "attach_extension" : "detach_extension",
          target:
            agentId === null
              ? { kind: "extension_bundle", id: bundle.id }
              : { kind: "agent", id: agentId },
          result: {
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
        );
        if (typeof actor === "string") return { outcome: actor };
        if (!UUID.test(input.bundleId)) return { outcome: "not_found" };
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
        if (
          row.registeredBy === actor.userId &&
          (await anotherManager(
            tx,
            input.workspaceId,
            actor.userId,
            input.managerRoles,
          ))
        ) {
          return { outcome: "self_review" };
        }
        const [attached] = await tx
          .select({ id: extensionAttachments.id })
          .from(extensionAttachments)
          .where(eq(extensionAttachments.bundleId, row.id))
          .limit(1);
        if (attached) return { outcome: "attached" };
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
      const rows = await db
        .select({
          scope: extensionAttachments.scope,
          mode: extensionAttachments.mode,
          bundle: extensionBundles,
        })
        .from(extensionAttachments)
        .innerJoin(
          extensionBundles,
          eq(extensionBundles.id, extensionAttachments.bundleId),
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
      return rows.map((row) => ({
        scope: row.scope as "workspace" | "agent",
        mode: row.mode as ExtensionMode,
        bundle: bundleOf(row.bundle),
      }));
    },
  };
}

import { randomUUID } from "node:crypto";
import type { WorkspaceRole } from "@werft-ai/contracts";
import type {
  BundleManifest,
  ExtensionBundle,
  ExtensionBundleReview,
  ExtensionBundleSource,
  ExtensionBundleStore,
  ExtensionMode,
  Principal,
} from "@werft-ai/platform";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { receiptActorOf } from "../control-shared.ts";
import { DB_NOW } from "../db-clock.ts";
import { lockedRole } from "../musterrolle/api-keys.ts";
import type { Database } from "../queries.ts";
import {
  agents,
  extensionAttachments,
  extensionBundles,
  receipts,
} from "../schema.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  };
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
      | "detach_extension";
    target: { kind: "extension_bundle" | "agent"; id: string };
    result: Record<string, unknown>;
  },
) {
  await tx.insert(receipts).values({
    id: input.id,
    ownerId: principal.ownerId,
    actor: receiptActorOf(principal),
    requestId: principal.requestId ?? null,
    operation: input.operation,
    targetRef: { resource: input.target, workspace_id: principal.ownerId },
    status: "succeeded",
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
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) {
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
        if (row.review === input.review) {
          return { outcome: "unchanged", bundle: bundleOf(row) };
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
          },
        });
        return {
          outcome: "reviewed",
          bundle: bundleOf(updated),
          receiptId: input.receiptId,
        };
      });
    },

    recordAttachment(input) {
      return db.transaction(async (tx) => {
        const actor = await managerCheck(
          tx,
          input.workspaceId,
          input.principal,
          input.managerRoles,
        );
        if (typeof actor === "string") return { outcome: actor };
        const bundle = await byId(tx, input.workspaceId, input.bundleId);
        if (!bundle) return { outcome: "bundle_not_found" };
        const scope = input.scope ?? "agent";
        let agentId: string | null = null;
        if (scope === "agent") {
          if (!input.agentId || !UUID.test(input.agentId)) {
            return { outcome: "agent_not_found" };
          }
          const [agent] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.id, input.agentId.toLowerCase()),
                eq(agents.workspaceId, input.workspaceId),
              ),
            )
            .limit(1)
            .for("key share");
          if (!agent) return { outcome: "agent_not_found" };
          agentId = agent.id;
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
            mode: input.mode ?? "optional",
            createdBy: actor.userId,
          });
        } else {
          await tx
            .delete(extensionAttachments)
            .where(and(target, eq(extensionAttachments.bundleId, bundle.id)));
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
            ...(input.kind === "attach"
              ? { mode: input.mode ?? "optional" }
              : {}),
          },
        });
        return { outcome: "recorded", receiptId: input.receiptId };
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

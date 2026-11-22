import { randomUUID } from "node:crypto";
import {
  SKILL_AUTO_APPROVAL_REASON_VALUES,
  SKILL_SYNC_RESULT_VALUES,
  SKILL_SYNC_TRIGGER_VALUES,
  type SkillAutoApprovalReason,
  type SkillSyncResult,
  type SkillSyncTriggerKind,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  SkillAutoApproval,
  SkillAutoApproveState,
  SkillGitLocation,
  SkillGitSource,
  SkillGitSourceStore,
  SkillSyncCheck,
  SkillSyncTrigger,
} from "@werft-ai/platform";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { lockActorAccount } from "../control-shared.ts";
import { DB_NOW, fromDbNow } from "../db-clock.ts";
import { lockedRole } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import { memberships, skillGitSources, users } from "../schema.ts";
import { writeSucceededReceipt } from "../succeeded-receipt.ts";

type Row = typeof skillGitSources.$inferSelect;

/** A 40-character commit never moves, so it is never synced. */
const COMMIT_REF = "^[0-9a-f]{40}$";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};

export function triggerJson(trigger: SkillSyncTrigger) {
  return {
    kind: trigger.kind,
    delivery_id: trigger.deliveryId,
    user_id: trigger.userId,
  };
}

export function triggerOf(value: unknown): SkillSyncTrigger {
  const json = record(value);
  const kind = (SKILL_SYNC_TRIGGER_VALUES as readonly string[]).includes(
    String(json.kind),
  )
    ? (json.kind as SkillSyncTriggerKind)
    : "daily";
  return {
    kind,
    deliveryId: typeof json.delivery_id === "string" ? json.delivery_id : null,
    userId: typeof json.user_id === "string" ? json.user_id : null,
  };
}

export function gitVersionJson(
  location: SkillGitLocation,
  trigger: SkillSyncTrigger,
) {
  return {
    repository_id: location.repositoryId,
    path: location.path,
    ref: location.ref,
    commit: location.commit,
    trigger: triggerJson(trigger),
  };
}

export function gitVersionOf(
  value: unknown,
): (SkillGitLocation & { trigger: SkillSyncTrigger }) | null {
  if (value === null || value === undefined) return null;
  const json = record(value);
  return {
    repositoryId: Number(json.repository_id),
    path: String(json.path ?? ""),
    ref: String(json.ref ?? ""),
    commit: String(json.commit ?? ""),
    trigger: triggerOf(json.trigger),
  };
}

export function checkJson(check: SkillSyncCheck) {
  const auto = check.autoApproval;
  return {
    at: check.at.toISOString(),
    trigger: triggerJson(check.trigger),
    commit: check.commit,
    result: check.result,
    version_id: check.versionId,
    issues: check.issues,
    auto_approval:
      auto === null
        ? null
        : {
            result: auto.result,
            reason: auto.reason,
            rule:
              auto.rule === null
                ? null
                : {
                    kind: auto.rule.kind,
                    required_reviews: auto.rule.requiredReviews,
                  },
            pull_request: auto.pullRequest,
          },
  };
}

function autoApprovalOf(value: unknown): SkillAutoApproval | null {
  if (value === null || value === undefined) return null;
  const json = record(value);
  const rule = json.rule === null ? null : record(json.rule);
  const reason = (
    SKILL_AUTO_APPROVAL_REASON_VALUES as readonly unknown[]
  ).includes(json.reason)
    ? (json.reason as SkillAutoApprovalReason)
    : null;
  return {
    result: json.result === "approved" ? "approved" : "pending",
    reason,
    rule:
      rule === null
        ? null
        : {
            kind:
              rule.kind === "branch_protection"
                ? "branch_protection"
                : "ruleset",
            requiredReviews: Number(rule.required_reviews ?? 0),
          },
    pullRequest:
      typeof json.pull_request === "number" ? json.pull_request : null,
  };
}

function checkOf(value: unknown): SkillSyncCheck | null {
  if (value === null || value === undefined) return null;
  const json = record(value);
  const result = (SKILL_SYNC_RESULT_VALUES as readonly string[]).includes(
    String(json.result),
  )
    ? (json.result as SkillSyncResult)
    : "github_unavailable";
  return {
    at: new Date(String(json.at)),
    trigger: triggerOf(json.trigger),
    commit: typeof json.commit === "string" ? json.commit : null,
    result,
    versionId: typeof json.version_id === "string" ? json.version_id : null,
    issues: Array.isArray(json.issues)
      ? json.issues.map((issue) => {
          const one = record(issue);
          return {
            path: String(one.path ?? ""),
            code: String(one.code ?? ""),
            message: String(one.message ?? ""),
          };
        })
      : [],
    autoApproval: autoApprovalOf(json.auto_approval),
  };
}

export function sourceOf(row: Row): SkillGitSource {
  return {
    workspaceId: row.workspaceId,
    name: row.name,
    connectionId: row.connectionId,
    installationId: row.installationId,
    repositoryId: row.repositoryId,
    repository: row.repository,
    path: row.path,
    ref: row.ref,
    syncEnabled: row.syncEnabled,
    autoApprove: {
      state: row.autoApprove as SkillAutoApproveState["state"],
      requestedBy: row.autoApproveRequestedBy,
      consentedBy: row.autoApproveConsentedBy,
      grantId: row.autoApproveGrantId,
    },
    lastCheck: checkOf(row.lastCheck),
  };
}

/**
 * Which kept trigger a new one may replace: a person's check is not turned
 * into a webhook's, which a pause would then skip.
 */
const RANK: Record<SkillSyncTriggerKind, number> = {
  daily: 0,
  webhook: 0,
  register: 1,
  resume: 1,
  manual: 2,
};

const keptOf = (value: unknown): SkillSyncTrigger | null =>
  value === null || value === undefined ? null : triggerOf(value);

const byName = (workspaceId: string, name: string) =>
  and(
    eq(skillGitSources.workspaceId, workspaceId),
    eq(skillGitSources.name, name),
  );

/** The source row under its lock, for a write that reads its settings again. */
export async function lockedSource(
  tx: Database,
  workspaceId: string,
  name: string,
): Promise<Row | undefined> {
  const [row] = await tx
    .select()
    .from(skillGitSources)
    .where(byName(workspaceId, name))
    .limit(1)
    .for("update");
  return row;
}

/**
 * The actor's live role, and whether another live manager exists. The actor's user row, then the memberships of the
 * actor and of every manager in user_id order, as a suspension and a role
 * change take them, so the "only manager" rule queues behind those instead
 * of deadlocking them; none of them loses the role before this commits.
 */
export async function lockedManagers(
  tx: Database,
  workspaceId: string,
  userId: string,
  roles: readonly WorkspaceRole[],
): Promise<{ role: WorkspaceRole | null; another: boolean }> {
  await lockActorAccount(tx, userId);
  const rows = await tx
    .select({
      userId: memberships.userId,
      role: memberships.role,
      live: sql<boolean>`${memberships.disabledAt} is null and ${users.disabledAt} is null`,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(
      and(
        eq(memberships.workspaceId, workspaceId),
        or(
          eq(memberships.userId, userId),
          inArray(memberships.role, [...roles]),
        ),
      ),
    )
    .orderBy(asc(memberships.userId))
    .for("share", { of: memberships });
  const mine = rows.find((row) => row.userId === userId && row.live);
  return {
    role: (mine?.role as WorkspaceRole | undefined) ?? null,
    another: rows.some(
      (row) =>
        row.userId !== userId &&
        row.live &&
        roles.includes(row.role as WorkspaceRole),
    ),
  };
}

export async function recordCheckInTx(
  tx: Database,
  workspaceId: string,
  name: string,
  check: SkillSyncCheck,
): Promise<void> {
  await tx
    .update(skillGitSources)
    .set({
      lastCheck: checkJson(check),
      lastCheckedAt: check.at,
      updatedAt: DB_NOW,
    })
    .where(byName(workspaceId, name));
}

export function createPostgresSkillGitSourceStore(
  db: Database,
): SkillGitSourceStore {
  return {
    async get(workspaceId, name) {
      const [row] = await db
        .select()
        .from(skillGitSources)
        .where(byName(workspaceId, name))
        .limit(1);
      return row ? sourceOf(row) : null;
    },

    async list(workspaceId) {
      const rows = await db
        .select()
        .from(skillGitSources)
        .where(eq(skillGitSources.workspaceId, workspaceId))
        .orderBy(asc(skillGitSources.name));
      return rows.map(sourceOf);
    },

    async matching(input) {
      if (input.connectionIds.length === 0) return [];
      const rows = await db
        .select()
        .from(skillGitSources)
        .where(
          and(
            inArray(skillGitSources.connectionId, [...input.connectionIds]),
            eq(skillGitSources.installationId, input.installationId),
            eq(skillGitSources.repositoryId, input.repositoryId),
            eq(skillGitSources.syncEnabled, true),
            sql`${skillGitSources.ref} !~ ${COMMIT_REF}`,
            or(
              eq(skillGitSources.ref, input.ref),
              and(
                sql`${skillGitSources.ref} NOT LIKE 'refs/%'`,
                or(
                  sql`'refs/heads/' || ${skillGitSources.ref} = ${input.ref}`,
                  sql`'refs/tags/' || ${skillGitSources.ref} = ${input.ref}`,
                ),
              ),
            ),
          ),
        );
      return rows.map(sourceOf);
    },

    async due(before, limit, claimMs) {
      // Claimed by moving the last check to `claimMs` past `before`, so
      // another replica's daily pass does not pick the same source and one
      // that died before checking it lets it go then; a check overwrites it.
      const claimed = new Date(before.getTime() + claimMs);
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            workspaceId: skillGitSources.workspaceId,
            name: skillGitSources.name,
          })
          .from(skillGitSources)
          .where(
            and(
              eq(skillGitSources.syncEnabled, true),
              sql`${skillGitSources.ref} !~ ${COMMIT_REF}`,
              or(
                isNull(skillGitSources.lastCheckedAt),
                lt(skillGitSources.lastCheckedAt, before),
              ),
            ),
          )
          .orderBy(sql`${skillGitSources.lastCheckedAt} ASC NULLS FIRST`)
          .limit(limit)
          .for("update", { skipLocked: true });
        for (const row of rows) {
          await tx
            .update(skillGitSources)
            .set({ lastCheckedAt: claimed })
            .where(byName(row.workspaceId, row.name));
        }
        return rows;
      });
    },

    begin(workspaceId, name, trigger, leaseMs) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            busy: sql<boolean>`${skillGitSources.checkingUntil} IS NOT NULL AND ${skillGitSources.checkingUntil} > clock_timestamp()`,
            again: skillGitSources.checkAgain,
          })
          .from(skillGitSources)
          .where(byName(workspaceId, name))
          .limit(1)
          .for("update");
        if (!row) return { outcome: "not_found" as const };
        if (row.busy) {
          const kept = keptOf(row.again);
          if (kept === null || RANK[trigger.kind] >= RANK[kept.kind]) {
            await tx
              .update(skillGitSources)
              .set({ checkAgain: triggerJson(trigger) })
              .where(byName(workspaceId, name));
          }
          return { outcome: "queued" as const };
        }
        // A trigger kept for a check whose replica died stays, so the new
        // holder runs it once more.
        const token = randomUUID();
        await tx
          .update(skillGitSources)
          .set({ checkingUntil: fromDbNow(leaseMs), checkingToken: token })
          .where(byName(workspaceId, name));
        return { outcome: "started" as const, token };
      });
    },

    finish(workspaceId, name, leaseMs, token) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            again: skillGitSources.checkAgain,
            token: skillGitSources.checkingToken,
          })
          .from(skillGitSources)
          .where(byName(workspaceId, name))
          .limit(1)
          .for("update");
        if (!row || row.token !== token) return null;
        const again = keptOf(row.again);
        await tx
          .update(skillGitSources)
          .set({
            checkingUntil: again === null ? null : fromDbNow(leaseMs),
            checkingToken: again === null ? null : token,
            checkAgain: null,
          })
          .where(byName(workspaceId, name));
        return again;
      });
    },

    async recordCheck(workspaceId, name, check, token) {
      await db
        .update(skillGitSources)
        .set({
          lastCheck: checkJson(check),
          lastCheckedAt: check.at,
          updatedAt: DB_NOW,
        })
        .where(
          and(
            byName(workspaceId, name),
            eq(skillGitSources.checkingToken, token),
          ),
        );
    },

    setEnabled(input) {
      return db.transaction(async (tx) => {
        const userId = input.principal.actor?.userId;
        if (!userId) return { outcome: "actor_inactive" };
        const role = await lockedRole(tx, input.workspaceId, userId);
        if (role === null) return { outcome: "actor_inactive" };
        if (!input.managerRoles.includes(role)) return { outcome: "outranked" };
        const row = await lockedSource(tx, input.workspaceId, input.name);
        if (!row) return { outcome: "not_found" };
        if (row.syncEnabled === input.enabled) {
          return { outcome: "unchanged", source: sourceOf(row) };
        }
        const [updated] = await tx
          .update(skillGitSources)
          .set({
            syncEnabled: input.enabled,
            // A check that read GitHub before this approves nothing.
            ...(row.autoApprove === "on"
              ? { autoApproveGrantId: input.receiptId }
              : {}),
            updatedAt: DB_NOW,
          })
          .where(byName(input.workspaceId, input.name))
          .returning();
        if (!updated) throw new Error("skill git source vanished in its tx");
        await writeSucceededReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "update_extension_sync",
          resource: { kind: "skill", id: input.name },
          workspaceId: input.workspaceId,
          result: {
            name: input.name,
            action: input.enabled ? "resume" : "pause",
          },
        });
        return {
          outcome: "updated",
          source: sourceOf(updated),
          receiptId: input.receiptId,
        };
      });
    },

    setAutoApprove(input) {
      return db.transaction(async (tx) => {
        const userId = input.principal.actor?.userId;
        if (!userId) return { outcome: "actor_inactive" };
        const { role, another } = await lockedManagers(
          tx,
          input.workspaceId,
          userId,
          input.managerRoles,
        );
        if (role === null) return { outcome: "actor_inactive" };
        if (!input.managerRoles.includes(role)) return { outcome: "outranked" };
        const row = await lockedSource(tx, input.workspaceId, input.name);
        if (!row) return { outcome: "not_found" };
        let set: Partial<typeof skillGitSources.$inferInsert>;
        let selfConsent = false;
        switch (input.action) {
          case "off":
            if (row.autoApprove === "off") {
              return { outcome: "unchanged", source: sourceOf(row) };
            }
            set = {
              autoApprove: "off",
              autoApproveRequestedBy: null,
              autoApproveConsentedBy: null,
              autoApproveGrantId: null,
            };
            break;
          case "request":
            if (row.autoApprove !== "off") {
              return { outcome: "unchanged", source: sourceOf(row) };
            }
            set = { autoApprove: "requested", autoApproveRequestedBy: userId };
            break;
          case "consent":
            if (row.autoApprove === "on") {
              return { outcome: "unchanged", source: sourceOf(row) };
            }
            if (row.autoApprove !== "requested") {
              return { outcome: "not_requested" };
            }
            // The same rule as a version's review: another manager consents,
            // unless the requester is the workspace's only one.
            selfConsent = row.autoApproveRequestedBy === userId;
            if (selfConsent && another) return { outcome: "self_consent" };
            set = {
              autoApprove: "on",
              autoApproveConsentedBy: userId,
              autoApproveGrantId: input.receiptId,
            };
            break;
        }
        const [updated] = await tx
          .update(skillGitSources)
          .set({ ...set, updatedAt: DB_NOW })
          .where(byName(input.workspaceId, input.name))
          .returning();
        if (!updated) throw new Error("skill git source vanished in its tx");
        await writeSucceededReceipt(tx, input.principal, {
          id: input.receiptId,
          operation: "update_extension_sync",
          resource: { kind: "skill", id: input.name },
          workspaceId: input.workspaceId,
          result: {
            name: input.name,
            action: `auto_approve_${input.action}`,
            ...(input.action === "consent"
              ? { requested_by: row.autoApproveRequestedBy }
              : {}),
            ...(selfConsent ? { self_consent: "sole_manager" } : {}),
          },
        });
        return {
          outcome: "updated",
          source: sourceOf(updated),
          receiptId: input.receiptId,
        };
      });
    },
  };
}

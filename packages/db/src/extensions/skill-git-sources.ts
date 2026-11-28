import { randomUUID } from "node:crypto";
import {
  SKILL_AUTO_APPROVAL_REASON_VALUES,
  SKILL_CHECK_RULE_VALUES,
  SKILL_SYNC_RESULT_VALUES,
  SKILL_SYNC_TRIGGER_VALUES,
  type SkillAutoApprovalReason,
  type SkillCheckFinding,
  type SkillCheckRule,
  type SkillSyncResult,
  type SkillSyncTriggerKind,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import type {
  SkillAutoApproval,
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
            checks: auto.checks,
          },
  };
}

function autoApprovalOf(value: unknown): SkillAutoApproval | null {
  if (value === null || value === undefined) return null;
  const json = record(value);
  // A reason from before the fixed-rule checks decided alone reads as none.
  const reason = (
    SKILL_AUTO_APPROVAL_REASON_VALUES as readonly unknown[]
  ).includes(json.reason)
    ? (json.reason as SkillAutoApprovalReason)
    : null;
  return {
    result: json.result === "approved" ? "approved" : "pending",
    reason,
    checks: checksOf(json.checks),
  };
}

/** A check written before the fixed-rule checks has none. */
function checksOf(value: unknown): SkillCheckFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const json = record(entry);
    if (!(SKILL_CHECK_RULE_VALUES as readonly unknown[]).includes(json.rule)) {
      return [];
    }
    const texts = (list: unknown) =>
      Array.isArray(list)
        ? list.filter((item) => typeof item === "string")
        : [];
    return [
      {
        rule: json.rule as SkillCheckRule,
        paths: texts(json.paths),
        samples: texts(json.samples),
      },
    ];
  });
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

/**
 * On under the rule of today, approval on the fixed-rule checks alone: the
 * grant is one this host wrote, twice. A host from before, running beside
 * this one or after a rollback, turns it on by request and consent and
 * writes the grant once. That was consent to another rule, so it reads as
 * off.
 */
export const autoApproveOn = (
  row: Pick<
    Row,
    "autoApprove" | "autoApproveGrantId" | "autoApproveChecksGrantId"
  >,
): boolean =>
  row.autoApprove === "on" &&
  row.autoApproveGrantId !== null &&
  row.autoApproveChecksGrantId === row.autoApproveGrantId;

export function sourceOf(row: Row): SkillGitSource {
  const on = autoApproveOn(row);
  return {
    workspaceId: row.workspaceId,
    name: row.name,
    connectionId: row.connectionId,
    installationId: row.installationId,
    access: row.access === "public" ? "public" : "installation",
    repositoryId: row.repositoryId,
    repository: row.repository,
    path: row.path,
    ref: row.ref,
    syncEnabled: row.syncEnabled,
    repositorySourceId: row.repositorySourceId,
    autoApprove: {
      state: on ? "on" : "off",
      enabledBy: on ? row.autoApproveConsentedBy : null,
      grantId: on ? row.autoApproveGrantId : null,
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
  auto_approve: 1,
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
            isNull(skillGitSources.repositorySourceId),
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
              // A registered repository's skill is checked by its
              // repository's pass, never by this one.
              isNull(skillGitSources.repositorySourceId),
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
            repositorySourceId: skillGitSources.repositorySourceId,
          })
          .from(skillGitSources)
          .where(byName(workspaceId, name))
          .limit(1)
          .for("update");
        if (!row) return { outcome: "not_found" as const };
        // Its repository's pass checks it, under the repository's lease.
        if (row.repositorySourceId !== null) {
          return { outcome: "repository_skill" as const };
        }
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
      const written = await db
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
        )
        .returning({ name: skillGitSources.name });
      return written.length > 0;
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
        // Sync stays off for a registered repository's skill: the column is
        // what keeps a host from before repositories away from it.
        if (row.repositorySourceId !== null) {
          return { outcome: "repository_skill" };
        }
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
            ...(autoApproveOn(row)
              ? { autoApproveChecksGrantId: input.receiptId }
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
        const role = await lockedRole(tx, input.workspaceId, userId);
        if (role === null) return { outcome: "actor_inactive" };
        if (!input.managerRoles.includes(role)) return { outcome: "outranked" };
        const row = await lockedSource(tx, input.workspaceId, input.name);
        if (!row) return { outcome: "not_found" };
        if (row.repositorySourceId !== null) {
          return { outcome: "repository_skill" };
        }
        // What the two-manager flow left is cleared by off and replaced by on.
        if (
          input.action === "on" ? autoApproveOn(row) : row.autoApprove === "off"
        ) {
          return { outcome: "unchanged", source: sourceOf(row) };
        }
        const by = input.action === "on" ? userId : null;
        const [updated] = await tx
          .update(skillGitSources)
          .set({
            autoApprove: input.action,
            // The table's check wants both while on; one manager is both.
            autoApproveRequestedBy: by,
            autoApproveConsentedBy: by,
            autoApproveGrantId: input.action === "on" ? input.receiptId : null,
            autoApproveChecksGrantId:
              input.action === "on" ? input.receiptId : null,
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
            action: `auto_approve_${input.action}`,
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

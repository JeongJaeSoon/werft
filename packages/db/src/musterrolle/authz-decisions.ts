import {
  AUDIT_RETENTION_DEFAULT_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
  type AuthorizationReason,
  auditRetentionDaysSchema,
} from "@werft-ai/contracts";
import type {
  AuditRetentionStore,
  DecisionEntry,
  DecisionLog,
  RefusalOf,
  UnrecordedAllow,
} from "@werft-ai/platform";
import { and, eq, isNull, sql } from "drizzle-orm";
import { lockActorAccount } from "../control-shared.ts";
import type { Database } from "../queries.ts";
import {
  authzDecisions,
  memberships,
  type toolCallAudits,
  users,
  workspaces,
} from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";

function decisionRow({ request, decision }: DecisionEntry) {
  const { subject, resource } = request;
  return {
    id: decision.decision_id,
    ownerId: resource.owner_scope,
    workspaceId: subject.principal?.workspace_id ?? null,
    principalKind: subject.principal?.kind ?? null,
    principalId: subject.principal?.id ?? null,
    actorUserId: subject.actor_user_id ?? null,
    agentId: subject.agent?.agent_id ?? null,
    agentReleaseId: subject.agent?.release_id ?? null,
    linkedAccountId: subject.linked_account?.id ?? null,
    linkedAccountRevision: subject.linked_account?.revision ?? null,
    surface: subject.surface,
    action: request.action,
    resourceKind: resource.kind,
    resourceId: resource.id,
    outcome: decision.outcome,
    reasonCode: decision.reason_code,
    justification: subject.justification ?? null,
    policyVersion: decision.policy_version,
    requestId: request.request_id,
  };
}

export function createPostgresDecisionLog(db: Database): DecisionLog {
  return {
    async record(entry) {
      await db.insert(authzDecisions).values(decisionRow(entry));
    },
  };
}

function denied(allowed: UnrecordedAllow, reason: AuthorizationReason) {
  const { decision } = allowed;
  return decisionRow({
    request: allowed.request,
    decision: {
      outcome: "deny",
      reason_code: reason,
      effective_scopes: [],
      policy_version: decision.policy_version,
      decision_id: decision.decision_id,
    },
  });
}

/**
 * Runs a store's body in a transaction that also keeps the request's one
 * decision row: the allow, or a deny for the rule `refusalOf` reads in the
 * outcome. The row commits with the change or not at all, so no refusal
 * decided under the store's locks is left on record as an allow. A throw
 * leaves the request a deny `error` instead, written after the rollback.
 */
export function decidedTransaction<Result extends { outcome: string }>(
  db: Database,
  allowed: UnrecordedAllow,
  refusalOf: RefusalOf<Result["outcome"]>,
): (body: (tx: Database) => Promise<Result>) => Promise<Result> {
  if (allowed.decision.outcome !== "allow") {
    throw new Error("only an allow is left for the store to keep");
  }
  return async (body) => {
    try {
      return await db.transaction(async (tx) => {
        const result = await body(tx);
        const reason = refusalOf(result.outcome);
        await tx
          .insert(authzDecisions)
          .values(
            reason === null ? decisionRow(allowed) : denied(allowed, reason),
          );
        return result;
      });
    } catch (error) {
      // A commit whose answer was lost may have kept its row; the same
      // decision id keeps this one from being a second. When storage is
      // down this fails too, and the request's own error is what surfaces.
      await db
        .insert(authzDecisions)
        .values(denied(allowed, "error"))
        .onConflictDoNothing({ target: authzDecisions.id })
        .catch(() => undefined);
      throw error;
    }
  };
}

export function createPostgresAuditRetention(
  db: Database,
): AuditRetentionStore {
  return {
    async setAuditRetentionDays({ workspaceId, ownerUserId, days }) {
      // A value the settings schema refuses would break every later read.
      auditRetentionDaysSchema.parse(days);
      // Same lock as offboarding takes, so an owner disabled mid-request
      // cannot still write the setting.
      return db.transaction(async (tx) => {
        await lockActorAccount(tx, ownerUserId);
        const owner = await tx
          .select({ userId: memberships.userId })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.workspaceId, workspaceId),
              eq(memberships.userId, ownerUserId),
              eq(memberships.role, "owner"),
              isNull(memberships.disabledAt),
              isNull(users.disabledAt),
            ),
          )
          .limit(1)
          .for("share", { of: memberships });
        if (owner.length === 0) return false;
        const rows = await tx
          .update(workspaces)
          .set({
            settings: sql`jsonb_set(${workspaces.settings}, '{audit_retention_days}', to_jsonb(${days}::int))`,
          })
          .where(eq(workspaces.id, workspaceId))
          .returning({ id: workspaces.id });
        return rows.length > 0;
      });
    },
  };
}

export function expireAuthzDecisions(
  db: Database,
  input: { limit: number; dryRun: boolean },
): Promise<number> {
  return expireByAuditRetention(db, authzDecisions, input);
}

export async function expireByAuditRetention(
  db: Database,
  table: typeof authzDecisions | typeof toolCallAudits,
  input: { limit: number; dryRun: boolean },
): Promise<number> {
  const expired = sql`
    SELECT d.id FROM ${table} d
    LEFT JOIN ${workspaces} w ON w.id = d.workspace_id
    WHERE d.at < statement_timestamp() - make_interval(days => ${AUDIT_RETENTION_MIN_DAYS}::int)
      AND d.at < statement_timestamp() - make_interval(days => greatest(
      ${AUDIT_RETENTION_MIN_DAYS}::int,
      coalesce(
        CASE WHEN jsonb_typeof(w.settings -> 'audit_retention_days') = 'number'
          THEN floor((w.settings ->> 'audit_retention_days')::numeric)::int END,
        ${AUDIT_RETENTION_DEFAULT_DAYS}::int
      )
    ))
    ORDER BY d.at
    LIMIT ${input.limit}`;
  const result = await db.execute<{ id: string }>(
    input.dryRun
      ? expired
      : sql`DELETE FROM ${table} WHERE id IN (${expired} FOR UPDATE OF d SKIP LOCKED) RETURNING id`,
  );
  return rowsOf<{ id: string }>(result).length;
}

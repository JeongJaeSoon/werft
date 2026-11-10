import {
  AUDIT_RETENTION_DEFAULT_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
  auditRetentionDaysSchema,
} from "@werft-ai/contracts";
import type { AuditRetentionStore, DecisionLog } from "@werft-ai/platform";
import { and, eq, isNull, sql } from "drizzle-orm";
import { lockActorAccount } from "./control-shared.ts";
import { rowsOf } from "./control-unit-of-work.ts";
import type { Database } from "./queries.ts";
import {
  authzDecisions,
  memberships,
  type toolCallAudits,
  users,
  workspaces,
} from "./schema.ts";

export function createPostgresDecisionLog(db: Database): DecisionLog {
  return {
    async record({ request, decision }) {
      const { subject, resource } = request;
      await db.insert(authzDecisions).values({
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
      });
    },
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

/**
 * Deletes the oldest rows of an audit table past their workspace's
 * `audit_retention_days`, a batch at a time. The one retention rule for every
 * table that follows it, so there is one setting to explain.
 */
export async function expireByAuditRetention(
  db: Database,
  table: typeof authzDecisions | typeof toolCallAudits,
  input: { limit: number; dryRun: boolean },
): Promise<number> {
  const expired = sql`
    SELECT d.id FROM ${table} d
    LEFT JOIN ${workspaces} w ON w.id = d.workspace_id
    -- The bare floor lets the table's own "at" index bound the scan.
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

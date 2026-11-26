import {
  AUDIT_RETENTION_DEFAULT_DAYS,
  AUDIT_RETENTION_MIN_DAYS,
  type AuditEvent,
} from "@werft-ai/contracts";
import type { AuditLogFilter, AuditLogReader } from "@werft-ai/platform";
import { and, desc, eq, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import {
  type AuditCursor,
  decodeAuditCursor,
  encodeAuditCursor,
  rethrowCursorCastError,
} from "../cursors.ts";
import type { Database } from "../queries.ts";
import { authzDecisions, receipts, workspaces } from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";

// UTC with every microsecond: the cursor compares what Postgres stores, and
// a JS Date would cut it to milliseconds.
function atText(column: PgColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

// The same window expireByAuditRetention deletes outside of, so a listed row
// is one the reconciler keeps.
async function retentionStart(db: Database, ownerId: string): Promise<string> {
  const rows = rowsOf<{ start: string }>(
    await db.execute(sql`
      SELECT to_char(
        (statement_timestamp() - make_interval(days => greatest(
          ${AUDIT_RETENTION_MIN_DAYS}::int,
          coalesce(
            CASE WHEN jsonb_typeof(w.settings -> 'audit_retention_days') = 'number'
              THEN floor((w.settings ->> 'audit_retention_days')::numeric)::int END,
            ${AUDIT_RETENTION_DEFAULT_DAYS}::int
          )
        ))) AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS start
      FROM ${workspaces} w WHERE w.id::text = ${ownerId}`),
  );
  const start = rows[0]?.start;
  // Reading with the default instead could show rows a shorter window hides.
  if (start === undefined) throw new Error("workspace retention unreadable");
  return start;
}

type PrincipalKind = NonNullable<AuditEvent["actor"]["principal_kind"]>;

type ReceiptActor = {
  principal?: { kind?: PrincipalKind; id?: string };
  actor_user_id?: string | null;
  agent_id?: string | null;
} | null;

type TargetRef = {
  session_id?: string;
  resource?: { kind?: string; id?: string };
  user_id?: string;
};

function receiptTarget(ref: TargetRef): AuditEvent["target"] {
  if (typeof ref.session_id === "string") {
    return { kind: "session", id: ref.session_id };
  }
  if (typeof ref.resource?.kind === "string") {
    return { kind: ref.resource.kind, id: ref.resource.id ?? null };
  }
  if (typeof ref.user_id === "string") return { kind: "user", id: ref.user_id };
  return { kind: "unknown", id: null };
}

// Descending (at, kind, id): every part is fixed-width or compared as the
// database orders it (lowercase uuid text sorts as the uuid does).
function newerFirst(a: AuditEvent, b: AuditEvent): number {
  const x = `${a.at} ${a.kind} ${a.id}`;
  const y = `${b.at} ${b.kind} ${b.id}`;
  return x === y ? 0 : x > y ? -1 : 1;
}

// The full (at, kind, id) triple against each table's fixed kind, so a row
// of the other table at the same instant is neither skipped nor repeated.
function before(
  cursor: AuditCursor | null,
  at: PgColumn,
  kind: AuditEvent["kind"],
  id: PgColumn,
): SQL | undefined {
  return cursor
    ? sql`(${at}, ${kind}::text, ${id}) < (${cursor.at}::timestamptz, ${cursor.kind}::text, ${cursor.id}::uuid)`
    : undefined;
}

// What a filter keeps of each table, so a count reads the rows a page lists.
function matching(ownerId: string, filter: AuditLogFilter, start: string) {
  const userId = filter.actor_user_id?.toLowerCase();
  const window = (at: PgColumn) =>
    and(
      sql`${at} >= ${start}::timestamptz`,
      filter.from ? sql`${at} >= ${filter.from}::timestamptz` : undefined,
      filter.to ? sql`${at} < ${filter.to}::timestamptz` : undefined,
    );
  return {
    decisions:
      filter.kind === "receipt"
        ? undefined
        : and(
            eq(authzDecisions.ownerId, ownerId),
            window(authzDecisions.at),
            userId ? eq(authzDecisions.actorUserId, userId) : undefined,
            filter.action
              ? eq(authzDecisions.action, filter.action)
              : undefined,
            filter.outcome
              ? eq(authzDecisions.outcome, filter.outcome)
              : undefined,
          ),
    receipts:
      filter.kind === "decision"
        ? undefined
        : and(
            eq(receipts.ownerId, ownerId),
            window(receipts.createdAt),
            userId
              ? sql`${receipts.actor} ->> 'actor_user_id' = ${userId}`
              : undefined,
            filter.action ? eq(receipts.operation, filter.action) : undefined,
            // Text, so an outcome that is no receipt status matches nothing
            // instead of failing the enum cast.
            filter.outcome
              ? sql`${receipts.status}::text = ${filter.outcome}`
              : undefined,
          ),
  };
}

export function createPostgresAuditLogReader(db: Database): AuditLogReader {
  return {
    async count(ownerId, filter, stopAt) {
      const start = await retentionStart(db, ownerId);
      const where = matching(ownerId, filter, start);
      // Reads at most stopAt rows of each table: the log grows with every
      // request, and the screen needs no more than "past the cap".
      const upTo = async (
        table: typeof authzDecisions | typeof receipts,
        condition: SQL | undefined,
      ) => {
        const rows = rowsOf<{ n: number }>(
          await db.execute(sql`
            SELECT count(*)::int AS n FROM (
              SELECT 1 FROM ${table} WHERE ${condition} LIMIT ${stopAt}
            ) AS kept`),
        );
        return rows[0]?.n ?? 0;
      };
      const [decision, receipt] = await Promise.all([
        where.decisions ? upTo(authzDecisions, where.decisions) : 0,
        where.receipts ? upTo(receipts, where.receipts) : 0,
      ]);
      return { decision, receipt };
    },

    async page(ownerId, filter, cursorText, limit) {
      const cursor = cursorText ? decodeAuditCursor(cursorText) : null;
      const start = await retentionStart(db, ownerId);
      const where = matching(ownerId, filter, start);

      const decisions =
        where.decisions === undefined
          ? []
          : await db
              .select({
                id: authzDecisions.id,
                at: atText(authzDecisions.at),
                requestId: authzDecisions.requestId,
                principalKind: authzDecisions.principalKind,
                principalId: authzDecisions.principalId,
                userId: authzDecisions.actorUserId,
                agentId: authzDecisions.agentId,
                action: authzDecisions.action,
                resourceKind: authzDecisions.resourceKind,
                resourceId: authzDecisions.resourceId,
                outcome: authzDecisions.outcome,
                reasonCode: authzDecisions.reasonCode,
                surface: sql<
                  string | null
                >`${authzDecisions.surface} ->> 'kind'`,
              })
              .from(authzDecisions)
              .where(
                and(
                  where.decisions,
                  before(
                    cursor,
                    authzDecisions.at,
                    "decision",
                    authzDecisions.id,
                  ),
                ),
              )
              .orderBy(desc(authzDecisions.at), desc(authzDecisions.id))
              .limit(limit + 1)
              .catch(rethrowCursorCastError);

      const receiptRows =
        where.receipts === undefined
          ? []
          : await db
              .select({
                id: receipts.id,
                at: atText(receipts.createdAt),
                requestId: receipts.requestId,
                actor: receipts.actor,
                operation: receipts.operation,
                targetRef: receipts.targetRef,
                status: receipts.status,
              })
              .from(receipts)
              .where(
                and(
                  where.receipts,
                  before(cursor, receipts.createdAt, "receipt", receipts.id),
                ),
              )
              .orderBy(desc(receipts.createdAt), desc(receipts.id))
              .limit(limit + 1)
              .catch(rethrowCursorCastError);

      const merged: AuditEvent[] = [
        ...decisions.map(
          (row): AuditEvent => ({
            kind: "decision",
            id: row.id,
            at: row.at,
            request_id: row.requestId,
            actor: {
              principal_kind: row.principalKind as PrincipalKind | null,
              principal_id: row.principalId,
              user_id: row.userId,
              agent_id: row.agentId,
            },
            action: row.action,
            target: { kind: row.resourceKind, id: row.resourceId },
            outcome: row.outcome,
            reason_code: row.reasonCode,
            surface: row.surface,
          }),
        ),
        ...receiptRows.map((row): AuditEvent => {
          const actor = row.actor as ReceiptActor;
          return {
            kind: "receipt",
            id: row.id,
            at: row.at,
            request_id: row.requestId,
            actor: {
              principal_kind: actor?.principal?.kind ?? null,
              principal_id: actor?.principal?.id ?? null,
              user_id: actor?.actor_user_id ?? null,
              agent_id: actor?.agent_id ?? null,
            },
            action: row.operation,
            target: receiptTarget(row.targetRef as TargetRef),
            outcome: row.status,
            reason_code: null,
            surface: null,
          };
        }),
      ].sort(newerFirst);
      // Each table gave its newest limit + 1, so whatever this page leaves
      // out sorts after its last row.
      const items = merged.slice(0, limit);
      const cursors = items.map((row) =>
        encodeAuditCursor({ at: row.at, kind: row.kind, id: row.id }),
      );
      return {
        items,
        next_cursor: merged.length > limit ? (cursors.at(-1) ?? null) : null,
        retention_start: start,
        cursors,
      };
    },
  };
}

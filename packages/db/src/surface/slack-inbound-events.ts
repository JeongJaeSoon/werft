import { randomUUID } from "node:crypto";
import {
  JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
  SLACK_INBOUND_EVENT_STATUS_VALUES,
  type SlackInboundEventStatus,
} from "@werft-ai/contracts";
import type {
  SurfaceInboundClaim,
  SurfaceInboundEventStore,
  SurfaceInboundFence,
} from "@werft-ai/platform";
import { and, eq, gt, sql } from "drizzle-orm";
import {
  holdBufferedInput,
  takeSlackTurnInput,
} from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { slackInboundEvents, slackInstallations } from "../schema.ts";
import { rowsOf } from "../statement-rows.ts";
import { released } from "./slack-shared.ts";

const t = slackInboundEvents;

// Every lease judgment below is `now()` in the database, the clock the
// uninstall's superseded check also reads; no app clock enters it.
const leaseHeld = (fence: SurfaceInboundFence) =>
  and(
    eq(t.id, fence.id),
    eq(t.claimToken, fence.claimToken),
    gt(t.leaseExpiresAt, sql`now()`),
  );

const installationStatusOf = sql<SurfaceInboundClaim["installationStatus"]>`(
  SELECT i.status FROM ${slackInstallations} i
  WHERE i.app_id = slack_inbound_events.app_id
    AND i.team_id = slack_inbound_events.team_id
)`;

// Thread order, the claim's ORDER BY and its head-of-conversation test
// alike; event_time is Slack's, in whole seconds.
const order = (alias: string) =>
  sql.raw(
    `(COALESCE(${alias}.event_time, ${alias}.received_at), ${alias}.received_at, ${alias}.id)`,
  );

export function createPostgresSlackInboundEventStore(
  db: Database,
  options: {
    /** Read before each buffered hold; a throw leaves the row to its lease. */
    bufferLimit?: () => Promise<number>;
    logger?: {
      info(message: string, fields?: Record<string, unknown>): void;
    };
  } = {},
): SurfaceInboundEventStore {
  const bufferLimit =
    options.bufferLimit ?? (async () => JUDGMENT_BUFFER_LIMIT_PER_CHANNEL);
  return {
    async seen(appId, eventId) {
      const [row] = await db
        .select({ id: t.id })
        .from(t)
        .where(and(eq(t.appId, appId), eq(t.eventId, eventId)))
        .limit(1);
      return row !== undefined;
    },

    async record(event) {
      const [row] = await db
        .insert(t)
        .values({
          id: randomUUID(),
          workspaceId: event.workspaceId,
          agentId: event.agentId,
          slackAppId: event.slackAppId,
          teamId: event.teamId,
          appId: event.appId,
          eventId: event.eventId,
          eventType: event.eventType,
          eventSubtype: event.eventSubtype,
          eventTime: event.eventTime,
          status: event.status,
          dropReason: event.status === "dropped" ? event.dropReason : null,
          dropFields: event.status === "dropped" ? event.dropFields : null,
          payload: event.status === "dropped" ? null : event.payload,
          conversationKey:
            event.status === "dropped" ? null : event.conversationKey,
        })
        .onConflictDoNothing({ target: [t.appId, t.eventId] })
        .returning({ id: t.id });
      return row ? "recorded" : "duplicate";
    },

    claim({ limit, leaseMs, maxAttempts }) {
      return db.transaction(async (tx) => {
        // One claimer at a time: the thread rule reads other rows' leases,
        // and a lease another claimer has not committed yet is invisible.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext('slack_inbound_events.claim'))`,
        );
        // A lease that ran out on its last attempt: crashed every time.
        await tx
          .update(t)
          .set({ status: "failed", ...released })
          .where(
            and(
              eq(t.status, "received"),
              sql`${t.leaseExpiresAt} <= now()`,
              sql`${t.attempts} >= ${maxAttempts}`,
            ),
          );
        const rows = await tx
          .update(t)
          .set({
            claimToken: sql`gen_random_uuid()`,
            leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
            attempts: sql`${t.attempts} + 1`,
          })
          .where(
            sql`${t.id} IN (
              SELECT c.id FROM slack_inbound_events c
              WHERE c.status = 'received'
                AND c.attempts < ${maxAttempts}
                AND (c.claim_token IS NULL OR c.lease_expires_at <= now())
                AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
                AND NOT EXISTS (
                  SELECT 1 FROM slack_inbound_events o
                  WHERE o.status = 'received'
                    AND o.conversation_key = c.conversation_key
                    AND o.id <> c.id
                    -- A late retry of an older event must not run beside
                    -- the one its thread already has in flight.
                    AND (${order("o")} < ${order("c")}
                      OR (o.claim_token IS NOT NULL AND o.lease_expires_at > now()))
                )
              ORDER BY ${order("c")}
              LIMIT ${limit}
              FOR UPDATE OF c SKIP LOCKED
            )`,
          )
          .returning({
            id: t.id,
            claimToken: t.claimToken,
            attempts: t.attempts,
            workspaceId: t.workspaceId,
            agentId: t.agentId,
            slackAppId: t.slackAppId,
            teamId: t.teamId,
            appId: t.appId,
            eventId: t.eventId,
            eventType: t.eventType,
            eventSubtype: t.eventSubtype,
            eventTime: t.eventTime,
            receivedAt: t.receivedAt,
            conversationKey: t.conversationKey,
            payload: t.payload,
            installationStatus: installationStatusOf,
          });
        // RETURNING keeps no order; hand them out in thread order.
        return rows
          .sort(
            (a, b) =>
              (a.eventTime ?? a.receivedAt).getTime() -
                (b.eventTime ?? b.receivedAt).getTime() ||
              a.receivedAt.getTime() - b.receivedAt.getTime() ||
              a.id.localeCompare(b.id),
          )
          .map(({ receivedAt: _, claimToken, payload, ...row }) => ({
            ...row,
            // Set by this very update, and received rows keep their payload
            // (slack_inbound_events_payload_check).
            claimToken: claimToken as string,
            payload: payload as Record<string, unknown>,
          }));
      });
    },

    async renew(fence, leaseMs) {
      const [row] = await db
        .update(t)
        .set({
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
        })
        .where(leaseHeld(fence))
        .returning({ installationStatus: installationStatusOf });
      return row ?? null;
    },

    async complete(fence, input) {
      const limit =
        input !== undefined && "buffered" in input ? await bufferLimit() : null;
      let overLimit: Record<string, string | number> | null = null;
      const done = await db.transaction(async (tx) => {
        const [row] = await tx
          .update(t)
          .set({ status: "processed", payload: null, ...released })
          .where(leaseHeld(fence))
          .returning({
            workspaceId: t.workspaceId,
            agentId: t.agentId,
            teamId: t.teamId,
          });
        if (row === undefined) return false;
        if (input === undefined) return true;
        if ("buffered" in input) {
          // One taker per topic at a time, so the topic's highest number plus
          // one is free.
          const topic = await tx.execute(sql`
            SELECT id FROM conversation_topics
            WHERE id = ${input.topicId}::uuid
              AND workspace_id = ${row.workspaceId}::uuid
              AND agent_id = ${row.agentId}::uuid
            FOR UPDATE`);
          if (rowsOf(topic).length === 0) {
            throw new Error(
              `topic ${input.topicId} is no topic of the event's agent`,
            );
          }
          const hold = await holdBufferedInput(
            tx,
            row,
            input,
            limit ?? JUDGMENT_BUFFER_LIMIT_PER_CHANNEL,
          );
          if (hold.dropped > 0) {
            overLimit = {
              workspace_id: row.workspaceId,
              agent_id: row.agentId,
              channel_id: input.channelId,
              dropped_count: hold.dropped,
            };
          }
          return true;
        }
        await takeSlackTurnInput(tx, row, input);
        return true;
      });
      // After the commit, so a rolled-back hold logs nothing.
      if (overLimit !== null) {
        options.logger?.info("Judgment buffer over limit", overLimit);
      }
      return done;
    },

    async drop(fence, reason) {
      const rows = await db
        .update(t)
        .set({
          status: "dropped",
          dropReason: reason,
          payload: null,
          conversationKey: null,
          ...released,
        })
        .where(leaseHeld(fence))
        .returning({ id: t.id });
      return rows.length > 0;
    },

    async fail(fence, { retryInMs, maxAttempts }) {
      const spent = sql`${t.attempts} >= ${maxAttempts}`;
      const [row] = await db
        .update(t)
        .set({
          status: sql`CASE WHEN ${spent} THEN 'failed' ELSE 'received' END`,
          nextAttemptAt: sql`CASE WHEN ${spent} THEN NULL ELSE now() + make_interval(secs => ${retryInMs / 1000}) END`,
          ...released,
        })
        .where(leaseHeld(fence))
        .returning({ status: t.status });
      if (row === undefined) return "lost";
      return row.status === "failed" ? "failed" : "retry";
    },
  };
}

/** How long a failed row keeps its payload, counted from its receipt. */
export const SLACK_INBOUND_FAILED_PAYLOAD_RETENTION_MS = 7 * 24 * 60 * 60_000;

/**
 * Clears the payload of failed rows received more than `retentionMs` ago;
 * a row fails within minutes of its receipt (five claims, backoff capped at
 * five minutes). Returns how many rows it changed; a dry run counts them, rows
 * another transaction holds included. The reconciler runs it every pass.
 */
export async function purgeFailedSlackInboundPayloads(
  db: Database,
  options: { limit: number; dryRun: boolean; retentionMs?: number },
): Promise<number> {
  const retentionMs =
    options.retentionMs ?? SLACK_INBOUND_FAILED_PAYLOAD_RETENTION_MS;
  // The first two conditions repeat the predicate of
  // slack_inbound_events_failed_payload_idx. Change one and the other follows.
  const expired = sql`
    SELECT id FROM slack_inbound_events
    WHERE status = 'failed'
      AND payload IS NOT NULL
      AND received_at < now() - make_interval(secs => ${retentionMs / 1000})
    ORDER BY received_at
    LIMIT ${options.limit}`;
  const result = await db.execute(
    options.dryRun
      ? expired
      : sql`
    UPDATE slack_inbound_events SET payload = NULL
    WHERE id IN (${expired} FOR UPDATE SKIP LOCKED)
    RETURNING id`,
  );
  return rowsOf<{ id: string }>(result).length;
}

type PayloadCountRow = {
  last: string | null;
  status: SlackInboundEventStatus | null;
  with_payload: number;
};
type PurgeBatchRow = { last: string | null; cleared: number };

/** Rows that still hold a payload, by status, every status present. */
export type SlackInboundPayloadCounts = Record<SlackInboundEventStatus, number>;

/**
 * Counts rows that hold a payload by status, walking the table in primary
 * key order `pageSize` rows per statement so no statement scans it whole.
 */
export async function countSlackInboundPayloads(
  db: Database,
  options: { pageSize: number },
): Promise<SlackInboundPayloadCounts> {
  const counts = Object.fromEntries(
    SLACK_INBOUND_EVENT_STATUS_VALUES.map((status) => [status, 0]),
  ) as SlackInboundPayloadCounts;
  let after: string | null = null;
  for (;;) {
    const rows: PayloadCountRow[] = rowsOf<PayloadCountRow>(
      await db.execute(sql`
        WITH page AS (
          SELECT id, status, payload IS NOT NULL AS held
          FROM slack_inbound_events
          WHERE ${after}::uuid IS NULL OR id > ${after}::uuid
          ORDER BY id
          LIMIT ${options.pageSize}
        )
        SELECT
          (SELECT id FROM page ORDER BY id DESC LIMIT 1)::text AS last,
          status,
          (count(*) FILTER (WHERE held))::int AS with_payload
        FROM page GROUP BY status`),
    );
    for (const row of rows) {
      if (row.status !== null) counts[row.status] += row.with_payload;
    }
    const last: string | null = rows[0]?.last ?? null;
    if (last === null) return counts;
    after = last;
  }
}

/**
 * Clears the payload of processed rows that still hold one: rows the slack
 * role completed before it cleared payloads itself. Walks the table in
 * primary key order, `batchSize` rows per statement, each its own
 * transaction, so a batch locks at most that many settled rows, for as long
 * as its one UPDATE takes. Received and failed rows are left alone; a
 * second run finds nothing.
 */
export async function purgeProcessedSlackInboundPayloads(
  db: Database,
  options: { batchSize: number },
): Promise<{ cleared: number; batches: number }> {
  let after: string | null = null;
  let cleared = 0;
  let batches = 0;
  for (;;) {
    const [row]: PurgeBatchRow[] = rowsOf<PurgeBatchRow>(
      await db.execute(sql`
        WITH batch AS (
          SELECT id FROM slack_inbound_events
          WHERE ${after}::uuid IS NULL OR id > ${after}::uuid
          ORDER BY id
          LIMIT ${options.batchSize}
        ), done AS (
          UPDATE slack_inbound_events e SET payload = NULL
          FROM batch
          WHERE e.id = batch.id
            AND e.status = 'processed'
            AND e.payload IS NOT NULL
          RETURNING e.id
        )
        SELECT
          (SELECT id FROM batch ORDER BY id DESC LIMIT 1)::text AS last,
          (SELECT count(*) FROM done)::int AS cleared`),
    );
    if (row === undefined || row.last === null) return { cleared, batches };
    batches += 1;
    cleared += row.cleared;
    after = row.last;
  }
}

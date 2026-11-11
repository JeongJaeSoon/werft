import { randomUUID } from "node:crypto";
import type {
  SlackInboundClaim,
  SlackInboundEventStore,
  SlackInboundFence,
} from "@werft-ai/platform";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { slackInboundEvents, slackInstallations } from "../schema.ts";

const t = slackInboundEvents;

// Every lease judgment below is `now()` in the database, the clock the
// uninstall's superseded check also reads; no app clock enters it.
const leaseHeld = (fence: SlackInboundFence) =>
  and(
    eq(t.id, fence.id),
    eq(t.claimToken, fence.claimToken),
    gt(t.leaseExpiresAt, sql`now()`),
  );

const released = { claimToken: null, leaseExpiresAt: null } as const;

const installationStatusOf = sql<SlackInboundClaim["installationStatus"]>`(
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
): SlackInboundEventStore {
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
            // (slack_inbound_events_dropped_check).
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

    async complete(fence) {
      const rows = await db
        .update(t)
        .set({ status: "processed", ...released })
        .where(leaseHeld(fence))
        .returning({ id: t.id });
      return rows.length > 0;
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

import { randomUUID } from "node:crypto";
import type { SessionLinkRecord, SessionLinkStore } from "@werft-ai/platform";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { lockSessionForControl, UUID } from "./control-shared.ts";
import { DB_NOW } from "./db-clock.ts";
import { markCutTurnsTold, stopJoiningSession } from "./emergency-stop.ts";
import { CREATE_SESSION, SESSIONS_RESOURCE } from "./postgres-unit-of-work.ts";
import type { Database } from "./queries.ts";
import { idempotencyKeys, receipts, sessionLinks, turns } from "./schema.ts";
import { lockChannelKind } from "./sessions/index.ts";
import { rowsOf } from "./statement-rows.ts";

const t = sessionLinks;

const columns = {
  id: t.id,
  workspaceId: t.workspaceId,
  installationId: t.installationId,
  surfaceBindingId: t.surfaceBindingId,
  surfaceRef: t.surfaceRef,
  channelId: t.channelId,
  threadId: t.threadId,
  openedByTs: t.openedByTs,
  agentId: t.agentId,
  releaseId: t.releaseId,
  sessionId: t.sessionId,
  createdBy: t.createdBy,
  revokedAt: t.revokedAt,
};

// The thread's open link: closed ones stay as its history. A revoked link is
// open, so its thread stays blocked.
const openByKey = (installationId: string, surfaceRef: string) =>
  and(
    eq(t.installationId, installationId.toLowerCase()),
    eq(t.surfaceRef, surfaceRef),
    isNull(t.closedAt),
  );

export function createPostgresSessionLinkStore(db: Database): SessionLinkStore {
  return {
    async find(installationId, surfaceRef) {
      if (!UUID.test(installationId)) return null;
      const [row] = await db
        .select(columns)
        .from(t)
        .where(openByKey(installationId, surfaceRef))
        .limit(1);
      return row ?? null;
    },

    async closedSessions(installationId, surfaceRef) {
      if (!UUID.test(installationId)) return [];
      const rows = await db
        .select({ sessionId: t.sessionId })
        .from(t)
        .where(
          and(
            eq(t.installationId, installationId.toLowerCase()),
            eq(t.surfaceRef, surfaceRef),
            isNotNull(t.closedAt),
            isNotNull(t.sessionId),
          ),
        );
      return rows.flatMap(({ sessionId }) =>
        sessionId === null ? [] : [sessionId],
      );
    },

    reserve(input) {
      return db.transaction(async (tx) => {
        const installationId = input.installationId.toLowerCase();
        // No row lock covers a link that is not there yet; this lock lets one
        // reservation of the thread at a time look and insert. Taken first,
        // with nothing else held, so it orders after no other lock.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`session_links:${installationId}:${input.surfaceRef}`}, 0))`,
        );
        const open = () =>
          tx
            .select(columns)
            .from(t)
            .where(openByKey(installationId, input.surfaceRef))
            .limit(1)
            .for("update");
        const [held] = await open();
        if (held) return { link: held, reserved: false };
        const [inserted] = await tx
          .insert(t)
          .values({
            id: randomUUID(),
            workspaceId: input.workspaceId,
            ownerId: input.workspaceId,
            installationId,
            surfaceBindingId: input.surfaceBindingId,
            surfaceRef: input.surfaceRef,
            channelId: input.channelId,
            threadId: input.threadId,
            openedByTs: input.openedByTs,
            agentId: input.agentId,
            releaseId: input.releaseId,
            createdBy: input.createdBy,
          })
          // No target, so the open-only unique is an arbiter: a writer that
          // skipped the lock is a conflict here, not an error.
          .onConflictDoNothing()
          .returning(columns);
        if (inserted) return { link: inserted, reserved: true };
        // That writer's insert has committed: ON CONFLICT waited for it.
        const [theirs] = await open();
        if (!theirs) {
          throw new Error(`session link ${input.surfaceRef} vanished`);
        }
        return { link: theirs, reserved: false };
      });
    },

    async attachSession(linkId, sessionId) {
      await db.transaction(async (tx) => {
        const [link] = await tx
          .select({ installationId: t.installationId, channelId: t.channelId })
          .from(t)
          .where(eq(t.id, linkId));
        // A conversion of the channel, running or done, is not missed: one
        // that made the channel private while this session was being made
        // narrows it here. One that made it public leaves it to the channel's
        // members, never wider than it was made.
        if (link?.installationId && link.channelId) {
          await lockChannelKind(tx, link.installationId, link.channelId);
        }
        // Stopped in any install of the channel's Slack team, as one stop
        // covers them all.
        const [stopped] = rowsOf(
          await tx.execute(sql`
            SELECT 1 FROM ${t} l
            JOIN slack_installations li ON li.id = l.installation_id
            JOIN surface_bindings b ON b.external_surface_id = l.channel_id
              AND b.agent_id = l.agent_id
            JOIN slack_installations bi ON bi.id = b.installation_id
            WHERE l.id = ${linkId}::uuid
              AND coalesce(bi.team_id, bi.id::text)
                = coalesce(li.team_id, li.id::text)
              AND b.emergency_stopped_at IS NOT NULL`),
        );
        // The session as a control takes it (its launch, then the row),
        // before the link's key to it, which a claim of its worker would
        // otherwise wait on in the other order.
        if (stopped) {
          await lockSessionForControl(tx, {
            sessionId: sessionId.toLowerCase(),
            attempt: 0,
          });
        }
        const attached = await tx
          .update(t)
          .set({ sessionId: sessionId.toLowerCase() })
          .where(and(eq(t.id, linkId), isNull(t.sessionId)))
          .returning({ id: t.id });
        if (attached.length === 0) return;
        if (stopped) await stopJoiningSession(tx, sessionId.toLowerCase());
        // A turn a stop cut before this thread held the session, the
        // channel on again or not, is never told here as a failure.
        await markCutTurnsTold(tx, sessionId.toLowerCase());
        const narrowed = await tx.execute(sql`
          INSERT INTO session_shares (session_id, owner_id, workspace_id, scope,
            updated_by, updated_at, revision)
          SELECT s.id, s.owner_id, s.workspace_id, 'private_channel', NULL,
            ${DB_NOW}, 1
          FROM ${t} l
          JOIN surface_bindings b ON b.id = l.surface_binding_id
          JOIN sessions s ON s.id = l.session_id
          WHERE l.id = ${linkId}::uuid AND b.surface_kind = 'private_channel'
            AND s.workspace_id IS NOT NULL
          ON CONFLICT (session_id) DO UPDATE
            SET scope = EXCLUDED.scope, updated_by = NULL,
              updated_at = EXCLUDED.updated_at,
              revision = session_shares.revision + 1
            WHERE session_shares.scope NOT IN ('private', 'private_channel')
          RETURNING session_id`);
        if (rowsOf(narrowed).length > 0) {
          await tx.execute(
            sql`SELECT pg_notify('session_events', ${sessionId.toLowerCase()})`,
          );
        }
      });
      return read(linkId);
    },

    async openedSession(link) {
      const [row] = await db
        .select({ result: receipts.result })
        .from(idempotencyKeys)
        .innerJoin(receipts, eq(receipts.id, idempotencyKeys.receiptId))
        .where(
          and(
            eq(idempotencyKeys.principal, link.workspaceId),
            eq(idempotencyKeys.operation, CREATE_SESSION),
            eq(idempotencyKeys.resource, SESSIONS_RESOURCE),
            eq(idempotencyKeys.key, link.id),
          ),
        )
        .limit(1);
      const made = (row?.result as { session_id?: unknown } | null | undefined)
        ?.session_id;
      return typeof made === "string" ? made : null;
    },

    async slackTurn(sessionId, message) {
      const [row] = await db
        .select({ sequence: turns.sequence, requesterId: turns.requesterId })
        .from(turns)
        .where(
          and(
            eq(turns.sessionId, sessionId.toLowerCase()),
            sql`${turns.slackMessage}->>'team_id' = ${message.teamId}`,
            sql`${turns.slackMessage}->>'channel_id' = ${message.channelId}`,
            sql`${turns.slackMessage}->>'ts' = ${message.ts}`,
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async reopen(linkId, openedByTs) {
      await db
        .update(t)
        .set({ openedByTs })
        .where(and(eq(t.id, linkId), isNull(t.sessionId)));
      return read(linkId);
    },
  };

  async function read(linkId: string): Promise<SessionLinkRecord> {
    const [row] = await db
      .select(columns)
      .from(t)
      .where(eq(t.id, linkId))
      .limit(1);
    if (!row) throw new Error(`session link ${linkId} not found`);
    return row;
  }
}

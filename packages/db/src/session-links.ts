import { randomUUID } from "node:crypto";
import type { SessionLinkRecord, SessionLinkStore } from "@werft-ai/platform";
import { and, eq, isNull, sql } from "drizzle-orm";
import { UUID } from "./control-shared.ts";
import { DB_NOW } from "./db-clock.ts";
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

    reserve(input) {
      return db.transaction(async (tx) => {
        const installationId = input.installationId.toLowerCase();
        // No row lock covers a link that is not there yet; this lock lets one
        // reservation of the thread at a time look and insert. Taken first,
        // with nothing else held, so it orders after no other lock. A host
        // from before it takes none: the ON CONFLICT below still waits for
        // its insert, which every unique on the thread conflicts with.
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
          // No target, so every unique is an arbiter: an older host's row,
          // racing in under the old (installation_id, surface_ref) key, is a
          // conflict here, not an error from the open-only one.
          .onConflictDoNothing()
          .returning(columns);
        if (inserted) return { link: inserted, reserved: true };
        // An older host's insert has committed: ON CONFLICT waited for it.
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
        const attached = await tx
          .update(t)
          .set({ sessionId: sessionId.toLowerCase() })
          .where(and(eq(t.id, linkId), isNull(t.sessionId)))
          .returning({ id: t.id });
        if (attached.length === 0) return;
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

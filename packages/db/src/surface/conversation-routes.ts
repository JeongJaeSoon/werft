import {
  type ConversationRouteEffect,
  DEFAULT_USER_LOCALE,
  ENDED_SESSION_STATUSES,
  SLACK_NOTICE_MESSAGES,
  type SlackNoticeMessage,
  slackMessageUrl,
  type UserLocale,
} from "@werft-ai/contracts";
import type {
  ConversationRouteStore,
  ConversationRouteTask,
  ConversationRouteTaskThread,
  ConversationTurnSurfaceSubject,
  PendingConversationRoute,
  SecretKey,
  StoredSourceSet,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import {
  adoptSessionParent,
  keptTurnRequest,
  lockedDeletedSource,
  releaseKeptTurnRequest,
  standaloneTaskOf,
} from "../conversations/index.ts";
import {
  APPEND_MESSAGE,
  conversationTurnInputScope,
  lockConversationTurnInput,
} from "../postgres-unit-of-work.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { conversationReplyDedupeKey } from "./conversation-replies.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

/**
 * Points the mirror thread at the task, under the thread's unique index;
 * the row and its new `rev` when the pointer line is due (the thread pointed
 * nowhere, or at another task: A→B, and A→B→A twice), null when it already
 * pointed at this task. This is where which task a mirror names is decided.
 */
export async function pointThreadMirror(
  tx: Database,
  input: {
    workspaceId: string;
    agentId: string;
    installationId: string;
    channelId: string;
    threadTs: string;
    sessionId: string;
  },
): Promise<{ id: string; rev: number } | null> {
  const [row] = rowsOf<{ id: string; rev: number }>(
    await tx.execute(sql`
      INSERT INTO task_thread_mirrors AS m (workspace_id, agent_id,
        installation_id, channel_id, thread_ts, session_id)
      VALUES (${input.workspaceId}::uuid, ${input.agentId}::uuid,
        ${input.installationId}::uuid, ${input.channelId}, ${input.threadTs},
        ${input.sessionId}::uuid)
      ON CONFLICT (installation_id, channel_id, thread_ts) DO UPDATE
        SET session_id = EXCLUDED.session_id, rev = m.rev + 1,
          updated_at = now()
        WHERE m.session_id IS DISTINCT FROM EXCLUDED.session_id
      RETURNING m.id, m.rev`),
  );
  return row ?? null;
}

/**
 * One pointer line per change of a mirror thread's task. The row's id is
 * in it: a row its task's delete took away starts again at `rev` 1.
 */
export const taskMirrorDedupeKey = (mirror: { id: string; rev: number }) =>
  `task_mirror:${mirror.id}:${mirror.rev}`;

/** The turn's input is in its task: its own receipt, whoever wrote it. */
const handedInput = (route: PendingConversationRoute) => sql`
  EXISTS (SELECT 1 FROM idempotency_keys
    WHERE principal = ${route.workspaceId}
      AND operation = ${APPEND_MESSAGE}
      AND resource = ${conversationTurnInputScope(route.sessionId)}
      AND key = ${route.turnId})`;

/**
 * The task's thread while it is an open task of the turn's own conversation
 * (G3); null otherwise. In a transaction the session row is held against a
 * close until it ends.
 */
async function openTaskThread(
  executor: Database,
  route: PendingConversationRoute,
  hold = false,
): Promise<(ConversationRouteTaskThread & { openedByTs: string }) | null> {
  const [task] = rowsOf<{
    channel_id: string;
    thread_id: string;
    opened_by_ts: string;
  }>(
    await executor.execute(sql`
      SELECT sl.channel_id, sl.thread_id, sl.opened_by_ts FROM sessions s
      JOIN session_links sl ON sl.session_id = s.id
        AND sl.role = 'primary'
        AND sl.closed_at IS NULL AND sl.revoked_at IS NULL
      WHERE s.id = ${route.sessionId}::uuid
        AND s.workspace_id = ${route.workspaceId}::uuid
        AND s.parent_conversation_id = ${route.conversationId}::uuid
        AND s.status::text NOT IN (${sql.join(
          ENDED_SESSION_STATUSES.map((status) => sql`${status}`),
          sql`, `,
        )})
      ORDER BY sl.created_at DESC LIMIT 1
      ${hold ? sql`FOR SHARE OF s` : sql``}`),
  );
  return task === undefined
    ? null
    : {
        channelId: task.channel_id,
        threadTs: task.thread_id,
        openedByTs: task.opened_by_ts,
      };
}

// The DM's own person, when the turn's requester is them (v1-b/DM3).
const dmPersonOf = (route: PendingConversationRoute) =>
  route.dm !== null && route.dm.personUserId === route.requesterUserId
    ? route.dm.personUserId
    : null;

const standaloneOf = (route: PendingConversationRoute, person: string) =>
  standaloneTaskOf(sql.raw("s"), {
    workspaceId: route.workspaceId,
    agentId: route.agentId,
    personUserId: person,
  });

const threadRefOf = (route: PendingConversationRoute) =>
  `${route.thread.channelId}:${route.thread.threadTs}`;

// The link this turn's hand-off bound: opened by the DM message itself.
const ownBindOf = (route: PendingConversationRoute) => sql`
  sl.session_id = ${route.sessionId}::uuid
  AND sl.installation_id = ${route.thread.installationId.toLowerCase()}::uuid
  AND sl.surface_ref = ${threadRefOf(route)}
  AND sl.opened_by_ts = ${route.thread.messageTs}
  AND sl.closed_at IS NULL`;

/**
 * Takes back what a DM hand-off bound for a turn that ends unhanded: the
 * link and, with no link left, the parent. Kept once any input went in by
 * that link, this turn's or another message's.
 */
async function dropOwnBind(tx: Database, route: PendingConversationRoute) {
  const dropped = rowsOf(
    await tx.execute(sql`
      DELETE FROM session_links sl
      WHERE ${ownBindOf(route)}
        AND NOT ${handedInput(route)}
        AND NOT EXISTS (SELECT 1 FROM turns t
          WHERE t.session_id = sl.session_id AND t.created_at >= sl.created_at)
      RETURNING sl.id`),
  );
  if (dropped.length === 0) return;
  await tx.execute(sql`
    UPDATE sessions SET parent_conversation_id = NULL
    WHERE id = ${route.sessionId}::uuid
      AND parent_conversation_id = ${route.conversationId}::uuid
      AND NOT EXISTS (SELECT 1 FROM session_links
        WHERE session_id = ${route.sessionId}::uuid)`);
}

class BindRefused extends Error {
  constructor(readonly reason: "gone" | "thread_taken" | "other_parent") {
    super(reason);
  }
}

/**
 * What a mention turn's route_to_task decision reads and writes (v1-b/E4).
 * The thread, the requester, the request and the task are the server's
 * records; the model named the task alone, which is checked again here.
 */
export function createPostgresConversationRoutes(
  db: Database,
  secretKey: SecretKey,
): ConversationRouteStore {
  return {
    async pending(turnId) {
      const [turn] = rowsOf<{
        workspace_id: string;
        agent_id: string;
        conversation_id: string;
        topic_id: string | null;
        requester_kind: string;
        requester_id: string;
        routed_session_id: string | null;
        slack_subject: ConversationTurnSurfaceSubject | null;
        sources: StoredSourceSet | null;
        installation_id: string | null;
        slack_app_id: string | null;
        conversation_kind: string;
        person_user_id: string | null;
        dm_binding_id: string | null;
        thread_ts: string | null;
        team_id: string | null;
        channel_id: string | null;
        ts: string | null;
      }>(
        await db.execute(sql`
          SELECT t.workspace_id, t.agent_id, t.conversation_id, t.topic_id,
            t.requester_kind, t.requester_id, t.routed_session_id,
            t.slack_subject, t.sources,
            c.kind AS conversation_kind, c.person_user_id,
            (SELECT sb.id FROM surface_bindings sb
              WHERE sb.installation_id = t.slack_installation_id
                AND sb.agent_id = t.agent_id
                -- A DM binding names no channel: one per installation.
                AND sb.surface_kind = 'dm' AND sb.status = 'ready'
                AND sb.revoked_at IS NULL
              ORDER BY sb.created_at DESC LIMIT 1) AS dm_binding_id,
            t.slack_installation_id AS installation_id,
            (SELECT sa.id FROM slack_installations i
              JOIN slack_apps sa ON sa.app_id = i.app_id
              WHERE i.id = t.slack_installation_id
                AND sa.agent_id = t.agent_id) AS slack_app_id,
            tp.slack_thread_ts AS thread_ts,
            e.team_id, e.channel_id, e.ts
          FROM conversation_turns t
          JOIN conversations c ON c.id = t.conversation_id
          JOIN conversation_topics tp ON tp.id = t.topic_id
          -- A person's mention alone hands work on (G2).
          JOIN conversation_engagements e ON e.conversation_turn_id = t.id
            AND e.kind = 'mention'
          WHERE t.id = ${turnId}::uuid AND t.origin = 'm2'
            AND t.state = 'decided' AND t.decision = 'route_to_task'
            AND t.task_effect IS NULL`),
      );
      if (
        turn === undefined ||
        turn.routed_session_id === null ||
        turn.topic_id === null ||
        turn.installation_id === null ||
        turn.team_id === null ||
        turn.channel_id === null ||
        turn.ts === null ||
        !turn.thread_ts ||
        turn.requester_kind !== "user"
      ) {
        return null;
      }
      return {
        turnId,
        workspaceId: turn.workspace_id,
        agentId: turn.agent_id,
        conversationId: turn.conversation_id,
        topicId: turn.topic_id,
        sessionId: turn.routed_session_id,
        thread: {
          installationId: turn.installation_id,
          slackAppId: turn.slack_app_id,
          teamId: turn.team_id,
          channelId: turn.channel_id,
          threadTs: turn.thread_ts,
          messageTs: turn.ts,
        },
        requesterUserId: turn.requester_id,
        subject: turn.slack_subject,
        sources: turn.sources,
        dm:
          turn.conversation_kind === "dm" && turn.person_user_id !== null
            ? {
                personUserId: turn.person_user_id,
                surfaceBindingId: turn.dm_binding_id,
              }
            : null,
      } as PendingConversationRoute;
    },

    async handed(route) {
      const [row] = rowsOf<{ handed: boolean }>(
        await db.execute(sql`SELECT ${handedInput(route)} AS handed`),
      );
      return row?.handed === true;
    },

    async sourceDeleted(route) {
      return db.transaction(
        async (tx) =>
          (await lockedDeletedSource(tx, {
            workspaceId: route.workspaceId,
            sessionId: null,
            sources: route.sources,
            throughTurn: null,
          })) !== null,
      );
    },

    requestText: (turnId) => keptTurnRequest(db, secretKey, turnId),

    async openTask(route): Promise<ConversationRouteTask | null> {
      const linked = await openTaskThread(db, route);
      if (linked !== null) return { kind: "linked", ...linked };
      const person = dmPersonOf(route);
      if (person === null) return null;
      const [row] = rowsOf<{ id: string }>(
        await db.execute(sql`
          SELECT s.id FROM sessions s
          WHERE s.id = ${route.sessionId}::uuid
            AND ${standaloneOf(route, person)}`),
      );
      return row === undefined ? null : { kind: "standalone" };
    },

    async bindStandalone(route) {
      const person = dmPersonOf(route);
      const bindingId = route.dm?.surfaceBindingId ?? null;
      if (person === null || bindingId === null) return "gone";
      const installationId = route.thread.installationId.toLowerCase();
      const surfaceRef = threadRefOf(route);
      try {
        return await db.transaction(async (tx) => {
          // The thread's reservation lock, first and alone, as a mention's.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`session_links:${installationId}:${surfaceRef}`}, 0))`,
          );
          // Then settle's: a bind and the turn's end never cross.
          await lockConversationTurnInput(tx, {
            workspaceId: route.workspaceId,
            sessionId: route.sessionId,
            turnId: route.turnId,
          });
          const [state] = rowsOf<{ ended: boolean; mine: boolean }>(
            await tx.execute(sql`
              SELECT
                EXISTS (SELECT 1 FROM conversation_turns
                  WHERE id = ${route.turnId}::uuid
                    AND task_effect IS NOT NULL) AS ended,
                EXISTS (SELECT 1 FROM session_links sl
                  WHERE ${ownBindOf(route)}) AS mine`),
          );
          // Ended by a run beside this one: nothing is bound for it.
          if (state?.ended === true) throw new BindRefused("gone");
          // Bound by a run beside this one, or before a crash.
          if (state?.mine === true) return "bound" as const;
          const [session] = rowsOf<{ agent_release_id: string }>(
            await tx.execute(sql`
              SELECT s.agent_release_id FROM sessions s
              WHERE s.id = ${route.sessionId}::uuid
                AND ${standaloneOf(route, person)}
              FOR UPDATE OF s`),
          );
          if (session === undefined) throw new BindRefused("gone");
          const adopted = await adoptSessionParent(tx, route.sessionId, {
            kind: "dm",
            workspaceId: route.workspaceId,
            agentId: route.agentId,
            personUserId: person,
          });
          const [parent] = rowsOf<{ ok: boolean }>(
            await tx.execute(sql`
              SELECT parent_conversation_id = ${route.conversationId}::uuid AS ok
              FROM sessions WHERE id = ${route.sessionId}::uuid`),
          );
          // Never another conversation's, whatever wrote it.
          if (adopted === "other" || parent?.ok !== true) {
            throw new BindRefused("other_parent");
          }
          const inserted = rowsOf<{ id: string }>(
            await tx.execute(sql`
              INSERT INTO session_links (id, workspace_id, owner_id, session_id,
                installation_id, surface_binding_id, surface_ref, channel_id,
                thread_id, opened_by_ts, agent_id, release_id, created_by,
                created_at)
              VALUES (gen_random_uuid(), ${route.workspaceId}::uuid,
                ${route.workspaceId}, ${route.sessionId}::uuid,
                ${installationId}::uuid, ${bindingId}::uuid, ${surfaceRef},
                ${route.thread.channelId}, ${route.thread.threadTs},
                ${route.thread.messageTs}, ${route.agentId}::uuid,
                ${session.agent_release_id}, ${route.requesterUserId}::uuid,
                -- After any input that went in while this waited for the row.
                clock_timestamp())
              ON CONFLICT DO NOTHING
              RETURNING id`),
          );
          if (inserted.length === 0) throw new BindRefused("thread_taken");
          return "bound" as const;
        });
      } catch (error) {
        if (error instanceof BindRefused) return error.reason;
        throw error;
      }
    },

    async settle(
      route,
      effect: ConversationRouteEffect,
      line: SlackNoticeMessage | null,
      mirror: ConversationRouteTaskThread | null,
    ) {
      return db.transaction(async (tx) => {
        // After a hand-off of this turn writing its input, or before it
        // starts: the receipt read below is then the last word.
        await lockConversationTurnInput(tx, {
          workspaceId: route.workspaceId,
          sessionId: route.sessionId,
          turnId: route.turnId,
        });
        // An unhanded end takes back its DM hand-off's bind, whichever run
        // records it.
        if (effect !== "routed" && dmPersonOf(route) !== null) {
          await dropOwnBind(tx, route);
        }
        const written = rowsOf(
          await tx.execute(sql`
            UPDATE conversation_turns SET task_effect = ${effect}
            WHERE id = ${route.turnId}::uuid AND decision = 'route_to_task'
              AND task_effect IS NULL
              AND (${effect} = 'routed' OR NOT ${handedInput(route)})
              -- No other end for a turn whose input its task took.
            RETURNING id`),
        );
        await releaseKeptTurnRequest(tx, route.turnId);
        if (written.length === 0) return false;
        const { thread } = route;
        if (thread.slackAppId === null) return true;
        let post: {
          text: SlackNoticeMessage;
          dedupeKey: string;
          link?: string;
        };
        // Closed since its input went in (a stop before its first turn,
        // say): the effect stands, but no thread is pointed at it.
        const task =
          mirror === null ? null : await openTaskThread(tx, route, true);
        if (task !== null) {
          const pointed = await pointThreadMirror(tx, {
            workspaceId: route.workspaceId,
            agentId: route.agentId,
            installationId: thread.installationId,
            channelId: thread.channelId,
            threadTs: thread.threadTs,
            sessionId: route.sessionId,
          });
          if (pointed === null) return true;
          post = {
            text: "routeMirror",
            dedupeKey: taskMirrorDedupeKey(pointed),
            link: slackMessageUrl(task.channelId, task.threadTs),
          };
        } else if (line !== null) {
          // One line per turn, as its answer would be.
          post = {
            text: line,
            dedupeKey: conversationReplyDedupeKey(route.turnId),
          };
        } else {
          return true;
        }
        const [requester] = rowsOf<{ locale: UserLocale | null }>(
          await tx.execute(sql`
            SELECT locale FROM users WHERE id::text = ${route.requesterUserId}`),
        );
        const locale = requester?.locale ?? DEFAULT_USER_LOCALE;
        await createPostgresSlackOutboxStore(tx).enqueue({
          workspaceId: route.workspaceId,
          agentId: route.agentId,
          slackAppId: thread.slackAppId,
          installationId: thread.installationId,
          kind: "conversation_reply",
          channelId: thread.channelId,
          threadTs: thread.threadTs,
          slackUserId: null,
          sessionLinkId: null,
          sessionId: null,
          body: {
            text: SLACK_NOTICE_MESSAGES[locale][post.text],
            locale,
            ...(post.link === undefined ? {} : { link_url: post.link }),
          },
          dedupeKey: post.dedupeKey,
          // The turn's whole set: a delete of any of it stops the line (③).
          sources: route.sources,
          conversationTurnId: route.turnId,
        });
        return true;
      });
    },
  };
}

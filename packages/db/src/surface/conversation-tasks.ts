import {
  type ConversationTaskEffect,
  DEFAULT_USER_LOCALE,
  SLACK_NOTICE_MESSAGES,
  type UserLocale,
} from "@werft-ai/contracts";
import type {
  ConversationTaskDraft,
  ConversationTaskStore,
  ConversationTurnSurfaceSubject,
  PendingConversationTask,
  SecretKey,
  StoredSourceSet,
  SurfaceOutboxStore,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import {
  keptTurnRequest,
  lockedDeletedSource,
  releaseKeptTurnRequest,
} from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { conversationReplyDedupeKey } from "./conversation-replies.ts";

/**
 * What a mention turn's spawn_task decision reads and writes (v1-b/E3). The
 * thread, the requester and the request are the server's records, never
 * the model's text: the model gave the draft alone.
 */
export function createPostgresConversationTasks(
  db: Database,
  outbox: Pick<SurfaceOutboxStore, "enqueue">,
  secretKey: SecretKey,
): ConversationTaskStore {
  return {
    async pending(turnId) {
      const [turn] = rowsOf<{
        workspace_id: string;
        agent_id: string;
        conversation_id: string;
        topic_id: string | null;
        requester_kind: string;
        requester_id: string;
        task_draft: ConversationTaskDraft | null;
        slack_subject: ConversationTurnSurfaceSubject | null;
        sources: StoredSourceSet | null;
        release_id: string | null;
        installation_id: string | null;
        slack_app_id: string | null;
        binding_id: string | null;
        surface_kind: string | null;
        thread_ts: string | null;
        team_id: string | null;
        channel_id: string | null;
        ts: string | null;
      }>(
        await db.execute(sql`
          SELECT t.workspace_id, t.agent_id, t.conversation_id, t.topic_id,
            t.requester_kind, t.requester_id, t.task_draft, t.slack_subject,
            t.sources, t.release_id,
            t.slack_installation_id AS installation_id,
            (SELECT sa.id FROM slack_installations i
              JOIN slack_apps sa ON sa.app_id = i.app_id
              WHERE i.id = t.slack_installation_id
                AND sa.agent_id = t.agent_id) AS slack_app_id,
            b.id AS binding_id, b.surface_kind,
            tp.slack_thread_ts AS thread_ts,
            e.team_id, e.channel_id, e.ts
          FROM conversation_turns t
          JOIN conversation_topics tp ON tp.id = t.topic_id
          -- A person's mention alone opens a task (G2), never unsolicited talk.
          JOIN conversation_engagements e ON e.conversation_turn_id = t.id
            AND e.kind = 'mention'
          LEFT JOIN LATERAL (
            SELECT sb.id, sb.surface_kind FROM surface_bindings sb
            WHERE sb.installation_id = t.slack_installation_id
              AND sb.agent_id = t.agent_id
              AND sb.external_surface_id = e.channel_id
              AND sb.status = 'ready'
            ORDER BY sb.created_at DESC LIMIT 1) b ON true
          WHERE t.id = ${turnId}::uuid AND t.origin = 'm2'
            AND t.state = 'decided' AND t.decision = 'spawn_task'
            AND t.task_effect IS NULL`),
      );
      if (
        turn === undefined ||
        turn.task_draft === null ||
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
        thread: {
          installationId: turn.installation_id,
          slackAppId: turn.slack_app_id,
          surfaceBindingId: turn.binding_id,
          teamId: turn.team_id,
          channelId: turn.channel_id,
          threadTs: turn.thread_ts,
          messageTs: turn.ts,
        },
        shareScope:
          turn.surface_kind === "dm"
            ? "private"
            : turn.surface_kind === "private_channel"
              ? "private_channel"
              : null,
        releaseId: turn.release_id,
        requesterUserId: turn.requester_id,
        draft: turn.task_draft,
        subject: turn.slack_subject,
        sources: turn.sources,
      } as PendingConversationTask;
    },

    async sourceDeleted(task) {
      return db.transaction(
        async (tx) =>
          (await lockedDeletedSource(tx, {
            workspaceId: task.workspaceId,
            sessionId: null,
            sources: task.sources,
            throughTurn: null,
          })) !== null,
      );
    },

    requestText: (turnId) => keptTurnRequest(db, secretKey, turnId),

    async settle(turnId, effect: ConversationTaskEffect) {
      return db.transaction(async (tx) => {
        const written = rowsOf(
          await tx.execute(sql`
            UPDATE conversation_turns SET task_effect = ${effect}
            WHERE id = ${turnId}::uuid AND decision = 'spawn_task'
              AND task_effect IS NULL
            RETURNING id`),
        );
        await releaseKeptTurnRequest(tx, turnId);
        return written.length > 0;
      });
    },

    async tellThread(task, message) {
      if (task.thread.slackAppId === null) return;
      const [requester] = rowsOf<{ locale: UserLocale | null }>(
        await db.execute(sql`
          SELECT locale FROM users WHERE id::text = ${task.requesterUserId}`),
      );
      const locale = requester?.locale ?? DEFAULT_USER_LOCALE;
      await outbox.enqueue({
        workspaceId: task.workspaceId,
        agentId: task.agentId,
        slackAppId: task.thread.slackAppId,
        installationId: task.thread.installationId,
        kind: "conversation_reply",
        channelId: task.thread.channelId,
        threadTs: task.thread.threadTs,
        slackUserId: null,
        sessionLinkId: null,
        sessionId: null,
        body: { text: SLACK_NOTICE_MESSAGES[locale][message], locale },
        // One line per turn, as its answer would be.
        dedupeKey: conversationReplyDedupeKey(task.turnId),
        sources: task.sources,
        conversationTurnId: task.turnId,
      });
    },

    async dropUnopenedLink(link) {
      await db.execute(sql`
        DELETE FROM session_links
        WHERE id = ${link.id}::uuid AND session_id IS NULL
          AND opened_by_ts = ${link.openedByTs}`);
    },
  };
}

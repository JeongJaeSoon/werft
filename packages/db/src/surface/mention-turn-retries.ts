import {
  type ConversationInputId,
  DEFAULT_USER_LOCALE,
  SLACK_NOTICE_MESSAGES,
  type SlackNoticeMessage,
  type UserLocale,
} from "@werft-ai/contracts";
import type {
  ConversationTurnSurfaceSubject,
  MentionTurnAttempt,
  MentionTurnLine,
  MentionTurnRetryRequest,
  MentionTurnRetryRequests,
  MentionTurnRetryStore,
  SecretKey,
  StoredSourceSet,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import {
  keptTurnRequest,
  releaseKeptTurnRequest,
} from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { conversationReplyDedupeKey } from "./conversation-replies.ts";
import { createPostgresSlackOutboxStore } from "./slack-outbox.ts";

/** A mention's "trying again" line: one per input, however many tries. */
export const MENTION_RETRY_NOTICE_KEY_PREFIX = "mention_retry_notice:";
const retryNoticeKey = (inputId: ConversationInputId) =>
  `${MENTION_RETRY_NOTICE_KEY_PREFIX}${inputId}`;

/**
 * A mention turn's tries (v1-b/F1): where each stands, the lines its thread
 * is told, and the input a next try is written from. Every line goes in the
 * turn's topic thread, with the turn's sources, so a delete stops it.
 */
export function createPostgresMentionTurnRetries(
  db: Database,
  secretKey: SecretKey,
): MentionTurnRetryStore & MentionTurnRetryRequests {
  return {
    async attemptOf(turnId): Promise<MentionTurnAttempt | null> {
      const [row] = rowsOf<{
        input_id: ConversationInputId;
        attempt: number;
        ended_at: Date | string | null;
        went_out: boolean;
        call_in_flight: boolean;
      }>(
        await db.execute(sql`
          SELECT q.input_id, q.attempt, q.ended_at,
            (t.decision IS NOT NULL OR t.task_effect IS NOT NULL
              OR EXISTS (SELECT 1 FROM slack_outbox o
                WHERE o.conversation_turn_id = t.id
                  AND left(o.dedupe_key, ${MENTION_RETRY_NOTICE_KEY_PREFIX.length})
                    <> ${MENTION_RETRY_NOTICE_KEY_PREFIX})) AS went_out,
            EXISTS (SELECT 1 FROM conversation_calls c
              WHERE c.conversation_turn_id = t.id
                AND c.state = 'in_flight') AS call_in_flight
          FROM conversation_turn_queue q
          JOIN conversation_turns t ON t.id = q.turn_id
          WHERE q.turn_id = ${turnId}::uuid AND t.origin = 'm2'`),
      );
      if (row === undefined) return null;
      return {
        inputId: row.input_id,
        attempt: Number(row.attempt),
        endedAt: row.ended_at === null ? null : new Date(row.ended_at),
        wentOut: row.went_out,
        callInFlight: row.call_in_flight,
      };
    },

    async tell(turnId, line: MentionTurnLine) {
      const [turn] = rowsOf<{
        workspace_id: string;
        agent_id: string;
        sources: StoredSourceSet | null;
        installation_id: string | null;
        channel_id: string | null;
        thread_ts: string | null;
        slack_app_id: string | null;
        locale: UserLocale | null;
        input_id: ConversationInputId | null;
        user_root: boolean | null;
      }>(
        await db.execute(sql`
          SELECT t.workspace_id, t.agent_id, t.sources,
            t.slack_installation_id AS installation_id,
            tp.slack_channel_id AS channel_id,
            tp.slack_thread_ts AS thread_ts,
            (SELECT sa.id FROM slack_installations i
              JOIN slack_apps sa ON sa.app_id = i.app_id
              WHERE i.id = t.slack_installation_id
                AND sa.agent_id = t.agent_id) AS slack_app_id,
            u.locale, q.input_id,
            p.requester_user_id IS NOT NULL AS user_root
          FROM conversation_turns t
          JOIN conversation_topics tp ON tp.id = t.topic_id
          LEFT JOIN users u
            ON t.requester_kind = 'user' AND u.id::text = t.requester_id
          LEFT JOIN conversation_turn_queue q ON q.turn_id = t.id
          LEFT JOIN conversation_turn_permits p ON p.turn_id = t.id
          WHERE t.id = ${turnId}::uuid AND t.origin = 'm2'`),
      );
      if (
        turn === undefined ||
        turn.installation_id === null ||
        turn.slack_app_id === null ||
        turn.channel_id === null ||
        !turn.thread_ts ||
        (line === "retrying" && turn.input_id === null)
      ) {
        return "no_thread";
      }
      // Whose account refused, as the call's grant chose it (v1-b/F2).
      const text: SlackNoticeMessage =
        line === "retrying"
          ? "mentionRetrying"
          : line === "failed"
            ? "mentionFailed"
            : turn.user_root === false
              ? "budgetAccountTeam"
              : "budgetAccountUser";
      const locale = turn.locale ?? DEFAULT_USER_LOCALE;
      const enqueued = await createPostgresSlackOutboxStore(db).enqueue({
        workspaceId: turn.workspace_id,
        agentId: turn.agent_id,
        slackAppId: turn.slack_app_id,
        installationId: turn.installation_id,
        kind: "conversation_reply",
        channelId: turn.channel_id,
        threadTs: turn.thread_ts,
        slackUserId: null,
        sessionLinkId: null,
        sessionId: null,
        body: { text: SLACK_NOTICE_MESSAGES[locale][text], locale },
        // The last line is the turn's one line, as its answer would be.
        dedupeKey:
          line === "retrying" && turn.input_id !== null
            ? retryNoticeKey(turn.input_id)
            : conversationReplyDedupeKey(turnId),
        sources: turn.sources,
        conversationTurnId: turnId,
      });
      return enqueued === "enqueued" ? "enqueued" : "duplicate";
    },

    async letGo(turnId) {
      await releaseKeptTurnRequest(db, turnId);
    },

    async requestOf(turnId): Promise<MentionTurnRetryRequest | "moved" | null> {
      const [turn] = rowsOf<{
        workspace_id: string;
        agent_id: string;
        conversation_id: string;
        topic_id: string;
        slack_installation_id: string;
        requester_id: string;
        slack_subject: ConversationTurnSurfaceSubject | null;
        input_id: ConversationInputId;
        attempt: number;
        team_id: string | null;
        channel_id: string | null;
        ts: string | null;
      }>(
        await db.execute(sql`
          SELECT t.workspace_id, t.agent_id, t.conversation_id, t.topic_id,
            t.slack_installation_id, t.requester_id, t.slack_subject,
            q.input_id, q.attempt, e.team_id, e.channel_id, e.ts
          FROM conversation_turns t
          JOIN conversation_turn_queue q ON q.turn_id = t.id
          LEFT JOIN conversation_engagements e
            ON e.conversation_turn_id = t.id AND e.kind = 'mention'
          WHERE t.id = ${turnId}::uuid AND t.origin = 'm2'
            AND t.requester_kind = 'user'
            AND t.slack_installation_id IS NOT NULL
            AND t.topic_id IS NOT NULL`),
      );
      if (turn === undefined) return null;
      if (
        turn.team_id === null ||
        turn.channel_id === null ||
        turn.ts === null
      ) {
        return "moved";
      }
      const text = await keptTurnRequest(db, secretKey, turnId);
      if (text === null) return null;
      return {
        workspaceId: turn.workspace_id,
        agentId: turn.agent_id,
        conversationId: turn.conversation_id,
        topicId: turn.topic_id,
        slackInstallationId: turn.slack_installation_id,
        message: {
          teamId: turn.team_id,
          channelId: turn.channel_id,
          ts: turn.ts,
        },
        requesterUserId: turn.requester_id,
        text,
        slackSubject: turn.slack_subject,
        inputId: turn.input_id,
        attempt: Number(turn.attempt),
      } as MentionTurnRetryRequest;
    },
  };
}

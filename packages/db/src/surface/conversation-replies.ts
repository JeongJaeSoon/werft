import type { ConversationTurnId, UserLocale } from "@werft-ai/contracts";
import type {
  ConversationReplyEffect,
  ConversationReplyStore,
  StoredSourceSet,
  SurfaceOutboxStore,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/** One turn's answer row: the same turn twice enqueues once. */
export const conversationReplyDedupeKey = (turnId: ConversationTurnId) =>
  `conversation_reply:${turnId}`;

/**
 * The effect of a conversation turn's "reply" decision (v1-b/E1): its
 * answer as an outbox row of no session. Everything the row holds is the
 * server's: the answer the decision recorded, the topic's channel and
 * thread, the turn's sources (delete check ③ at send), and the requester
 * the turn was written with.
 */
export function createPostgresConversationReplies(
  db: Database,
  outbox: Pick<SurfaceOutboxStore, "enqueue">,
): ConversationReplyStore {
  return {
    async post(turnId): Promise<ConversationReplyEffect> {
      const [turn] = rowsOf<{
        workspace_id: string;
        agent_id: string;
        state: string;
        decision: string | null;
        answer_text: string | null;
        sources: StoredSourceSet | null;
        installation_id: string | null;
        channel_id: string | null;
        thread_ts: string | null;
        slack_app_id: string | null;
        requester_name: string | null;
        requester_locale: UserLocale | null;
      }>(
        await db.execute(sql`
          SELECT t.workspace_id, t.agent_id, t.state, t.decision,
            t.answer_text, t.sources,
            t.slack_installation_id AS installation_id,
            tp.slack_channel_id AS channel_id,
            tp.slack_thread_ts AS thread_ts,
            (SELECT sa.id FROM slack_installations i
              JOIN slack_apps sa ON sa.app_id = i.app_id
              WHERE i.id = t.slack_installation_id
                AND sa.agent_id = t.agent_id) AS slack_app_id,
            u.display_name AS requester_name, u.locale AS requester_locale
          FROM conversation_turns t
          JOIN conversation_topics tp ON tp.id = t.topic_id
          LEFT JOIN users u
            ON t.requester_kind = 'user' AND u.id::text = t.requester_id
          WHERE t.id = ${turnId}::uuid AND t.origin = 'm2'`),
      );
      // Only a recorded reply posts; a turn a delete voided holds none.
      if (
        turn === undefined ||
        turn.state !== "decided" ||
        turn.decision !== "reply" ||
        turn.answer_text === null
      ) {
        return "none";
      }
      if (
        turn.installation_id === null ||
        turn.slack_app_id === null ||
        turn.channel_id === null ||
        !turn.thread_ts
      ) {
        return "no_thread";
      }
      const name = turn.requester_name?.replace(/\s+/g, " ").trim();
      const enqueued = await outbox.enqueue({
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
        body: {
          text: turn.answer_text,
          ...(turn.requester_locale === null
            ? {}
            : { locale: turn.requester_locale }),
          ...(name ? { requested_by: name } : {}),
        },
        dedupeKey: conversationReplyDedupeKey(turnId),
        sources: turn.sources,
        conversationTurnId: turnId,
      });
      return enqueued === "enqueued" ? "enqueued" : "duplicate";
    },
  };
}

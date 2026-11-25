import type { ConversationTurnId } from "@werft-ai/contracts";
import {
  CONVERSATION_ANSWERING_DECISIONS,
  type ConversationReactionEffect,
  type ConversationReactionStore,
  type SurfaceOutboxStore,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/** One 👀 per Slack team, channel and message, whichever agent asked. */
export const conversationReactionDedupeKey = (target: {
  teamId: string;
  channelId: string;
  ts: string;
}) => `reaction:${target.teamId}:${target.channelId}:${target.ts}`;

/**
 * The 👀 of a conversation turn that took the message on (v1-b/E2): a
 * `reaction` outbox row for the message that called the turn, which its
 * engagement names. Which message it is, and whether the app may react, are
 * the server's records, never the model's text.
 */
export function createPostgresConversationReactions(
  db: Database,
  outbox: Pick<SurfaceOutboxStore, "enqueue">,
  /** The bot scope `reactions.add` needs. */
  scope: string,
): ConversationReactionStore {
  return {
    async react(
      turnId: ConversationTurnId,
    ): Promise<ConversationReactionEffect> {
      const [turn] = rowsOf<{
        workspace_id: string;
        agent_id: string;
        state: string;
        decision: string | null;
        installation_id: string | null;
        slack_app_id: string | null;
        granted: boolean | null;
        team_id: string | null;
        channel_id: string | null;
        ts: string | null;
      }>(
        await db.execute(sql`
          SELECT t.workspace_id, t.agent_id, t.state, t.decision,
            t.slack_installation_id AS installation_id,
            sa.id AS slack_app_id,
            COALESCE(${scope} = ANY (sa.bot_scopes), false) AS granted,
            e.team_id, e.channel_id, e.ts
          FROM conversation_turns t
          LEFT JOIN slack_installations i ON i.id = t.slack_installation_id
          LEFT JOIN slack_apps sa
            ON sa.app_id = i.app_id AND sa.agent_id = t.agent_id
          LEFT JOIN conversation_engagements e
            ON e.conversation_turn_id = t.id
          WHERE t.id = ${turnId}::uuid AND t.origin = 'm2'`),
      );
      if (
        turn === undefined ||
        turn.state !== "decided" ||
        turn.decision === null ||
        !CONVERSATION_ANSWERING_DECISIONS.includes(
          turn.decision as (typeof CONVERSATION_ANSWERING_DECISIONS)[number],
        )
      ) {
        return "none";
      }
      if (
        turn.installation_id === null ||
        turn.slack_app_id === null ||
        turn.team_id === null ||
        turn.channel_id === null ||
        turn.ts === null
      ) {
        return "no_message";
      }
      // An install from before the scope: the answer goes, the call is not made.
      if (turn.granted !== true) return "no_scope";
      const enqueued = await outbox.enqueue({
        workspaceId: turn.workspace_id,
        agentId: turn.agent_id,
        slackAppId: turn.slack_app_id,
        installationId: turn.installation_id,
        kind: "reaction",
        channelId: turn.channel_id,
        threadTs: turn.ts,
        slackUserId: null,
        sessionLinkId: null,
        sessionId: null,
        body: { text: "" },
        dedupeKey: conversationReactionDedupeKey({
          teamId: turn.team_id,
          channelId: turn.channel_id,
          ts: turn.ts,
        }),
      });
      return enqueued === "enqueued" ? "enqueued" : "duplicate";
    },
  };
}

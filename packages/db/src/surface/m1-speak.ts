import { randomUUID } from "node:crypto";
import type { ConversationJudgmentId } from "@werft-ai/contracts";
import type { M1Speak, M1SpeakStore } from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import { lockSlackSourceMark } from "../conversations/source-mark-lock.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/** The inbox event id of a held reply a verdict sent on to its work. */
export function m1SpeakEventId(judgmentId: ConversationJudgmentId): string {
  return `werft-m1:${judgmentId}`;
}

const voidSpeakIn = (db: Database, judgmentId: ConversationJudgmentId) =>
  db.execute(sql`
    UPDATE conversation_judgments
    SET decision = 'quiet', reason = 'invalid_target'
    WHERE id = ${judgmentId}::uuid
      AND outcome = 'judged' AND decision = 'speak'`);

export function createPostgresM1SpeakStore(db: Database): M1SpeakStore {
  return {
    sendOnToWork(speak: M1Speak) {
      const message = {
        workspaceId: speak.workspaceId,
        teamId: speak.teamId,
        channelId: speak.channelId,
        ts: speak.post.ts,
      };
      return db.transaction(async (tx) => {
        // The mark lock first, as a delete takes it: one under way is waited
        // for, and one after this finds the event in the inbox, which the
        // receive path drops as it does any deleted message's.
        await tx.execute(lockSlackSourceMark(message));
        const [deleted] = rowsOf(
          await tx.execute(sql`
            SELECT 1 FROM deleted_sources
            WHERE (workspace_id, team_id, channel_id, ts)
              = (${message.workspaceId}::uuid, ${message.teamId},
                 ${message.channelId}, ${message.ts})`),
        );
        if (deleted !== undefined) {
          await voidSpeakIn(tx, speak.judgmentId);
          return "source_deleted" as const;
        }
        // Shared, as a change of the rollout writes the agent's row.
        const [agent] = rowsOf<{ rollout: string }>(
          await tx.execute(sql`
            SELECT conversation_rollout AS rollout FROM agents
            WHERE id = ${speak.agentId}::uuid
              AND workspace_id = ${speak.workspaceId}::uuid
              AND deleted_at IS NULL
            FOR SHARE`),
        );
        if (agent?.rollout !== "on") return "not_on" as const;
        // The reply as the buffer holds it now (an edit since is its text),
        // and the app the agent is live in there.
        const [held] = rowsOf<{
          body: string;
          requester_id: string;
          thread_ts: string;
          slack_app_id: string;
          app_id: string;
        }>(
          await tx.execute(sql`
            SELECT i.body, i.requester_id, t.slack_thread_ts AS thread_ts,
              a.id AS slack_app_id, si.app_id
            FROM conversation_judgments j
            JOIN conversation_inputs i ON i.id = j.input_id
            JOIN conversation_topics t ON t.id = i.topic_id
            JOIN surface_bindings b ON b.agent_id = j.agent_id
              AND b.surface = 'slack'
              AND b.external_surface_id = j.slack_channel_id
              AND b.revoked_at IS NULL
            JOIN slack_installations si ON si.id = b.installation_id
              AND si.team_id = j.slack_team_id
            JOIN slack_apps a ON a.app_id = si.app_id
              AND a.workspace_id = si.workspace_id
            WHERE j.id = ${speak.judgmentId}::uuid
              AND j.outcome = 'judged' AND j.decision = 'speak'
              AND i.buffer_expires_at IS NOT NULL
            ORDER BY b.id
            LIMIT 1`),
        );
        if (held === undefined) return "gone" as const;
        const [recorded] = rowsOf(
          await tx.execute(sql`
            INSERT INTO slack_inbound_events (
              id, workspace_id, agent_id, slack_app_id, team_id, app_id,
              event_id, event_type, status, payload, conversation_key
            ) VALUES (
              ${randomUUID()}::uuid, ${speak.workspaceId}::uuid,
              ${speak.agentId}::uuid, ${held.slack_app_id}::uuid,
              ${speak.teamId}, ${held.app_id},
              ${m1SpeakEventId(speak.judgmentId)}, 'message', 'received',
              ${JSON.stringify({
                event: {
                  type: "message",
                  channel: speak.channelId,
                  user: held.requester_id,
                  text: held.body,
                  ts: speak.post.ts,
                  thread_ts: held.thread_ts,
                },
              })}::jsonb,
              ${`${held.slack_app_id}:${speak.channelId}:${held.thread_ts}`}
            )
            ON CONFLICT (app_id, event_id) DO NOTHING
            RETURNING id`),
        );
        return recorded === undefined
          ? ("duplicate" as const)
          : ("to_task" as const);
      });
    },

    async voidSpeak(judgmentId) {
      await voidSpeakIn(db, judgmentId);
    },
  };
}

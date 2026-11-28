import { randomUUID } from "node:crypto";
import type { ConversationInputId } from "@werft-ai/contracts";
import type { InboundInputReceipt } from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { requestReplyJudgment } from "./conversation-judgments.ts";
import { lockSessionForSources, recordSourceInput } from "./turn-sources.ts";

/**
 * Takes the Slack message a turn came from as the next input of its topic,
 * the input's requester the turn's, and records how the agent took it. A
 * message taken already keeps its row. Runs in the transaction that inserts
 * the turn, so the two exist together or not at all; the inbox completion
 * runs it again only for a turn made before that.
 */
export async function takeSlackTurnInput(
  tx: Database,
  place: { workspaceId: string; agentId: string; teamId: string },
  input: InboundInputReceipt,
): Promise<void> {
  // The session before the topic, in the turn's insert and the inbox's
  // completion alike.
  await lockSessionForSources(tx, input.turn.sessionId);
  // One taker per topic at a time, so the topic's highest number plus one
  // is free.
  const topic = await tx.execute(sql`
    SELECT id FROM conversation_topics
    WHERE id = ${input.topicId}::uuid
      AND workspace_id = ${place.workspaceId}::uuid
      AND agent_id = ${place.agentId}::uuid
    FOR UPDATE`);
  if (rowsOf(topic).length === 0) {
    throw new Error(`topic ${input.topicId} is no topic of the event's agent`);
  }
  const [turn] = rowsOf<{
    id: string;
    requester_kind: string | null;
    requester_id: string | null;
  }>(
    await tx.execute(sql`
      SELECT t.id, t.requester_kind, t.requester_id
      FROM turns t JOIN sessions s ON s.id = t.session_id
      WHERE t.session_id = ${input.turn.sessionId}::uuid
        AND t.sequence = ${input.turn.sequence}
        AND s.workspace_id = ${place.workspaceId}::uuid`),
  );
  if (turn === undefined) {
    throw new Error(
      `turn ${input.turn.sequence} of session ${input.turn.sessionId} is missing`,
    );
  }
  if (
    (turn.requester_kind !== "user" && turn.requester_kind !== "slack_bot") ||
    turn.requester_id === null
  ) {
    throw new Error(`turn ${turn.id} has no Slack requester`);
  }
  // A reply held for its work's judgment (`m1_to_task`, v1-b/U1) before
  // its turn: the turn takes that row, the turn's text and requester now its
  // own. Any other held row, or one a batch has, stays the buffer's.
  await tx.execute(sql`
    UPDATE conversation_inputs SET turn_id = ${turn.id}::bigint,
      requester_kind = ${turn.requester_kind},
      requester_id = ${turn.requester_id},
      body = NULL, buffer_expires_at = NULL
    WHERE agent_id = ${place.agentId}::uuid
      AND slack_team_id = ${place.teamId}
      AND slack_channel_id = ${input.channelId}
      AND slack_ts = ${input.ts}
      AND buffer_expires_at IS NOT NULL AND turn_id IS NULL
      AND judgment_batch_id IS NULL AND EXISTS (
        SELECT 1 FROM conversation_judgments j
        WHERE j.input_id = conversation_inputs.id
          AND j.grade = 'm1_to_task')`);
  // A reply its work's closing let an unasked turn answer (94S-2506) is not
  // the session's too. The judgment's row lock waits out an issue still
  // writing its turn; input then judgment, as M1's finish takes them. The
  // throw undoes this turn and the event is seen again, answered.
  const answered = rowsOf<{ turn_id: string | null }>(
    await tx.execute(sql`
      SELECT j.turn_id FROM conversation_judgments j
      JOIN conversation_inputs i ON i.id = j.input_id
      WHERE i.agent_id = ${place.agentId}::uuid
        AND i.slack_team_id = ${place.teamId}
        AND i.slack_channel_id = ${input.channelId}
        AND i.slack_ts = ${input.ts}
        AND j.grade = 'm1_to_task'
      FOR SHARE OF j`),
  );
  if (answered.some((row) => row.turn_id !== null)) {
    throw new Error(
      `Slack post ${input.ts} was answered by an unasked turn; the session does not take it`,
    );
  }
  await tx.execute(sql`
    INSERT INTO conversation_inputs (
      id, workspace_id, agent_id, topic_id, seq,
      slack_team_id, slack_channel_id, slack_ts,
      requester_kind, requester_id, turn_id
    )
    SELECT ${randomUUID()}::uuid, ${place.workspaceId}::uuid,
      ${place.agentId}::uuid, ${input.topicId}::uuid,
      COALESCE(MAX(i.seq), 0) + 1,
      ${place.teamId}, ${input.channelId}, ${input.ts},
      ${turn.requester_kind}, ${turn.requester_id},
      ${turn.id}::bigint
    FROM conversation_inputs i WHERE i.topic_id = ${input.topicId}::uuid
    ON CONFLICT (agent_id, slack_team_id, slack_channel_id, slack_ts)
      DO NOTHING`);
  // The row this insert or an earlier take of the message wrote.
  const [taken] = rowsOf<{ id: ConversationInputId }>(
    await tx.execute(sql`
      SELECT id FROM conversation_inputs
      WHERE agent_id = ${place.agentId}::uuid
        AND slack_team_id = ${place.teamId}
        AND slack_channel_id = ${input.channelId}
        AND slack_ts = ${input.ts}`),
  );
  if (taken !== undefined && input.judgment !== undefined) {
    await requestReplyJudgment(tx, {
      workspaceId: place.workspaceId,
      agentId: place.agentId,
      teamId: place.teamId,
      channelId: input.channelId,
      ts: input.ts,
      topicId: input.topicId,
      inputId: taken.id,
      sessionId: input.turn.sessionId,
      rule: input.judgment.rule,
    });
  }
  if (taken !== undefined) {
    await recordSourceInput(tx, {
      sessionId: input.turn.sessionId,
      inputId: taken.id,
      place: {
        teamId: place.teamId,
        channelId: input.channelId,
        ts: input.ts,
      },
    });
  }
  await tx.execute(sql`
    INSERT INTO conversation_engagements (
      workspace_id, agent_id, team_id, channel_id, ts, kind, session_id
    ) VALUES (
      ${place.workspaceId}::uuid, ${place.agentId}::uuid, ${place.teamId},
      ${input.channelId}, ${input.ts}, ${input.engagement},
      ${input.turn.sessionId}::uuid
    )
    ON CONFLICT DO NOTHING`);
}

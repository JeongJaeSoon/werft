import type { SlackMessageRef } from "@werft-ai/contracts";
import { taskRequestSchema } from "@werft-ai/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * Whether a task of the release's agent, in `conversationId`, would pass the
 * open tasks its conversation or its agent may have: the scope it would go
 * over, or null. Takes the agent's task lock to the end of the caller's
 * transaction, so two acceptances count one after the other. A task is open
 * from its acceptance until its session closes (decision 35).
 */
export async function openTaskLimit(
  tx: Database,
  input: {
    releaseId: string;
    conversationId: string | null;
    limits: { conversation: number; agent: number };
  },
): Promise<"conversation" | "agent" | null> {
  const [agent] = rowsOf<{ agent_id: string }>(
    await tx.execute(sql`
      SELECT agent_id FROM agent_releases WHERE id = ${input.releaseId}`),
  );
  if (agent === undefined) {
    throw new Error(`release ${input.releaseId} has no agent`);
  }
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('task_open:' || ${agent.agent_id}))`,
  );
  const [open] = rowsOf<{ conversation: number; agent: number }>(
    await tx.execute(sql`
      SELECT
        count(*) FILTER (
          WHERE s.parent_conversation_id = ${input.conversationId}::uuid
        )::int AS conversation,
        count(*)::int AS agent
      FROM sessions s
      JOIN agent_releases r ON r.id = s.agent_release_id
      WHERE r.agent_id = ${agent.agent_id}::uuid
        AND s.task_closing IS NOT NULL
        AND s.admission_state NOT IN ('closing', 'closed')`),
  );
  if ((open?.conversation ?? 0) >= input.limits.conversation) {
    return "conversation";
  }
  if ((open?.agent ?? 0) >= input.limits.agent) return "agent";
  return null;
}

/**
 * Writes a task session's request (G6): the requester's text, attached by
 * the server, and the input turn 1 took its Slack message as. In the
 * acceptance's transaction, after that input is taken.
 */
export async function writeTaskRequest(
  tx: Database,
  input: {
    sessionId: string;
    agentReleaseId: string;
    slackMessage: SlackMessageRef | undefined;
    text: string;
  },
): Promise<void> {
  const message = input.slackMessage;
  if (message === undefined) {
    throw new Error("a task session needs the Slack message it came from");
  }
  const [taken] = rowsOf<{ id: string }>(
    await tx.execute(sql`
      SELECT i.id FROM conversation_inputs i
      JOIN agent_releases r ON r.agent_id = i.agent_id
      WHERE r.id = ${input.agentReleaseId}
        AND i.slack_team_id = ${message.team_id}
        AND i.slack_channel_id = ${message.channel_id}
        AND i.slack_ts = ${message.ts}`),
  );
  if (taken === undefined) {
    throw new Error("a task session's message was not taken as an input");
  }
  const request = taskRequestSchema.parse({
    inputId: taken.id,
    text: input.text,
  });
  await tx.execute(sql`
    UPDATE sessions SET task_request = ${JSON.stringify(request)}::jsonb
    WHERE id = ${input.sessionId}::uuid AND task_request IS NULL`);
}

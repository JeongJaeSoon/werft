import { randomUUID } from "node:crypto";
import {
  type ConversationInputId,
  type ConversationTopicId,
  type JudgmentRule,
  M1_PROMPT_VERSION,
} from "@werft-ai/contracts";
import {
  M1_CHANNEL_WINDOW_MS,
  M1_JUDGMENTS_PER_CHANNEL_WINDOW,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { sessionWorkClosed } from "./session-work.ts";

/**
 * Whether a buffered row (alias `i`) is held for a reply's judgment, not
 * for a batch: a thread the agent took part in with no session (`m1_engaged`).
 */
export const heldForReply = sql`EXISTS (
  SELECT 1 FROM conversation_judgments j WHERE j.input_id = i.id)`;

/**
 * The `m1_engaged` judgments of a channel in M1's window that count against
 * its cap with the batches: taken, and called the model or may have.
 */
export function engagedJudgmentsInWindow(channel: {
  agentId: SQL;
  teamId: SQL;
  channelId: SQL;
  at: SQL;
}): SQL {
  return sql`(SELECT count(*) FROM conversation_judgments j
    WHERE j.agent_id = ${channel.agentId}
      AND j.slack_team_id = ${channel.teamId}
      AND j.slack_channel_id = ${channel.channelId}
      AND j.grade = 'm1_engaged'
      AND j.claimed_at > ${channel.at} - make_interval(secs => ${M1_CHANNEL_WINDOW_MS / 1000})
      AND (j.outcome IS NULL OR j.attempts > 0))`;
}

/**
 * M1's cap of a channel: its live binding's, or the starting one when the
 * channel has none.
 */
export function m1ChannelCap(channel: { agentId: SQL; channelId: SQL }): SQL {
  return sql`COALESCE((SELECT sb.m1_judgments_per_hour FROM surface_bindings sb
    WHERE sb.agent_id = ${channel.agentId} AND sb.surface = 'slack'
      AND sb.external_surface_id = ${channel.channelId}
      AND sb.revoked_at IS NULL
    ORDER BY sb.created_at DESC LIMIT 1), ${M1_JUDGMENTS_PER_CHANNEL_WINDOW})`;
}

/**
 * Writes the waiting judgment of an unmentioned reply, in the transaction
 * that takes it: `m1_to_task` while its session's work is open, `m1` once it
 * is closed (decision 35, `sessionWorkClosed`),
 * `m1_engaged` for one held with no session, or the bound thread's grade
 * a held one names (`heldAs`). A reply already waiting or judged adds none.
 */
export async function requestReplyJudgment(
  tx: Database,
  input: {
    workspaceId: string;
    agentId: string;
    teamId: string;
    channelId: string;
    ts: string;
    topicId: ConversationTopicId;
    inputId: ConversationInputId;
    /** The session the reply became a turn of; none for one held. */
    sessionId: string | null;
    /** A held reply of a thread bound to work (v1-b/U1). */
    heldAs?: "m1" | "m1_to_task";
    rule: JudgmentRule;
  },
): Promise<void> {
  let grade: string = input.heldAs ?? "m1_engaged";
  if (input.sessionId !== null) {
    const [session] = rowsOf<{ admission_state: string }>(
      await tx.execute(sql`
        SELECT admission_state FROM sessions WHERE id = ${input.sessionId}::uuid`),
    );
    grade = sessionWorkClosed(session?.admission_state) ? "m1" : "m1_to_task";
  }
  await tx.execute(sql`
    INSERT INTO conversation_judgments (
      id, workspace_id, agent_id, conversation_id, grade, slack_team_id,
      slack_channel_id, refs, input_id, prompt_version, rule_decision,
      rule_reason
    )
    SELECT ${randomUUID()}::uuid, ${input.workspaceId}::uuid,
      ${input.agentId}::uuid, t.conversation_id, ${grade}, ${input.teamId},
      ${input.channelId}, ARRAY[${input.ts}]::text[], ${input.inputId}::uuid,
      ${M1_PROMPT_VERSION}, ${input.rule.decision}, ${input.rule.reason}
    FROM conversation_topics t
    JOIN agents a ON a.id = t.agent_id
    WHERE t.id = ${input.topicId}::uuid
      -- The gate as far as this transaction can see it; the judge asks it
      -- again before the call and the record.
      AND a.conversation_rollout <> 'off'
      AND NOT EXISTS (
        SELECT 1 FROM surface_bindings b
        WHERE b.agent_id = t.agent_id AND b.surface = 'slack'
          AND b.external_surface_id = ${input.channelId} AND b.external_shared)
    ON CONFLICT (input_id) WHERE input_id IS NOT NULL DO NOTHING`);
}

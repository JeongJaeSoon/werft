import {
  ENDED_SESSION_STATUSES,
  TASK_CLOSING_DEFAULT,
  taskClosingSchema,
} from "@werft-ai/contracts";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * Whether `session` (a sessions row) is a standalone session of `person`
 * that their DM with the agent sees as an open task (v1-b/DM3): of the
 * agent's releases, made by the person themselves (never by a key), with no
 * parent conversation and no link ever, not a preview and not
 * ended. Read for the DM's own person alone; a channel turn never reads it.
 */
export const standaloneTaskOf = (
  session: SQL,
  input: { workspaceId: string; agentId: string; personUserId: string },
) => sql`(
  ${session}.workspace_id = ${input.workspaceId}::uuid
  AND ${session}.parent_conversation_id IS NULL
  AND ${session}.created_by_user_id = ${input.personUserId}::uuid
  AND ${session}.created_by_api_key_id IS NULL
  AND NOT ${session}.preview
  AND ${session}.status::text NOT IN (${sql.join(
    ENDED_SESSION_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  )})
  AND EXISTS (SELECT 1 FROM agent_releases sar
    WHERE sar.id = ${session}.agent_release_id
      AND sar.agent_id = ${input.agentId}::uuid)
  AND NOT EXISTS (SELECT 1 FROM session_links ssl
    WHERE ssl.session_id = ${session}.id)
)`;

/**
 * The closing rules a standalone session handed to from a DM takes: those
 * a task the DM opens gets (spawn_task), so the close button, the time
 * rules and the pull request close treat it as the DM's other tasks.
 */
export const handOffClosing = () =>
  sql`${JSON.stringify(taskClosingSchema.parse(TASK_CLOSING_DEFAULT))}::jsonb`;

/**
 * Brings the closing rules of DM hand-offs (v1-b/DM3) in line with them, at
 * most `limit` sessions each way. A session handed to by an image that did
 * not write them gets them: still open, its open primary link opened by
 * the message of a DM's route_to_task turn that named it and ended. Ended,
 * whatever its effect: the end takes an unused bind back in the same
 * transaction, so a link still there is a kept one (an input went in by
 * it); a bind still in flight writes its own. A session a hand-off was
 * taken back from without them (no parent and no link left) loses them.
 * Neither has an interpretation, which a task opened as one always has,
 * and rules already there stay.
 */
export async function syncHandOffClosing(
  db: Database,
  options: { dryRun: boolean; limit: number },
): Promise<{ filled: number; cleared: number }> {
  const handed = sql`
    s.task_closing IS NULL
    AND s.task_interpretation IS NULL
    AND s.parent_conversation_id IS NOT NULL
    AND s.admission_state NOT IN ('closing', 'closed')
    AND EXISTS (SELECT 1 FROM conversation_turns t
      JOIN conversations c ON c.id = t.conversation_id AND c.kind = 'dm'
      JOIN conversation_engagements e ON e.conversation_turn_id = t.id
        AND e.kind = 'mention'
      JOIN session_links sl ON sl.session_id = s.id
        AND sl.role = 'primary'
        AND sl.closed_at IS NULL AND sl.revoked_at IS NULL
        AND sl.installation_id = t.slack_installation_id
        AND sl.channel_id = e.channel_id
        AND sl.opened_by_ts = e.ts
      WHERE t.routed_session_id = s.id
        AND t.conversation_id = s.parent_conversation_id
        AND t.decision = 'route_to_task'
        AND t.task_effect IS NOT NULL)`;
  const takenBack = sql`
    s.task_closing IS NOT NULL
    AND s.task_interpretation IS NULL
    AND s.parent_conversation_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM session_links ssl
      WHERE ssl.session_id = s.id)`;
  if (options.dryRun) {
    const [row] = rowsOf<{ filled: number; cleared: number }>(
      await db.execute(sql`
        SELECT
          (SELECT count(*)::int FROM (SELECT 1 FROM sessions s
            WHERE ${handed} LIMIT ${options.limit}) f) AS filled,
          (SELECT count(*)::int FROM (SELECT 1 FROM sessions s
            WHERE ${takenBack} LIMIT ${options.limit}) c) AS cleared`),
    );
    return { filled: row?.filled ?? 0, cleared: row?.cleared ?? 0 };
  }
  // A session another write holds is left to the next pass.
  const filled = rowsOf(
    await db.execute(sql`
      UPDATE sessions SET task_closing = ${handOffClosing()}
      WHERE id IN (SELECT s.id FROM sessions s WHERE ${handed}
        ORDER BY s.id LIMIT ${options.limit}
        FOR UPDATE OF s SKIP LOCKED)
        AND task_closing IS NULL
      RETURNING id`),
  );
  const cleared = rowsOf(
    await db.execute(sql`
      UPDATE sessions SET task_closing = NULL
      WHERE id IN (SELECT s.id FROM sessions s WHERE ${takenBack}
        ORDER BY s.id LIMIT ${options.limit}
        FOR UPDATE OF s SKIP LOCKED)
        AND task_interpretation IS NULL
        AND parent_conversation_id IS NULL
      RETURNING id`),
  );
  return { filled: filled.length, cleared: cleared.length };
}

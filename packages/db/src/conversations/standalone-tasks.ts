import { ENDED_SESSION_STATUSES } from "@werft-ai/contracts";
import { type SQL, sql } from "drizzle-orm";

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

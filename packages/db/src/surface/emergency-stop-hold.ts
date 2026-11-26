import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * Whether an emergency stop holds in a Slack channel the session works in
 * (one of its threads, or its parent conversation's channel): it stays
 * paused until a binding manager turns that channel on again.
 */
export async function emergencyStopHolds(
  tx: Database,
  sessionId: string,
): Promise<boolean> {
  const [row] = rowsOf<{ held: boolean }>(
    await tx.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM sessions s
        JOIN surface_bindings b
          ON b.revoked_at IS NULL
         AND b.emergency_stopped_at IS NOT NULL
        WHERE s.id = ${sessionId}::uuid
          AND (
            EXISTS (
              SELECT 1 FROM session_links l
              WHERE l.session_id = s.id
                AND l.installation_id = b.installation_id
                AND l.channel_id = b.external_surface_id
                AND l.agent_id = b.agent_id)
            OR EXISTS (
              SELECT 1 FROM conversations c
              WHERE c.id = s.parent_conversation_id
                AND c.agent_id = b.agent_id
                AND c.channel_id = b.external_surface_id)
          )
      ) AS held`),
  );
  return row?.held === true;
}

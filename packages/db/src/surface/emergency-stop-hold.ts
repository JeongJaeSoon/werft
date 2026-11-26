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
            -- A thread's channel through any install of its Slack team: one
            -- stop covers them all, so a revoked install's link is held too.
            EXISTS (
              SELECT 1 FROM session_links l
              JOIN slack_installations li ON li.id = l.installation_id
              JOIN slack_installations bi ON bi.id = b.installation_id
              WHERE l.session_id = s.id
                AND coalesce(li.team_id, li.id::text)
                  = coalesce(bi.team_id, bi.id::text)
                AND l.channel_id = b.external_surface_id
                AND l.agent_id = b.agent_id)
            OR EXISTS (
              SELECT 1 FROM conversations c
              WHERE c.id = s.parent_conversation_id
                AND c.agent_id = b.agent_id
                AND c.channel_id = b.external_surface_id
                AND c.team_id = (SELECT i.team_id FROM slack_installations i WHERE i.id = b.installation_id))
          )
      ) AS held`),
  );
  return row?.held === true;
}

/**
 * Whether the agent of `releaseId` is emergency-stopped in `channelId`,
 * read with the channel's binding held: the stop holds it while it stops
 * the channel's work, so work begun here either waits for the stop and
 * sees it, or is done first and is found by it.
 */
export async function channelEmergencyStopped(
  tx: Database,
  input: { releaseId: string; teamId: string; channelId: string },
): Promise<boolean> {
  const rows = rowsOf<{ stopped: boolean }>(
    await tx.execute(sql`
      SELECT b.emergency_stopped_at IS NOT NULL AS stopped
      FROM surface_bindings b
      JOIN agent_releases r ON r.agent_id = b.agent_id
      JOIN slack_installations i ON i.id = b.installation_id
      WHERE r.id = ${input.releaseId}
        AND i.team_id = ${input.teamId}
        AND b.external_surface_id = ${input.channelId}
        AND b.revoked_at IS NULL
      ORDER BY b.id
      FOR SHARE OF b`),
  );
  return rows.some((row) => row.stopped);
}

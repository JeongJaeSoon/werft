import { type AdmissionState, admissionStateSchema } from "@werft-ai/contracts";
import { type SQL, sql } from "drizzle-orm";

/**
 * The admissions a session's work is closed in (decision 35): closing or
 * closed. Any other is work still open, an idle, paused or stopped session
 * included: a reply to its thread is the work's to take.
 */
export const CLOSED_WORK_ADMISSION_STATES = [
  "closing",
  "closed",
] as const satisfies readonly AdmissionState[];

/**
 * Whether a session's work is closed (decision 35), by the admission_state
 * a sessions row holds; parsed here, so a value outside the enum throws.
 * No session left is closed work: nothing is there to take a reply.
 */
export function sessionWorkClosed(admissionState: string | undefined): boolean {
  if (admissionState === undefined) return true;
  return (CLOSED_WORK_ADMISSION_STATES as readonly AdmissionState[]).includes(
    admissionStateSchema.parse(admissionState),
  );
}

/**
 * The admission_state of the session the latest link of a topic's Slack
 * thread names, as a scalar subquery; null when none names one. The link
 * is read by its install and surface ref, as the receive path finds it,
 * and is one made by `heldAt` when given: the work a reply was held for,
 * not one a later mention opened in the same thread.
 */
export const threadWorkAdmission = (
  agentId: SQL,
  topicId: SQL,
  heldAt?: SQL,
): SQL => sql`(
  SELECT s.admission_state FROM session_links l
  JOIN sessions s ON s.id = l.session_id
  JOIN conversation_topics tp ON tp.id = ${topicId}
  WHERE l.agent_id = ${agentId}
    AND l.installation_id IN (
      SELECT i.id FROM slack_installations i
      JOIN slack_apps sa ON sa.app_id = i.app_id
      WHERE sa.agent_id = ${agentId} AND i.team_id = tp.slack_team_id)
    AND l.surface_ref = tp.slack_channel_id || ':' || tp.slack_thread_ts
    ${heldAt === undefined ? sql`` : sql`AND (${heldAt} IS NULL OR l.created_at <= ${heldAt})`}
  ORDER BY l.created_at DESC, l.id DESC LIMIT 1)`;

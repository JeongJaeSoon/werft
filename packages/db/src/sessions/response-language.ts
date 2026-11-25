import type { RESPONSE_LANGUAGE_VALUES } from "@werft-ai/contracts";
import { eq } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { agentReleases, sessions } from "../schema.ts";
import { responseLanguageOf } from "../worker-unit-of-work.ts";

/**
 * The response language the agent release of `sessionId` fixes, as its
 * worker is told it; null when it fixes none (`follow-user`, a release
 * before the field, a session without a release).
 */
export async function sessionResponseLanguage(
  db: Database,
  sessionId: string,
): Promise<(typeof RESPONSE_LANGUAGE_VALUES)[number] | null> {
  const [row] = await db
    .select({ snapshot: agentReleases.runtimeConfigSnapshot })
    .from(sessions)
    .innerJoin(agentReleases, eq(agentReleases.id, sessions.agentReleaseId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return responseLanguageOf(row?.snapshot);
}

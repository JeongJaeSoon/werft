import { formatSurfaceRef } from "@werft-ai/contracts";
import type { EngagementStore } from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

export function createPostgresEngagementStore(db: Database): EngagementStore {
  return {
    async engagedThread(query) {
      const rows = rowsOf(
        await db.execute(sql`
          SELECT 1 FROM session_links l
          JOIN conversation_engagements e ON e.session_id = l.session_id
          WHERE l.installation_id = ${query.installationId}::uuid
            AND l.surface_ref = ${formatSurfaceRef(query.channelId, query.threadTs)}
            AND l.agent_id = ${query.agentId}::uuid
            AND e.agent_id = ${query.agentId}::uuid
          LIMIT 1`),
      );
      return rows.length > 0;
    },
  };
}

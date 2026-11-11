import type { GitHubAppManifestStore } from "@werft-ai/platform";
import { eq, lt } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { githubAppManifestStates } from "../schema.ts";

export function createPostgresGitHubAppManifestStore(
  db: Database,
): GitHubAppManifestStore {
  return {
    async issueState(stateHash, state, now) {
      await db
        .delete(githubAppManifestStates)
        .where(lt(githubAppManifestStates.expiresAt, now));
      await db.insert(githubAppManifestStates).values({
        stateHash,
        workspaceId: state.workspaceId,
        actorUserId: state.actorUserId,
        role: state.role,
        ownerLogin: state.ownerLogin,
        public: state.public,
        replacesAppId: state.replacesAppId,
        expiresAt: state.expiresAt,
      });
    },

    async consumeState(stateHash) {
      // One DELETE: of two requests with the same state, one gets the row.
      const [row] = await db
        .delete(githubAppManifestStates)
        .where(eq(githubAppManifestStates.stateHash, stateHash))
        .returning();
      if (!row) return null;
      return {
        workspaceId: row.workspaceId,
        actorUserId: row.actorUserId,
        role: row.role,
        ownerLogin: row.ownerLogin,
        public: row.public,
        replacesAppId: row.replacesAppId,
        expiresAt: row.expiresAt,
      };
    },
  };
}

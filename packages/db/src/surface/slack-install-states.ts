import type { SlackInstallStore } from "@werft-ai/platform";
import { and, eq, lt } from "drizzle-orm";
import { revokeInstallationIdentities } from "../musterrolle/agent-identities.ts";
import type { Database } from "../queries.ts";
import { slackInstallations, slackInstallStates } from "../schema.ts";
import {
  registerSlackInstallation,
  revokeSlackInstallation,
  verifySlackInstallation,
} from "./slack-installations.ts";

// Slack's event_time is whole seconds, so a verify in that same second
// may still predate the report.
const verifiedAfter = (verifiedAt: Date | null, sentAt: Date) =>
  verifiedAt !== null && verifiedAt.getTime() >= sentAt.getTime() + 1000;

export function createPostgresSlackInstallStore(
  db: Database,
): SlackInstallStore {
  return {
    async issueState(stateHash, state, now) {
      await db
        .delete(slackInstallStates)
        .where(lt(slackInstallStates.expiresAt, now));
      await db.insert(slackInstallStates).values({
        stateHash,
        workspaceId: state.workspaceId,
        agentId: state.agentId,
        slackAppId: state.slackAppId,
        actorUserId: state.actorUserId,
        teamId: state.teamId,
        redirectUrl: state.redirectUrl,
        expiresAt: state.expiresAt,
      });
    },

    async consumeState(stateHash) {
      // One DELETE: of two requests with the same state, one gets the row.
      const [row] = await db
        .delete(slackInstallStates)
        .where(eq(slackInstallStates.stateHash, stateHash))
        .returning();
      if (!row) return null;
      return {
        workspaceId: row.workspaceId,
        agentId: row.agentId,
        slackAppId: row.slackAppId,
        actorUserId: row.actorUserId,
        teamId: row.teamId,
        redirectUrl: row.redirectUrl,
        expiresAt: row.expiresAt,
      };
    },

    async recordInstallation(input) {
      const key = { appId: input.appId, teamId: input.teamId };
      const registered = await registerSlackInstallation(db, {
        ...key,
        workspaceId: input.workspaceId,
      });
      if (registered.outcome === "workspace_conflict") {
        return { outcome: "workspace_conflict" };
      }
      const verified = await verifySlackInstallation(db, {
        ...key,
        botUserId: input.botUserId,
      });
      if (verified.outcome === "not_found") {
        throw new Error(
          `Slack installation ${key.appId}/${key.teamId} vanished after registering`,
        );
      }
      if (verified.outcome === "revoked") return { outcome: "revoked" };
      return { outcome: "verified", installationId: verified.installation.id };
    },

    async revokeInstallation(key, sentAt) {
      return db.transaction(async (tx) => {
        // Locked, so a reinstall cannot verify it between check and revoke.
        // NO KEY UPDATE still queues behind link and verify, but lets a
        // channel binding write take the row's key share for its foreign key
        // while it holds the identity: FOR UPDATE here would wait on that
        // identity and block that write, a deadlock.
        const [row] = await tx
          .select({ verifiedAt: slackInstallations.verifiedAt })
          .from(slackInstallations)
          .where(
            and(
              eq(slackInstallations.appId, key.appId),
              eq(slackInstallations.teamId, key.teamId),
            ),
          )
          .for("no key update");
        if (!row) return "not_found";
        if (sentAt && verifiedAfter(row.verifiedAt, sentAt)) {
          return "superseded";
        }
        const revoked = await revokeSlackInstallation(tx, key);
        if (revoked.outcome === "not_found") return "not_found";
        // The console reads the agent's identity, so it goes with the
        // install. Also on a repeat: an install revoked before this
        // existed still has its identity active.
        await revokeInstallationIdentities(tx, revoked.installation.id);
        return "revoked";
      });
    },
  };
}

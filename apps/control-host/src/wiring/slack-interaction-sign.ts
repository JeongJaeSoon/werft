import {
  createSlackSigningSecrets,
  slackRequestSignature,
} from "@werft-ai/chat-slack";
import {
  createPostgresSecretStore,
  createPostgresSlackAppStore,
  type Database,
  slackInstallations,
} from "@werft-ai/db";
import type { SecretKey } from "@werft-ai/platform";
import { and, asc, eq } from "drizzle-orm";

// What the operator's slack-interaction-sign CLI needs from the Slack adapter.
export { slackRequestSignature };

/** The agent's created Slack app as the API reads it, with its teams. */
export type SlackInteractionTarget = {
  appId: string;
  signingSecret: string;
  teamIds: string[];
};

export type SlackInteractionTargets = {
  forAgent(agentId: string): Promise<SlackInteractionTarget | null>;
};

/** Reads the signing secret through the same lookup the API checks with. */
export function postgresSlackInteractionTargets(
  db: Database,
  key: SecretKey,
): SlackInteractionTargets {
  const signingSecrets = createSlackSigningSecrets({
    apps: createPostgresSlackAppStore(db, key),
    secrets: createPostgresSecretStore(db, key),
    ttlMs: 0,
  });
  return {
    async forAgent(agentId) {
      const app = await signingSecrets.forAgent(agentId);
      if (app === null) return null;
      const teams = await db
        .select({ teamId: slackInstallations.teamId })
        .from(slackInstallations)
        .where(
          and(
            eq(slackInstallations.workspaceId, app.workspaceId),
            eq(slackInstallations.appId, app.appId),
            eq(slackInstallations.status, "verified"),
          ),
        )
        .orderBy(asc(slackInstallations.teamId));
      return {
        appId: app.appId,
        signingSecret: app.signingSecret,
        teamIds: teams.map((team) => team.teamId),
      };
    },
  };
}

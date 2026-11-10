import { SLACK_BINDING_MESSAGES } from "@werft-ai/contracts";
import type { SecretStore } from "../ports/secret-store.ts";
import type { SlackAppStore } from "../ports/slack-app-store.ts";
import { SessionServiceError } from "../sessions/session-service.ts";
import type { ChannelKindReadable } from "../surface/ports/channel-kind-readable.ts";
import { SlackApiError, type SlackBotApi } from "./slack-config-api.ts";
import {
  isTokenGone,
  isTokenRevoked,
  type SlackTokenRevoked,
} from "./slack-token-gone.ts";

/** The bot token an install stored for the app; null when it has none. */
export function slackBotToken(
  secrets: Pick<SecretStore, "get">,
  workspaceId: string,
  slackAppId: string,
): Promise<string | null> {
  return secrets.get({
    workspaceId,
    owner: { kind: "slack_app", id: slackAppId },
    purpose: "slack_bot_token",
  });
}

/** The bot token of the agent's own app; null without one. */
export async function agentSlackBotToken(
  deps: {
    apps: Pick<SlackAppStore, "findForAgent">;
    secrets: Pick<SecretStore, "get">;
  },
  workspaceId: string,
  agentId: string,
): Promise<string | null> {
  const app = await deps.apps.findForAgent(workspaceId, agentId);
  return app === null ? null : slackBotToken(deps.secrets, workspaceId, app.id);
}

/**
 * Channel kinds as the agent's own app sees them. Without a secret store
 * (no master key) there is no bot token to ask with, so a channel cannot
 * be bound.
 */
export function createSlackChannelKinds(deps: {
  apps: Pick<SlackAppStore, "findForAgent"> | null;
  secrets: Pick<SecretStore, "get"> | null;
  slack: SlackBotApi;
  /** Revokes the install when Slack says the bot token was revoked. */
  tokenRevoked?: SlackTokenRevoked;
}): ChannelKindReadable {
  const notInstalled = () =>
    new SessionServiceError(
      "SLACK_NOT_INSTALLED",
      SLACK_BINDING_MESSAGES.notInstalled,
    );
  return {
    async kindOf(workspaceId, agentId, channelId) {
      if (deps.apps === null || deps.secrets === null) throw notInstalled();
      const startedAt = new Date();
      const app = await deps.apps.findForAgent(workspaceId, agentId);
      const token =
        app === null
          ? null
          : await slackBotToken(deps.secrets, workspaceId, app.id);
      if (app === null || token === null) throw notInstalled();
      try {
        return await deps.slack.channelKind(token, channelId);
      } catch (error) {
        if (isTokenGone(error)) {
          if (isTokenRevoked(error)) {
            await deps.tokenRevoked?.({
              workspaceId,
              agentId,
              slackAppId: app.id,
              appId: app.appId,
              failedToken: token,
              since: startedAt,
            });
          }
          throw notInstalled();
        }
        // A private channel is hidden from a bot not invited yet; it is
        // bound, and waits for the invite. A DM never is.
        if (
          error instanceof SlackApiError &&
          error.code === "channel_not_found" &&
          !channelId.startsWith("D")
        ) {
          return "private_channel";
        }
        if (error instanceof SlackApiError && error.answered) {
          throw new SessionServiceError(
            "BAD_REQUEST",
            SLACK_BINDING_MESSAGES.channelUnknown,
            undefined,
            { slack_error: error.code },
          );
        }
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          SLACK_BINDING_MESSAGES.slackUnavailable,
          { afterSeconds: 10 },
        );
      }
    },
  };
}

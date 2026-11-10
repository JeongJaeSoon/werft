import type {
  AgentIdentityStore,
  SecretStore,
  SlackInstallStore,
} from "@werft-ai/platform";
import { SlackApiError } from "./slack-config-api.ts";

// Slack's answers for a bot token that no longer works.
const TOKEN_GONE = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
]);

// The two that only an uninstall or a revoke produces. `invalid_auth` also
// comes from an IP allow list or a bad secret read, `not_authed` from a
// missing token and `token_expired` from rotation, so those answer 409 and
// leave the state alone.
const TOKEN_REVOKED = new Set(["token_revoked", "account_inactive"]);

const answeredWith = (error: unknown, codes: ReadonlySet<string>) =>
  error instanceof SlackApiError && error.answered && codes.has(error.code);

/** Slack answered, and what it said is that the bot token does not work. */
export const isTokenGone = (error: unknown) => answeredWith(error, TOKEN_GONE);

/** Slack answered that the bot token was revoked: the app is uninstalled. */
export const isTokenRevoked = (error: unknown) =>
  answeredWith(error, TOKEN_REVOKED);

/**
 * For an uninstall that ended without an event: a Slack call made with the
 * agent's bot token was answered `token_revoked`, so the install is revoked
 * as `app_uninstalled` would have. A reinstall stores a new token before it
 * verifies, so when the stored token is no longer the one that failed, the
 * failure is stale and nothing changes. Never throws: the caller is already
 * answering the failure.
 */
export type SlackTokenRevoked = (input: {
  workspaceId: string;
  agentId: string;
  slackAppId: string;
  /** Slack's id for the app whose token failed; null before it is created. */
  appId: string | null;
  failedToken: string;
  /** When the failing call began. */
  since: Date;
}) => Promise<void>;

export function createSlackTokenRevoked(deps: {
  identities: Pick<AgentIdentityStore, "list">;
  installs: Pick<SlackInstallStore, "revokeInstallation">;
  secrets: Pick<SecretStore, "get">;
  onError?: (error: unknown) => void;
}): SlackTokenRevoked {
  return async (input) => {
    try {
      const current = await deps.secrets.get({
        workspaceId: input.workspaceId,
        owner: { kind: "slack_app", id: input.slackAppId },
        purpose: "slack_bot_token",
      });
      if (current !== input.failedToken || input.appId === null) return;
      const rows = await deps.identities.list(
        input.workspaceId,
        input.agentId,
        20,
      );
      // An agent may hold installs of other apps; only this app's token died.
      // The store skips an install verified at or after the call began (a
      // reinstall that raced it): sentAt is a second early because its
      // check allows for Slack's whole-second event times.
      const sentAt = new Date(input.since.getTime() - 1000);
      for (const row of rows) {
        if (row.status !== "active" || row.appId !== input.appId) continue;
        await deps.installs.revokeInstallation(
          { appId: row.appId, teamId: row.teamId },
          sentAt,
        );
      }
    } catch (error) {
      deps.onError?.(error);
    }
  };
}

import {
  type ConfigTokenSummary,
  type RotatedConfigToken,
  type SecretAudit,
  SessionServiceError,
  type SlackConfigTokenStore,
} from "@werft-ai/platform";
import {
  SLACK_APP_GONE_CODES,
  SlackApiError,
  type SlackConfigApi,
} from "./slack-config-api.ts";

/** Rotate once the access token has less than this left (Slack: 12 h). */
export const CONFIG_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** Longer than the Slack call's timeout, so a live rotation keeps it. */
export const CONFIG_TOKEN_LEASE_MS = 30_000;
const PERSIST_ATTEMPTS = 3;
const BUSY_POLL_MS = 200;

// Slack's answers that mean this token or refresh token is no good, as
// opposed to Slack being unwell.
const DEAD_TOKEN_CODES = new Set([
  "invalid_refresh_token",
  "token_expired",
  "token_revoked",
  "invalid_auth",
  "not_authed",
  "account_inactive",
]);

export type ConfigTokenReason = "not_set" | "rejected" | "needs_reentry";

export const configTokenInvalid = (reason: ConfigTokenReason) =>
  new SessionServiceError(
    "CONFIG_TOKEN_INVALID",
    reason === "not_set"
      ? "No Slack App Configuration Token is set for this workspace"
      : "Slack no longer accepts this workspace's App Configuration Token; an owner or admin must paste a new one",
    undefined,
    { reason_code: reason },
  );

const slackUnavailable = (method: string) =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    `Slack did not answer ${method}; try again`,
    { afterSeconds: 5 },
  );

const isDeadToken = (error: unknown) =>
  error instanceof SlackApiError &&
  error.answered &&
  DEAD_TOKEN_CODES.has(error.code);

export type SlackConfigTokens = ReturnType<typeof createSlackConfigTokens>;

/**
 * True only when Slack itself says the app is gone: export answers a gone
 * code to the app maker's own token. Another user's token may be told an app
 * it cannot manage is not there, and a probe that fails any other way proves
 * nothing, so both leave the caller to decide.
 */
export async function slackLacksApp(
  api: Pick<SlackConfigApi, "exportApp">,
  tokens: SlackConfigTokens,
  workspaceId: string,
  app: { appId: string; maker: string },
): Promise<boolean> {
  try {
    // The token in hand, not the one described before, must be the maker's.
    return await tokens.withToken(workspaceId, async (token, issuer) => {
      if (issuer !== app.maker) return false;
      await api.exportApp(token, app.appId);
      return false;
    });
  } catch (error) {
    return (
      error instanceof SlackApiError &&
      error.answered &&
      SLACK_APP_GONE_CODES.has(error.code)
    );
  }
}

/**
 * Hands out a valid access token for a workspace, rotating it through
 * Slack when it is close to expiry. The refresh token is single-use, so
 * rotations are serialized across processes by the store's lease; Slack is
 * called with no transaction open and its answer stored in a second one.
 */
export function createSlackConfigTokens(deps: {
  store: SlackConfigTokenStore;
  api: SlackConfigApi;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}) {
  const { store, api } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function persist(
    workspaceId: string,
    leaseId: string,
    rotated: RotatedConfigToken,
    audit?: SecretAudit,
  ) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await store.complete(
          workspaceId,
          leaseId,
          rotated,
          audit,
        );
        if (result.outcome === "lease_lost") {
          throw configTokenInvalid("needs_reentry");
        }
        return result;
      } catch (error) {
        if (error instanceof SessionServiceError) throw error;
        if (attempt >= PERSIST_ATTEMPTS) {
          // Slack has spent the old refresh token and the new one could not
          // be kept: only a new paste recovers.
          await store.invalidate(workspaceId, leaseId).catch(() => {});
          throw configTokenInvalid("needs_reentry");
        }
      }
    }
  }

  async function accessToken(
    workspaceId: string,
  ): Promise<{ token: string; issuerUserId: string }> {
    for (;;) {
      const at = now();
      const claim = await store.claim(workspaceId, {
        now: at,
        freshUntil: new Date(at.getTime() + CONFIG_TOKEN_REFRESH_MARGIN_MS),
        leaseUntil: new Date(at.getTime() + CONFIG_TOKEN_LEASE_MS),
      });
      switch (claim.outcome) {
        case "fresh":
          return { token: claim.accessToken, issuerUserId: claim.issuerUserId };
        case "not_set":
          throw configTokenInvalid("not_set");
        case "needs_reentry":
          throw configTokenInvalid("needs_reentry");
        case "busy":
          await sleep(
            Math.max(
              BUSY_POLL_MS,
              Math.min(1_000, claim.until.getTime() - now().getTime()),
            ),
          );
          continue;
        case "claimed": {
          let rotated: RotatedConfigToken;
          try {
            rotated = await api.rotateConfigToken(claim.refreshToken);
          } catch (error) {
            if (isDeadToken(error)) {
              await store.invalidate(workspaceId, claim.leaseId);
              throw configTokenInvalid("needs_reentry");
            }
            await store.release(workspaceId, claim.leaseId);
            throw slackUnavailable("tooling.tokens.rotate");
          }
          await persist(workspaceId, claim.leaseId, rotated);
          return {
            token: rotated.accessToken,
            issuerUserId: rotated.issuerUserId,
          };
        }
      }
    }
  }

  return {
    accessToken,

    /**
     * Runs one App Configuration API call with the workspace's token. Slack
     * refusing the token itself answers 409 CONFIG_TOKEN_INVALID, so every
     * caller reports it the same way.
     */
    async withToken<T>(
      workspaceId: string,
      call: (token: string, issuerUserId: string) => Promise<T>,
    ): Promise<T> {
      const { token, issuerUserId } = await accessToken(workspaceId);
      try {
        return await call(token, issuerUserId);
      } catch (error) {
        if (error instanceof SlackApiError && error.answered) {
          if (error.code === "token_expired") {
            await store.expireAccess(workspaceId, now());
            throw configTokenInvalid("rejected");
          }
          if (isDeadToken(error)) {
            await store.invalidate(workspaceId, null);
            throw configTokenInvalid("needs_reentry");
          }
        }
        throw error;
      }
    },

    /**
     * Stores a pasted refresh token by rotating it at once: that proves
     * Slack takes it and yields the access token and its expiry. A token
     * Slack refuses leaves whatever was stored before untouched.
     */
    async register(
      workspaceId: string,
      refreshToken: string,
      audit: SecretAudit,
    ): Promise<
      | {
          outcome: "stored";
          summary: ConfigTokenSummary;
          previousIssuerUserId: string | null;
        }
      | { outcome: "actor_inactive" | "outranked" | "workspace_not_found" }
    > {
      for (;;) {
        const at = now();
        const claim = await store.claimForReplace(
          workspaceId,
          {
            now: at,
            leaseUntil: new Date(at.getTime() + CONFIG_TOKEN_LEASE_MS),
          },
          audit,
        );
        if (claim.outcome === "busy") {
          await sleep(BUSY_POLL_MS);
          continue;
        }
        if (claim.outcome !== "claimed") return claim;
        let rotated: RotatedConfigToken;
        try {
          rotated = await api.rotateConfigToken(refreshToken);
        } catch (error) {
          await store.release(workspaceId, claim.leaseId);
          if (error instanceof SlackApiError && error.answered) {
            throw configTokenInvalid("rejected");
          }
          throw slackUnavailable("tooling.tokens.rotate");
        }
        const stored = await persist(
          workspaceId,
          claim.leaseId,
          rotated,
          audit,
        );
        return {
          outcome: "stored",
          summary: stored.summary,
          previousIssuerUserId: stored.previousIssuerUserId,
        };
      }
    },

    describe: (workspaceId: string) => store.describe(workspaceId),
    delete: (workspaceId: string, audit: SecretAudit) =>
      store.delete(workspaceId, audit),
  };
}

import type {
  DeleteSlackSecretResponse,
  PutSlackConfigTokenResponse,
  PutSlackSecretResponse,
  SlackAppKind,
  SlackAppSecretPurpose,
  SlackConfigTokenSummary,
  SlackPublicUrls,
  SlackSecretSummary,
} from "@werft-ai/contracts";
import {
  ACTOR_INACTIVE,
  type AuthorizationPolicy,
  type Caller,
  type ConfigTokenSummary,
  MANAGEMENT_ROLES,
  NOT_FOUND,
  OUTRANKED,
  type PutSecretResult,
  requirePermitted,
  type SecretAudit,
  type SecretStore,
  type SecretSummary,
  SessionServiceError,
} from "@werft-ai/platform";
import type { SlackConfigTokens } from "./slack-config-token.ts";
import { slackEventsUrl } from "./slack-events-finalize.ts";
import { slackLinkRedirectUrl } from "./slack-manifest.ts";

export function slackPublicUrlsOf(
  consoleOrigin: string | null,
  eventsPublicUrl: string | null,
): SlackPublicUrls {
  return {
    redirect_url:
      consoleOrigin === null ? null : slackLinkRedirectUrl(consoleOrigin),
    events_url_template:
      eventsPublicUrl === null
        ? null
        : slackEventsUrl(eventsPublicUrl, "{agent_id}"),
  };
}

const FORBIDDEN_WEB_ONLY = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "Slack secrets are set from a signed-in console session, not with an API key",
    undefined,
    { reason_code: "web_session_required" },
  );

const MANAGERS = MANAGEMENT_ROLES["workspace.manage"] ?? [];
const STORE_OFF = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
    undefined,
    { reason_code: "secret_store_off" },
  );

export function slackSecretSummaryOf(
  summary: SecretSummary | null,
): SlackSecretSummary {
  if (summary === null) {
    return {
      configured: false,
      last4: null,
      updated_at: null,
      updated_by: null,
    };
  }
  return {
    configured: true,
    last4: summary.last4,
    updated_at: summary.updatedAt.toISOString(),
    updated_by:
      summary.updatedBy === null
        ? null
        : {
            user_id: summary.updatedBy.userId,
            display_name: summary.updatedBy.displayName,
          },
  };
}

export function slackConfigTokenSummaryOf(
  summary: ConfigTokenSummary,
  urls: SlackPublicUrls,
): SlackConfigTokenSummary {
  return {
    ...slackSecretSummaryOf(summary.secret),
    urls,
    state: summary.state,
    expires_at: summary.expiresAt?.toISOString() ?? null,
    issuer:
      summary.issuer === null
        ? null
        : { user_id: summary.issuer.userId, team_id: summary.issuer.teamId },
  };
}

export function createSlackSecretService(deps: {
  authorization: AuthorizationPolicy;
  /** Null when the API runs without a master key. */
  store: SecretStore | null;
  tokens: SlackConfigTokens | null;
  urls: SlackPublicUrls;
  /** The kind of one of the workspace's Slack apps, or null when it has none. */
  appKind: (
    workspaceId: string,
    slackAppId: string,
  ) => Promise<SlackAppKind | null>;
  newId?: () => string;
}) {
  const { authorization } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function permitted(caller: Caller, workspaceId: string) {
    if (workspaceId !== caller.ownerId) throw NOT_FOUND();
    await requirePermitted(authorization, caller, "workspace.manage", {
      kind: "workspace",
      id: workspaceId,
    });
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user"
    ) {
      throw FORBIDDEN_WEB_ONLY();
    }
  }

  async function managedStore(
    caller: Caller,
    workspaceId: string,
  ): Promise<SecretStore> {
    await permitted(caller, workspaceId);
    if (deps.store === null) throw STORE_OFF();
    return deps.store;
  }

  async function managedTokens(
    caller: Caller,
    workspaceId: string,
  ): Promise<SlackConfigTokens> {
    await permitted(caller, workspaceId);
    if (deps.tokens === null) throw STORE_OFF();
    return deps.tokens;
  }

  const auditOf = (caller: Caller): SecretAudit => ({
    principal: caller,
    receiptId: newId(),
    roles: MANAGERS,
  });

  return {
    async describeConfigToken(
      caller: Caller,
      workspaceId: string,
    ): Promise<SlackConfigTokenSummary> {
      const tokens = await managedTokens(caller, workspaceId);
      return slackConfigTokenSummaryOf(
        await tokens.describe(workspaceId),
        deps.urls,
      );
    },

    /**
     * The pasted refresh token is rotated at once, which both proves Slack
     * takes it and yields the access token kept with it. `readValue` runs
     * only once the caller is allowed, so a refused caller learns nothing
     * about the request body.
     */
    async setConfigToken(
      caller: Caller,
      workspaceId: string,
      readValue: () => Promise<string>,
    ): Promise<PutSlackConfigTokenResponse> {
      const tokens = await managedTokens(caller, workspaceId);
      const audit = auditOf(caller);
      const result = await tokens.register(
        workspaceId,
        await readValue(),
        audit,
      );
      switch (result.outcome) {
        case "stored":
          return {
            ...slackConfigTokenSummaryOf(result.summary, deps.urls),
            receipt_id: audit.receiptId,
            warnings:
              result.previousIssuerUserId !== null &&
              result.summary.issuer !== null
                ? [
                    {
                      code: "config_token_issuer_changed",
                      previous_user_id: result.previousIssuerUserId,
                      user_id: result.summary.issuer.userId,
                    },
                  ]
                : [],
          };
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },

    async deleteConfigToken(
      caller: Caller,
      workspaceId: string,
    ): Promise<DeleteSlackSecretResponse> {
      const tokens = await managedTokens(caller, workspaceId);
      const audit = auditOf(caller);
      const result = await tokens.delete(workspaceId, audit);
      switch (result.outcome) {
        case "deleted":
          return { receipt_id: audit.receiptId };
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },

    /**
     * A manual app's own values. An app the platform created keeps secrets
     * only the server writes: an admin who knew its signing secret could
     * sign events as Slack and act as any member.
     */
    async setAppSecret(
      caller: Caller,
      workspaceId: string,
      slackAppId: string,
      purpose: SlackAppSecretPurpose,
      readValue: () => Promise<string>,
    ): Promise<PutSlackSecretResponse> {
      const store = await managedStore(caller, workspaceId);
      const kind = await deps.appKind(workspaceId, slackAppId);
      if (kind === null) throw NOT_FOUND();
      if (kind !== "manual") {
        throw new SessionServiceError(
          "FORBIDDEN",
          "This Slack app's secrets are written by the platform only",
          undefined,
          { reason_code: "server_managed_secret" },
        );
      }
      const audit = auditOf(caller);
      const result: PutSecretResult = await store.put(
        {
          workspaceId,
          owner: { kind: "slack_app", id: slackAppId },
          purpose,
        },
        await readValue(),
        { audit },
      );
      switch (result.outcome) {
        case "stored":
          return {
            ...slackSecretSummaryOf(result.summary),
            receipt_id: audit.receiptId,
          };
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        default:
          throw NOT_FOUND();
      }
    },
  };
}

export type SlackSecretService = ReturnType<typeof createSlackSecretService>;

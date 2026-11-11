import { createHash, randomBytes } from "node:crypto";
import {
  BOT_SCOPES,
  type CompleteSlackInstallRequest,
  type CompleteSlackInstallResponse,
  SLACK_INSTALL_STATE_TTL_SECONDS,
  type SlackFinalizeWarning,
  type StartSlackInstallResponse,
} from "@werft-ai/contracts";
import {
  type AgentIdentityStore,
  type AuthorizationPolicy,
  agentIdentityView,
  type Caller,
  MANAGEMENT_ROLES,
  NOT_FOUND,
  requirePermitted,
  type SecretStore,
  SessionServiceError,
  type SlackAppRecord,
  type SlackAppStore,
  type SlackInstallState,
  type SlackInstallStore,
  secretOwnerRef,
} from "@werft-ai/platform";
import { slackAppView } from "./slack-app-service.ts";
import {
  SlackApiError,
  type SlackConfigApi,
  type SlackInstallApi,
} from "./slack-config-api.ts";
import {
  configTokenInvalid,
  type SlackConfigTokens,
  slackLacksApp,
} from "./slack-config-token.ts";
import { slackAuthorizeUrl } from "./slack-manifest.ts";

const ACTION = "binding.manage" as const;

/** What an install leaves behind, for the steps that follow it. */
export type SlackInstalled = {
  workspaceId: string;
  agentId: string;
  slackAppId: string;
  appId: string;
  teamId: string;
  botUserId: string;
  installationId: string;
  identityId: string;
};

export type SlackFinalizeResult = {
  finalized: boolean;
  warnings: SlackFinalizeWarning[];
};

/**
 * Runs once the install is verified and the identity linked: registering
 * events, then the home channel and welcome, joined with
 * `composeSlackFinalize`. A step that cannot run says so in its result; one
 * that throws leaves the install in place and is reported as
 * `finalized: false`.
 */
export type SlackInstallFinalize = (
  installed: SlackInstalled,
) => Promise<SlackFinalizeResult>;

/**
 * The steps in order: every step runs, `finalized` only when all of them
 * did, warnings in step order. A step that throws stops the rest.
 */
export function composeSlackFinalize(
  ...steps: SlackInstallFinalize[]
): SlackInstallFinalize {
  return async (installed) => {
    const warnings: SlackFinalizeWarning[] = [];
    let finalized = true;
    for (const step of steps) {
      const result = await step(installed);
      finalized &&= result.finalized;
      warnings.push(...result.warnings);
    }
    return { finalized, warnings };
  };
}

type StateRefusal =
  | "not_found"
  | "expired"
  | "workspace"
  | "actor"
  | "agent"
  | "app";
type Rejection = "app" | "team" | "enterprise" | "scope" | "slack_error";

const FORBIDDEN_WEB_ONLY = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "Slack apps are installed from a signed-in console session, not with an API key",
    undefined,
    { reason_code: "web_session_required" },
  );
const STORE_OFF = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "The secret store is off: the API was started without PLATFORM_SECRET_KEY",
    undefined,
    { reason_code: "secret_store_off" },
  );
const stateInvalid = (reason: StateRefusal) =>
  new SessionServiceError(
    "SLACK_INSTALL_STATE_INVALID",
    reason === "expired"
      ? "This install link has expired; start the install again"
      : "This install link is not valid for this session; start the install again",
    undefined,
    { reason_code: reason },
  );
const rejected = (reason: Rejection, details: object = {}) =>
  new SessionServiceError(
    "SLACK_INSTALL_REJECTED",
    reason === "slack_error"
      ? "Slack refused the install"
      : "Slack's answer does not match this agent's app; nothing was stored",
    undefined,
    { reason_code: reason, ...details },
  );
const slackUnavailable = (error: SlackApiError) =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    `Slack did not answer ${error.method}; start the install again`,
    undefined,
    { reason_code: "slack_no_answer", ...slackCallDetails(error) },
  );
// Only what names the failure: never the request, the answer or a token.
const slackCallDetails = (error: SlackApiError) => ({
  slack_method: error.method,
  failure: error.failure,
  ...(error.httpStatus === null ? {} : { http_status: error.httpStatus }),
  ...(error.failure === "slack_error" ? { slack_error: error.code } : {}),
});
const appGone = (app: SlackAppRecord) =>
  new SessionServiceError(
    "SLACK_APP_GONE",
    "Slack no longer has this agent's app; delete it here and create it again",
    undefined,
    { slack_app_id: app.id, app_id: app.appId },
  );
const unsettled = (what: string) =>
  new SessionServiceError(
    "REVISION_CONFLICT",
    `${what}; start the install again`,
  );

const hashState = (state: string) =>
  createHash("sha256").update(state, "utf8").digest();

/** The bot token's name: the identity's `credential_ref` and `bot_token_ref`. */
export const slackBotTokenRef = (slackAppId: string) =>
  `${secretOwnerRef({ kind: "slack_app", id: slackAppId })}/slack_bot_token`;

function slackCallFailed(error: unknown): never {
  if (error instanceof SlackApiError) {
    throw error.answered
      ? rejected("slack_error", slackCallDetails(error))
      : slackUnavailable(error);
  }
  throw error;
}

export type SlackInstallService = ReturnType<typeof createSlackInstallService>;

export function createSlackInstallService(deps: {
  authorization: AuthorizationPolicy;
  /** The three are null when the API runs without a master key. */
  apps: SlackAppStore | null;
  states: SlackInstallStore | null;
  secrets: SecretStore | null;
  tokens: SlackConfigTokens | null;
  identities: AgentIdentityStore;
  api: SlackInstallApi & Pick<SlackConfigApi, "exportApp">;
  finalize?: SlackInstallFinalize;
  now?: () => Date;
}) {
  const { authorization, identities, api } = deps;
  const now = deps.now ?? (() => new Date());
  const finalize =
    deps.finalize ??
    (async (): Promise<SlackFinalizeResult> => ({
      finalized: true,
      warnings: [],
    }));

  function ready() {
    if (
      deps.apps === null ||
      deps.states === null ||
      deps.secrets === null ||
      deps.tokens === null
    ) {
      throw STORE_OFF();
    }
    return {
      apps: deps.apps,
      states: deps.states,
      secrets: deps.secrets,
      tokens: deps.tokens,
    };
  }

  // The state is spent only after this, so a member, an API key or a
  // cross-site request cannot use up a link.
  async function permitAgent(caller: Caller, agentId: string) {
    await requirePermitted(authorization, caller, ACTION, {
      kind: "agent",
      id: agentId,
    });
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user" ||
      !caller.actor?.userId
    ) {
      throw FORBIDDEN_WEB_ONLY();
    }
    return caller.actor.userId;
  }

  function refusalOf(
    state: SlackInstallState | null,
    expected: { workspaceId: string; userId: string; agentId: string },
    app: SlackAppRecord | null,
  ): StateRefusal | null {
    if (state === null) return "not_found";
    if (state.expiresAt.getTime() <= now().getTime()) return "expired";
    if (state.workspaceId !== expected.workspaceId) return "workspace";
    if (state.actorUserId !== expected.userId) return "actor";
    if (state.agentId !== expected.agentId) return "agent";
    if (app === null || app.id !== state.slackAppId || app.state !== "created")
      return "app";
    return null;
  }

  return {
    /** A fresh single-use link to Slack's consent screen for the agent's app. */
    async start(
      caller: Caller,
      agentId: string,
    ): Promise<StartSlackInstallResponse> {
      const userId = await permitAgent(caller, agentId);
      const { apps, states, tokens } = ready();
      const workspaceId = caller.ownerId;
      const app = await apps.findForAgent(workspaceId, agentId);
      if (app === null) throw NOT_FOUND();
      if (app.state === "creating") {
        throw new SessionServiceError(
          "SLACK_APP_CREATING",
          "This agent's Slack app is being created",
          undefined,
          { slack_app_id: app.id, uncertain: false },
        );
      }
      if (
        app.state !== "created" ||
        app.clientId === null ||
        app.appId === null
      ) {
        throw unsettled("This agent's Slack app is being deleted");
      }
      const issuer = (await tokens.describe(workspaceId)).issuer;
      const teamId = issuer?.teamId;
      if (!teamId) throw configTokenInvalid("not_set");
      // Another Slack user's token may be told an app it cannot manage is
      // not there; GET /slack/app warns of that case instead.
      if (
        app.createdByTokenUser !== null &&
        app.createdByTokenUser === issuer?.userId &&
        // Slack's consent screen answers "Invalid client_id" for an app it
        // does not have; only Slack saying so stops the link.
        (await slackLacksApp(api, tokens, workspaceId, {
          appId: app.appId,
          maker: app.createdByTokenUser,
        }))
      ) {
        throw appGone(app);
      }
      const at = now();
      const expiresAt = new Date(
        at.getTime() + SLACK_INSTALL_STATE_TTL_SECONDS * 1000,
      );
      const state = randomBytes(32).toString("base64url");
      await states.issueState(
        hashState(state),
        {
          workspaceId,
          agentId: agentId.toLowerCase(),
          slackAppId: app.id,
          actorUserId: userId,
          teamId,
          redirectUrl: app.redirectUrl,
          expiresAt,
        },
        at,
      );
      return {
        authorize_url: slackAuthorizeUrl({
          clientId: app.clientId,
          redirectUrl: app.redirectUrl,
          state,
        }),
        expires_at: expiresAt.toISOString(),
      };
    },

    /**
     * Spends the state, then exchanges the code. Nothing is stored unless
     * Slack's answer names this app, the expected team, no enterprise and
     * every bot scope; then the token is sealed, the install verified with
     * the token itself, the identity linked and Finalize run, in that order.
     */
    async complete(
      caller: Caller,
      request: CompleteSlackInstallRequest,
    ): Promise<CompleteSlackInstallResponse> {
      const agentId = request.agent_id.toLowerCase();
      const userId = await permitAgent(caller, agentId);
      const { apps, states, secrets } = ready();
      const state = await states.consumeState(hashState(request.state));
      const app =
        state === null
          ? null
          : await apps.findForAgent(state.workspaceId, state.agentId);
      const refusal = refusalOf(
        state,
        { workspaceId: caller.ownerId, userId, agentId },
        app,
      );
      if (refusal !== null || state === null || app === null) {
        throw stateInvalid(refusal ?? "not_found");
      }
      if (request.code === undefined) {
        throw new SessionServiceError(
          "SLACK_INSTALL_DENIED",
          "The install was not approved in Slack",
          undefined,
          { slack_error: request.error ?? "unknown" },
        );
      }
      const { appId, clientId } = app;
      if (appId === null || clientId === null) throw stateInvalid("app");
      const clientSecret = await secrets.get({
        workspaceId: app.workspaceId,
        owner: { kind: "slack_app", id: app.id },
        purpose: "slack_client_secret",
      });
      if (clientSecret === null) {
        throw new Error(`Slack app ${app.id} has no client secret`);
      }

      const grant = await api
        .exchangeInstallCode({
          clientId,
          clientSecret,
          code: request.code,
          redirectUri: state.redirectUrl,
        })
        .catch(slackCallFailed);
      if (grant.appId !== appId) throw rejected("app");
      if (grant.enterpriseInstall) throw rejected("enterprise");
      if (grant.teamId !== state.teamId) throw rejected("team");
      const missing = BOT_SCOPES.filter(
        (scope) => !grant.scopes.includes(scope),
      );
      if (missing.length > 0) {
        throw rejected("scope", { missing_scopes: missing });
      }

      const stored = await apps.storeBotToken({
        workspaceId: app.workspaceId,
        slackAppId: app.id,
        botToken: grant.botToken,
      });
      if (stored === null) throw unsettled("This agent's Slack app changed");
      const bot = await api.botIdentity(grant.botToken).catch(slackCallFailed);
      if (bot.appId !== appId) throw rejected("app");
      if (bot.teamId !== state.teamId) throw rejected("team");

      const recorded = await states.recordInstallation({
        workspaceId: app.workspaceId,
        appId,
        teamId: bot.teamId,
        botUserId: bot.botUserId,
      });
      if (recorded.outcome === "workspace_conflict") {
        throw new SessionServiceError(
          "SLACK_INSTALL_CONFLICT",
          "This Slack app is already installed in that team for another workspace",
        );
      }
      if (recorded.outcome === "revoked") {
        throw unsettled("The install was revoked while it was recorded");
      }

      const linked = await identities.link({
        principal: caller,
        workspaceId: app.workspaceId,
        agentId,
        key: { appId, teamId: bot.teamId },
        credentialRef: slackBotTokenRef(app.id),
        managerRoles: MANAGEMENT_ROLES[ACTION] ?? [],
      });
      let identity: Parameters<typeof agentIdentityView>[0];
      let receiptId: string | null = null;
      switch (linked.outcome) {
        case "linked":
          identity = linked.identity;
          receiptId = linked.receiptId;
          break;
        case "exists":
          identity = linked.identity;
          break;
        case "taken":
          throw new SessionServiceError(
            "AGENT_IDENTITY_TAKEN",
            "This Slack app is linked to another agent",
          );
        case "credential_ref_in_use":
          throw new SessionServiceError(
            "CREDENTIAL_REF_IN_USE",
            "The bot token's name is bound elsewhere",
          );
        case "agent_not_found":
          throw NOT_FOUND();
        case "outranked":
        case "actor_inactive":
          throw new SessionServiceError(
            "FORBIDDEN",
            "The caller no longer holds this right",
            undefined,
            { reason_code: "role" },
          );
        case "not_installed":
          throw unsettled("The install was revoked while it was linked");
      }

      let finalized = false;
      let warnings: SlackFinalizeWarning[] = [];
      try {
        ({ finalized, warnings } = await finalize({
          workspaceId: app.workspaceId,
          agentId,
          slackAppId: app.id,
          appId,
          teamId: bot.teamId,
          botUserId: bot.botUserId,
          installationId: recorded.installationId,
          identityId: identity.id,
        }));
      } catch {
        finalized = false;
        warnings = [{ code: "finalize_failed" }];
      }
      return {
        slack_app: slackAppView(stored),
        installation: {
          id: recorded.installationId,
          app_id: appId,
          team_id: bot.teamId,
          bot_user_id: bot.botUserId,
          status: "verified",
        },
        agent_identity: agentIdentityView(identity),
        receipt_id: receiptId,
        finalized,
        warnings,
      };
    },
  };
}

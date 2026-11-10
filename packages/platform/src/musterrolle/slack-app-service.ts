import type {
  CreateSlackAppRequest,
  CreateSlackAppResponse,
  DeleteSlackAppResponse,
  GetSlackAppResponse,
  ListWorkspaceSlackAppsResponse,
  SlackAgentWarning,
  SlackApp,
  SlackAppSettings,
  SlackWarning,
} from "@werft-ai/contracts";
import type {
  CreatedSlackApp,
  SlackAppActor,
  SlackAppRecord,
  SlackAppStore,
} from "../ports/slack-app-store.ts";
import {
  requirePermitted,
  SessionServiceError,
} from "../sessions/session-service.ts";
import {
  type AuthorizationPolicy,
  type Caller,
  MANAGEMENT_ROLES,
} from "./policy.ts";
import { ACTOR_INACTIVE, NOT_FOUND, OUTRANKED } from "./service-errors.ts";
import {
  SLACK_APP_GONE_CODES,
  SlackApiError,
  type SlackConfigApi,
} from "./slack-config-api.ts";
import { type SlackConfigTokens, slackLacksApp } from "./slack-config-token.ts";
import { slackEventsUrl } from "./slack-events-finalize.ts";
import {
  type AgentAppManifestInput,
  buildAgentAppManifest,
  slackAppRedirectUrl,
} from "./slack-manifest.ts";
import { slackSecretSummaryOf } from "./slack-secret-service.ts";

const SLACK_INSTALL_ACTION = "binding.manage" as const;
const WORKSPACE_ACTION = "workspace.manage" as const;
/** Longer than the create call's timeout plus the write after it. */
export const SLACK_APP_CREATE_STALE_MS = 60_000;
const FINISH_ATTEMPTS = 3;

const FORBIDDEN_WEB_ONLY = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "Slack apps are managed from a signed-in console session, not with an API key",
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
const NO_CONSOLE_ORIGIN = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "The console's address is not configured (CONSOLE_ORIGIN), so no OAuth redirect can be set",
    undefined,
    { reason_code: "console_origin_unset" },
  );
const EVENTS_URL_UNSET = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "No https events address is known (CONSOLE_ORIGIN, or SLACK_EVENTS_PUBLIC_URL when events enter apart from the console), so no Request URL can be sent to Slack",
    undefined,
    { reason_code: "events_url_unset" },
  );
const creating = (app: SlackAppRecord, uncertain: boolean) =>
  new SessionServiceError(
    "SLACK_APP_CREATING",
    uncertain
      ? "An earlier creation of this agent's Slack app got no answer. Check api.slack.com/apps for it; if it is not there, ask again with replace_uncertain"
      : "This agent's Slack app is being created",
    undefined,
    { slack_app_id: app.id, uncertain },
  );
const slackRefused = (error: SlackApiError) =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    `Slack refused ${error.method}: ${error.code}`,
    undefined,
    { reason_code: "slack_refused", slack_error: error.code },
  );
const answerLost = (method: string) =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    `Slack's answer to ${method} was lost; asking again reports what is known`,
    { afterSeconds: 60 },
  );

export function slackAppView(record: SlackAppRecord): SlackApp {
  return {
    id: record.id,
    kind: record.kind,
    agent_id: record.agentId,
    state: record.state,
    app_id: record.appId,
    client_id: record.clientId,
    redirect_url: record.redirectUrl,
    created_by_token_user: record.createdByTokenUser,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
    secrets: {
      slack_signing_secret: slackSecretSummaryOf(
        record.secrets.slack_signing_secret,
      ),
      slack_client_secret: slackSecretSummaryOf(
        record.secrets.slack_client_secret,
      ),
      slack_bot_token: slackSecretSummaryOf(record.secrets.slack_bot_token),
    },
  };
}

function issuerWarnings(
  record: SlackAppRecord | null,
  issuer: { userId: string } | null,
): SlackWarning[] {
  const maker = record?.state === "created" ? record.createdByTokenUser : null;
  if (!maker || !issuer || maker === issuer.userId) return [];
  return [
    {
      code: "config_token_issuer_changed",
      previous_user_id: maker,
      user_id: issuer.userId,
    },
  ];
}

export type SlackAppService = ReturnType<typeof createSlackAppService>;

export function createSlackAppService(deps: {
  authorization: AuthorizationPolicy;
  /** Null when the API runs without a master key. */
  apps: SlackAppStore | null;
  tokens: SlackConfigTokens | null;
  api: SlackConfigApi;
  consoleOrigin: string | null;
  eventsPublicUrl?: string | null;
  onAgentAppChanged?: (agentId: string) => void;
  /** Why the agent's Slack sessions would be refused now; null when they would start. */
  activeReleaseWarning?: (
    workspaceId: string,
    agentId: string,
  ) => Promise<SlackAgentWarning | null>;
  /** Where a Slack refusal's detail goes; the response carries only its code. */
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
  now?: () => Date;
  newId?: () => string;
}) {
  const { authorization, api } = deps;
  const refuse = (error: SlackApiError) => {
    deps.logger?.warn("Slack refused the app manifest", {
      method: error.method,
      slack_error: error.code,
      http_status: error.httpStatus,
      details: error.details,
    });
    return slackRefused(error);
  };
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  async function agentWarnings(
    workspaceId: string,
    agentId: string,
  ): Promise<SlackAgentWarning[]> {
    const warning =
      (await deps.activeReleaseWarning?.(workspaceId, agentId)) ?? null;
    return warning === null ? [] : [warning];
  }

  function ready() {
    if (deps.apps === null || deps.tokens === null) throw STORE_OFF();
    return { apps: deps.apps, tokens: deps.tokens };
  }

  function requireConsole(caller: Caller) {
    if (
      caller.subject.surface.kind !== "web" ||
      caller.subject.principal?.kind !== "user"
    ) {
      throw FORBIDDEN_WEB_ONLY();
    }
  }

  async function permitAgent(caller: Caller, agentId: string) {
    await requirePermitted(authorization, caller, SLACK_INSTALL_ACTION, {
      kind: "agent",
      id: agentId,
    });
    requireConsole(caller);
  }

  async function readAgent(caller: Caller, agentId: string) {
    await requirePermitted(authorization, caller, "agent.settings_read", {
      kind: "agent",
      id: agentId,
    });
    requireConsole(caller);
  }

  const actorOf = (
    caller: Caller,
    action: typeof SLACK_INSTALL_ACTION | typeof WORKSPACE_ACTION,
  ): SlackAppActor => ({
    principal: caller,
    managerRoles: MANAGEMENT_ROLES[action] ?? [],
  });

  async function finish(
    apps: SlackAppStore,
    input: Parameters<SlackAppStore["finishCreate"]>[0],
  ): Promise<SlackAppRecord> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await apps.finishCreate(input);
      } catch {
        if (attempt >= FINISH_ATTEMPTS)
          throw answerLost("apps.manifest.create");
      }
    }
  }

  async function create(
    workspaceId: string,
    agentId: string,
    actor: SlackAppActor,
    request: CreateSlackAppRequest,
  ): Promise<CreateSlackAppResponse> {
    const { apps, tokens } = ready();
    if (deps.consoleOrigin === null) throw NO_CONSOLE_ORIGIN();
    const begun = await apps.beginAgentApp({
      workspaceId,
      agentId,
      actor,
      redirectUrl: slackAppRedirectUrl(deps.consoleOrigin, agentId),
      newId: newId(),
      staleBefore: new Date(now().getTime() - SLACK_APP_CREATE_STALE_MS),
      replaceUncertain: request.replace_uncertain,
    });
    switch (begun.outcome) {
      case "agent_not_found":
        throw NOT_FOUND();
      case "agent_not_active":
        throw new SessionServiceError(
          "AGENT_NOT_ACTIVE",
          "Activate a release of this agent before creating its Slack app",
        );
      case "actor_inactive":
        throw ACTOR_INACTIVE();
      case "outranked":
        throw OUTRANKED();
      case "creating":
        throw creating(begun.app, begun.uncertain);
      case "exists": {
        if (begun.app.state !== "created") {
          throw new SessionServiceError(
            "REVISION_CONFLICT",
            "This agent's Slack app is being deleted",
          );
        }
        return {
          slack_app: slackAppView(begun.app),
          created: false,
          warnings: await agentWarnings(workspaceId, agentId),
        };
      }
    }
    const manifestInput: AgentAppManifestInput = {
      name: begun.agent.name,
      botName: begun.agent.slug,
      description: begun.agent.role,
      redirectUrl: begun.app.redirectUrl,
    };
    const previousTokenUser = await apps.lastTokenUser(workspaceId);
    let called = false;
    let created: { app: CreatedSlackApp; tokenUserId: string };
    try {
      created = await tokens.withToken(workspaceId, async (token, issuer) => {
        called = true;
        return {
          app: await api.createApp(token, buildAgentAppManifest(manifestInput)),
          tokenUserId: issuer,
        };
      });
    } catch (error) {
      const refused =
        !called ||
        (error instanceof SlackApiError && error.answered) ||
        (error instanceof SessionServiceError &&
          error.code === "CONFIG_TOKEN_INVALID");
      if (!refused) throw answerLost("apps.manifest.create");
      await apps.failCreate(workspaceId, begun.app.id);
      if (error instanceof SlackApiError) throw refuse(error);
      throw error;
    }
    const record = await finish(apps, {
      workspaceId,
      slackAppId: begun.app.id,
      created: created.app,
      tokenUserId: created.tokenUserId,
    });
    deps.onAgentAppChanged?.(agentId);
    const warnings: SlackWarning[] =
      previousTokenUser !== null && previousTokenUser !== created.tokenUserId
        ? [
            {
              code: "config_token_issuer_changed",
              previous_user_id: previousTokenUser,
              user_id: created.tokenUserId,
            },
          ]
        : [];
    return {
      slack_app: slackAppView(record),
      created: true,
      warnings: [...warnings, ...(await agentWarnings(workspaceId, agentId))],
    };
  }

  const service = {
    async createAgentApp(
      caller: Caller,
      agentId: string,
      request: CreateSlackAppRequest,
    ): Promise<CreateSlackAppResponse> {
      await permitAgent(caller, agentId);
      return create(
        caller.ownerId,
        agentId,
        actorOf(caller, SLACK_INSTALL_ACTION),
        request,
      );
    },

    /** The operator's CLI: whoever holds the database holds this right. */
    createAgentAppAsOperator(
      workspaceId: string,
      agentId: string,
      request: CreateSlackAppRequest,
    ): Promise<CreateSlackAppResponse> {
      return create(workspaceId, agentId, null, request);
    },

    async getAgentApp(
      caller: Caller,
      agentId: string,
    ): Promise<GetSlackAppResponse> {
      await readAgent(caller, agentId);
      const { apps, tokens } = ready();
      const record = await apps.findForAgent(caller.ownerId, agentId);
      const token = await tokens.describe(caller.ownerId);
      if (
        record === null &&
        (await apps.getSettings(caller.ownerId, agentId)) === null
      )
        throw NOT_FOUND();
      return {
        slack_app: record === null ? null : slackAppView(record),
        event_url:
          deps.eventsPublicUrl == null
            ? null
            : slackEventsUrl(deps.eventsPublicUrl, agentId),
        events: record?.events ?? {
          state: "pending",
          checked_at: null,
          url: null,
        },
        warnings: [
          ...issuerWarnings(record, token.issuer),
          ...(await agentWarnings(caller.ownerId, agentId)),
        ],
        config_token: token.state,
      };
    },

    async getAgentAppManifest(caller: Caller, agentId: string) {
      await readAgent(caller, agentId);
      const { apps } = ready();
      const record = await apps.findForAgent(caller.ownerId, agentId);
      const agent = await apps.manifestAgent(caller.ownerId, agentId);
      if (record === null || agent === null) throw NOT_FOUND();
      return buildAgentAppManifest({
        name: agent.name,
        botName: agent.slug,
        description: agent.role,
        redirectUrl: record.redirectUrl,
        ...(deps.eventsPublicUrl == null
          ? {}
          : { eventsUrl: slackEventsUrl(deps.eventsPublicUrl, agentId) }),
      });
    },

    async getAgentAppSettings(
      caller: Caller,
      agentId: string,
    ): Promise<SlackAppSettings> {
      await readAgent(caller, agentId);
      const settings = await ready().apps.getSettings(caller.ownerId, agentId);
      if (settings === null) throw NOT_FOUND();
      return settings;
    },

    async putAgentAppSettings(
      caller: Caller,
      agentId: string,
      settings: SlackAppSettings,
    ): Promise<SlackAppSettings> {
      await permitAgent(caller, agentId);
      const result = await ready().apps.putSettings({
        workspaceId: caller.ownerId,
        agentId,
        actor: actorOf(caller, SLACK_INSTALL_ACTION),
        settings,
      });
      if (result === "not_found") throw NOT_FOUND();
      if (result === "actor_inactive") throw ACTOR_INACTIVE();
      if (result === "outranked") throw OUTRANKED();
      return settings;
    },

    async listMadeApps(
      caller: Caller,
      workspaceId: string,
    ): Promise<ListWorkspaceSlackAppsResponse> {
      if (workspaceId !== caller.ownerId) throw NOT_FOUND();
      await requirePermitted(authorization, caller, WORKSPACE_ACTION, {
        kind: "workspace",
        id: workspaceId,
      });
      requireConsole(caller);
      const { apps } = ready();
      const made = await apps.listMade(workspaceId);
      return {
        items: made.map(({ app, agent }) => ({
          slack_app: slackAppView(app),
          agent,
        })),
      };
    },

    async deleteApp(
      caller: Caller,
      workspaceId: string,
      slackAppId: string,
    ): Promise<DeleteSlackAppResponse> {
      if (workspaceId !== caller.ownerId) throw NOT_FOUND();
      const { apps, tokens } = ready();
      const found = await apps.find(workspaceId, slackAppId);
      if (found === null) throw NOT_FOUND();
      const action =
        found.agentId === null ? WORKSPACE_ACTION : SLACK_INSTALL_ACTION;
      await requirePermitted(
        authorization,
        caller,
        action,
        found.agentId === null
          ? { kind: "workspace", id: workspaceId }
          : { kind: "agent", id: found.agentId },
      );
      requireConsole(caller);
      const begun = await apps.beginDelete({
        workspaceId,
        slackAppId,
        actor: actorOf(caller, action),
      });
      switch (begun.outcome) {
        case "not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "creating":
          throw creating(begun.app, true);
        case "settled":
          return { slack_app: slackAppView(begun.app) };
      }
      const appId = begun.app.appId;
      if (appId === null) throw new Error("deleting Slack app has no app id");
      try {
        await tokens.withToken(workspaceId, (token) =>
          api.deleteApp(token, appId),
        );
      } catch (error) {
        if (!(error instanceof SlackApiError)) throw error;
        const gone =
          error.answered &&
          (SLACK_APP_GONE_CODES.has(error.code) ||
            // Slack answers delete for an app removed in its own UI with
            // no_permission, which a foreign app gets too: export decides.
            (error.code === "no_permission" &&
              begun.app.createdByTokenUser !== null &&
              (await slackLacksApp(api, tokens, workspaceId, {
                appId,
                maker: begun.app.createdByTokenUser,
              }))));
        if (!gone) {
          throw error.answered
            ? refuse(error)
            : answerLost("apps.manifest.delete");
        }
      }
      const deleted = await apps.finishDelete(workspaceId, slackAppId);
      if (deleted.agentId !== null) deps.onAgentAppChanged?.(deleted.agentId);
      return { slack_app: slackAppView(deleted) };
    },

    /**
     * Sends the whole manifest for one of the workspace's own apps. The
     * app id is read from `slack_apps`, never taken from a caller, so the
     * token cannot be pointed at an app the platform did not make here.
     */
    updateAgentAppManifest,

    /**
     * Sends the app's manifest with its Request URL again, so Slack checks
     * the URL anew; the answer to that check arrives as a url_verification.
     */
    async recheckAgentAppEvents(
      caller: Caller,
      agentId: string,
    ): Promise<GetSlackAppResponse> {
      await permitAgent(caller, agentId);
      const { apps } = ready();
      if (deps.eventsPublicUrl == null) throw EVENTS_URL_UNSET();
      const record = await apps.findForAgent(caller.ownerId, agentId);
      const agent = await apps.manifestAgent(caller.ownerId, agentId);
      if (record === null || agent === null) throw NOT_FOUND();
      await updateAgentAppManifest(caller.ownerId, record.id, {
        name: agent.name,
        botName: agent.slug,
        description: agent.role,
        eventsUrl: slackEventsUrl(deps.eventsPublicUrl, agentId),
      });
      return service.getAgentApp(caller, agentId);
    },
  };
  return service;

  async function updateAgentAppManifest(
    workspaceId: string,
    slackAppId: string,
    input: Omit<AgentAppManifestInput, "redirectUrl">,
  ): Promise<{ permissionsUpdated: boolean }> {
    const { apps, tokens } = ready();
    const record = await apps.find(workspaceId, slackAppId);
    if (record === null || record.state !== "created" || !record.appId) {
      throw NOT_FOUND();
    }
    const appId = record.appId;
    const manifest = buildAgentAppManifest({
      ...input,
      redirectUrl: record.redirectUrl,
    });
    // A new Request URL is verified only once Slack reaches it with a
    // signed request (slack-events-service). Written before the call so a
    // challenge Slack sends while the update is in flight is kept.
    if (input.eventsUrl !== undefined)
      await apps.registerEventsUrl(
        workspaceId,
        slackAppId,
        input.eventsUrl,
        now().toISOString(),
      );
    try {
      return await tokens.withToken(workspaceId, (token) =>
        api.updateApp(token, appId, manifest),
      );
    } catch (error) {
      // An unanswered call may still have reached Slack, whose challenge
      // then left `verified`.
      if (input.eventsUrl !== undefined)
        await apps.setEventsUnlessVerified(workspaceId, slackAppId, {
          state: "failed",
          checked_at: now().toISOString(),
          error: "events_registration_failed",
        });
      if (error instanceof SlackApiError) {
        throw error.answered
          ? refuse(error)
          : answerLost("apps.manifest.update");
      }
      throw error;
    }
  }
}

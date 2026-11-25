import {
  type CreateSlackAppRequest,
  type CreateSlackAppResponse,
  type DeleteSlackAppResponse,
  type GetSlackAppBotsResponse,
  type GetSlackAppResponse,
  type ListWorkspaceSlackAppsResponse,
  type PutSlackAppBotsRequest,
  type RecheckSlackAppEventsResponse,
  SLACK_ALLOWED_BOTS_MAX,
  SLACK_BINDING_MESSAGES,
  type SlackAgentWarning,
  type SlackApp,
  type SlackAppCleanup,
  type SlackAppCleanupStep,
  type SlackAppSettings,
  type SlackBot,
  type SlackBotRefusal,
  type SlackManifestSyncError,
  type SlackWarning,
} from "@werft-ai/contracts";
import {
  ACTOR_INACTIVE,
  type AuthorizationPolicy,
  type Caller,
  type CreatedSurfaceApp,
  MANAGEMENT_ROLES,
  NOT_FOUND,
  OUTRANKED,
  requirePermitted,
  type SecretStore,
  SessionServiceError,
  type SurfaceAppActor,
  type SurfaceAppRecord,
  type SurfaceAppStore,
} from "@werft-ai/platform";
import {
  SLACK_APP_GONE_CODES,
  SlackApiError,
  type SlackBotDirectory,
  type SlackConfigApi,
  SlackRateLimitedError,
  type SlackWorkspaceBot,
} from "./slack-config-api.ts";
import { type SlackConfigTokens, slackLacksApp } from "./slack-config-token.ts";
import { slackEventsUrl } from "./slack-events-finalize.ts";
import {
  type AgentAppManifestInput,
  agentManifestDrift,
  buildAgentAppManifest,
  slackAppRedirectUrl,
} from "./slack-manifest.ts";
import { slackSecretSummaryOf } from "./slack-secret-service.ts";
import { isTokenGone } from "./slack-token-gone.ts";

const SLACK_INSTALL_ACTION = "binding.manage" as const;
const WORKSPACE_ACTION = "workspace.manage" as const;
/** Longer than the create call's timeout plus the write after it. */
export const SLACK_APP_CREATE_STALE_MS = 60_000;
const FINISH_ATTEMPTS = 3;
/** A manifest check begun longer ago than this died with its process. */
export const SLACK_MANIFEST_CHECK_STALE_MS = 10 * 60_000;
/** The longest Retry-After a start's manifest check waits out, once. */
const MANIFEST_RATE_WAIT_MAX_SECONDS = 120;
const SLACK_CLEANUP_FAILED_MESSAGE =
  "Werft closed the app, but Slack's side could not be cleaned up: delete the app in Slack's app management page (api.slack.com/apps)";

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
    "No https events address is known (CONSOLE_ORIGIN, or the events address in Settings > Integrations > Slack when events enter apart from the console), so no Request URL can be sent to Slack",
    undefined,
    { reason_code: "events_url_unset" },
  );
const creating = (app: SurfaceAppRecord, uncertain: boolean) =>
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
    error instanceof SlackRateLimitedError
      ? { afterSeconds: error.retryAfterSeconds }
      : undefined,
    { reason_code: "slack_refused", slack_error: error.code },
  );
const answerLost = (method: string) =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    `Slack's answer to ${method} was lost; asking again reports what is known`,
    { afterSeconds: 60 },
  );

export function slackAppView(record: SurfaceAppRecord): SlackApp {
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
  record: SurfaceAppRecord | null,
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

/** 200 accounts a page; a workspace past 4,000 lists only the first. */
const SLACK_BOT_LIST_MAX_PAGES = 20;

const SLACK_NOT_INSTALLED = () =>
  new SessionServiceError(
    "SLACK_NOT_INSTALLED",
    SLACK_BINDING_MESSAGES.notInstalled,
  );

/**
 * The live bots by name, each saying whether the agent answers it, then the
 * allowed ones Slack deleted, deactivated or no longer lists.
 */
export function botItems(
  allowed: readonly string[],
  bots: readonly SlackWorkspaceBot[],
): SlackBot[] {
  const allow = new Set(allowed);
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const live = bots
    .filter((bot) => !bot.deleted)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((bot) => ({
      user_id: bot.id,
      name: bot.name,
      state: "active" as const,
      allowed: allow.has(bot.id),
    }));
  const gone = allowed
    .filter((id) => byId.get(id)?.deleted !== false)
    .map((id) => ({
      user_id: id,
      name: byId.get(id)?.name ?? null,
      state: "gone" as const,
      allowed: true,
    }));
  return [...live, ...gone];
}

export type SlackAppService = ReturnType<typeof createSlackAppService>;

export function createSlackAppService(deps: {
  authorization: AuthorizationPolicy;
  /** Null when the API runs without a master key. */
  apps: SurfaceAppStore | null;
  tokens: SlackConfigTokens | null;
  api: SlackConfigApi;
  consoleOrigin: string | null;
  /** Read on each use: an owner can change it while the API runs. */
  eventsPublicUrl?: () => Promise<string | null>;
  onAgentAppChanged?: (agentId: string) => void;
  /** Why the agent's Slack sessions would be refused now; null when they would start. */
  activeReleaseWarning?: (
    workspaceId: string,
    agentId: string,
  ) => Promise<SlackAgentWarning | null>;
  /** Where a Slack refusal's detail goes; the response carries only its code. */
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
  /** Reads the install's bot accounts for the bot allow list; unset, it is off. */
  bots?: {
    secrets: Pick<SecretStore, "get">;
    api: SlackBotDirectory;
  };
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
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
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const eventsUrlOf = async (agentId: string): Promise<string | null> => {
    const base = (await deps.eventsPublicUrl?.()) ?? null;
    return base === null ? null : slackEventsUrl(base, agentId);
  };

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
  ): SurfaceAppActor => ({
    principal: caller,
    managerRoles: MANAGEMENT_ROLES[action] ?? [],
  });

  /**
   * The agent's allowed bots, and every bot account of its install's Slack
   * workspace but its own, read from Slack now.
   */
  /**
   * The install team's bots but the agent's own. When the list stops short
   * of Slack's end, the allowed and `asked` ids it did not reach are read
   * one by one, so none of them is taken for gone or unknown.
   */
  async function workspaceBots(
    workspaceId: string,
    agentId: string,
    asked: readonly string[] = [],
  ): Promise<{
    allowed: string[];
    bots: SlackWorkspaceBot[];
    truncated: boolean;
    /** Why an id that is no live bot of ours cannot be allowed. */
    refusalOf: (id: string) => SlackBotRefusal;
  }> {
    const { apps } = ready();
    const facts = await apps.getAllowedBots(workspaceId, agentId);
    if (facts === null) throw NOT_FOUND();
    const record = await apps.findForAgent(workspaceId, agentId);
    if (
      deps.bots === undefined ||
      facts.install === null ||
      record === null ||
      record.state !== "created"
    ) {
      throw SLACK_NOT_INSTALLED();
    }
    const { install } = facts;
    const token = await deps.bots.secrets.get({
      workspaceId: record.workspaceId,
      owner: { kind: "slack_app", id: record.id },
      purpose: "slack_bot_token",
    });
    if (token === null) throw SLACK_NOT_INSTALLED();
    const bots: SlackWorkspaceBot[] = [];
    // Bots of other teams Slack showed, Slack Connect's among them.
    const foreign = new Set<string>();
    // This install's agents, the agent itself among them: agents do not
    // call each other over Slack.
    const werft = new Set([...facts.werftBotUserIds, install.botUserId]);
    const keep = (bot: SlackWorkspaceBot) => {
      if (bot.teamId !== install.teamId) foreign.add(bot.id);
      else if (!werft.has(bot.id)) bots.push(bot);
    };
    let cursor: string | null = null;
    try {
      for (let page = 0; page < SLACK_BOT_LIST_MAX_PAGES; page += 1) {
        const read = await deps.bots.api.listBots(token, cursor);
        for (const bot of read.bots) keep(bot);
        cursor = read.nextCursor;
        if (cursor === null) break;
      }
      if (cursor !== null) {
        const seen = new Set([...bots.map((bot) => bot.id), ...foreign]);
        for (const id of new Set([...facts.allowedBotUserIds, ...asked])) {
          if (seen.has(id) || werft.has(id)) continue;
          const found = await deps.bots.api.findBot(token, id);
          if (found !== null) keep(found);
        }
      }
    } catch (error) {
      if (error instanceof SlackRateLimitedError) {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          `Slack is limiting ${error.method}; try again shortly`,
          { afterSeconds: error.retryAfterSeconds },
        );
      }
      if (error instanceof SlackApiError && isTokenGone(error)) {
        throw SLACK_NOT_INSTALLED();
      }
      if (error instanceof SlackApiError) {
        throw new SessionServiceError(
          "BACKEND_UNAVAILABLE",
          `Slack did not answer ${error.method}; try again`,
          { afterSeconds: 5 },
        );
      }
      throw error;
    }
    return {
      // A bot allowed before its agent's app was made here is out of the
      // list, and a save that names it again is refused.
      allowed: facts.allowedBotUserIds.filter((id) => !werft.has(id)),
      bots,
      truncated: cursor !== null,
      refusalOf: (id) =>
        id === install.botUserId
          ? "slack_bot_own"
          : werft.has(id)
            ? "slack_bot_werft_agent"
            : foreign.has(id)
              ? "slack_bot_other_team"
              : "slack_bot_unknown",
    };
  }

  /**
   * A bot added must be a live bot of the install's Slack workspace; one
   * already allowed may stay after Slack lost it. Throws the one reason the
   * first refused id has, naming every refused id that shares it.
   */
  function assertAddable(
    ids: readonly string[],
    state: Awaited<ReturnType<typeof workspaceBots>>,
  ) {
    const live = new Set(
      state.bots.filter((bot) => !bot.deleted).map((b) => b.id),
    );
    const before = new Set(state.allowed);
    const refused = ids.filter((id) => !before.has(id) && !live.has(id));
    const [first] = refused;
    if (first === undefined) return;
    const reason = state.refusalOf(first);
    throw new SessionServiceError(
      "BAD_REQUEST",
      "Only a live bot of the agent's Slack workspace can be allowed",
      undefined,
      {
        reason_code: reason,
        user_ids: refused.filter((id) => state.refusalOf(id) === reason),
      },
    );
  }

  async function finish(
    apps: SurfaceAppStore,
    input: Parameters<SurfaceAppStore["finishCreate"]>[0],
  ): Promise<SurfaceAppRecord> {
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
    actor: SurfaceAppActor,
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
    let created: { app: CreatedSurfaceApp; tokenUserId: string };
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
        event_url: await eventsUrlOf(agentId),
        events: record?.events ?? {
          state: "pending",
          checked_at: null,
          url: null,
        },
        manifest_sync: record?.manifestSync ?? null,
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
      const eventsUrl = await eventsUrlOf(agentId);
      return buildAgentAppManifest({
        name: agent.name,
        botName: agent.slug,
        description: agent.role,
        redirectUrl: record.redirectUrl,
        ...(eventsUrl === null ? {} : { eventsUrl }),
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

    async getAgentAppBots(
      caller: Caller,
      agentId: string,
    ): Promise<GetSlackAppBotsResponse> {
      await readAgent(caller, agentId);
      const { allowed, bots, truncated } = await workspaceBots(
        caller.ownerId,
        agentId,
      );
      return { items: botItems(allowed, bots), truncated };
    },

    /**
     * Saves the bots the agent answers. A bot added must be a live bot of
     * the install's Slack workspace and not the agent's own; one already
     * allowed may stay after Slack lost it, shown as gone.
     */
    async putAgentAppBots(
      caller: Caller,
      agentId: string,
      request: PutSlackAppBotsRequest,
    ): Promise<GetSlackAppBotsResponse> {
      await permitAgent(caller, agentId);
      const state = await workspaceBots(
        caller.ownerId,
        agentId,
        request.allowed_user_ids,
      );
      assertAddable(request.allowed_user_ids, state);
      const { bots, truncated } = state;
      const result = await ready().apps.putAllowedBots({
        workspaceId: caller.ownerId,
        agentId,
        actor: actorOf(caller, SLACK_INSTALL_ACTION),
        allowedBotUserIds: request.allowed_user_ids,
      });
      if (result === "not_found") throw NOT_FOUND();
      if (result === "actor_inactive") throw ACTOR_INACTIVE();
      if (result === "outranked") throw OUTRANKED();
      return { items: botItems(request.allowed_user_ids, bots), truncated };
    },

    /** The operator CLI's read of the list: whoever holds the database may. */
    async listAgentAppBotsAsOperator(
      workspaceId: string,
      agentId: string,
    ): Promise<GetSlackAppBotsResponse> {
      const { allowed, bots, truncated } = await workspaceBots(
        workspaceId,
        agentId,
      );
      return { items: botItems(allowed, bots), truncated };
    },

    /**
     * The operator CLI's allow or disallow of one bot, checked as the web
     * save checks it. A disallow reads nothing from Slack, so it works when
     * Slack does not answer. Allowing a bot already allowed, or disallowing
     * one that is not, changes and records nothing.
     */
    async changeAgentAppBotAsOperator(
      workspaceId: string,
      agentId: string,
      change: { action: "allow" | "disallow"; botUserId: string },
    ): Promise<{
      changed: boolean;
      added: string[];
      removed: string[];
      allowed_user_ids: string[];
    }> {
      const { apps } = ready();
      if (change.action === "allow") {
        const state = await workspaceBots(workspaceId, agentId, [
          change.botUserId,
        ]);
        // Already allowed, as far as it was read: nothing to add, so a
        // disallow made meanwhile is not undone, and a bot Slack lost may stay.
        if (state.allowed.includes(change.botUserId)) {
          return {
            changed: false,
            added: [],
            removed: [],
            allowed_user_ids: state.allowed,
          };
        }
        assertAddable([change.botUserId], state);
      } else if ((await apps.getAllowedBots(workspaceId, agentId)) === null) {
        throw NOT_FOUND();
      }
      // The list is changed under the row's lock, so a run at the same time
      // keeps its own change.
      const saved = await apps.changeAllowedBotAsOperator({
        workspaceId,
        agentId,
        change,
        max: SLACK_ALLOWED_BOTS_MAX,
      });
      if (saved === "not_found") throw NOT_FOUND();
      if (saved === "too_many") {
        throw new SessionServiceError(
          "BAD_REQUEST",
          `An agent answers at most ${SLACK_ALLOWED_BOTS_MAX} bots`,
          undefined,
          { reason_code: "slack_bots_too_many" },
        );
      }
      const added = saved.after.filter((id) => !saved.before.includes(id));
      const removed = saved.before.filter((id) => !saved.after.includes(id));
      return {
        changed: added.length + removed.length > 0,
        added,
        removed,
        allowed_user_ids: saved.after,
      };
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
      const { apps } = ready();
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
          // Already deleted: the Slack side was tried then, not again.
          return { slack_app: slackAppView(begun.app), slack_cleanup: null };
      }
      const appId = begun.app.appId;
      if (appId === null) throw new Error("deleting Slack app has no app id");
      // Werft's side closes first, whatever Slack can be reached for.
      const finished = await apps.finishDelete({
        workspaceId,
        slackAppId,
        actor: actorOf(caller, action),
      });
      if (finished.outcome === "settled") {
        // A delete that ran alongside closed it and tried Slack's side.
        return { slack_app: slackAppView(finished.app), slack_cleanup: null };
      }
      if (finished.app.agentId !== null) {
        deps.onAgentAppChanged?.(finished.app.agentId);
      }
      const slackCleanup = await cleanUpInSlack(workspaceId, {
        appId,
        maker: begun.app.createdByTokenUser,
        botToken: finished.botToken,
      });
      try {
        await apps.recordDeleteCleanup(
          workspaceId,
          finished.receiptId,
          slackCleanup,
        );
      } catch (error) {
        deps.logger?.warn("Slack app delete cleanup not recorded", {
          slack_app_id: slackAppId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        slack_app: slackAppView(finished.app),
        slack_cleanup: slackCleanup,
      };
    },

    /**
     * Sends the whole manifest for one of the workspace's own apps. The
     * app id is read from `slack_apps`, never taken from a caller, so the
     * token cannot be pointed at an app the platform did not make here.
     */
    updateAgentAppManifest,

    /**
     * Sends the app's manifest with its Request URL again. Slack need not
     * check an unchanged URL again; a check it does send arrives as a
     * url_verification.
     */
    async recheckAgentAppEvents(
      caller: Caller,
      agentId: string,
    ): Promise<RecheckSlackAppEventsResponse> {
      await permitAgent(caller, agentId);
      const { apps } = ready();
      const eventsUrl = await eventsUrlOf(agentId);
      if (eventsUrl === null) throw EVENTS_URL_UNSET();
      const record = await apps.findForAgent(caller.ownerId, agentId);
      const agent = await apps.manifestAgent(caller.ownerId, agentId);
      if (record === null || agent === null) throw NOT_FOUND();
      const { permissionsUpdated } = await updateAgentAppManifest(
        caller.ownerId,
        record.id,
        {
          name: agent.name,
          botName: agent.slug,
          description: agent.role,
          eventsUrl,
        },
      );
      return {
        ...(await service.getAgentApp(caller, agentId)),
        reinstall_required: permissionsUpdated,
      };
    },

    /**
     * Run once at each start of the API: an agent app whose manifest in
     * Slack differs from this build's in its bot events only is sent its
     * whole manifest, which Slack takes without a new install. One whose
     * scopes differ, or that has no event subscription yet, is left alone.
     * What could not be done is recorded on the app and tried again at the
     * next start or recheck; nothing here runs on a timer.
     */
    async syncAgentAppManifests(): Promise<{
      checked: number;
      sent: number;
      failed: number;
    }> {
      const summary = { checked: 0, sent: 0, failed: 0 };
      if (deps.apps === null || deps.tokens === null) return summary;
      const { apps } = deps;
      const tokenActive = new Map<string, boolean>();
      for (const target of await apps.listAgentAppsForManifestCheck()) {
        const at = now();
        const claimed = await apps.claimManifestCheck({
          workspaceId: target.workspaceId,
          slackAppId: target.slackAppId,
          at,
          staleBefore: new Date(at.getTime() - SLACK_MANIFEST_CHECK_STALE_MS),
        });
        if (!claimed) continue;
        summary.checked += 1;
        const outcome = await checkAgentAppManifest(target, tokenActive).catch(
          (error: unknown) => {
            deps.logger?.warn("Slack app manifest check failed", {
              slack_app_id: target.slackAppId,
              error: error instanceof Error ? error.name : "unknown",
            });
            return "failed" as const;
          },
        );
        if (outcome === "sent") summary.sent += 1;
        if (outcome === "failed") summary.failed += 1;
      }
      return summary;
    },
  };
  return service;

  /**
   * After a delete committed: `auth.revoke` with the app's bot token, then
   * `apps.manifest.delete`, each once. A token or app Slack no longer has
   * counts as done. A failure is named, never tried again.
   */
  async function cleanUpInSlack(
    workspaceId: string,
    app: { appId: string; maker: string | null; botToken: string | null },
  ): Promise<SlackAppCleanup> {
    const { tokens } = ready();
    const failed: SlackAppCleanupStep[] = [];
    const note = (step: SlackAppCleanupStep, error: unknown) => {
      failed.push(step);
      deps.logger?.warn("Slack app delete: Slack-side cleanup failed", {
        method: step,
        app_id: app.appId,
        ...(error instanceof SlackApiError
          ? { slack_error: error.code, answered: error.answered }
          : { error: error instanceof Error ? error.name : "unknown" }),
      });
    };
    if (app.botToken !== null) {
      const botToken = app.botToken;
      try {
        await api.revokeBotToken(botToken);
      } catch (error) {
        if (!isTokenGone(error)) note("auth.revoke", error);
      }
    }
    try {
      await tokens.withToken(workspaceId, (token) =>
        api.deleteApp(token, app.appId),
      );
    } catch (error) {
      const gone =
        error instanceof SlackApiError &&
        error.answered &&
        (SLACK_APP_GONE_CODES.has(error.code) ||
          // Slack answers delete for an app removed in its own UI with
          // no_permission, which a foreign app gets too: export decides.
          (error.code === "no_permission" &&
            app.maker !== null &&
            (await slackLacksApp(api, tokens, workspaceId, {
              appId: app.appId,
              maker: app.maker,
            }).catch(() => false))));
      if (!gone) note("apps.manifest.delete", error);
    }
    return failed.length === 0
      ? { outcome: "done", failed_steps: [], message: null }
      : {
          outcome: "failed",
          failed_steps: failed,
          message: SLACK_CLEANUP_FAILED_MESSAGE,
        };
  }

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
    // A Request URL is verified once Slack reaches it with a signed request
    // (slack-events-service); a verified app stays verified when its URL
    // moves. Written before the call so a challenge Slack sends while the
    // update is in flight is kept.
    const moved =
      input.eventsUrl !== undefined &&
      (record.events?.url ?? null) !== input.eventsUrl;
    if (input.eventsUrl !== undefined)
      await apps.registerEventsUrl(
        workspaceId,
        slackAppId,
        input.eventsUrl,
        now().toISOString(),
      );
    try {
      const sent = await tokens.withToken(workspaceId, (token) =>
        api.updateApp(token, appId, manifest),
      );
      await recordManifestSync(workspaceId, slackAppId, null);
      return sent;
    } catch (error) {
      // An unanswered call may still have reached Slack, whose challenge
      // then left `verified`. Any other failure, a refused token included,
      // leaves Slack on the old URL whatever `verified` the store holds.
      const failed = {
        state: "failed",
        checked_at: now().toISOString(),
        error: "events_registration_failed",
      } as const;
      const unanswered = error instanceof SlackApiError && !error.answered;
      if (moved && !unanswered)
        await apps.setEvents(workspaceId, slackAppId, failed);
      else if (input.eventsUrl !== undefined)
        await apps.setEventsUnlessVerified(workspaceId, slackAppId, failed);
      const unsent = manifestSyncErrorOf(error);
      if (unsent !== null)
        await recordManifestSync(workspaceId, slackAppId, unsent);
      if (error instanceof SlackApiError) {
        throw error.answered
          ? refuse(error)
          : answerLost("apps.manifest.update");
      }
      throw error;
    }
  }

  /** A failure to record is logged: it must not hide what Slack answered. */
  async function recordManifestSync(
    workspaceId: string,
    slackAppId: string,
    error: SlackManifestSyncError | null,
  ) {
    try {
      await ready().apps.setManifestSync(workspaceId, slackAppId, {
        error,
        checkedAt: now(),
      });
    } catch (failure) {
      deps.logger?.warn("Slack app manifest check not recorded", {
        slack_app_id: slackAppId,
        error: failure instanceof Error ? failure.name : "unknown",
      });
    }
  }

  /**
   * Calls once more after a Retry-After short enough to wait out; one app's
   * check shares `budget`, so it waits at most once.
   */
  async function paced<T>(
    budget: { waited: boolean },
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      const wait =
        error instanceof SlackRateLimitedError
          ? error.retryAfterSeconds
          : error instanceof SessionServiceError &&
              (error.details as { slack_error?: unknown } | null)
                ?.slack_error === "ratelimited"
            ? (error.retry?.afterSeconds ?? null)
            : null;
      if (
        wait === null ||
        wait > MANIFEST_RATE_WAIT_MAX_SECONDS ||
        budget.waited
      )
        throw error;
      budget.waited = true;
      await sleep(wait * 1000);
      return call();
    }
  }

  async function checkAgentAppManifest(
    target: { workspaceId: string; slackAppId: string; agentId: string },
    tokenActive: Map<string, boolean>,
  ): Promise<"current" | "sent" | "left" | "failed"> {
    const { apps, tokens } = ready();
    const { workspaceId, slackAppId, agentId } = target;
    let active = tokenActive.get(workspaceId);
    if (active === undefined) {
      active = (await tokens.describe(workspaceId)).state === "active";
      tokenActive.set(workspaceId, active);
    }
    if (!active) {
      await recordManifestSync(
        workspaceId,
        slackAppId,
        "config_token_inactive",
      );
      return "failed";
    }
    const record = await apps.find(workspaceId, slackAppId);
    const appId = record?.state === "created" ? record.appId : null;
    if (!appId) return "left";
    const budget = { waited: false };
    let exported: unknown;
    try {
      exported = await paced(budget, () =>
        tokens.withToken(workspaceId, (token) => api.exportApp(token, appId)),
      );
    } catch (error) {
      const unread = manifestSyncErrorOf(error);
      if (unread === null) throw error;
      if (unread === "config_token_inactive")
        tokenActive.set(workspaceId, false);
      await recordManifestSync(workspaceId, slackAppId, unread);
      return "failed";
    }
    const drift = agentManifestDrift(exported);
    if (drift === "current") {
      await recordManifestSync(workspaceId, slackAppId, null);
      return "current";
    }
    if (drift !== "events") {
      // A scope change waits for an admin's new install; the rest is
      // Finalize's, or not an agent app manifest at all.
      if (drift !== "unsubscribed")
        deps.logger?.warn("Slack app manifest left as it is", {
          slack_app_id: slackAppId,
          drift,
        });
      // Nothing is left to send on its own: an earlier failure no longer holds.
      await recordManifestSync(workspaceId, slackAppId, null);
      return "left";
    }
    const eventsUrl = await eventsUrlOf(agentId);
    if (eventsUrl === null) {
      await recordManifestSync(workspaceId, slackAppId, "events_url_unset");
      return "failed";
    }
    const agent = await apps.manifestAgent(workspaceId, agentId);
    if (agent === null) return "left";
    try {
      // Records its own outcome on the app.
      await paced(budget, () =>
        updateAgentAppManifest(workspaceId, slackAppId, {
          name: agent.name,
          botName: agent.slug,
          description: agent.role,
          eventsUrl,
        }),
      );
      return "sent";
    } catch {
      return "failed";
    }
  }
}

/** What a manifest check records for a failure; null for one it cannot name. */
function manifestSyncErrorOf(error: unknown): SlackManifestSyncError | null {
  if (error instanceof SlackApiError)
    return error.answered ? "slack_refused" : "no_answer";
  if (
    error instanceof SessionServiceError &&
    error.code === "CONFIG_TOKEN_INVALID"
  )
    return "config_token_inactive";
  // A config token rotation Slack did not answer, or rate-limited.
  if (
    error instanceof SessionServiceError &&
    error.code === "BACKEND_UNAVAILABLE"
  )
    return (error.details as { slack_error?: unknown } | null)?.slack_error ===
      "ratelimited"
      ? "slack_refused"
      : "no_answer";
  return null;
}

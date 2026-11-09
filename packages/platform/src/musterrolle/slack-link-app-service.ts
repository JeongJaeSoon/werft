import type { SlackApp, SlackWarning } from "@werft-ai/contracts";
import type {
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
  SLACK_APP_CREATE_STALE_MS,
  slackAppView,
} from "./slack-app-service.ts";
import {
  type CreatedSlackApp,
  SlackApiError,
  type SlackConfigApi,
} from "./slack-config-api.ts";
import type { SlackConfigTokens } from "./slack-config-token.ts";
import {
  buildLinkAppManifest,
  slackLinkRedirectUrl,
} from "./slack-manifest.ts";

const WORKSPACE_ACTION = "workspace.manage" as const;
const FINISH_ATTEMPTS = 3;
/** How long a start waits for a link app another request is creating. */
export const SLACK_LINK_APP_WAIT_MS = 15_000;
const WAIT_POLL_MS = 250;

/** The OIDC client Sign in with Slack runs as, for one workspace. */
export type SlackLinkClient = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  slackAppId: string | null;
};

export type SlackLinkAppResult = {
  slack_app: SlackApp;
  /** False when the workspace already had its link app. */
  created: boolean;
  warnings: SlackWarning[];
};

const FORBIDDEN_WEB_ONLY = () =>
  new SessionServiceError(
    "FORBIDDEN",
    "Slack apps are managed from a signed-in console session, not with an API key",
    undefined,
    { reason_code: "web_session_required" },
  );
const NOT_CONFIGURED = (reason: "store_off" | "no_console" | "config_token") =>
  new SessionServiceError(
    "SLACK_LINK_NOT_CONFIGURED",
    "Slack account linking is not set up for this workspace; ask an owner or admin to set up Slack in Integrations",
    undefined,
    { reason_code: reason },
  );
const creating = (app: SlackAppRecord, uncertain: boolean) =>
  new SessionServiceError(
    "SLACK_APP_CREATING",
    uncertain
      ? "An earlier creation of this workspace's Slack link app got no answer. Check api.slack.com/apps for it; if it is not there, ask again with replace_uncertain"
      : "This workspace's Slack link app is being created",
    undefined,
    { slack_app_id: app.id, uncertain },
  );
const DELETING = () =>
  new SessionServiceError(
    "REVISION_CONFLICT",
    "This workspace's Slack link app is being deleted",
  );
const slackRefused = (error: SlackApiError) =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    `Slack refused ${error.method}: ${error.code}`,
    undefined,
    { reason_code: "slack_refused", slack_error: error.code },
  );
const answerLost = () =>
  new SessionServiceError(
    "BACKEND_UNAVAILABLE",
    "Slack's answer to apps.manifest.create was lost; asking again reports what is known",
    { afterSeconds: 60 },
  );

export type SlackLinkAppService = ReturnType<typeof createSlackLinkAppService>;

/**
 * The workspace's account-linking Slack app and the OIDC client Sign in
 * with Slack runs as: the workspace's `created` link app, else (on a
 * start) a link app made now.
 */
export function createSlackLinkAppService(deps: {
  authorization: AuthorizationPolicy;
  /** Null when the API runs without a master key. */
  apps: SlackAppStore | null;
  tokens: SlackConfigTokens | null;
  api: SlackConfigApi;
  consoleOrigin: string | null;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}) {
  const { authorization, api } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  async function clientFor(
    workspaceId: string,
  ): Promise<SlackLinkClient | null> {
    const own = await deps.apps?.linkAppClient(workspaceId);
    if (own && own.app.clientId !== null) {
      return {
        clientId: own.app.clientId,
        clientSecret: own.clientSecret,
        redirectUri: own.app.redirectUrl,
        slackAppId: own.app.id,
      };
    }
    return null;
  }

  async function finish(
    apps: SlackAppStore,
    input: Parameters<SlackAppStore["finishCreate"]>[0],
  ): Promise<SlackAppRecord> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await apps.finishCreate(input);
      } catch {
        if (attempt >= FINISH_ATTEMPTS) throw answerLost();
      }
    }
  }

  /** Begins, creates in Slack and seals; the shape of the agent app's. */
  async function create(
    workspaceId: string,
    actor: SlackAppActor,
    replaceUncertain: boolean,
    /** A start waits out another request's creation instead of refusing. */
    waitUntil: number | null,
  ): Promise<SlackLinkAppResult> {
    const { apps, tokens } = deps;
    if (apps === null || tokens === null) throw NOT_CONFIGURED("store_off");
    if (deps.consoleOrigin === null) throw NOT_CONFIGURED("no_console");
    const redirectUrl = slackLinkRedirectUrl(deps.consoleOrigin);
    for (;;) {
      const begun = await apps.beginLinkApp({
        workspaceId,
        actor,
        redirectUrl,
        newId: newId(),
        staleBefore: new Date(now().getTime() - SLACK_APP_CREATE_STALE_MS),
        replaceUncertain,
      });
      switch (begun.outcome) {
        case "workspace_not_found":
          throw NOT_FOUND();
        case "actor_inactive":
          throw ACTOR_INACTIVE();
        case "outranked":
          throw OUTRANKED();
        case "creating":
          if (
            !begun.uncertain &&
            waitUntil !== null &&
            now().getTime() < waitUntil
          ) {
            await sleep(WAIT_POLL_MS);
            continue;
          }
          throw creating(begun.app, begun.uncertain);
        case "exists":
          if (begun.app.state !== "created") throw DELETING();
          return {
            slack_app: slackAppView(begun.app),
            created: false,
            warnings: [],
          };
      }
      const previousTokenUser = await apps.lastTokenUser(workspaceId);
      let called = false;
      let made: { app: CreatedSlackApp; tokenUserId: string };
      try {
        made = await tokens.withToken(workspaceId, async (token, issuer) => {
          called = true;
          return {
            app: await api.createApp(
              token,
              buildLinkAppManifest({
                workspaceName: begun.workspaceName,
                redirectUrl: begun.app.redirectUrl,
              }),
            ),
            tokenUserId: issuer,
          };
        });
      } catch (error) {
        const refused =
          !called ||
          (error instanceof SlackApiError && error.answered) ||
          (error instanceof SessionServiceError &&
            error.code === "CONFIG_TOKEN_INVALID");
        if (!refused) throw answerLost();
        await apps.failCreate(workspaceId, begun.app.id);
        if (error instanceof SlackApiError) throw slackRefused(error);
        throw error;
      }
      const record = await finish(apps, {
        workspaceId,
        slackAppId: begun.app.id,
        created: made.app,
        tokenUserId: made.tokenUserId,
      });
      return {
        slack_app: slackAppView(record),
        created: true,
        warnings:
          previousTokenUser !== null && previousTokenUser !== made.tokenUserId
            ? [
                {
                  code: "config_token_issuer_changed",
                  previous_user_id: previousTokenUser,
                  user_id: made.tokenUserId,
                },
              ]
            : [],
      };
    }
  }

  return {
    /** The client a callback exchanges its code with; never creates. */
    clientFor,

    /**
     * The client a start sends the person to Slack with. Without a link
     * app, the link app is made now: on behalf of the
     * workspace, for whoever may link their own account (the caller's
     * right to link is checked before this).
     */
    async clientForStart(caller: Caller): Promise<SlackLinkClient> {
      const workspaceId = caller.ownerId;
      const found = await clientFor(workspaceId);
      if (found !== null) return found;
      if (deps.tokens !== null) {
        const token = await deps.tokens.describe(workspaceId);
        // Refused before a row is written: a start with nothing to create
        // with leaves no `failed` app behind.
        if (token.state !== "active") throw NOT_CONFIGURED("config_token");
      }
      try {
        await create(
          workspaceId,
          null,
          false,
          now().getTime() + SLACK_LINK_APP_WAIT_MS,
        );
      } catch (error) {
        if (
          error instanceof SessionServiceError &&
          error.code === "CONFIG_TOKEN_INVALID"
        ) {
          throw NOT_CONFIGURED("config_token");
        }
        throw error;
      }
      const made = await clientFor(workspaceId);
      if (made === null) throw new Error("created link app has no client");
      return made;
    },

    /** An owner or admin making the link app ahead of anyone linking. */
    async createLinkApp(
      caller: Caller,
      request: { replace_uncertain: boolean },
    ): Promise<SlackLinkAppResult> {
      await requirePermitted(authorization, caller, WORKSPACE_ACTION, {
        kind: "workspace",
        id: caller.ownerId,
      });
      if (
        caller.subject.surface.kind !== "web" ||
        caller.subject.principal?.kind !== "user"
      ) {
        throw FORBIDDEN_WEB_ONLY();
      }
      return create(
        caller.ownerId,
        {
          principal: caller,
          managerRoles: MANAGEMENT_ROLES[WORKSPACE_ACTION] ?? [],
        },
        request.replace_uncertain,
        null,
      );
    },

    /** The operator's CLI: whoever holds the database holds this right. */
    createLinkAppAsOperator(
      workspaceId: string,
      request: { replace_uncertain: boolean },
    ): Promise<SlackLinkAppResult> {
      return create(workspaceId, null, request.replace_uncertain, null);
    },
  };
}

import {
  githubLinkCallbackRequestSchema,
  githubLinkCallbackResponseSchema,
  LINK_MESSAGES,
  linkedAccountParamsSchema,
  listLinkedAccountsResponseSchema,
  slackLinkCallbackRequestSchema,
  slackLinkCallbackResponseSchema,
  startGitHubLinkResponseSchema,
  startSlackLinkResponseSchema,
  unlinkAccountResponseSchema,
} from "@werft-ai/contracts";
import type { StructuredLogger } from "@werft-ai/observability";
import type {
  GitHubOAuthStore,
  LinkedAccountService,
} from "@werft-ai/platform";
import type {
  SlackLinkAppService,
  SlackLinkClient,
} from "../../wiring/chat-slack.ts";
import {
  ApiHttpError,
  type ApiRouter,
  apiRoute,
  jsonWithSchema,
  parseJsonBody,
} from "../app.ts";
import {
  consumeGitHubLinkState,
  exchangeGitHubCode,
  GITHUB_LINK_TTL_MS,
  GitHubOAuthRejectedError,
  GitHubOAuthUnavailableError,
  githubAuthorizeUrl,
  issueGitHubLinkState,
} from "../github-link.ts";
import {
  consumeSlackLinkState,
  exchangeSlackCode,
  issueSlackLinkState,
  SLACK_LINK_TTL_MS,
  type SlackOidcConfig,
  SlackOidcRejectedError,
  SlackOidcUnavailableError,
  slackAuthorizeUrl,
} from "../slack-link.ts";
import { mapped, requireParams } from "./errors.ts";

export interface LinkedAccountRouteDeps {
  /** The author App's user authorization; `redirectUri` null without a console origin. */
  github: {
    oauth: Pick<GitHubOAuthStore, "client">;
    redirectUri: string | null;
  };
  service: LinkedAccountService;
  /** Null: Sign in with Slack is not configured on this installation. */
  slack: {
    issuer: string;
    clients: Pick<SlackLinkAppService, "clientFor" | "clientForStart">;
  } | null;
  logger?: StructuredLogger;
}

function slackConfigured(deps: LinkedAccountRouteDeps) {
  if (!deps.slack) {
    throw new ApiHttpError(
      503,
      "BACKEND_UNAVAILABLE",
      "Sign in with Slack is not configured on this installation",
    );
  }
  return deps.slack;
}

const oidcConfig = (
  slack: NonNullable<LinkedAccountRouteDeps["slack"]>,
  client: SlackLinkClient,
): SlackOidcConfig => ({
  clientId: client.clientId,
  clientSecret: client.clientSecret,
  redirectUri: client.redirectUri,
  issuer: slack.issuer,
});

export function registerLinkedAccountRoutes(
  router: ApiRouter,
  deps: LinkedAccountRouteDeps,
) {
  apiRoute(router, "startSlackLink", async (context) => {
    const caller = context.get("caller");
    const slack = slackConfigured(deps);
    const { userId, teams } = await mapped(() =>
      deps.service.beginSlackLink(caller),
    );
    // May make the workspace's link app, so only after the caller may link.
    const client = await mapped(() => slack.clients.clientForStart(caller));
    const expiresAt = new Date(Date.now() + SLACK_LINK_TTL_MS);
    const issued = issueSlackLinkState(context, userId, expiresAt);
    return jsonWithSchema(context, startSlackLinkResponseSchema, {
      authorize_url: slackAuthorizeUrl(
        oidcConfig(slack, client),
        issued,
        teams.length === 1 ? (teams[0] ?? null) : null,
      ),
      expires_at: expiresAt.toISOString(),
    });
  });

  apiRoute(router, "slackLinkCallback", async (context) => {
    const caller = context.get("caller");
    const slack = slackConfigured(deps);
    const body = await parseJsonBody(context, slackLinkCallbackRequestSchema);
    const userId = await mapped(() => deps.service.personFor(caller));
    const issued = consumeSlackLinkState(context, body.state, userId);
    // The client the start used, unless the workspace has lost it since.
    const client = issued
      ? await mapped(() => slack.clients.clientFor(caller.ownerId))
      : null;
    if (!issued || !client) {
      throw new ApiHttpError(400, "BAD_REQUEST", LINK_MESSAGES.expired);
    }
    let verified: Awaited<ReturnType<typeof exchangeSlackCode>>;
    try {
      verified = await exchangeSlackCode(
        oidcConfig(slack, client),
        body.code,
        issued.nonce,
      );
    } catch (error) {
      if (error instanceof SlackOidcRejectedError) {
        deps.logger?.warn("Slack link refused by the IdP", {
          reason: error.message,
        });
        throw new ApiHttpError(400, "BAD_REQUEST", LINK_MESSAGES.expired);
      }
      if (error instanceof SlackOidcUnavailableError) {
        deps.logger?.warn("Slack link could not reach Slack", {
          reason: error.message,
        });
        throw new ApiHttpError(
          503,
          "BACKEND_UNAVAILABLE",
          "Slack could not be reached, try again later",
          true,
        );
      }
      throw error;
    }
    const linked = await mapped(() =>
      deps.service.linkSlackAccount(caller, verified),
    );
    deps.logger?.info("Slack account linked", {
      user_id: linked.linked_account.user_id,
      linked_account_id: linked.linked_account.id,
    });
    return jsonWithSchema(
      context,
      slackLinkCallbackResponseSchema,
      linked,
      201,
    );
  });

  // Null when anything the author App's user authorization needs is missing.
  async function githubClientFor(workspaceId: string) {
    const redirectUri = deps.github.redirectUri;
    const client =
      redirectUri === null ? null : await deps.github.oauth.client(workspaceId);
    if (redirectUri === null || client === null) {
      throw new ApiHttpError(
        409,
        "GITHUB_LINK_NOT_CONFIGURED",
        LINK_MESSAGES.githubUnset,
        false,
        undefined,
        { reason_code: "github_oauth_unset" },
      );
    }
    return { client, redirectUri };
  }

  apiRoute(router, "startGitHubLink", async (context) => {
    const caller = context.get("caller");
    const userId = await mapped(() => deps.service.personFor(caller));
    const { client, redirectUri } = await githubClientFor(caller.ownerId);
    const expiresAt = new Date(Date.now() + GITHUB_LINK_TTL_MS);
    const state = issueGitHubLinkState(
      context,
      userId,
      client.connectionId,
      expiresAt,
    );
    return jsonWithSchema(context, startGitHubLinkResponseSchema, {
      authorize_url: githubAuthorizeUrl(client, redirectUri, state),
      expires_at: expiresAt.toISOString(),
    });
  });

  apiRoute(router, "githubLinkCallback", async (context) => {
    const caller = context.get("caller");
    const body = await parseJsonBody(context, githubLinkCallbackRequestSchema);
    const userId = await mapped(() => deps.service.personFor(caller));
    const issuedFor = consumeGitHubLinkState(context, body.state, userId);
    if (issuedFor === null) {
      throw new ApiHttpError(400, "BAD_REQUEST", LINK_MESSAGES.expired);
    }
    const { client, redirectUri } = await githubClientFor(caller.ownerId);
    // Started with another connection's client: its code is not this one's.
    if (client.connectionId !== issuedFor) {
      throw new ApiHttpError(400, "BAD_REQUEST", LINK_MESSAGES.expired);
    }
    let verified: Awaited<ReturnType<typeof exchangeGitHubCode>>;
    try {
      verified = await exchangeGitHubCode(client, body.code, redirectUri);
    } catch (error) {
      if (error instanceof GitHubOAuthRejectedError) {
        deps.logger?.warn("GitHub link refused by GitHub", {
          reason: error.message,
        });
        throw new ApiHttpError(400, "BAD_REQUEST", LINK_MESSAGES.expired);
      }
      if (error instanceof GitHubOAuthUnavailableError) {
        deps.logger?.warn("GitHub link could not reach GitHub", {
          reason: error.message,
        });
        throw new ApiHttpError(
          503,
          "BACKEND_UNAVAILABLE",
          "GitHub could not be reached, try again later",
          true,
        );
      }
      throw error;
    }
    const linked = await mapped(() =>
      deps.service.linkGitHubAccount(caller, verified),
    );
    deps.logger?.info("GitHub account linked", {
      user_id: linked.linked_account.user_id,
      linked_account_id: linked.linked_account.id,
    });
    return jsonWithSchema(
      context,
      githubLinkCallbackResponseSchema,
      linked,
      201,
    );
  });

  apiRoute(router, "listLinkedAccounts", async (context) => {
    const page = await mapped(() =>
      deps.service.listLinkedAccounts(context.get("caller")),
    );
    return jsonWithSchema(context, listLinkedAccountsResponseSchema, page);
  });

  apiRoute(router, "unlinkAccount", async (context) => {
    const params = requireParams(context, linkedAccountParamsSchema);
    const receipt = await mapped(() =>
      deps.service.unlinkAccount(context.get("caller"), params.id),
    );
    return jsonWithSchema(context, unlinkAccountResponseSchema, receipt);
  });
}

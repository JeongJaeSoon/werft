import { expect, test } from "bun:test";
import type {
  SlackAppService,
  SlackChannelSearchService,
  SlackEventsService,
  SlackInstallService,
  SlackInteractionService,
  SlackSecretService,
} from "@werft-ai/chat-slack";
import type {
  AchievementRuleService,
  AgentAdminService,
  AgentCallerLimitsService,
  AgentGitHubService,
  AgentIdentityService,
  AgentMcpService,
  AgentPullRequestService,
  AgentService,
  AgentUsageService,
  ApiKeyService,
  CredentialBindingService,
  EngineSettingsService,
  EnvVariableService,
  GitHubAppService,
  GitHubRepositoryService,
  GitHubSettingsService,
  GitHubWorkService,
  IdentityStore,
  InterruptService,
  InviteService,
  InviteStore,
  LinkedAccountService,
  MemberService,
  PendingRequestService,
  PullRequestService,
  PushRequestService,
  SessionAchievementService,
  SessionAttributionService,
  SessionOutcomeService,
  SessionOutputService,
  SessionService,
  SessionShareService,
  SettingsConsoleService,
  SettingsDocumentService,
  SurfaceBindingService,
  TeamService,
  UsageService,
} from "@werft-ai/platform";
import { createApiApp } from "./app.ts";
import type { BootstrapGate } from "./auth.ts";
import type { LoginSettingsAdmin } from "./login-settings.ts";
import { buildOpenApiDocument, DOCUMENTED_ROUTE_SCOPES } from "./openapi.ts";
import type { ProviderAdmin } from "./provider-admin.ts";
import { createSlackEventsLimiter } from "./rate-limit.ts";
import { ROUTE_ERROR_TESTS } from "./route-error-coverage.ts";
import { registerAgentPullRequestRoutes } from "./routes/action/agent-pull-request.ts";
import { registerPullRequestRoutes } from "./routes/action/pull-requests.ts";
import { registerPushRequestRoutes } from "./routes/action/push-requests.ts";
import { registerAgentMcpRoutes } from "./routes/agents/agent-mcp.ts";
import { registerAgentRoutes } from "./routes/agents/agents.ts";
import { registerEngineSettingsRoutes } from "./routes/agents/engine-settings.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerAgentGitHubRoutes } from "./routes/github/agent-github.ts";
import { registerGitHubAppRoutes } from "./routes/github/github-app.ts";
import { registerGitHubPackagesRoutes } from "./routes/github/github-packages.ts";
import { registerGitHubRepositoryRoutes } from "./routes/github/github-repositories.ts";
import { registerGitHubSettingsRoutes } from "./routes/github/github-settings.ts";
import {
  registerGitHubWorkRoutes,
  registerSessionAttributionRoutes,
  registerSessionOutcomeRoutes,
} from "./routes/github/github-work.ts";
import {
  registerInstallationSettingsRoutes,
  registerSettingsConsoleRoutes,
} from "./routes/installation-settings.ts";
import { registerLoginProviderRoutes } from "./routes/login-providers.ts";
import { registerLoginSettingsRoutes } from "./routes/login-settings.ts";
import { registerAgentCallerLimitsRoutes } from "./routes/musterrolle/agent-caller-limits.ts";
import { registerAgentIdentityRoutes } from "./routes/musterrolle/agent-identities.ts";
import { registerAgentUsageRoutes } from "./routes/musterrolle/agent-usage.ts";
import { registerApiKeyRoutes } from "./routes/musterrolle/api-keys.ts";
import { registerCredentialBindingRoutes } from "./routes/musterrolle/credential-bindings.ts";
import { registerEnvVariableRoutes } from "./routes/musterrolle/env-variables.ts";
import {
  registerInviteRoutes,
  registerPublicInviteRoutes,
} from "./routes/musterrolle/invites.ts";
import { registerLinkedAccountRoutes } from "./routes/musterrolle/linked-accounts.ts";
import { registerMemberRoutes } from "./routes/musterrolle/members.ts";
import { registerSessionShareRoutes } from "./routes/musterrolle/session-shares.ts";
import { registerTeamRoutes } from "./routes/musterrolle/teams.ts";
import {
  registerWorkspaceRoutes,
  type WorkspaceRouteDeps,
} from "./routes/musterrolle/workspaces.ts";
import {
  registerAchievementRoutes,
  registerSessionAchievementRoutes,
} from "./routes/sessions/achievements.ts";
import { registerCloseRoutes } from "./routes/sessions/close.ts";
import { registerEventRoutes } from "./routes/sessions/events.ts";
import { registerInterruptRoutes } from "./routes/sessions/interrupt.ts";
import { registerSessionOutputRoutes } from "./routes/sessions/outputs.ts";
import { registerPauseRoutes } from "./routes/sessions/pause.ts";
import { registerPendingRoutes } from "./routes/sessions/pending.ts";
import { registerReceiptRoutes } from "./routes/sessions/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions/sessions.ts";
import { registerSlackAppRoutes } from "./routes/surface/slack-apps.ts";
import { registerSlackBindingRoutes } from "./routes/surface/slack-bindings.ts";
import { registerSlackChannelRoutes } from "./routes/surface/slack-channels.ts";
import { registerSlackEventRoutes } from "./routes/surface/slack-events.ts";
import { registerSlackInstallRoutes } from "./routes/surface/slack-install.ts";
import { registerSlackInteractionRoutes } from "./routes/surface/slack-interactions.ts";
import { registerSlackSecretRoutes } from "./routes/surface/slack-secrets.ts";
import { registerUsageRoutes } from "./routes/usage/usage.ts";

// Routes the OpenAPI table declares but no Hono handler serves yet. Shrink
// this list as sibling tickets land; a route removed from here must exist.
const NOT_YET_IMPLEMENTED: string[] = [];
// The API reference UI and its same-origin asset are public documentation,
// not API operations. Keep this exception explicit so adding another Hono
// handler still requires either an OpenAPI declaration or a reviewed reason.
const NON_API_ROUTES = new Set([
  "GET /docs",
  "GET /docs/style-nonce.js",
  "GET /docs/scalar.js",
]);

function apiApp() {
  const auth = {
    identity: {} as IdentityStore,
    bootstrap: {} as BootstrapGate,
  };
  return createApiApp({
    authMode: "none",
    registerPublicRoutes: (router) => {
      registerPublicAuthRoutes(router, auth);
      registerPublicInviteRoutes(router, {
        invites: {} as InviteStore,
        identity: auth.identity,
      });
      registerSlackEventRoutes(router, {
        events: {} as SlackEventsService,
        limiter: createSlackEventsLimiter(),
      });
      registerSlackInteractionRoutes(router, {
        interactions: {} as SlackInteractionService,
        limiter: createSlackEventsLimiter(),
      });
    },
    registerRoutes: (router) => {
      registerAuthRoutes(router, auth);
      registerInviteRoutes(router, {} as InviteService);
      registerSessionRoutes(router, {} as SessionService);
      registerSessionShareRoutes(
        router,
        {} as SessionShareService,
        {} as SessionService,
      );
      registerReceiptRoutes(router, {} as SessionService);
      registerPendingRoutes(router, {} as PendingRequestService);
      registerPushRequestRoutes(router, {} as PushRequestService);
      registerPullRequestRoutes(router, {} as PullRequestService);
      registerInterruptRoutes(router, {} as InterruptService);
      registerMemberRoutes(router, {} as MemberService, {} as InviteService);
      registerAgentRoutes(router, {} as AgentService);
      registerAgentIdentityRoutes(router, {
        service: {} as AgentIdentityService,
      });
      registerSlackBindingRoutes(router, {
        service: {} as SurfaceBindingService,
      });
      registerSlackChannelRoutes(router, {
        service: {} as SlackChannelSearchService,
      });
      registerLinkedAccountRoutes(router, {
        service: {} as LinkedAccountService,
        slack: null,
        github: { oauth: { client: async () => null }, redirectUri: null },
      });
      registerApiKeyRoutes(router, {} as ApiKeyService);
      registerTeamRoutes(router, {} as TeamService, {} as AgentAdminService);
      registerAgentUsageRoutes(router, {} as AgentUsageService);
      registerAgentCallerLimitsRoutes(router, {} as AgentCallerLimitsService);
      registerCredentialBindingRoutes(router, {} as CredentialBindingService);
      registerEnvVariableRoutes(router, {} as EnvVariableService);
      registerPauseRoutes(router, {} as SessionService);
      registerCloseRoutes(router, {} as SessionService);
      registerUsageRoutes(router, {} as UsageService);
      registerSessionOutputRoutes(router, {} as SessionOutputService);
      registerInstallationSettingsRoutes(router, {} as SettingsDocumentService);
      registerSettingsConsoleRoutes(router, {} as SettingsConsoleService);
      registerLoginProviderRoutes(router, {} as ProviderAdmin);
      registerLoginSettingsRoutes(router, {} as LoginSettingsAdmin);
      registerWorkspaceRoutes(router, {} as WorkspaceRouteDeps);
      registerAchievementRoutes(router, {} as AchievementRuleService);
      registerSessionAchievementRoutes(router, {} as SessionAchievementService);
      registerSlackSecretRoutes(router, {} as SlackSecretService);
      registerGitHubAppRoutes(router, {} as GitHubAppService);
      registerGitHubRepositoryRoutes(router, {} as GitHubRepositoryService);
      registerGitHubSettingsRoutes(router, {} as GitHubSettingsService);
      registerGitHubPackagesRoutes(
        router,
        {} as Parameters<typeof registerGitHubPackagesRoutes>[1],
      );
      registerAgentGitHubRoutes(router, {} as AgentGitHubService);
      registerAgentMcpRoutes(router, {} as AgentMcpService);
      registerEngineSettingsRoutes(router, {} as EngineSettingsService);
      registerAgentPullRequestRoutes(router, {} as AgentPullRequestService);
      registerGitHubWorkRoutes(router, {} as GitHubWorkService);
      registerSessionAttributionRoutes(router, {} as SessionAttributionService);
      registerSessionOutcomeRoutes(router, {} as SessionOutcomeService);
      registerSlackAppRoutes(router, {
        apps: {} as SlackAppService,
        secrets: {} as SlackSecretService,
      });
      registerSlackInstallRoutes(router, {
        service: {} as SlackInstallService,
      });
      registerEventRoutes(router, {} as SessionService, {
        wakeup: { wait: async () => {} },
      });
    },
  });
}

function registeredHonoRoutes(): Set<string> {
  const app = apiApp();
  // /internal/* is the worker protocol, not part of the public document.
  return new Set(
    app.routes
      .filter(
        (route) =>
          route.method !== "ALL" && !route.path.startsWith("/internal/"),
      )
      .map(
        (route) =>
          `${route.method} ${route.path.replace(/\/$/, "").replace(/:(\w+)/g, "{$1}") || "/"}`,
      ),
  );
}

function honoRoutes(): Set<string> {
  return new Set(
    [...registeredHonoRoutes()].filter((route) => !NON_API_ROUTES.has(route)),
  );
}

function routesFromDocument(paths: Record<string, object>): Set<string> {
  return new Set(
    Object.entries(paths).flatMap(([path, operations]) =>
      Object.keys(operations).map(
        (method) => `${method.toUpperCase()} ${path}`,
      ),
    ),
  );
}

function openApiRoutes(): Set<string> {
  return routesFromDocument(buildOpenApiDocument().paths);
}

test("every Hono handler is declared in the OpenAPI route table", () => {
  const declared = openApiRoutes();
  for (const route of honoRoutes()) {
    expect(declared, `${route} is served but not in OpenAPI`).toContain(route);
  }
});

test("only the documentation UI routes are excluded from OpenAPI", () => {
  const served = registeredHonoRoutes();
  for (const route of NON_API_ROUTES) {
    expect(served).toContain(route);
    expect(openApiRoutes()).not.toContain(route);
  }
});

test("the production OpenAPIHono registry contains every declared route", () => {
  const document = apiApp().getOpenAPI31Document({
    openapi: "3.1.0",
    info: { title: "test", version: "test" },
  });
  expect(routesFromDocument(document.paths ?? {})).toEqual(openApiRoutes());
});

// The statuses themselves are compared where the handlers answer them: each
// route test file records its responses (route-error-coverage.ts).
test("every Hono handler has one test file that checks its error statuses", async () => {
  const owned = Object.values(ROUTE_ERROR_TESTS).flat();
  expect(owned.length, "a route is owned by two files").toBe(
    new Set(owned).size,
  );
  expect(owned.sort()).toEqual([...honoRoutes()].sort());
  for (const file of Object.keys(ROUTE_ERROR_TESTS)) {
    const source = await Bun.file(`${import.meta.dir}/${file}`).text();
    const oneLine = source.replace(/\s+/g, "").replace(/,\)/g, ")");
    expect(oneLine, `${file} does not record its route errors`).toContain(
      `recordRouteErrors("${file}")`,
    );
  }
});

test("OpenAPI routes without a handler are exactly the pending list", () => {
  const served = honoRoutes();
  const pending = [...openApiRoutes()].filter((route) => !served.has(route));
  expect(pending.sort()).toEqual([...NOT_YET_IMPLEMENTED].sort());
});

test("every OpenAPI x-scope matches the enforced scope map", () => {
  const documented = Object.entries(buildOpenApiDocument().paths).flatMap(
    ([path, operations]) =>
      Object.entries(operations).flatMap(([method, raw]) => {
        const scope = (raw as { "x-scope"?: string })["x-scope"];
        return scope ? [{ method: method.toUpperCase(), path, scope }] : [];
      }),
  );
  expect(documented).toEqual(
    DOCUMENTED_ROUTE_SCOPES.map(({ method, path, scope }) => ({
      method,
      path,
      scope,
    })),
  );
});

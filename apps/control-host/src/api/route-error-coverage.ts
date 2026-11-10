import { afterAll, expect } from "bun:test";
import {
  bodyRouteErrors,
  createApiApp,
  globalRouteErrors,
  mutationRouteErrors,
  rootRouteErrors,
} from "./app.ts";
import { API_ROUTE_SCOPES, buildOpenApiDocument } from "./openapi.ts";
import { scopedRouteErrors } from "./scope-policy.ts";

// The test file (from this directory) whose requests must produce every
// error status a route's handler declares. The OpenAPI parity test holds the keys' union to the
// routes Hono serves.
export const ROUTE_ERROR_TESTS: Record<string, string[]> = {
  "app.test.ts": ["GET /v1", "GET /v1/openapi.json"],
  "probes.test.ts": ["GET /healthz", "GET /readyz"],
  "auth.test.ts": [
    "POST /v1/auth/bootstrap",
    "POST /v1/auth/login",
    "POST /v1/auth/password-reset",
    "POST /v1/auth/logout",
    "POST /v1/workspaces/{id}/members/{userId}/password-reset",
    "GET /v1/auth/me",
    "PATCH /v1/auth/me",
  ],
  "google-login.test.ts": [
    "GET /v1/auth/login-methods",
    "POST /v1/auth/google/start",
    "POST /v1/auth/google/callback",
  ],
  "routes/sessions.test.ts": [
    "POST /v1/sessions",
    "GET /v1/sessions",
    "GET /v1/sessions/counts",
    "GET /v1/sessions/{id}",
    "PATCH /v1/sessions/{id}",
    "POST /v1/sessions/{id}/messages",
    "GET /v1/sessions/{id}/turns",
    "GET /v1/sessions/{id}/turns/{turn_id}",
    "POST /v1/sessions/{id}/terminate",
    "POST /v1/sessions/{id}/resume",
    "POST /v1/sessions/{id}/recovery-decisions",
  ],
  "routes/session-shares.test.ts": [
    "GET /v1/sessions/{id}/share",
    "POST /v1/sessions/{id}/share",
    "POST /v1/sessions/{id}/audit-read",
    "GET /v1/admin/sessions",
    "POST /v1/admin/sessions/{id}/terminate",
    "POST /v1/admin/sessions/{id}/recovery-decisions",
  ],
  "routes/receipts.test.ts": ["GET /v1/receipts/{id}"],
  "routes/pending.test.ts": [
    "GET /v1/sessions/{id}/pending-requests",
    "POST /v1/sessions/{id}/answers",
  ],
  "routes/push-requests.test.ts": [
    "POST /v1/sessions/{id}/push-requests",
    "GET /v1/sessions/{id}/push-requests",
    "GET /v1/sessions/{id}/push-requests/{push_request_id}",
    "POST /v1/sessions/{id}/push-requests/{push_request_id}/approve",
    "POST /v1/sessions/{id}/push-requests/{push_request_id}/reject",
  ],
  "routes/pull-requests.test.ts": [
    "POST /v1/sessions/{id}/push-requests/{push_request_id}/pull-request",
    "POST /v1/sessions/{id}/push-requests/{push_request_id}/pull-request/comments",
  ],
  "routes/github-work.test.ts": [
    "POST /v1/sessions/{id}/github/workflow-dispatches",
    "GET /v1/sessions/{id}/github/workflow-runs/{run_id}",
    "POST /v1/sessions/{id}/github/workflow-runs/{run_id}/rerun",
    "GET /v1/sessions/{id}/github/attribution",
    "GET /v1/sessions/{id}/github/refusals",
    "GET /v1/sessions/{id}/outcomes",
    "POST /v1/sessions/{id}/github/pull-requests/{number}/reviews",
  ],
  "routes/interrupt.test.ts": ["POST /v1/sessions/{id}/interrupt"],
  "routes/pause.test.ts": ["POST /v1/sessions/{id}/pause"],
  "routes/close.test.ts": ["POST /v1/sessions/{id}/close"],
  "routes/usage.test.ts": [
    "GET /v1/limits",
    "GET /v1/sessions/{id}/usage",
    "GET /v1/usage/summary",
    "GET /v1/usage/outcomes",
    "GET /v1/usage/achievements",
    "GET /v1/usage/series",
    "GET /v1/usage/breakdown",
    "GET /v1/usage/tools",
    "GET /v1/usage/tools/{name}/calls",
  ],
  "routes/outputs.test.ts": [
    "GET /v1/sessions/{id}/outputs",
    "GET /v1/sessions/{id}/outputs/{path}",
  ],
  "routes/connections.test.ts": ["GET /v1/connections"],
  "routes/installation-settings.test.ts": [
    "GET /v1/installation/settings/export",
    "POST /v1/installation/settings/import",
  ],
  "routes/settings-console.test.ts": [
    "GET /v1/installation/settings/connections",
    "POST /v1/installation/settings/connections",
    "GET /v1/installation/settings/connections/{id}/impact",
    "POST /v1/installation/settings/connections/{id}/auto-mode",
    "POST /v1/installation/settings/connections/{id}/models",
    "POST /v1/installation/settings/connections/{id}/convert",
    "POST /v1/installation/settings/connections/{id}/credential",
    "POST /v1/installation/settings/connections/{id}/disable",
    "POST /v1/installation/settings/connections/{id}/enable",
    "GET /v1/installation/settings/mcp-servers",
    "POST /v1/installation/settings/mcp-servers",
    "PATCH /v1/installation/settings/mcp-servers/{id}",
    "POST /v1/installation/settings/mcp-servers/{id}/credential",
    "POST /v1/installation/settings/mcp-servers/{id}/disable",
  ],
  "routes/events.test.ts": ["GET /v1/sessions/{id}/events"],
  "routes/members.test.ts": [
    "GET /v1/members",
    "PATCH /v1/members/{user_id}",
    "POST /v1/members/{user_id}/disable",
    "POST /v1/members/{user_id}/enable",
    "POST /v1/users/{user_id}/disable",
    "POST /v1/users/{user_id}/enable",
    "GET /v1/takeovers",
    "POST /v1/sessions/{id}/takeover",
  ],
  "routes/linked-accounts.test.ts": [
    "POST /v1/linked-accounts/slack/start",
    "POST /v1/linked-accounts/slack/callback",
    "POST /v1/linked-accounts/github/start",
    "POST /v1/linked-accounts/github/callback",
    "GET /v1/linked-accounts",
    "DELETE /v1/linked-accounts/{id}",
  ],
  "routes/invites.test.ts": [
    "POST /v1/invites",
    "GET /v1/invites",
    "DELETE /v1/invites/{id}",
    "POST /v1/invites/accept",
  ],
  "routes/workspaces.test.ts": [
    "POST /v1/workspaces/{id}/audit-retention",
    "POST /v1/workspaces/{id}/slack-guest",
    "PATCH /v1/workspaces/{id}/agent-access",
  ],
  "routes/github-app.test.ts": [
    "GET /v1/workspaces/{id}/github-app",
    "PUT /v1/workspaces/{id}/github-app",
    "DELETE /v1/workspaces/{id}/github-app",
    "GET /v1/workspaces/{id}/github-apps/{role}",
    "PUT /v1/workspaces/{id}/github-apps/{role}",
    "DELETE /v1/workspaces/{id}/github-apps/{role}",
    "GET /v1/workspaces/{id}/github-apps",
    "POST /v1/workspaces/{id}/github-apps",
    "POST /v1/workspaces/{id}/github-apps/{connectionId}/installations/start",
    "POST /v1/workspaces/{id}/github-apps/installations/complete",
  ],
  "routes/github-app-manifest.test.ts": [
    "POST /v1/workspaces/{id}/github-apps/author/manifest",
    "POST /v1/workspaces/{id}/github-apps/author/manifest/complete",
  ],
  "routes/github-repositories.test.ts": [
    "GET /v1/workspaces/{id}/github-repositories",
    "PATCH /v1/workspaces/{id}/github-repositories/{repositoryId}",
    "GET /v1/workspaces/{id}/github-repositories/{repositoryId}/app-pins",
    "PUT /v1/workspaces/{id}/github-repositories/{repositoryId}/app-pins/{role}",
    "GET /v1/agents/{id}/github/repositories",
    "POST /v1/agents/{id}/github/repositories",
  ],
  "routes/agent-github.test.ts": [
    "GET /v1/agents/{id}/github",
    "PUT /v1/agents/{id}/github/enabled",
    "PUT /v1/agents/{id}/github/settings",
    "PUT /v1/agents/{id}/github/repository-access",
    "GET /v1/agents/{id}/github/activity",
  ],
  "routes/agent-mcp.test.ts": [
    "GET /v1/agents/{id}/mcp/settings",
    "PUT /v1/agents/{id}/mcp/settings",
  ],
  "routes/engine-settings.test.ts": [
    "GET /v1/workspaces/{id}/engine-settings",
    "PUT /v1/workspaces/{id}/engine-settings",
    "GET /v1/agents/{id}/engine-settings",
    "PUT /v1/agents/{id}/engine-settings",
  ],
  "routes/agent-pull-request.test.ts": [
    "GET /v1/agents/{id}/github/pull-request",
    "PUT /v1/agents/{id}/github/pull-request",
  ],
  "routes/github-settings.test.ts": [
    "GET /v1/workspaces/{id}/github-settings",
    "PUT /v1/workspaces/{id}/github-settings",
    "PUT /v1/workspaces/{id}/github-settings/oauth-client-secret",
    "PUT /v1/workspaces/{id}/github-settings/pull-request",
    "PUT /v1/workspaces/{id}/github-settings/user-link-app",
  ],
  "routes/github-packages.test.ts": [
    "GET /v1/workspaces/{id}/github-packages",
    "PUT /v1/workspaces/{id}/github-packages/token",
    "DELETE /v1/workspaces/{id}/github-packages/token",
    "PUT /v1/workspaces/{id}/github-packages/allowlist",
  ],
  "routes/slack-secrets.test.ts": [
    "GET /v1/workspaces/{id}/slack/config-token",
    "PUT /v1/workspaces/{id}/slack/config-token",
    "DELETE /v1/workspaces/{id}/slack/config-token",
  ],
  "routes/api-keys.test.ts": [
    "POST /v1/api-keys",
    "GET /v1/api-keys",
    "DELETE /v1/api-keys/{id}",
  ],
  "routes/teams.test.ts": [
    "POST /v1/teams",
    "GET /v1/teams",
    "GET /v1/my-teams",
    "GET /v1/teams/{team_id}",
    "PATCH /v1/teams/{team_id}",
    "DELETE /v1/teams/{team_id}",
    "POST /v1/teams/{team_id}/members",
    "PATCH /v1/teams/{team_id}/members/{user_id}",
    "DELETE /v1/teams/{team_id}/members/{user_id}",
    "PUT /v1/agents/{id}/managing-team",
    "GET /v1/agents/{id}/admins",
    "POST /v1/agents/{id}/admins",
    "DELETE /v1/agents/{id}/admins/{kind}/{subject_id}",
    "GET /v1/administered-agents",
  ],
  "routes/env-variables.test.ts": [
    "GET /v1/workspace/variables",
    "PUT /v1/workspace/variables/{name}",
    "DELETE /v1/workspace/variables/{name}",
    "PUT /v1/workspace/variables/{name}/grants",
    "GET /v1/agents/{id}/variables",
    "PUT /v1/agents/{id}/variables/{name}",
    "DELETE /v1/agents/{id}/variables/{name}",
  ],
  "routes/credential-bindings.test.ts": [
    "GET /v1/agents/{id}/credential-bindings",
    "POST /v1/agents/{id}/credential-bindings",
    "DELETE /v1/agents/{id}/credential-bindings/{binding_id}",
  ],
  "routes/agents.test.ts": [
    "GET /v1/agents",
    "GET /v1/agents/counts",
    "POST /v1/agents",
    "GET /v1/agents/{id}",
    "PATCH /v1/agents/{id}",
    "POST /v1/agents/{id}/releases",
    "POST /v1/agents/{id}/activate",
  ],
  "routes/agent-identities.test.ts": [
    "POST /v1/agents/{id}/identities",
    "GET /v1/agents/{id}/identities",
    "DELETE /v1/agents/{id}/identities/{identity_id}",
  ],
  "routes/slack-bindings.test.ts": [
    "GET /v1/agents/{id}/slack-bindings",
    "PUT /v1/agents/{id}/slack-bindings",
    "POST /v1/agents/{id}/slack-bindings/{binding_id}/approve",
    "POST /v1/agents/{id}/slack-bindings/{binding_id}/reject",
  ],
  "routes/slack-channels.test.ts": [
    "GET /v1/agents/{id}/slack/channels",
    "GET /v1/agents/{id}/slack-channels",
  ],
  "routes/slack-apps.test.ts": [
    "GET /v1/agents/{id}/slack/app",
    "POST /v1/agents/{id}/slack/app/events/recheck",
    "GET /v1/agents/{id}/slack/app/manifest",
    "GET /v1/agents/{id}/slack/app/settings",
    "PUT /v1/agents/{id}/slack/app/settings",
    "POST /v1/agents/{id}/slack/app",
    "GET /v1/workspaces/{id}/slack/apps",
    "DELETE /v1/workspaces/{id}/slack/apps/{app_id}",
    "PUT /v1/workspaces/{id}/slack/apps/{app_id}/secrets/{purpose}",
  ],
  "routes/slack-install.test.ts": [
    "POST /v1/agents/{id}/slack/install/start",
    "POST /v1/slack/install/complete",
  ],
  "routes/slack-events.test.ts": ["POST /v1/slack/events/{agent_id}"],
  "routes/slack-interactions.test.ts": [
    "POST /v1/slack/interactions/{agent_id}",
  ],
  "routes/achievements.test.ts": [
    "GET /v1/achievement-categories",
    "POST /v1/achievement-categories",
    "PATCH /v1/achievement-categories/{id}",
    "POST /v1/achievement-categories/{id}/archive",
    "GET /v1/achievement-types",
    "POST /v1/achievement-types",
    "PATCH /v1/achievement-types/{id}",
    "POST /v1/achievement-types/{id}/archive",
    "GET /v1/achievement-rules",
    "POST /v1/achievement-rules",
    "POST /v1/achievement-rules/{family_id}/versions",
    "POST /v1/achievement-rules/{family_id}/disable",
    "POST /v1/achievement-rules/{family_id}/enable",
    "GET /v1/workspaces/{id}/achievement-judge",
    "PUT /v1/workspaces/{id}/achievement-judge",
    "GET /v1/sessions/{id}/achievements",
    "POST /v1/sessions/{id}/achievement-judgments",
    "POST /v1/achievements/{id}/review",
  ],
};

// Declared for clients but produced by nothing yet: alpha never trims
// events, so no cursor expires.
const DECLARED_ONLY: Record<string, number[]> = {
  "GET /v1/sessions/{id}/events": [410],
};

const SCOPED = new Set(
  API_ROUTE_SCOPES.map((route) => `${route.method} ${route.path}`),
);

type Operation = {
  route: string;
  pattern: RegExp;
  errors: number[];
  authenticated: boolean;
};

const OPERATIONS: Operation[] = Object.entries(
  buildOpenApiDocument().paths,
).flatMap(([path, operations]) =>
  Object.entries(operations).map(([method, operation]) => {
    const { responses, security } = operation as {
      responses: object;
      security?: unknown[];
    };
    return {
      route: `${method.toUpperCase()} ${path}`,
      pattern: new RegExp(
        `^${method.toUpperCase()} ${path.replace(/\{\w+\}/g, "[^/]+")}$`,
      ),
      errors: Object.keys(responses)
        .map(Number)
        .filter((status) => status >= 400),
      authenticated: (security?.length ?? 0) > 0,
    };
  }),
);

// What the app answers around a handler: the error hook everywhere, the
// auth middleware on authenticated routes, the body deadline and the cookie
// CSRF refusal on every other method, and the scope check.
function middlewareErrors(operation: Operation): number[] {
  const mutation =
    operation.route.includes(" /v1") && !operation.route.startsWith("GET ");
  return [
    ...globalRouteErrors,
    ...(operation.authenticated ? rootRouteErrors : []),
    ...(mutation ? bodyRouteErrors : []),
    ...(mutation && operation.authenticated ? mutationRouteErrors : []),
    ...(SCOPED.has(operation.route) ? scopedRouteErrors : []),
  ];
}

/**
 * A `createApiApp` that records the status of every error response its
 * `request` returns. After the file's tests, each route the file owns in
 * ROUTE_ERROR_TESTS must have answered every status its OpenAPI operation
 * declares beyond what the middleware adds, and no route may have answered
 * a status its operation does not declare.
 */
export function recordRouteErrors(file: string): typeof createApiApp {
  const owned = ROUTE_ERROR_TESTS[file];
  if (!owned) throw new Error(`${file} owns no routes in ROUTE_ERROR_TESTS`);
  const seen = new Map<string, Set<number>>();
  afterAll(() => {
    const undeclared: string[] = [];
    const unproduced: string[] = [];
    for (const operation of OPERATIONS) {
      const observed = seen.get(operation.route) ?? new Set();
      for (const status of observed) {
        if (!operation.errors.includes(status)) {
          undeclared.push(`${operation.route} ${status}`);
        }
      }
      if (!owned.includes(operation.route)) continue;
      const exempt = new Set([
        ...middlewareErrors(operation),
        ...(DECLARED_ONLY[operation.route] ?? []),
      ]);
      for (const status of operation.errors) {
        if (!exempt.has(status) && !observed.has(status)) {
          unproduced.push(`${operation.route} ${status}`);
        }
      }
    }
    expect(undeclared, "answered but not declared in OpenAPI").toEqual([]);
    expect(unproduced, `declared but no test in ${file} produced it`).toEqual(
      [],
    );
  });
  return (options) => {
    const app = createApiApp(options);
    const request = app.request.bind(app);
    app.request = async (input, init, ...rest) => {
      const response = await request(input, init, ...rest);
      if (response.status >= 400) {
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        const url = input instanceof Request ? input.url : String(input);
        // Hono serves HEAD with the GET handler and ignores a trailing slash.
        const path = new URL(url, "http://localhost").pathname.replace(
          /(.)\/$/,
          "$1",
        );
        const target = `${method === "HEAD" ? "GET" : method} ${path}`;
        const operation = OPERATIONS.find((candidate) =>
          candidate.pattern.test(target),
        );
        if (operation) {
          const statuses = seen.get(operation.route) ?? new Set();
          statuses.add(response.status);
          seen.set(operation.route, statuses);
        }
      }
      return response;
    };
    return app;
  };
}

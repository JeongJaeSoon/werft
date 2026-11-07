import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  API_ERROR_CODE_VALUES,
  SESSION_SCOPE_VALUES,
} from "@werft-ai/contracts";
import {
  API_REFERENCE_OUTPUT_PATH,
  generatedOutputs,
  OPENAPI_OUTPUT_PATH,
  renderApiReferenceDocument,
  renderScalarAsset,
  SCALAR_ASSET_OUTPUT_PATH,
} from "../../scripts/generate-openapi.ts";
import {
  API_ROUTE_DECLARATIONS,
  type ApiOperationId,
  buildOpenApiDocument,
  OPENAPI_COMPONENT_SCHEMAS,
  OPENAPI_TAGS,
  type RouteDeclaration,
  renderOpenApiDocument,
} from "./openapi.ts";

// Public /v1 operations whose declaration still lacks a description, a
// request example (when it takes a body), or a success example and
// description. 94S-599 empties this list; an entry that is already complete
// fails the test below, so the list only shrinks.
const UNDOCUMENTED_OPERATIONS = new Set<ApiOperationId>([
  "getSessionShare",
  "setSessionShare",
  "auditReadSession",
  "listAdminSessions",
  "adminTerminateSession",
  "adminDecideSessionRecovery",
  "acceptInvite",
  "activateAgent",
  "createAgent",
  "createAgentRelease",
  "createApiKey",
  "createCredentialBinding",
  "createInvite",
  "disableMember",
  "disableUser",
  "enableMember",
  "enableUser",
  "getAgent",
  "googleLoginCallback",
  "issuePasswordReset",
  "linkAgentIdentity",
  "listAdministeredAgents",
  "listAgentIdentities",
  "listApiKeys",
  "listCredentialBindings",
  "listInvites",
  "listLinkedAccounts",
  "listLoginMethods",
  "listMembers",
  "listSlackBindings",
  "listTakeovers",
  "putSlackBinding",
  "resetPassword",
  "revokeAgentIdentity",
  "revokeApiKey",
  "revokeCredentialBinding",
  "revokeInvite",
  "setAuditRetention",
  "setSlackGuest",
  "slackLinkCallback",
  "startGoogleLogin",
  "startSlackLink",
  "takeOverSession",
  "unlinkAccount",
  "updateAgent",
  "updateMember",
]);

const ROUTES: readonly RouteDeclaration[] = API_ROUTE_DECLARATIONS;

type Operation = {
  description: string;
  tags?: string[];
  security: Array<Record<string, string[]>>;
  "x-scope"?: string;
  parameters: Array<{
    name: string;
    in: string;
    required: boolean;
    description?: string;
  }>;
  responses: Record<
    string,
    { description?: string; $ref?: string; headers?: Record<string, unknown> }
  >;
};

function operations(): Array<[string, Operation]> {
  return Object.entries(buildOpenApiDocument().paths).flatMap(
    ([path, methods]) =>
      Object.entries(methods).map(([method, raw]): [string, Operation] => [
        `${method} ${path}`,
        raw as Operation,
      ]),
  );
}

function operation(method: string, path: string): Operation {
  const found = operations().find(([key]) => key === `${method} ${path}`);
  if (!found) throw new Error(`No ${method} ${path}`);
  return found[1];
}

describe("OpenAPI document", () => {
  test("is committed and matches the generator output", () => {
    expect(readFileSync(OPENAPI_OUTPUT_PATH, "utf8")).toBe(
      renderOpenApiDocument(),
    );
  });

  test("keeps OpenAPIHono route metadata in a Bun production bundle", async () => {
    const outdir = await mkdtemp(join(tmpdir(), "openapi-bundle-"));
    try {
      const result = await Bun.build({
        entrypoints: [join(import.meta.dir, "app.ts")],
        outdir,
        target: "bun",
        format: "esm",
        minify: true,
        splitting: true,
        naming: "[name]-[hash].[ext]",
      });
      expect(result.success).toBe(true);
      const entry = result.outputs.find(
        (output) => output.kind === "entry-point",
      );
      expect(entry).toBeDefined();
      const bundled = (await import(
        `${pathToFileURL(entry?.path ?? "").href}?${crypto.randomUUID()}`
      )) as typeof import("./app.ts");
      const app = bundled.createApiApp({
        authMode: "none",
        registerRoutes(router) {
          bundled.apiRoute(router, "getInstallationLimits", () =>
            Promise.resolve(new Response()),
          );
        },
      });
      const document = app.getOpenAPI31Document({
        openapi: "3.1.0",
        info: { title: "test", version: "test" },
      });
      expect(Object.keys(document.paths ?? {}).sort()).toEqual(
        ["/healthz", "/readyz", "/v1", "/v1/limits", "/v1/openapi.json"].sort(),
      );
    } finally {
      await rm(outdir, { recursive: true, force: true });
    }
  });

  test("commits an offline read-only Scalar reference from the same document", () => {
    expect(readFileSync(API_REFERENCE_OUTPUT_PATH, "utf8")).toBe(
      renderApiReferenceDocument(),
    );
    expect(readFileSync(SCALAR_ASSET_OUTPUT_PATH, "utf8")).toBe(
      renderScalarAsset(),
    );
    const html = renderApiReferenceDocument();
    const scalarAsset = renderScalarAsset();
    expect(html).toContain('src="./scalar.js"');
    expect(html).toContain("&quot;disabled&quot;:true");
    expect(html).toContain("&quot;hideClientButton&quot;:true");
    expect(html).toContain("&quot;hideTestRequestButton&quot;:true");
    expect(html).toContain("&quot;showDeveloperTools&quot;:&quot;never&quot;");
    expect(html).toContain("&quot;showToolbar&quot;:&quot;never&quot;");
    expect(html).toContain("&quot;telemetry&quot;:false");
    expect(html).toContain("&quot;withDefaultFonts&quot;:false");
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//);
    expect(html).not.toContain("Authorization");
    expect(scalarAsset).toContain("meta[property=csp-nonce]");
    expect(scalarAsset).not.toContain("./chunks/");
  });

  test("the generator covers JSON, HTML and Scalar, and --check passes on a fresh tree", () => {
    expect(generatedOutputs().map((output) => output.path)).toEqual([
      OPENAPI_OUTPUT_PATH,
      API_REFERENCE_OUTPUT_PATH,
      SCALAR_ASSET_OUTPUT_PATH,
    ]);
    const check = Bun.spawnSync(
      [process.execPath, "scripts/generate-openapi.ts", "--check"],
      { cwd: join(import.meta.dir, "../.."), stderr: "pipe", stdout: "pipe" },
    );
    expect(check.stderr.toString()).toBe("");
    expect(check.exitCode).toBe(0);
  });

  test("groups every operation under exactly one declared tag", () => {
    const document = buildOpenApiDocument();
    expect(document.tags).toEqual(OPENAPI_TAGS);
    const declared = new Set<string>(document.tags.map((tag) => tag.name));
    const used = new Set<string>();

    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, raw] of Object.entries(operations)) {
        const { tags } = raw as { tags?: string[] };
        expect(tags, `${method} ${path}`).toHaveLength(1);
        expect(declared.has(tags?.[0] ?? ""), `${method} ${path}`).toBe(true);
        if (tags?.[0]) used.add(tags[0]);
      }
    }

    expect([...used].sort()).toEqual([...declared].sort());
  });

  test("puts every declared tag in exactly one tag group", () => {
    const document = buildOpenApiDocument();
    expect(document["x-tagGroups"]).toEqual([
      { name: "Getting started", tags: ["Auth", "API keys"] },
      { name: "Agents", tags: ["Agents"] },
      {
        name: "Sessions",
        tags: [
          "Sessions",
          "Messages & turns",
          "Events",
          "Pending requests",
          "Session control",
          "Push requests",
          "GitHub work",
        ],
      },
      {
        name: "Workspace management",
        tags: ["Members", "Teams", "Linked accounts", "Workspace settings"],
      },
      { name: "Administration", tags: ["Admin", "Recovery"] },
      { name: "Operations", tags: ["Health", "Limits & receipts"] },
    ]);
    const grouped = document["x-tagGroups"].flatMap((group) => group.tags);
    expect([...grouped].sort()).toEqual(
      OPENAPI_TAGS.map((tag) => tag.name).sort(),
    );
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  test("files each operation under the tag of its audience", () => {
    const tagOf = (method: string, path: string) =>
      operation(method, path).tags?.[0];
    expect(tagOf("get", "/v1/profiles")).toBe("Agents");
    for (const [method, path] of [
      ["get", "/v1/admin/sessions"],
      ["post", "/v1/admin/sessions/{id}/terminate"],
      ["post", "/v1/admin/sessions/{id}/recovery-decisions"],
      ["post", "/v1/sessions/{id}/audit-read"],
      ["get", "/v1/takeovers"],
      ["post", "/v1/sessions/{id}/takeover"],
    ] as const) {
      expect(tagOf(method, path), `${method} ${path}`).toBe("Admin");
    }
    expect(
      tagOf("post", "/v1/workspaces/{id}/members/{userId}/password-reset"),
    ).toBe("Members");
    expect(tagOf("post", "/v1/invites/accept")).toBe("Auth");
  });

  const SETS_SESSION_COOKIE = new Set([
    "/v1/auth/login",
    "/v1/auth/google/start",
    "/v1/auth/google/callback",
    "/v1/invites/accept",
  ]);
  test("every cookie-authenticated mutation documents the CSRF header and 403", () => {
    const document = buildOpenApiDocument();
    const checked: string[] = [];
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, raw] of Object.entries(operations)) {
        const operation = raw as {
          security: Array<Record<string, string[]>>;
          parameters: Array<{ name: string; in: string; required: boolean }>;
          responses: Record<string, unknown>;
        };
        const cookie = operation.security.some((s) => "cookieSession" in s);
        const header = operation.parameters.find(
          (p) => p.in === "header" && p.name === "X-Requested-With",
        );
        if (SETS_SESSION_COOKIE.has(path)) {
          // These set a cookie, so every caller sends the header.
          expect(header?.required, path).toBe(true);
          expect(operation.responses, path).toHaveProperty("403");
        } else if (method !== "get" && cookie) {
          checked.push(`${method} ${path}`);
          expect(header?.required, path).toBe(false);
          expect(operation.responses, path).toHaveProperty("403");
        } else {
          expect(header, `${method} ${path}`).toBeUndefined();
        }
      }
    }
    expect(checked).toContain("post /v1/sessions");
    expect(checked).toContain("post /v1/auth/logout");
    expect(checked).toContain("patch /v1/agents/{id}");
    expect(checked).toContain("patch /v1/members/{user_id}");
    expect(checked).toContain("delete /v1/invites/{id}");
    expect(checked).not.toContain("post /v1/auth/login");
  });

  test("documents every api.md endpoint with $ref components", () => {
    const document = buildOpenApiDocument();
    expect(Object.keys(document.paths).sort()).toEqual(
      [
        "/healthz",
        "/readyz",
        "/v1",
        "/v1/admin/sessions",
        "/v1/admin/sessions/{id}/recovery-decisions",
        "/v1/admin/sessions/{id}/terminate",
        "/v1/openapi.json",
        "/v1/auth/bootstrap",
        "/v1/auth/google/callback",
        "/v1/auth/google/start",
        "/v1/auth/login",
        "/v1/auth/login-methods",
        "/v1/auth/logout",
        "/v1/auth/me",
        "/v1/auth/password-reset",
        "/v1/installation-profiles",
        "/v1/installation-profiles/options",
        "/v1/installation-profiles/{profile_id}/block",
        "/v1/installation-profiles/{profile_id}/retire",
        "/v1/installation-profiles/{profile_id}/rollout/retry",
        "/v1/installation-profiles/{profile_id}/unblock",
        "/v1/installation/settings/connections",
        "/v1/installation/settings/connections/{id}/convert",
        "/v1/installation/settings/connections/{id}/credential",
        "/v1/installation/settings/connections/{id}/disable",
        "/v1/installation/settings/export",
        "/v1/installation/settings/import",
        "/v1/installation/settings/mcp-servers",
        "/v1/installation/settings/mcp-servers/{id}",
        "/v1/installation/settings/mcp-servers/{id}/credential",
        "/v1/installation/settings/mcp-servers/{id}/disable",
        "/v1/limits",
        "/v1/linked-accounts",
        "/v1/linked-accounts/github/callback",
        "/v1/linked-accounts/github/start",
        "/v1/linked-accounts/slack/callback",
        "/v1/linked-accounts/slack/start",
        "/v1/linked-accounts/{id}",
        "/v1/profiles",
        "/v1/receipts/{id}",
        "/v1/sessions",
        "/v1/sessions/counts",
        "/v1/sessions/{id}",
        "/v1/sessions/{id}/achievement-judgments",
        "/v1/sessions/{id}/achievements",
        "/v1/sessions/{id}/answers",
        "/v1/sessions/{id}/audit-read",
        "/v1/sessions/{id}/close",
        "/v1/sessions/{id}/events",
        "/v1/sessions/{id}/github/attribution",
        "/v1/sessions/{id}/github/pull-requests/{number}/reviews",
        "/v1/sessions/{id}/github/refusals",
        "/v1/sessions/{id}/github/workflow-dispatches",
        "/v1/sessions/{id}/github/workflow-runs/{run_id}",
        "/v1/sessions/{id}/github/workflow-runs/{run_id}/rerun",
        "/v1/sessions/{id}/interrupt",
        "/v1/sessions/{id}/messages",
        "/v1/sessions/{id}/outcomes",
        "/v1/sessions/{id}/outputs",
        "/v1/sessions/{id}/outputs/{path}",
        "/v1/sessions/{id}/pause",
        "/v1/sessions/{id}/pending-requests",
        "/v1/sessions/{id}/profile",
        "/v1/sessions/{id}/push-requests",
        "/v1/sessions/{id}/push-requests/{push_request_id}",
        "/v1/sessions/{id}/push-requests/{push_request_id}/approve",
        "/v1/sessions/{id}/push-requests/{push_request_id}/pull-request",
        "/v1/sessions/{id}/push-requests/{push_request_id}/pull-request/comments",
        "/v1/sessions/{id}/push-requests/{push_request_id}/reject",
        "/v1/sessions/{id}/recovery-decisions",
        "/v1/sessions/{id}/resume",
        "/v1/sessions/{id}/share",
        "/v1/sessions/{id}/takeover",
        "/v1/sessions/{id}/terminate",
        "/v1/sessions/{id}/turns",
        "/v1/sessions/{id}/turns/{turn_id}",
        "/v1/sessions/{id}/usage",
        "/v1/workspaces/{id}/audit-retention",
        "/v1/workspaces/{id}/slack-guest",
        "/v1/workspaces/{id}/slack/apps",
        "/v1/workspaces/{id}/github-app",
        "/v1/workspaces/{id}/github-apps",
        "/v1/workspaces/{id}/github-apps/{role}",
        "/v1/workspaces/{id}/github-apps/{connectionId}/installations/start",
        "/v1/workspaces/{id}/github-apps/installations/complete",
        "/v1/workspaces/{id}/github-apps/author/manifest",
        "/v1/workspaces/{id}/github-apps/author/manifest/complete",
        "/v1/workspaces/{id}/github-repositories",
        "/v1/workspaces/{id}/github-repositories/{repositoryId}",
        "/v1/workspaces/{id}/github-repositories/{repositoryId}/app-pins",
        "/v1/workspaces/{id}/github-repositories/{repositoryId}/app-pins/{role}",
        "/v1/workspaces/{id}/github-settings",
        "/v1/workspaces/{id}/github-settings/oauth-client-secret",
        "/v1/workspaces/{id}/github-settings/pull-request",
        "/v1/workspaces/{id}/github-settings/user-link-app",
        "/v1/workspaces/{id}/github-packages",
        "/v1/workspaces/{id}/github-packages/token",
        "/v1/workspaces/{id}/github-packages/allowlist",
        "/v1/workspaces/{id}/slack/config-token",
        "/v1/workspaces/{id}/slack/apps/{app_id}",
        "/v1/workspaces/{id}/slack/apps/{app_id}/secrets/{purpose}",
        "/v1/workspaces/{id}/members/{userId}/password-reset",
        "/v1/takeovers",
        "/v1/agents",
        "/v1/agents/counts",
        "/v1/agents/{id}",
        "/v1/agents/{id}/releases",
        "/v1/agents/{id}/slack-bindings",
        "/v1/agents/{id}/slack/app",
        "/v1/agents/{id}/slack/app/events/recheck",
        "/v1/agents/{id}/slack/app/manifest",
        "/v1/agents/{id}/slack/app/settings",
        "/v1/agents/{id}/github",
        "/v1/agents/{id}/github/enabled",
        "/v1/agents/{id}/github/repositories",
        "/v1/agents/{id}/github/settings",
        "/v1/agents/{id}/github/pull-request",
        "/v1/agents/{id}/github/activity",
        "/v1/agents/{id}/slack-channels",
        "/v1/agents/{id}/slack/channels",
        "/v1/agents/{id}/slack/install/start",
        "/v1/slack/events/{agent_id}",
        "/v1/slack/install/complete",
        "/v1/slack/interactions/{agent_id}",
        "/v1/api-keys",
        "/v1/api-keys/{id}",
        "/v1/agents/{id}/admins",
        "/v1/agents/{id}/admins/{kind}/{subject_id}",
        "/v1/administered-agents",
        "/v1/teams",
        "/v1/my-teams",
        "/v1/teams/{team_id}",
        "/v1/teams/{team_id}/members",
        "/v1/teams/{team_id}/members/{user_id}",
        "/v1/agents/{id}/activate",
        "/v1/agents/{id}/credential-bindings",
        "/v1/agents/{id}/credential-bindings/{binding_id}",
        "/v1/agents/{id}/identities",
        "/v1/agents/{id}/identities/{identity_id}",
        "/v1/agents/{id}/managing-team",
        "/v1/invites",
        "/v1/invites/accept",
        "/v1/invites/{id}",
        "/v1/members",
        "/v1/members/{user_id}",
        "/v1/members/{user_id}/disable",
        "/v1/members/{user_id}/enable",
        "/v1/users/{user_id}/disable",
        "/v1/users/{user_id}/enable",
        "/v1/workspace-profiles",
        "/v1/workspace-profiles/{profile_id}/retire",
        "/v1/achievement-categories",
        "/v1/achievement-categories/{id}",
        "/v1/achievement-categories/{id}/archive",
        "/v1/achievement-types",
        "/v1/achievement-types/{id}",
        "/v1/achievement-types/{id}/archive",
        "/v1/achievements/{id}/review",
        "/v1/achievement-rules",
        "/v1/achievement-rules/{family_id}/versions",
        "/v1/achievement-rules/{family_id}/disable",
        "/v1/achievement-rules/{family_id}/enable",
        "/v1/workspaces/{id}/achievement-judge",
        "/v1/workspaces/{id}/agent-access",
        "/v1/usage/summary",
        "/v1/usage/outcomes",
        "/v1/usage/achievements",
        "/v1/usage/series",
        "/v1/usage/breakdown",
        "/v1/usage/tools",
        "/v1/usage/tools/{name}/calls",
      ].sort(),
    );
    const rendered = renderOpenApiDocument();
    for (const name of [
      "ApiErrorResponse",
      "SessionDetail",
      "SessionDurability",
      "SseEvent",
      "Receipt",
      "PostSessionAnswerRequest",
    ]) {
      expect(rendered).toContain(`"#/components/schemas/${name}"`);
    }
    expect(rendered).not.toContain('"$schema"');
    expect(JSON.stringify(document.paths["/v1/sessions"]?.post)).toContain(
      "Idempotency-Key",
    );
    expect(
      JSON.stringify(document.paths["/v1/sessions/{id}/events"]?.get),
    ).toContain("text/event-stream");
  });

  test("every operation declares the shared 500 response", () => {
    const document = buildOpenApiDocument();
    expect(document.components.responses.InternalError).toBeDefined();
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, raw] of Object.entries(operations)) {
        const { responses } = raw as { responses: Record<string, unknown> };
        expect(responses["500"], `${method} ${path}`).toEqual({
          $ref: "#/components/responses/InternalError",
        });
      }
    }
  });

  test("narrows every operation error response to its expected codes", () => {
    const document = buildOpenApiDocument();
    const known = new Set<string>(API_ERROR_CODE_VALUES);
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, raw] of Object.entries(operations)) {
        const { responses } = raw as {
          responses: Record<
            string,
            {
              $ref?: string;
              content?: {
                "application/json"?: {
                  schema?: {
                    allOf?: Array<{
                      properties?: {
                        error?: {
                          properties?: { code?: { enum?: string[] } };
                        };
                      };
                    }>;
                  };
                };
              };
            }
          >;
        };
        for (const [status, response] of Object.entries(responses)) {
          if (Number(status) < 400 || status === "500") continue;
          const codes =
            response.content?.["application/json"]?.schema?.allOf?.[1]
              ?.properties?.error?.properties?.code?.enum;
          expect(codes?.length, `${method} ${path} ${status}`).toBeGreaterThan(
            0,
          );
          for (const code of codes ?? []) {
            expect(known.has(code), `${method} ${path} ${status} ${code}`).toBe(
              true,
            );
          }
        }
      }
    }
    const bootstrap = document.paths["/v1/auth/bootstrap"]?.post as
      | { responses: Record<string, unknown> }
      | undefined;
    expect(bootstrap?.responses["409"]).toEqual(
      expect.objectContaining({
        description: expect.stringMatching(
          /^- `BOOTSTRAP_DONE`: An owner already exists/,
        ),
      }),
    );
  });

  test("every error response says when each of its codes happens", () => {
    for (const [key, { responses }] of operations()) {
      for (const [status, response] of Object.entries(responses)) {
        if (Number(status) < 400 || response.$ref) continue;
        const lines = response.description?.split("\n") ?? [];
        const codes = (
          response as {
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    unknown,
                    {
                      properties: {
                        error: { properties: { code: { enum: string[] } } };
                      };
                    },
                  ];
                };
              };
            };
          }
        ).content["application/json"].schema.allOf[1].properties.error
          .properties.code.enum;
        expect(lines, `${key} ${status}`).toHaveLength(codes.length);
        codes.forEach((code, index) => {
          expect(lines[index], `${key} ${status}`).toMatch(
            new RegExp(`^- \`${code}\`: \\S.{20,}`),
          );
        });
      }
    }
  });

  test("403 tells a CSRF refusal from a missing scope", () => {
    const create = operation("post", "/v1/sessions").responses["403"];
    expect(create?.description).toContain("CSRF: a cookie-authenticated");
    expect(create?.description).toContain(
      "Scope: the credential does not hold `sessions:write`",
    );
    const read = operation("get", "/v1/sessions/{id}").responses["403"];
    expect(read?.description).not.toContain("CSRF");
    expect(read?.description).toContain("`sessions:read`");
    const login = operation("post", "/v1/auth/login").responses["403"];
    expect(login?.description).toContain("every caller must send the header");
    expect(login?.description).not.toContain("Scope:");
  });

  test("413 names the `message` limit only where the body has a `message`", () => {
    const document = buildOpenApiDocument();
    const schemas = document.components.schemas as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    const withMessage: string[] = [];
    let checked = 0;
    for (const [key, method] of Object.entries(document.paths).flatMap(
      ([path, methods]) =>
        Object.entries(methods).map(
          ([verb, raw]) =>
            [
              `${verb} ${path}`,
              raw as {
                requestBody?: {
                  content: Record<string, { schema?: { $ref?: string } }>;
                };
                responses: Record<string, { description?: string }>;
              },
            ] as const,
        ),
    )) {
      const description = method.responses["413"]?.description;
      if (description === undefined) continue;
      checked += 1;
      const ref = method.requestBody?.content["application/json"]?.schema?.$ref;
      const body = ref ? schemas[ref.replace("#/components/schemas/", "")] : {};
      const hasMessage = body?.properties?.message !== undefined;
      expect(description.includes("`message`"), key).toBe(hasMessage);
      expect(description, key).toContain("larger than 64 KiB");
      if (hasMessage) withMessage.push(key);
    }
    expect(checked).toBeGreaterThan(withMessage.length);
    expect(withMessage.sort()).toEqual([
      "post /v1/sessions",
      "post /v1/sessions/{id}/messages",
    ]);
  });

  test("404 says a missing and another owner's resource answer the same", () => {
    for (const [key, { responses }] of operations()) {
      if (!responses["404"]) continue;
      expect(responses["404"].description, key).toContain(
        "belongs to another owner. All three answer the same",
      );
    }
  });

  test("every operation states its scope and Idempotency-Key from the declaration", () => {
    for (const route of ROUTES) {
      const { description, security, parameters, ...rest } = operation(
        route.method,
        route.path,
      );
      const scope = rest["x-scope"];
      if (scope) {
        expect(description, route.operationId).toContain(
          `**Scope:** \`${scope}\``,
        );
        expect(security).toEqual([
          { bearerApiKey: [scope] },
          { cookieSession: [scope] },
        ]);
      } else {
        expect(description, route.operationId).toContain("**Auth:**");
      }
      const key = parameters.find((p) => p.name === "Idempotency-Key");
      if (route.method !== "get") {
        expect(description, route.operationId).toContain(
          `**Idempotency-Key:** ${key ? "required" : "ignored"}.`,
        );
      } else {
        expect(description, route.operationId).not.toContain(
          "Idempotency-Key:",
        );
      }
      if (key) {
        expect(key.description, route.operationId).toContain(
          "1–255 characters",
        );
      }
    }
    expect(operation("post", "/v1/auth/logout").description).toContain(
      "**Auth:** cookie session only",
    );
    expect(
      operation("get", "/v1/sessions/{id}/events").parameters.find(
        (p) => p.name === "Last-Event-ID",
      )?.description,
    ).toContain("Replay resumes strictly after it");
  });

  test("shared rules live in info and the security schemes", () => {
    const document = buildOpenApiDocument();
    const info = document.info.description ?? "";
    for (const text of [
      ...SESSION_SCOPE_VALUES,
      "member` all but `sessions:recover`",
      "holds exactly the scopes it was issued with",
      "Idempotency-Key",
      "ApiErrorResponse",
      "Retry-After",
      "X-Request-Id",
      "apps/control-host/src/api/openapi.ts",
    ]) {
      expect(info).toContain(text);
    }
    expect(info).not.toContain("Generated from the Zod contracts");
    for (const scheme of Object.values(document.components.securitySchemes)) {
      expect(scheme.description.length).toBeGreaterThan(40);
    }
    for (const [key, { responses }] of operations()) {
      for (const [status, response] of Object.entries(responses)) {
        if (response.$ref) continue;
        expect(response.headers, `${key} ${status}`).toHaveProperty(
          "X-Request-Id",
        );
        const retryAfter =
          status === "429" ||
          (status === "503" && !response.description?.includes("NOT_READY"));
        expect(
          response.headers?.["Retry-After"] !== undefined,
          `${key} ${status}`,
        ).toBe(retryAfter);
      }
    }
  });

  test("every example parses with the schema it illustrates", () => {
    let parsed = 0;
    for (const route of ROUTES) {
      if (route.requestExample !== undefined) {
        expect(route.body, route.operationId).toBeDefined();
        OPENAPI_COMPONENT_SCHEMAS[route.body ?? "ApiErrorResponse"].parse(
          route.requestExample,
        );
        parsed += 1;
      }
      const success = route.success;
      if ("schema" in success && success.example !== undefined) {
        OPENAPI_COMPONENT_SCHEMAS[success.schema].parse(success.example);
        parsed += 1;
      }
    }
    expect(parsed).toBeGreaterThan(0);
  });

  test("every public /v1 operation is documented, or still on the allowlist", () => {
    const complete = (route: RouteDeclaration) =>
      Boolean(route.description) &&
      (route.body === undefined || route.requestExample !== undefined) &&
      Boolean(route.success.description) &&
      (!("schema" in route.success) || route.success.example !== undefined);
    const incomplete = ROUTES.filter(
      (route) => route.path.startsWith("/v1") && !complete(route),
    ).map((route) => route.operationId);
    expect(incomplete.sort()).toEqual([...UNDOCUMENTED_OPERATIONS].sort());
  });

  test("widening the receipt target keeps every alpha response valid", () => {
    const receipt = buildOpenApiDocument().components.schemas.Receipt as {
      required: string[];
      properties: {
        target_ref: { anyOf: { required: string[] }[] };
      };
    };
    // A client written against alpha still validates: the session shape is a
    // branch of the union, and the new actor field is not required.
    expect(receipt.properties.target_ref.anyOf[0]?.required).toEqual([
      "session_id",
      "turn_id",
      "request_id",
    ]);
    expect(receipt.properties.target_ref.anyOf[1]?.required).toEqual([
      "resource",
      "workspace_id",
    ]);
    expect(receipt.required).not.toContain("actor");
  });

  test("a session's repository_id is optional, and when it is refused is documented", () => {
    const request = buildOpenApiDocument().components.schemas
      .CreateSessionRequest as {
      required: string[];
      properties: Record<string, { description?: string }>;
    };
    expect(request.required).not.toContain("repository_id");
    expect(request.properties.repository_id?.description).toContain(
      "`repository_mode`",
    );
    const create = JSON.stringify(operation("post", "/v1/sessions"));
    expect(create).toContain(
      "Profile <id> needs a repository: send repository_id",
    );
    expect(create).toContain(
      "Profile <id> runs without a repository: omit repository_id",
    );
  });
});

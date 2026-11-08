import { describe, expect, test } from "bun:test";
import {
  agentMcpResponseSchema,
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  putAgentMcpSettingsResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  type AgentMcpRow,
  type AgentMcpStore,
  createAgentMcpService,
  createAuthorizationPolicy,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
  type SessionCatalog,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerAgentMcpRoutes } from "./agent-mcp.ts";

const createApiApp = recordRouteErrors("routes/agent-mcp.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const MISSING = "019a0000-0000-7000-8000-0000000000c9";
const STALE_REVISION = 99;

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId: WORKSPACE,
    role,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return `${WEB_SESSION_COOKIE_NAME}=${token}`;
}

const identity = {
  async resolveWebSession(tokenHash: Uint8Array) {
    return sessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
  },
  async renewWebSession() {
    return null;
  },
} as unknown as IdentityStore;

const KEY = { plaintext: `csp_${crypto.randomUUID()}` };
const keyStore = {
  async find(candidate: Uint8Array) {
    if (!Buffer.from(hashApiKey(KEY.plaintext)).equals(Buffer.from(candidate)))
      return null;
    return {
      id: crypto.randomUUID(),
      ownerId: WORKSPACE,
      workspaceId: WORKSPACE,
      kind: "personal" as const,
      agentId: null,
      createdByUserId: crypto.randomUUID(),
      creatorRole: "owner" as const,
      scopes: ["sessions:read" as const, "sessions:write" as const],
    };
  },
};

const catalog = {
  profiles: {},
  repositories: {},
  mcp_servers: {
    docs: {
      url: "https://docs.example.com/mcp",
      credential_ref: "docs-key",
      auth: { kind: "bearer", value: "x", ref: "docs-token" },
      workspaces: ["acme"],
    },
  },
} as unknown as SessionCatalog;

const releaseCard = {
  capabilities: {
    mcp: [{ server: "docs" }],
    credential_refs: ["docs-key"],
    forbidden: [],
  },
};
const releasePins = {
  tools: {
    per_tool: {
      mcp__docs__read: "allow",
      mcp__docs__write: "ask",
    },
  },
};

function appWith(options: { row?: AgentMcpRow | null } = {}) {
  const row = options.row ?? null;
  const store: AgentMcpStore = {
    async agent(_workspaceId, agentId) {
      return agentId === AGENT
        ? {
            workspaceSlug: "acme",
            activeRelease: {
              id: "rel_1",
              card: releaseCard,
              policyPins: releasePins,
              mcpDeny: [],
            },
          }
        : null;
    },
    row: async () => row,
    boundRefs: async (_workspaceId, _agentId, refs) =>
      refs.filter((ref) => ref === "docs-key"),
    async put(input) {
      if (input.agentId !== AGENT) return { outcome: "not_found" };
      // The real store runs the service's check under its lock, on the held row.
      input.check(row, "docs", []);
      if (input.expectedRevision === STALE_REVISION) {
        return { outcome: "conflict", revision: 1 };
      }
      return { outcome: "saved", revision: 1, receiptId: null };
    },
  };
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    registerRoutes: (router) =>
      registerAgentMcpRoutes(
        router,
        createAgentMcpService({
          authorization: createAuthorizationPolicy({}),
          store,
          catalog,
        }),
      ),
  });
  return async (
    method: "GET" | "PUT",
    path: string,
    request: { cookie?: string; key?: boolean; body?: unknown } = {},
  ) => {
    const response = await app.request(path, {
      method,
      headers: {
        ...(request.cookie ? { Cookie: request.cookie } : {}),
        ...(request.key ? { Authorization: `Bearer ${KEY.plaintext}` } : {}),
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
        ...(request.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
}

const settingsPath = (id = AGENT) => `/v1/agents/${id}/mcp/settings`;
const reason = (json: unknown) =>
  (
    apiErrorResponseSchema.parse(json).error.details as {
      reason_code?: string;
    } | null
  )?.reason_code;
const valid = {
  server: "docs",
  allowed_tools: ["mcp__docs__read"],
  credential_refs: ["docs-key"],
};
const body = (
  settings: Record<string, unknown> = valid,
  expected_revision: number | null = null,
) => ({ expected_revision, settings });

describe("the agent MCP settings API", () => {
  test("with no row, GET shows what the active release does, allow pins only", async () => {
    const call = appWith();
    const read = await call("GET", settingsPath(), {
      cookie: cookieFor("admin"),
    });
    expect(read.status).toBe(200);
    expect(agentMcpResponseSchema.parse(read.json)).toEqual({
      source: "release",
      settings: valid,
      settings_revision: null,
      active_release_id: "rel_1",
      bound_credential_refs: ["docs-key"],
    });
  });

  test("with a row, GET shows the row and its revision", async () => {
    const call = appWith({
      row: {
        server: "docs",
        allowedTools: ["mcp__docs__search"],
        credentialRefs: ["docs-key", "other-key"],
        revision: 4,
        updatedBy: crypto.randomUUID(),
      },
    });
    const read = await call("GET", settingsPath(), {
      cookie: cookieFor("owner"),
    });
    expect(agentMcpResponseSchema.parse(read.json)).toMatchObject({
      source: "agent",
      settings_revision: 4,
      settings: { allowed_tools: ["mcp__docs__search"] },
      bound_credential_refs: ["docs-key"],
    });
  });

  test("a member who manages no agent cannot read or save; an API key cannot save", async () => {
    const call = appWith();
    const member = cookieFor("member");
    expect((await call("GET", settingsPath(), { cookie: member })).status).toBe(
      403,
    );
    expect(
      (await call("PUT", settingsPath(), { cookie: member, body: body() }))
        .status,
    ).toBe(403);
    const byKey = await call("PUT", settingsPath(), {
      key: true,
      body: body(),
    });
    // The scope policy refuses a key first; the service's own web-session
    // rule is held in agent-mcp-service.test.ts.
    expect(byKey.status).toBe(403);
  });

  test("an admin saves; a stale revision is a 409", async () => {
    const call = appWith();
    const admin = cookieFor("admin");
    const saved = await call("PUT", settingsPath(), {
      cookie: admin,
      body: body(),
    });
    expect(saved.status).toBe(200);
    expect(putAgentMcpSettingsResponseSchema.parse(saved.json)).toEqual({
      settings_revision: 1,
      receipt_id: null,
    });
    const stale = await call("PUT", settingsPath(), {
      cookie: admin,
      body: body(valid, STALE_REVISION),
    });
    expect(stale.status).toBe(409);
    expect(apiErrorResponseSchema.parse(stale.json).error.code).toBe(
      "REVISION_CONFLICT",
    );
  });

  test("each validation rule answers 400 with its reason", async () => {
    const call = appWith();
    const admin = cookieFor("admin");
    const refused = async (settings: Record<string, unknown>) => {
      const result = await call("PUT", settingsPath(), {
        cookie: admin,
        body: body(settings),
      });
      expect(result.status).toBe(400);
      return reason(result.json);
    };
    expect(
      await refused({
        server: "nowhere",
        allowed_tools: ["mcp__nowhere__read"],
        credential_refs: ["docs-key"],
      }),
    ).toBe("server_unknown");
    expect(await refused({ ...valid, server: "github" })).toBe(
      "server_builtin",
    );
    expect(await refused({ ...valid, server: null, credential_refs: [] })).toBe(
      "server_required",
    );
    expect(
      await refused({ ...valid, allowed_tools: ["mcp__wiki__read"] }),
    ).toBe("tool_outside_server");
    expect(await refused({ ...valid, allowed_tools: ["mcp__docs__"] })).toBe(
      "tool_outside_server",
    );
    expect(await refused({ ...valid, credential_refs: [] })).toBe(
      "server_credential_missing",
    );
    expect(
      await refused({
        ...valid,
        allowed_tools: ["mcp__docs__read", "mcp__docs__read"],
      }),
    ).toBe("duplicate");
    expect(
      await refused({ ...valid, credential_refs: ["docs-key", "docs-key"] }),
    ).toBe("duplicate");
  });

  test("a server the catalog no longer has can still be narrowed and cleared", async () => {
    const call = appWith({
      row: {
        server: "retired",
        allowedTools: ["mcp__retired__a", "mcp__retired__b"],
        credentialRefs: ["retired-key"],
        revision: 2,
        updatedBy: crypto.randomUUID(),
      },
    });
    const admin = cookieFor("admin");
    const narrowed = await call("PUT", settingsPath(), {
      cookie: admin,
      body: body(
        {
          server: "retired",
          allowed_tools: ["mcp__retired__a"],
          credential_refs: ["retired-key"],
        },
        2,
      ),
    });
    expect(narrowed.status).toBe(200);
    const cleared = await call("PUT", settingsPath(), {
      cookie: admin,
      body: body({ server: null, allowed_tools: [], credential_refs: [] }, 2),
    });
    expect(cleared.status).toBe(200);
    // A different missing server is still an unknown one.
    const swapped = await call("PUT", settingsPath(), {
      cookie: admin,
      body: body({ ...valid, server: "other" }, 2),
    });
    expect(swapped.status).toBe(400);
  });

  test("an unknown agent is not found; a malformed or huge body is refused", async () => {
    const call = appWith();
    const owner = cookieFor("owner");
    expect(
      (await call("GET", settingsPath(MISSING), { cookie: owner })).status,
    ).toBe(404);
    expect(
      (
        await call("PUT", settingsPath(MISSING), {
          cookie: owner,
          body: body(),
        })
      ).status,
    ).toBe(404);
    for (const bad of [
      {},
      { ...body(), expected_revision: "1" },
      { ...body(), expected_revision: 0 },
      { ...body(), extra: 1 },
      body({ ...valid, allowed_tools: "mcp__docs__read" }),
      body({ ...valid, credential_refs: ["Not A Name"] }),
      body({ ...valid, extra: true }),
    ]) {
      expect(
        (await call("PUT", settingsPath(), { cookie: owner, body: bad }))
          .status,
      ).toBe(400);
    }
    const huge = await call("PUT", settingsPath(), {
      cookie: owner,
      body: { ...body(), pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
    });
    expect(huge.status).toBe(413);
  });
});

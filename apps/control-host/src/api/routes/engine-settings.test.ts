import { describe, expect, test } from "bun:test";
import {
  agentEngineSettingsResponseSchema,
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  putEngineSettingsResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  type StoredEngineSettings,
  type ToolCatalogView,
  WEB_SESSION_COOKIE_NAME,
  workspaceEngineSettingsResponseSchema,
} from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createEngineSettingsService,
  type EngineSettingsStore,
  type IdentityReader,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
  type SavedEngineSettings,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../auth.ts";
import { hashApiKey } from "../keys.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerEngineSettingsRoutes } from "./agents/engine-settings.ts";

const createApiApp = recordRouteErrors("routes/engine-settings.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000a2";
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

const AGENT_KEY_ID = "019a0000-0000-7000-8000-0000000000d1";
const PERSONAL_KEY_ID = "019a0000-0000-7000-8000-0000000000d2";
const KEY_CREATOR = "019a0000-0000-7000-8000-0000000000e1";

// The policy learns who made a key only from the identity reader.
const keyCreators: IdentityReader = {
  async reread(subject) {
    const { principal } = subject;
    if (principal.kind !== "api_key") return { status: "ok", principal };
    return principal.id === AGENT_KEY_ID
      ? { status: "ok", principal, keyAgentId: AGENT }
      : {
          status: "ok",
          principal,
          keyCreator: { userId: KEY_CREATOR, role: "owner" },
        };
  },
};

const KEY = { plaintext: `csp_${crypto.randomUUID()}` };
const AGENT_KEY = { plaintext: `csp_${crypto.randomUUID()}` };
const keyStore = {
  async find(candidate: Uint8Array) {
    const matches = (held: { plaintext: string }) =>
      Buffer.from(hashApiKey(held.plaintext)).equals(Buffer.from(candidate));
    if (!matches(KEY) && !matches(AGENT_KEY)) return null;
    const forAgent = matches(AGENT_KEY);
    return {
      id: forAgent ? AGENT_KEY_ID : PERSONAL_KEY_ID,
      ownerId: WORKSPACE,
      workspaceId: WORKSPACE,
      kind: forAgent ? ("agent" as const) : ("personal" as const),
      agentId: forAgent ? AGENT : null,
      createdByUserId: KEY_CREATOR,
      creatorRole: "owner" as const,
      scopes: ["sessions:read" as const, "sessions:write" as const],
    };
  },
};

const catalog: ToolCatalogView = {
  id: "test",
  tools: ["Read", "Bash", "WebFetch"].map((name) => ({
    name,
    boundary: "local" as const,
  })),
};

const rules = (
  permissions: StoredEngineSettings["permissions"] = {},
): StoredEngineSettings => ({ permissions, auto_mode: {} });

function appWith(
  options: {
    workspace?: SavedEngineSettings;
    agent?: SavedEngineSettings;
    writesOpen?: boolean;
  } = {},
) {
  const workspace = options.workspace ?? { settings: rules(), revision: null };
  const agent = options.agent ?? { settings: rules(), revision: null };
  const saved: { scope: string; settings: StoredEngineSettings }[] = [];
  const outcome = (current: SavedEngineSettings, expected: number | null) =>
    options.writesOpen === false
      ? ({ outcome: "writes_closed" } as const)
      : expected === STALE_REVISION
        ? ({ outcome: "conflict", revision: current.revision } as const)
        : null;
  const store: EngineSettingsStore = {
    writesOpen: async () => options.writesOpen !== false,
    workspace: async () => workspace,
    agent: async (_workspaceId, agentId) =>
      agentId === AGENT
        ? { ...agent, inherited: { entries: 1, rules: 3 } }
        : null,
    async putWorkspace(input) {
      const refused = outcome(workspace, input.expectedRevision);
      if (refused !== null) return refused;
      saved.push({ scope: "workspace", settings: input.settings });
      return { outcome: "saved", revision: 1, receiptId: null };
    },
    async putAgent(input) {
      if (input.agentId !== AGENT) return { outcome: "not_found" };
      const refused = outcome(agent, input.expectedRevision);
      if (refused !== null) return refused;
      saved.push({ scope: "agent", settings: input.settings });
      return { outcome: "saved", revision: 1, receiptId: null };
    },
  };
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    registerRoutes: (router) =>
      registerEngineSettingsRoutes(
        router,
        createEngineSettingsService({
          authorization: createAuthorizationPolicy({ identity: keyCreators }),
          store,
          catalogs: [catalog],
        }),
      ),
  });
  const call = async (
    method: "GET" | "PUT",
    path: string,
    request: {
      cookie?: string;
      personalKey?: boolean;
      agentKey?: boolean;
      body?: unknown;
    } = {},
  ) => {
    const response = await app.request(path, {
      method,
      headers: {
        ...(request.cookie ? { Cookie: request.cookie } : {}),
        ...(request.personalKey
          ? { Authorization: `Bearer ${KEY.plaintext}` }
          : {}),
        ...(request.agentKey
          ? { Authorization: `Bearer ${AGENT_KEY.plaintext}` }
          : {}),
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
  return { call, saved };
}

const workspacePath = (id = WORKSPACE) =>
  `/v1/workspaces/${id}/engine-settings`;
const agentPath = (id = AGENT) => `/v1/agents/${id}/engine-settings`;
const reason = (json: unknown) =>
  (
    apiErrorResponseSchema.parse(json).error.details as {
      reason_code?: string;
    } | null
  )?.reason_code;
const body = (
  settings: unknown = rules({ deny: ["Bash"] }),
  expected_revision: number | null = null,
) => ({ expected_revision, settings });

describe("the workspace engine settings API", () => {
  test("a member reads the rules and whether saving is open", async () => {
    const { call } = appWith({
      workspace: { settings: rules({ deny: ["Bash"] }), revision: 3 },
      writesOpen: false,
    });
    const read = await call("GET", workspacePath(), {
      cookie: cookieFor("member"),
    });
    expect(read.status).toBe(200);
    expect(workspaceEngineSettingsResponseSchema.parse(read.json)).toEqual({
      settings: rules({ deny: ["Bash"] }),
      settings_revision: 3,
      writes_open: false,
    });
  });

  test("another workspace's id is not found", async () => {
    const { call } = appWith();
    const read = await call("GET", workspacePath(OTHER_WORKSPACE), {
      cookie: cookieFor("owner"),
    });
    expect(read.status).toBe(404);
  });

  test("an agent's own credential reads nothing of the workspace", async () => {
    const { call } = appWith();
    const read = await call("GET", workspacePath(), { agentKey: true });
    expect(read.status).toBe(403);
  });

  test("a member's personal API key reads both; saving stays with the web session", async () => {
    const { call } = appWith();
    expect(
      (await call("GET", workspacePath(), { personalKey: true })).status,
    ).toBe(200);
    expect((await call("GET", agentPath(), { personalKey: true })).status).toBe(
      200,
    );
  });

  test("saving another workspace's id is not found; a huge body is a 413", async () => {
    const { call, saved } = appWith();
    const other = await call("PUT", workspacePath(OTHER_WORKSPACE), {
      cookie: cookieFor("owner"),
      body: body(),
    });
    expect(other.status).toBe(404);
    const huge = await call("PUT", workspacePath(), {
      cookie: cookieFor("owner"),
      body: { ...body(), pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
    });
    expect(huge.status).toBe(413);
    expect(saved).toEqual([]);
  });

  test("only an owner or admin with a web session saves", async () => {
    const { call, saved } = appWith();
    const asMember = await call("PUT", workspacePath(), {
      cookie: cookieFor("member"),
      body: body(),
    });
    expect(asMember.status).toBe(403);
    const byKey = await call("PUT", workspacePath(), {
      personalKey: true,
      body: body(),
    });
    expect(byKey.status).toBe(403);
    expect(saved).toEqual([]);

    const asAdmin = await call("PUT", workspacePath(), {
      cookie: cookieFor("admin"),
      body: body(),
    });
    expect(asAdmin.status).toBe(200);
    expect(putEngineSettingsResponseSchema.parse(asAdmin.json)).toEqual({
      settings_revision: 1,
      receipt_id: null,
    });
    expect(saved).toEqual([
      { scope: "workspace", settings: rules({ deny: ["Bash"] }) },
    ]);
  });

  test("a stale revision is a 409 and nothing is saved", async () => {
    const { call, saved } = appWith();
    const stale = await call("PUT", workspacePath(), {
      cookie: cookieFor("owner"),
      body: body(rules({ deny: ["Bash"] }), STALE_REVISION),
    });
    expect(stale.status).toBe(409);
    expect(saved).toEqual([]);
  });

  test("a shut gate refuses the save with its reason", async () => {
    const { call, saved } = appWith({ writesOpen: false });
    const refused = await call("PUT", workspacePath(), {
      cookie: cookieFor("owner"),
      body: body(),
    });
    expect(refused.status).toBe(403);
    expect(reason(refused.json)).toBe("engine_settings_writes_closed");
    expect(saved).toEqual([]);
  });

  test("a rule the engine would drop is a 400 with the parser's reason", async () => {
    const { call, saved } = appWith();
    const refused = await call("PUT", workspacePath(), {
      cookie: cookieFor("owner"),
      body: body(rules({ deny: ["NoSuchTool"] })),
    });
    expect(refused.status).toBe(400);
    expect(reason(refused.json)).toBeString();
    expect(saved).toEqual([]);
  });

  test("text the database cannot hold is a 400, not a server error", async () => {
    const { call, saved } = appWith();
    for (const text of ["read\u0000docs", "read\ud800docs"]) {
      const refused = await call("PUT", workspacePath(), {
        cookie: cookieFor("owner"),
        body: body({ permissions: {}, auto_mode: { allow: [text] } }),
      });
      expect(refused.status).toBe(400);
      expect(reason(refused.json)).toBe("settings_shape");
    }
    expect(saved).toEqual([]);
  });

  test("the request cannot carry inherited restrictions", async () => {
    const { call, saved } = appWith();
    const refused = await call("PUT", workspacePath(), {
      cookie: cookieFor("owner"),
      body: {
        expected_revision: null,
        settings: { ...rules(), admin_deny: [] },
      },
    });
    expect(refused.status).toBe(400);
    expect(saved).toEqual([]);
  });
});

describe("the agent engine settings API", () => {
  test("GET shows the agent's rules, the workspace's, and how allow lists meet", async () => {
    const { call } = appWith({
      workspace: {
        settings: rules({ allow: ["Read"], deny: ["Bash"] }),
        revision: 2,
      },
      agent: { settings: rules({ allow: ["WebFetch"] }), revision: 5 },
    });
    const read = await call("GET", agentPath(), { cookie: cookieFor("admin") });
    expect(read.status).toBe(200);
    expect(agentEngineSettingsResponseSchema.parse(read.json)).toMatchObject({
      settings: rules({ allow: ["WebFetch"] }),
      settings_revision: 5,
      workspace: { settings_revision: 2 },
      inherited: { entries: 1, rules: 3 },
      reach: {
        agent_allow_without_effect: { permissions: ["WebFetch"] },
        workspace_allow_inactive: false,
      },
      writes_open: true,
    });
  });

  test("an unknown agent is not found; a member who manages none is refused", async () => {
    const { call } = appWith();
    expect(
      (await call("GET", agentPath(MISSING), { cookie: cookieFor("admin") }))
        .status,
    ).toBe(404);
    expect(
      (await call("GET", agentPath(), { cookie: cookieFor("member") })).status,
    ).toBe(403);
    expect(
      (
        await call("PUT", agentPath(), {
          cookie: cookieFor("member"),
          body: body(),
        })
      ).status,
    ).toBe(403);
  });

  test("an admin saves; an API key cannot", async () => {
    const { call, saved } = appWith();
    const byKey = await call("PUT", agentPath(), {
      personalKey: true,
      body: body(),
    });
    expect(byKey.status).toBe(403);
    const saves = await call("PUT", agentPath(), {
      cookie: cookieFor("admin"),
      body: body(rules({ ask: ["WebFetch"] })),
    });
    expect(saves.status).toBe(200);
    expect(saved).toEqual([
      { scope: "agent", settings: rules({ ask: ["WebFetch"] }) },
    ]);
  });

  test("a stale revision, a shut gate and a bad rule each refuse", async () => {
    const stale = await appWith().call("PUT", agentPath(), {
      cookie: cookieFor("admin"),
      body: body(rules({ deny: ["Bash"] }), STALE_REVISION),
    });
    expect(stale.status).toBe(409);
    const closed = await appWith({ writesOpen: false }).call(
      "PUT",
      agentPath(),
      { cookie: cookieFor("admin"), body: body() },
    );
    expect(closed.status).toBe(403);
    expect(reason(closed.json)).toBe("engine_settings_writes_closed");
    const bad = await appWith().call("PUT", agentPath(), {
      cookie: cookieFor("admin"),
      body: body(rules({ deny: ["NoSuchTool"] })),
    });
    expect(bad.status).toBe(400);
  });

  test("a huge body is a 413", async () => {
    const { call, saved } = appWith();
    const huge = await call("PUT", agentPath(), {
      cookie: cookieFor("admin"),
      body: { ...body(), pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
    });
    expect(huge.status).toBe(413);
    expect(saved).toEqual([]);
  });

  test("saving an unknown agent is not found", async () => {
    const { call } = appWith();
    const missing = await call("PUT", agentPath(MISSING), {
      cookie: cookieFor("admin"),
      body: body(),
    });
    expect(missing.status).toBe(404);
  });
});

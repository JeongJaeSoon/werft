import { describe, expect, test } from "bun:test";
import {
  AGENT_WORKSPACE_MCP_SERVERS_MAX,
  agentWorkspaceMcpServerListSchema,
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  putAgentWorkspaceMcpServersResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  type AgentWorkspaceMcpServerRow,
  type AgentWorkspaceMcpStore,
  createAgentWorkspaceMcpService,
  createAuthorizationPolicy,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../../auth.ts";
import { hashApiKey } from "../../keys.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerAgentWorkspaceMcpRoutes } from "./agent-mcp.ts";

const createApiApp = recordRouteErrors(
  "routes/agents/agent-workspace-mcp.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const MISSING = "019a0000-0000-7000-8000-0000000000c9";
const TRACKER = "019a0000-0000-7000-8000-0000000000d1";
const WIKI = "019a0000-0000-7000-8000-0000000000d2";
const ELSEWHERE = "019a0000-0000-7000-8000-0000000000d9";
const CONNECTOR = "019a0000-0000-7000-8000-0000000000e1";

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

function appWith() {
  const on = new Set<string>([TRACKER]);
  const rows = (): AgentWorkspaceMcpServerRow[] => [
    {
      serverId: TRACKER,
      name: "tracker",
      on: on.has(TRACKER),
      state: "active",
      connectedBy: { userId: CONNECTOR, displayName: "Ada" },
      toolCount: 3,
    },
    {
      serverId: WIKI,
      name: "wiki",
      on: on.has(WIKI),
      state: "none",
      connectedBy: null,
      toolCount: 0,
    },
  ];
  const puts: string[][] = [];
  const store: AgentWorkspaceMcpStore = {
    list: async (_workspaceId, agentId) => (agentId === AGENT ? rows() : null),
    async put(input) {
      if (input.agentId !== AGENT) return { outcome: "not_found" };
      const at = input.serverIds.findIndex(
        (id) => id !== TRACKER && id !== WIKI,
      );
      if (at >= 0) return { outcome: "server_unknown", at };
      puts.push([...input.serverIds]);
      const same =
        input.serverIds.length === on.size &&
        input.serverIds.every((id) => on.has(id));
      on.clear();
      for (const id of input.serverIds) on.add(id);
      return {
        outcome: "saved",
        receiptId: same ? null : crypto.randomUUID(),
      };
    },
  };
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    registerRoutes: (router) =>
      registerAgentWorkspaceMcpRoutes(
        router,
        createAgentWorkspaceMcpService({
          authorization: createAuthorizationPolicy({}),
          store,
        }),
      ),
  });
  const call = async (
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
    return {
      status: response.status,
      text,
      json: text ? JSON.parse(text) : null,
    };
  };
  return { call, puts };
}

const serversPath = (id = AGENT) => `/v1/agents/${id}/mcp/workspace-servers`;
const reason = (json: unknown) =>
  (
    apiErrorResponseSchema.parse(json).error.details as {
      reason_code?: string;
    } | null
  )?.reason_code;

describe("the agent workspace MCP servers API", () => {
  test("GET lists every workspace server with on, its connection and who connected it", async () => {
    const { call } = appWith();
    const read = await call("GET", serversPath(), {
      cookie: cookieFor("admin"),
    });
    expect(read.status).toBe(200);
    expect(agentWorkspaceMcpServerListSchema.parse(read.json)).toEqual({
      items: [
        {
          server_id: TRACKER,
          name: "tracker",
          on: true,
          state: "active",
          connected_by: { user_id: CONNECTOR, display_name: "Ada" },
          tool_count: 3,
        },
        {
          server_id: WIKI,
          name: "wiki",
          on: false,
          state: "none",
          connected_by: null,
          tool_count: 0,
        },
      ],
      limit: AGENT_WORKSPACE_MCP_SERVERS_MAX,
    });
    expect(read.text).not.toContain("url");
  });

  test("an admin saves the whole set; the same set again writes no receipt", async () => {
    const { call, puts } = appWith();
    const admin = cookieFor("admin");
    const saved = await call("PUT", serversPath(), {
      cookie: admin,
      body: { server_ids: [WIKI.toUpperCase()] },
    });
    expect(saved.status).toBe(200);
    const parsed = putAgentWorkspaceMcpServersResponseSchema.parse(saved.json);
    expect(parsed.receipt_id).not.toBeNull();
    expect(parsed.servers.items.map((row) => [row.name, row.on])).toEqual([
      ["tracker", false],
      ["wiki", true],
    ]);
    expect(puts).toEqual([[WIKI]]);
    const again = await call("PUT", serversPath(), {
      cookie: admin,
      body: { server_ids: [WIKI] },
    });
    expect(
      putAgentWorkspaceMcpServersResponseSchema.parse(again.json).receipt_id,
    ).toBeNull();
    const cleared = await call("PUT", serversPath(), {
      cookie: admin,
      body: { server_ids: [] },
    });
    expect(cleared.status).toBe(200);
    expect(puts.at(-1)).toEqual([]);
  });

  test("a member outside the agent finds none and cannot save; an API key cannot read or save", async () => {
    const { call, puts } = appWith();
    const member = cookieFor("member");
    expect((await call("GET", serversPath(), { cookie: member })).status).toBe(
      404,
    );
    expect((await call("GET", serversPath(), { key: true })).status).toBe(403);
    expect(
      (
        await call("PUT", serversPath(), {
          cookie: member,
          body: { server_ids: [TRACKER] },
        })
      ).status,
    ).toBe(403);
    const byKey = await call("PUT", serversPath(), {
      key: true,
      body: { server_ids: [TRACKER] },
    });
    expect(byKey.status).toBe(403);
    expect(puts).toEqual([]);
  });

  test("an id outside the workspace or named twice answers 400 with its place", async () => {
    const { call, puts } = appWith();
    const owner = cookieFor("owner");
    const unknown = await call("PUT", serversPath(), {
      cookie: owner,
      body: { server_ids: [TRACKER, ELSEWHERE] },
    });
    expect(unknown.status).toBe(400);
    expect(reason(unknown.json)).toBe("server_unknown");
    expect(apiErrorResponseSchema.parse(unknown.json).error.details).toEqual(
      expect.objectContaining({ field: "server_ids.1" }),
    );
    const twice = await call("PUT", serversPath(), {
      cookie: owner,
      body: { server_ids: [TRACKER, TRACKER.toUpperCase()] },
    });
    expect(twice.status).toBe(400);
    expect(reason(twice.json)).toBe("duplicate");
    expect(puts).toEqual([]);
  });

  test("an unknown agent is not found; a malformed, too long or huge body is refused", async () => {
    const { call } = appWith();
    const owner = cookieFor("owner");
    expect(
      (await call("GET", serversPath(MISSING), { cookie: owner })).status,
    ).toBe(404);
    expect(
      (
        await call("PUT", serversPath(MISSING), {
          cookie: owner,
          body: { server_ids: [] },
        })
      ).status,
    ).toBe(404);
    const nine = Array.from(
      { length: AGENT_WORKSPACE_MCP_SERVERS_MAX + 1 },
      () => crypto.randomUUID(),
    );
    for (const bad of [
      {},
      { server_ids: "tracker" },
      { server_ids: ["tracker"] },
      { server_ids: [], extra: 1 },
      { server_ids: nine },
    ]) {
      expect(
        (await call("PUT", serversPath(), { cookie: owner, body: bad })).status,
      ).toBe(400);
    }
    const huge = await call("PUT", serversPath(), {
      cookie: owner,
      body: { server_ids: [], pad: "x".repeat(REQUEST_BODY_MAX_BYTES) },
    });
    expect(huge.status).toBe(413);
  });
});

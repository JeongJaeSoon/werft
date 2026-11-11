import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  type AgentPullRequestSettings,
  agentPullRequestResponseSchema,
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  DEFAULT_AGENT_PULL_REQUEST_SETTINGS,
  putAgentPullRequestSettingsResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  createAgentPullRequestService,
  createAuthorizationPolicy,
  type IdentityStore,
  type MembershipRole,
  type PullRequestSettingsStore,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../../auth.ts";
import { hashApiKey } from "../../keys.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerAgentPullRequestRoutes } from "./agent-pull-request.ts";

const createApiApp = recordRouteErrors(
  "routes/action/agent-pull-request.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const MISSING = "019a0000-0000-7000-8000-0000000000c9";

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

// The Postgres store (the agent lock, the receipt, the session join) is its
// own integration test (packages/db/src/pull-request-settings.integration.test.ts).
function appWith() {
  let held: { settings: AgentPullRequestSettings; revision: number } | null =
    null;
  const writes: AgentPullRequestSettings[] = [];
  const store = {
    async agent() {
      return (
        held ?? { settings: DEFAULT_AGENT_PULL_REQUEST_SETTINGS, revision: 0 }
      );
    },
    async putAgent(input) {
      if (input.agentId !== AGENT) return { outcome: "not_found" };
      if ((held?.revision ?? 0) !== input.revision) {
        return { outcome: "revision_conflict" };
      }
      if (
        held !== null &&
        JSON.stringify(held.settings) === JSON.stringify(input.settings)
      ) {
        return {
          outcome: "stored",
          settings: held.settings,
          revision: held.revision,
          receiptId: null,
        };
      }
      held = { settings: input.settings, revision: input.revision + 1 };
      writes.push(input.settings);
      return {
        outcome: "stored",
        settings: held.settings,
        revision: held.revision,
        receiptId: crypto.randomUUID(),
      };
    },
  } as Pick<PullRequestSettingsStore, "agent" | "putAgent">;
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    registerRoutes: (router) =>
      registerAgentPullRequestRoutes(
        router,
        createAgentPullRequestService({
          authorization: createAuthorizationPolicy({}),
          agents: {
            async get(_workspaceId, agentId) {
              return agentId === AGENT
                ? ({ active_release: null } as unknown as AgentDetail)
                : null;
            },
          },
          settings: store,
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
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  return { call, writes };
}

const code = (json: unknown) => apiErrorResponseSchema.parse(json).error.code;
const path = (id = AGENT) => `/v1/agents/${id}/github/pull-request`;

const SETTINGS: AgentPullRequestSettings = {
  formatting: "on",
  template: "## Summary\n<!-- ours -->\n",
  template_name: "feature.md",
};

describe("the agent pull request settings API", () => {
  test("an agent with none saved reads as inherit at revision 0", async () => {
    const { call } = appWith();
    const read = await call("GET", path(), { cookie: cookieFor("admin") });
    expect(read.status).toBe(200);
    expect(agentPullRequestResponseSchema.parse(read.json)).toEqual({
      pull_request: DEFAULT_AGENT_PULL_REQUEST_SETTINGS,
      pull_request_revision: 0,
    });
  });

  test("a manager saves at the revision read; the same values again write nothing", async () => {
    const { call, writes } = appWith();
    const admin = cookieFor("admin");
    const put = await call("PUT", path(), {
      cookie: admin,
      body: { pull_request: SETTINGS, revision: 0 },
    });
    expect(put.status).toBe(200);
    expect(putAgentPullRequestSettingsResponseSchema.parse(put.json)).toEqual({
      pull_request: SETTINGS,
      pull_request_revision: 1,
      receipt_id: expect.any(String),
    });
    const again = await call("PUT", path(), {
      cookie: admin,
      body: { pull_request: SETTINGS, revision: 1 },
    });
    expect(again.json.receipt_id).toBeNull();
    expect(writes).toEqual([SETTINGS]);
    expect(
      agentPullRequestResponseSchema.parse(
        (await call("GET", path(), { cookie: admin })).json,
      ),
    ).toEqual({ pull_request: SETTINGS, pull_request_revision: 1 });
  });

  test("a stale revision is 409 and stores nothing", async () => {
    const { call, writes } = appWith();
    const admin = cookieFor("admin");
    await call("PUT", path(), {
      cookie: admin,
      body: { pull_request: SETTINGS, revision: 0 },
    });
    const stale = await call("PUT", path(), {
      cookie: admin,
      body: {
        pull_request: { ...SETTINGS, formatting: "off" },
        revision: 0,
      },
    });
    expect(stale.status).toBe(409);
    expect(code(stale.json)).toBe("REVISION_CONFLICT");
    expect(writes).toHaveLength(1);
  });

  test("a template the platform will not use is 400 with its reason", async () => {
    const { call, writes } = appWith();
    const admin = cookieFor("admin");
    const open = await call("PUT", path(), {
      cookie: admin,
      body: {
        pull_request: { ...SETTINGS, template: "## A\n<!-- never closed\n" },
        revision: 0,
      },
    });
    expect(open.status).toBe(400);
    expect(open.json.error.details).toEqual({
      reason_code: "template_unsupported",
    });
    const huge = await call("PUT", path(), {
      cookie: admin,
      body: {
        pull_request: { ...SETTINGS, template: "a".repeat(16 * 1024 + 1) },
        revision: 0,
      },
    });
    expect(huge.status).toBe(400);
    expect(writes).toEqual([]);
  });

  test("a name with a control character or no length is 400", async () => {
    const { call } = appWith();
    const admin = cookieFor("admin");
    for (const name of ["", "a\nb", "x".repeat(101)]) {
      const put = await call("PUT", path(), {
        cookie: admin,
        body: {
          pull_request: { ...SETTINGS, template_name: name },
          revision: 0,
        },
      });
      expect(put.status).toBe(400);
    }
  });

  test("a member who manages no agent is refused; an API key may not save", async () => {
    const { call, writes } = appWith();
    const body = { pull_request: SETTINGS, revision: 0 };
    expect(
      (await call("GET", path(), { cookie: cookieFor("member") })).status,
    ).toBe(403);
    expect(
      (await call("PUT", path(), { cookie: cookieFor("member"), body })).status,
    ).toBe(403);
    const key = await call("PUT", path(), { key: true, body });
    expect(key.status).toBe(403);
    expect(writes).toEqual([]);
  });

  test("no credentials is 401; an unknown agent is 404; a huge body is 413", async () => {
    const { call } = appWith();
    const admin = cookieFor("admin");
    expect((await call("GET", path())).status).toBe(401);
    const missing = await call("GET", path(MISSING), { cookie: admin });
    expect(missing.status).toBe(404);
    const put = await call("PUT", path(MISSING), {
      cookie: admin,
      body: { pull_request: SETTINGS, revision: 0 },
    });
    expect(put.status).toBe(404);
    expect(
      (
        await call("PUT", path(), {
          cookie: admin,
          body: { pad: "a".repeat(REQUEST_BODY_MAX_BYTES) },
        })
      ).status,
    ).toBe(413);
  });
});

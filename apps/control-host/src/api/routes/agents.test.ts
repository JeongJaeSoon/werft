import { describe, expect, test } from "bun:test";
import {
  type AgentDetail,
  type AgentRelease,
  activateAgentResponseSchema,
  activationCredentialUnboundDetailsSchema,
  agentDetailSchema,
  apiErrorResponseSchema,
  countAgentsResponseSchema,
  createAgentReleaseResponseSchema,
  type ListAgentsQuery,
  listAgentsResponseSchema,
  requestBodyInvalidDetailsSchema,
  saveAgentResponseSchema,
} from "@werft-ai/contracts";
import {
  type AgentRecord,
  type AgentService,
  type AgentStore,
  type AuthorizationPolicy,
  type Caller,
  type CatalogProfile,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  deriveReleaseId,
  InvalidCursorError,
  profileFingerprint,
  withSeededInstallation,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerAgentRoutes } from "./agents.ts";

const createApiApp = recordRouteErrors("routes/agents.test.ts");

const AGENT = "019a0000-0000-7000-8000-0000000000a1";
const VERSION = "019a0000-0000-7000-8000-0000000000a2";
const OWNER_USER = "019a0000-0000-7000-8000-0000000000b1";
const RECEIPT = "4d6d1a3e-1f1c-4c3a-9f3e-2b1c1d1e1f10";
const AT = "2026-10-11T00:00:00.000Z";

const PROFILE: CatalogProfile = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Grep"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};

const card = {
  role: "재무 분석가",
  instructions: "분기 보고서를 읽고 이상치를 요약한다.",
  language: "ko" as const,
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  rules: [],
};

const detail: AgentRecord = {
  behavior_revision: 0,
  model_source: "fixed",
  draft: null,
  agent: {
    id: AGENT,
    workspace_id: "019a0000-0000-7000-8000-0000000000c1",
    slug: "finance",
    name: "재무 분석가",
    description: null,
    managing_team_id: null,
    managing_team_name: null,
    status: "active",
    active_release_id: null,
    activation_revision: -1,
    created_by: OWNER_USER,
    created_at: AT,
    updated_at: AT,
  },
  versions: [
    {
      id: VERSION,
      agent_id: AGENT,
      version_no: 1,
      card,
      content_sha256: "a".repeat(64),
      created_by: OWNER_USER,
      created_at: AT,
    },
  ],
  releases: [],
  active_release: null,
};

function storedRelease(profile: CatalogProfile = PROFILE): AgentRelease {
  const identity = {
    agent_id: AGENT,
    card_sha256: "a".repeat(64),
    runtime_profile_id: "coding",
    repository_id: null,
    profile_digest: profileFingerprint(profile),
    runtime_config_snapshot: { model: "claude-sonnet-5" },
    effective_tools: { tools: ["Read"], mcp: [] },
    policy_pins: {
      tools: {
        default: { builtin: "allow", mcp: "ask" },
        per_tool: { Read: "allow" },
      },
    } as const,
  };
  return {
    id: deriveReleaseId(identity),
    version_id: VERSION,
    created_by: OWNER_USER,
    created_at: AT,
    approved_by: null,
    approved_at: null,
    note: null,
    label: "2026-10-11_09:00:00",
    activated_at: null,
    deactivated_at: null,
    ...identity,
  };
}

const allowing: AuthorizationPolicy = {
  authorize: async () => ({
    outcome: "allow",
    reason_code: "ok",
    effective_scopes: [],
    policy_version: "test",
    decision_id: crypto.randomUUID(),
  }),
};

const outage = () =>
  Promise.reject(
    Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
  );

function store(overrides: Partial<AgentStore> = {}): AgentStore {
  return {
    list: async () => ({ items: [detail.agent], next_cursor: null }),
    count: async () => ({
      all: 1,
      administered: 0,
      active: 1,
      draft: 0,
      unassigned: 1,
    }),
    summaries: async () => new Map(),
    get: async () => detail,
    findVersion: async () => detail.versions[0] ?? null,
    findRelease: async () => storedRelease(),
    releaseSuperseded: async () => false,
    create: async () => ({ outcome: "created", detail }),
    update: async () => ({ outcome: "updated", detail, saved: null }),
    recordDraftFailure: async () => true,
    hasGitHubSettings: async () => false,
    followProfile: async () => ({ outcome: "updated" as const }),
    insertRelease: async ({ release }) => ({
      outcome: "created",
      release: {
        ...release,
        created_at: AT,
        approved_by: null,
        approved_at: null,
        label: "2026-10-11_09:00:00",
        activated_at: null,
        deactivated_at: null,
      },
    }),
    activate: async () => ({
      outcome: "activated",
      revision: 0,
      previousReleaseId: null,
      receiptId: RECEIPT,
    }),
    ...overrides,
  };
}

function asPerson(caller: Caller): Caller {
  return {
    ...caller,
    actor: {
      principal: { kind: "user", id: OWNER_USER },
      userId: OWNER_USER,
      workspaceId: caller.ownerId,
      apiKeyId: null,
    },
  };
}

type Routed = Omit<
  AgentService,
  | "resolveRelease"
  | "promptIdentity"
  | "rolloutRelease"
  | "migrateAgent"
  | "revertMigration"
>;

function app(
  agentStore: AgentStore = store(),
  options: {
    authorization?: AuthorizationPolicy;
    person?: boolean;
    unbound?: string[];
    blocked?: boolean;
  } = {},
) {
  const catalog = withSeededInstallation({
    profiles: { coding: PROFILE },
    repositories: {
      "sample-app": {
        url: "https://github.com/acme/sample-app",
        branch: "main",
        profiles: ["coding"],
        auth: { kind: "github_app", registered: true } as const,
      },
    },
  });
  const coding = catalog.installation?.get("coding");
  const service = createAgentService({
    authorization: options.authorization ?? allowing,
    store: agentStore,
    catalog:
      options.blocked && catalog.installation && coding
        ? {
            ...catalog,
            installation: new Map([
              ...catalog.installation,
              ["coding", { ...coding, state: "blocked" }],
            ]),
          }
        : catalog,
    credentials: { unboundRefs: async () => options.unbound ?? [] },
  });
  const routed: Routed =
    options.person === false
      ? service
      : {
          listAgents: (caller, query) =>
            service.listAgents(asPerson(caller), query),
          countAgents: (caller) => service.countAgents(asPerson(caller)),
          getAgent: (caller, id) => service.getAgent(asPerson(caller), id),
          createAgent: (caller, body) =>
            service.createAgent(asPerson(caller), body),
          updateAgent: (caller, id, body) =>
            service.updateAgent(asPerson(caller), id, body),
          createRelease: (caller, id, body) =>
            service.createRelease(asPerson(caller), id, body),
          activateAgent: (caller, id, body) =>
            service.activateAgent(asPerson(caller), id, body),
        };
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) => registerAgentRoutes(router, routed),
  });
}

const owner = { "X-Owner-Id": "owner-a" };

function send(
  api: ReturnType<typeof app>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = owner,
) {
  return api.request(path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function codeOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

const oversized = JSON.stringify({ name: "x".repeat(65 * 1024) });
const keyOnly = () =>
  app(store(), { authorization: createAuthorizationPolicy(), person: false });

describe("GET /v1/agents", () => {
  test("lists the workspace's agents", async () => {
    const response = await send(app(), "GET", "/v1/agents");
    expect(response.status).toBe(200);
    expect(listAgentsResponseSchema.parse(await response.json())).toEqual({
      items: [detail.agent],
      next_cursor: null,
    });
  });

  test("hands the store the cursor and limit, 50 by default, and returns its next_cursor", async () => {
    const asked: unknown[] = [];
    const api = app(
      store({
        list: async (_workspace, query) => {
          asked.push(query);
          return { items: [detail.agent], next_cursor: "next" };
        },
      }),
    );
    const first = await send(api, "GET", "/v1/agents");
    expect((await first.json()).next_cursor).toBe("next");
    await send(api, "GET", "/v1/agents?cursor=next&limit=100");
    expect(asked).toEqual([{ limit: 50 }, { cursor: "next", limit: 100 }]);
  });

  test("hands the store a trimmed q and the ids split, and refuses a blank q or a bad id", async () => {
    const asked: unknown[] = [];
    const api = app(
      store({
        list: async (_workspace, query) => {
          asked.push(query);
          return { items: [], next_cursor: null };
        },
      }),
    );
    const other = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
    expect((await send(api, "GET", "/v1/agents?q=%20notes%20")).status).toBe(
      200,
    );
    expect(
      (await send(api, "GET", `/v1/agents?ids=${AGENT},${other}`)).status,
    ).toBe(200);
    expect(
      (await send(api, "GET", "/v1/agents?runtime_profile_id=coding")).status,
    ).toBe(200);
    expect(asked).toEqual([
      { limit: 50, q: "notes" },
      { limit: 50, ids: [AGENT, other] },
      { limit: 50, runtime_profile_id: "coding" },
    ]);
    const tooMany = Array.from({ length: 101 }, () => AGENT).join(",");
    for (const query of [
      "q=%20",
      `q=${"x".repeat(201)}`,
      "ids=",
      "ids=not-an-id",
      `ids=${AGENT},`,
      `ids=${tooMany}`,
      "runtime_profile_id=",
      `runtime_profile_id=${"p".repeat(129)}`,
    ]) {
      const response = await send(api, "GET", `/v1/agents?${query}`);
      expect(response.status, query.slice(0, 40)).toBe(400);
    }
  });

  test("answers 400 to a limit out of range and to a cursor the store did not issue", async () => {
    for (const query of ["limit=0", "limit=101", "limit=x", "cursor="]) {
      const response = await send(app(), "GET", `/v1/agents?${query}`);
      expect(response.status, query).toBe(400);
    }
    const forged = await send(
      app(
        store({
          list: () => Promise.reject(new InvalidCursorError()),
        }),
      ),
      "GET",
      "/v1/agents?cursor=forged",
    );
    expect(forged.status).toBe(400);
    expect(await codeOf(forged)).toBe("BAD_REQUEST");
  });

  test("refuses an API key that names no agent of its own, whatever its scopes", async () => {
    const response = await send(keyOnly(), "GET", "/v1/agents");
    expect(response.status).toBe(403);
    expect(await codeOf(response)).toBe("FORBIDDEN");
  });

  test("a key's agent comes from its stored row, so only an agent key gets one agent and the policy is asked about that agent", async () => {
    const asked: unknown[] = [];
    const policy: AuthorizationPolicy = {
      authorize: async (request) => {
        asked.push([request.action, request.resource.agent_id]);
        return allowing.authorize(request);
      },
    };
    const stored = (kind: "agent" | "personal") => ({
      find: async (workspaceId: string, keyId: string) => ({
        id: keyId,
        workspaceId,
        kind,
        name: null,
        agentId: kind === "agent" ? AGENT : null,
        createdByUserId: null,
        createdByDisplayName: null,
        scopes: [],
        createdAt: new Date(AT),
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
      }),
    });
    const service = (kind: "agent" | "personal") =>
      createAgentService({
        authorization: policy,
        store: store({
          list: () =>
            Promise.reject(new Error("a key never lists the workspace")),
        }),
        catalog: { profiles: {}, repositories: {} },
        credentials: { unboundRefs: async () => [] },
        keys: stored(kind),
      });
    const key = callerFor(
      {
        kind: "api_key",
        id: "key-1",
        owner_id: "ws-1",
        workspace_id: "ws-1",
        scopes: ["sessions:write"],
      },
      { kind: "api" },
      "request-1",
      { creatorId: null },
    );

    expect(await service("agent").listAgents(key, { limit: 50 })).toEqual({
      items: [detail.agent],
      next_cursor: null,
    });
    expect(asked).toEqual([["session.submit", AGENT]]);
    // A filter keeps the key's agent only when it matches it.
    const filters: [ListAgentsQuery, number][] = [
      [{ limit: 50, q: detail.agent.slug.toUpperCase() }, 1],
      [{ limit: 50, q: "no such agent" }, 0],
      [{ limit: 50, ids: [AGENT.toUpperCase()] }, 1],
      [{ limit: 50, ids: ["1b4e28ba-2fa1-11d2-883f-0016d3cca427"] }, 0],
      // No active release, so on no profile.
      [{ limit: 50, runtime_profile_id: "coding" }, 0],
      [{ limit: 50, managing_team: "unassigned" }, 1],
    ];
    for (const [query, kept] of filters) {
      const page = await service("agent").listAgents(key, query);
      expect(page.items, JSON.stringify(query)).toHaveLength(kept);
    }
    const teamed = createAgentService({
      authorization: policy,
      store: store({
        get: async () => ({
          ...detail,
          agent: {
            ...detail.agent,
            managing_team_id: "6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
            managing_team_name: "Finance",
          },
        }),
      }),
      catalog: { profiles: {}, repositories: {} },
      credentials: { unboundRefs: async () => [] },
      keys: stored("agent"),
    });
    for (const [query, kept] of [
      [{ limit: 50 }, 1],
      [{ limit: 50, managing_team: "unassigned" }, 0],
    ] as const) {
      const page = await teamed.listAgents(key, query);
      expect(page.items, JSON.stringify(query)).toHaveLength(kept);
    }
    asked.length = 1;
    // Even a policy that allows everything never hears of a personal key.
    for (const [kind, query] of [
      ["personal", { limit: 50 }],
      ["agent", { limit: 50, include: "summary" }],
    ] as const) {
      await expect(service(kind).listAgents(key, query)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    expect(asked).toHaveLength(1);
  });

  test("requires authentication and maps an outage to 503", async () => {
    expect((await send(app(), "GET", "/v1/agents", undefined, {})).status).toBe(
      401,
    );
    expect(
      (await send(app(store({ list: outage })), "GET", "/v1/agents")).status,
    ).toBe(503);
  });
});

describe("GET /v1/agents/counts", () => {
  test("counts the workspace's agents and the caller's own, not as an agent id", async () => {
    const asked: string[] = [];
    const api = app(
      store({
        count: async (workspaceId, reader) => {
          asked.push(workspaceId, reader.userId, reader.outsideAccess);
          return {
            all: 501,
            administered: 3,
            active: 410,
            draft: 80,
            unassigned: 7,
          };
        },
      }),
    );
    const response = await send(api, "GET", "/v1/agents/counts");
    expect(response.status).toBe(200);
    expect(countAgentsResponseSchema.parse(await response.json())).toEqual({
      counts: {
        all: 501,
        administered: 3,
        active: 410,
        draft: 80,
        unassigned: 7,
      },
    });
    expect(asked[0]).toBe("owner-a");
  });

  test("requires authentication, refuses an API key and maps an outage to 503", async () => {
    expect(
      (await send(app(), "GET", "/v1/agents/counts", undefined, {})).status,
    ).toBe(401);
    const refused = await send(keyOnly(), "GET", "/v1/agents/counts");
    expect(refused.status).toBe(403);
    expect(
      (await send(app(store({ count: outage })), "GET", "/v1/agents/counts"))
        .status,
    ).toBe(503);
  });
});

describe("POST /v1/agents", () => {
  const TEAM = "019a0000-0000-7000-8000-0000000000c9";
  const body = {
    slug: "finance",
    name: "재무 분석가",
    managing_team_id: TEAM,
    card,
  };

  test("creates the agent with its first version", async () => {
    let created: unknown;
    const response = await send(
      app(
        store({
          create: async (input) => {
            created = input;
            return { outcome: "created", detail };
          },
        }),
      ),
      "POST",
      "/v1/agents",
      body,
    );
    expect(response.status).toBe(201);
    expect(saveAgentResponseSchema.parse(await response.json())).toEqual({
      ...detail,
      effective_behavior: { applied: null, draft: null },
      release: {
        status: "unchanged",
        reason: null,
        release_id: null,
        version_id: detail.versions.at(-1)?.id as string,
      },
    });
    expect(created).toMatchObject({
      slug: "finance",
      createdBy: OWNER_USER,
      contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("refuses a card that names an MCP server or a bad slug", async () => {
    for (const bad of [
      {
        ...body,
        card: { ...card, capabilities: { ...card.capabilities, mcp: [] } },
      },
      { ...body, slug: "Finance Team" },
      { ...body, card: { ...card, api_key: "x" } },
      { ...body, card: { ...card, tone: "공손하게" } },
    ]) {
      const response = await send(app(), "POST", "/v1/agents", bad);
      expect(response.status).toBe(400);
    }
  });

  test("a taken slug is 409 ALREADY_EXISTS", async () => {
    const response = await send(
      app(store({ create: async () => ({ outcome: "slug_taken" }) })),
      "POST",
      "/v1/agents",
      body,
    );
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("ALREADY_EXISTS");
  });

  test("passes the managing team, and its refusals map to 404 and 403", async () => {
    let asked: unknown;
    const created = await send(
      app(
        store({
          create: async (input) => {
            asked = input.managingTeam;
            return { outcome: "created", detail };
          },
        }),
      ),
      "POST",
      "/v1/agents",
      body,
    );
    expect(created.status).toBe(201);
    expect(asked).toEqual({ id: TEAM, managerRoles: ["owner", "admin"] });
    const missing = await send(
      app(store({ create: async () => ({ outcome: "team_not_found" }) })),
      "POST",
      "/v1/agents",
      body,
    );
    expect(missing.status).toBe(404);
    const refused = await send(
      app(store({ create: async () => ({ outcome: "team_not_allowed" }) })),
      "POST",
      "/v1/agents",
      body,
    );
    expect(refused.status).toBe(403);
  });

  test("a body without a managing team is 400 naming managing_team_id, and nothing is written", async () => {
    let writes = 0;
    const issuesOf = async (sent: unknown) => {
      const response = await send(
        app(
          store({
            create: async () => {
              writes += 1;
              return { outcome: "created", detail };
            },
          }),
        ),
        "POST",
        "/v1/agents",
        sent,
      );
      expect(response.status).toBe(400);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.code).toBe("BAD_REQUEST");
      expect(error.message).toBe("Request body is invalid");
      return requestBodyInvalidDetailsSchema.parse(error.details).issues;
    };
    const { managing_team_id: _, ...withoutTeam } = body;
    expect(await issuesOf(withoutTeam)).toEqual([
      { path: "managing_team_id", message: "managing_team_id is required" },
    ]);
    for (const team of [null, "", "not-a-uuid"]) {
      expect(
        (await issuesOf({ ...body, managing_team_id: team })).map(
          (issue) => issue.path,
        ),
      ).toEqual(["managing_team_id"]);
    }
    expect(writes).toBe(0);
  });

  test("refuses an API key and an oversized body", async () => {
    expect((await send(keyOnly(), "POST", "/v1/agents", body)).status).toBe(
      403,
    );
    expect((await send(app(), "POST", "/v1/agents", oversized)).status).toBe(
      413,
    );
  });
});

describe("GET /v1/agents/{id}", () => {
  test("returns versions, releases and the active release", async () => {
    const response = await send(app(), "GET", `/v1/agents/${AGENT}`);
    expect(response.status).toBe(200);
    expect(agentDetailSchema.parse(await response.json())).toEqual({
      ...detail,
      effective_behavior: { applied: null, draft: null },
    });
  });

  test("a missing agent and a malformed id are both not found", async () => {
    expect(
      (
        await send(
          app(store({ get: async () => null })),
          "GET",
          `/v1/agents/${AGENT}`,
        )
      ).status,
    ).toBe(404);
    expect((await send(app(), "GET", "/v1/agents/not-a-uuid")).status).toBe(
      404,
    );
  });

  test("refuses an API key", async () => {
    expect((await send(keyOnly(), "GET", `/v1/agents/${AGENT}`)).status).toBe(
      403,
    );
  });
});

describe("PATCH /v1/agents/{id}", () => {
  test("an agent that keeps changing under the save is 409 REVISION_CONFLICT, and a refused release is answered with 200 and its reason", async () => {
    const api = app(store({ update: async () => ({ outcome: "stale" }) }));
    const response = await send(api, "PATCH", `/v1/agents/${AGENT}`, {
      card,
      runtime_profile_id: "coding",
    });
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("REVISION_CONFLICT");

    const released = await send(
      app(
        store({
          update: async () => ({
            outcome: "updated",
            detail,
            saved: {
              status: "pending",
              versionId: VERSION,
              behaviorRevision: 1,
            },
          }),
        }),
      ),
      "PATCH",
      `/v1/agents/${AGENT}`,
      { card, runtime_profile_id: "coding" },
    );
    expect(released.status).toBe(200);
    const body = saveAgentResponseSchema.parse(await released.json());
    // This catalog's profile needs a repository the agent never had: the
    // card is kept and the refusal is the answer, not an error status.
    expect(body.release).toEqual({
      status: "failed",
      reason: "release_refused",
      release_id: null,
      version_id: body.versions.at(-1)?.id as string,
    });
  });

  test("a card becomes a new version", async () => {
    let update: unknown;
    const response = await send(
      app(
        store({
          update: async (input) => {
            update = input;
            return { outcome: "updated", detail, saved: null };
          },
        }),
      ),
      "PATCH",
      `/v1/agents/${AGENT}`,
      { card },
    );
    expect(response.status).toBe(200);
    expect(update).toMatchObject({
      agentId: AGENT,
      card: { card, contentSha256: expect.any(String) },
      updatedBy: OWNER_USER,
    });
  });

  test("refuses an empty patch, an unknown agent and an oversized body", async () => {
    expect((await send(app(), "PATCH", `/v1/agents/${AGENT}`, {})).status).toBe(
      400,
    );
    expect(
      (
        await send(app(), "PATCH", `/v1/agents/${AGENT}`, {
          card: { ...card, tone: "공손하게" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send(
          app(store({ update: async () => ({ outcome: "not_found" }) })),
          "PATCH",
          `/v1/agents/${AGENT}`,
          { name: "x" },
        )
      ).status,
    ).toBe(404);
    expect(
      (await send(app(), "PATCH", `/v1/agents/${AGENT}`, oversized)).status,
    ).toBe(413);
    expect(
      (await send(keyOnly(), "PATCH", `/v1/agents/${AGENT}`, { name: "x" }))
        .status,
    ).toBe(403);
  });
});

describe("POST /v1/agents/{id}/releases", () => {
  const path = `/v1/agents/${AGENT}/releases`;
  const body = {
    version_id: VERSION,
    runtime_profile_id: "coding",
    repository_id: "sample-app",
  };

  test("releases a version with a hash id and no credential", async () => {
    const response = await send(app(), "POST", path, body);
    expect(response.status).toBe(200);
    const released = createAgentReleaseResponseSchema.parse(
      await response.json(),
    );
    expect(released.created).toBe(true);
    expect(released.release.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(released.release.repository_id).toBe("sample-app");
    expect(released.release.approved_by).toBeNull();
    expect(JSON.stringify(released)).not.toContain("catalog-provider-key");
  });

  test("carries a trimmed note, null without one, and refuses a blank or long one", async () => {
    const noted = createAgentReleaseResponseSchema.parse(
      await (
        await send(app(), "POST", path, { ...body, note: "  hotfix  " })
      ).json(),
    );
    expect(noted.release.note).toBe("hotfix");
    const bare = createAgentReleaseResponseSchema.parse(
      await (await send(app(), "POST", path, body)).json(),
    );
    expect(bare.release.note).toBeNull();
    expect(bare.release.id).toBe(noted.release.id);
    for (const note of ["   ", "a".repeat(201), "a\u0000b", 7]) {
      const response = await send(app(), "POST", path, { ...body, note });
      expect(response.status).toBe(400);
      expect(await codeOf(response)).toBe("BAD_REQUEST");
    }
  });

  test("a release without a repository for a profile that needs one is 422 and says why", async () => {
    const { repository_id: _, ...bare } = body;
    const response = await send(app(), "POST", path, bare);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: "UNSUPPORTED_CAPABILITY",
        message:
          "repository_id: Profile coding needs a repository: send repository_id",
      },
    });
  });

  test("a profile the operator blocked is 409 PROFILE_BLOCKED naming it", async () => {
    const response = await send(
      app(store(), { blocked: true }),
      "POST",
      path,
      body,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "PROFILE_BLOCKED",
        details: { reason_code: "blocked", profile_id: "coding" },
      },
    });
  });

  test("a card tool outside the profile or an unknown profile is 422", async () => {
    const wide = {
      ...detail.versions[0],
      card: {
        ...card,
        capabilities: { ...card.capabilities, tools: ["Bash"] },
      },
    } as NonNullable<AgentDetail["versions"][0]>;
    const tooWide = await send(
      app(store({ findVersion: async () => wide })),
      "POST",
      path,
      body,
    );
    expect(tooWide.status).toBe(422);
    expect(await codeOf(tooWide)).toBe("UNSUPPORTED_CAPABILITY");
    expect(
      (
        await send(app(), "POST", path, {
          ...body,
          runtime_profile_id: "missing",
        })
      ).status,
    ).toBe(422);
  });

  test("another agent's version is not found; a bad body is 400 or 413", async () => {
    expect(
      (
        await send(
          app(store({ findVersion: async () => null })),
          "POST",
          path,
          body,
        )
      ).status,
    ).toBe(404);
    expect((await send(app(), "POST", path, { version_id: "x" })).status).toBe(
      400,
    );
    expect((await send(app(), "POST", path, oversized)).status).toBe(413);
    expect((await send(keyOnly(), "POST", path, body)).status).toBe(403);
  });
});

describe("POST /v1/agents/{id}/activate", () => {
  const path = `/v1/agents/${AGENT}/activate`;
  const body = { release_id: storedRelease().id, expected_revision: -1 };

  test("moves the pointer and names the receipt", async () => {
    const response = await send(app(), "POST", path, body);
    expect(response.status).toBe(200);
    expect(activateAgentResponseSchema.parse(await response.json())).toEqual({
      active_release_id: body.release_id,
      previous_release_id: null,
      activation_revision: 0,
      receipt_id: RECEIPT,
    });
  });

  test("a stale revision is 409 REVISION_CONFLICT", async () => {
    const response = await send(
      app(
        store({
          activate: async () => ({
            outcome: "conflict",
            activeReleaseId: "sha256:other",
            revision: 4,
          }),
        }),
      ),
      "POST",
      path,
      body,
    );
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("REVISION_CONFLICT");
  });

  test("a release made against a since-changed profile is 409 PROFILE_DIGEST_MISMATCH", async () => {
    const stale = storedRelease({ ...PROFILE, tools: ["Read"] });
    const response = await send(
      app(store({ findRelease: async () => stale })),
      "POST",
      path,
      { ...body, release_id: stale.id },
    );
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe("PROFILE_DIGEST_MISMATCH");
  });

  test("a release naming an unbound credential is 409 CREDENTIAL_UNBOUND with the names", async () => {
    const response = await send(
      app(store(), { unbound: ["mcp-notion", "slack_bot_token"] }),
      "POST",
      path,
      body,
    );
    expect(response.status).toBe(409);
    const { error } = (await response.json()) as {
      error: { code: string; details: unknown };
    };
    expect(error.code).toBe("CREDENTIAL_UNBOUND");
    expect(
      activationCredentialUnboundDetailsSchema.parse(error.details),
    ).toEqual({
      reason_code: "credential_unbound",
      missing: ["mcp-notion", "slack_bot_token"],
    });
  });

  test("another agent's or a missing release is not found", async () => {
    const elsewhere = {
      ...storedRelease(),
      agent_id: "019a0000-0000-7000-8000-0000000000ff",
    };
    elsewhere.id = deriveReleaseId(elsewhere);
    for (const found of [null, elsewhere]) {
      const response = await send(
        app(store({ findRelease: async () => found })),
        "POST",
        path,
        body,
      );
      expect(response.status).toBe(404);
    }
  });

  test("refuses a bad body, an oversized one and an API key", async () => {
    expect(
      (
        await send(app(), "POST", path, {
          release_id: "x",
          expected_revision: -2,
        })
      ).status,
    ).toBe(400);
    expect((await send(app(), "POST", path, oversized)).status).toBe(413);
    expect((await send(keyOnly(), "POST", path, body)).status).toBe(403);
  });
});

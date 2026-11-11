import { beforeEach, describe, expect, test } from "bun:test";
import {
  type AchievementCategory,
  type AchievementRule,
  type AchievementType,
  type AuthorizationRequest,
  achievementJudgeSettingsSchema,
  achievementRuleChangeResponseSchema,
  achievementTypeChangeResponseSchema,
  apiErrorResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  type ListSessionAchievementsResponse,
  listAchievementTypesResponseSchema,
  listSessionAchievementsResponseSchema,
  REQUEST_BODY_MAX_BYTES,
  rejudgeSessionResponseSchema,
  reviewAchievementResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  type AchievementRuleStore,
  createAchievementRuleService,
  createAuthorizationPolicy,
  createSessionAchievementService,
  type DecisionLog,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../../auth.ts";
import { hashApiKey } from "../../keys.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import {
  registerAchievementRoutes,
  registerSessionAchievementRoutes,
} from "./achievements.ts";

const createApiApp = recordRouteErrors("routes/sessions/achievements.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const USER = "019a0000-0000-7000-8000-0000000000c1";
const OTHER_USER = "019a0000-0000-7000-8000-0000000000c2";
const ID = "019a0000-0000-7000-8000-0000000000d1";
const AT = "2026-11-02T01:00:00.000Z";

const CATEGORY: AchievementCategory = {
  id: ID,
  name: "Delivery",
  position: 0,
  created_by: USER,
  created_at: AT,
  archived_at: null,
  archived_by: null,
};
const TYPE: AchievementType = {
  id: ID,
  key: "pull_request",
  name: "GitHub PR",
  evidence_kind: "github_pull_request",
  builtin: true,
  created_by: null,
  created_at: AT,
  archived_at: null,
  archived_by: null,
};
const RULE: AchievementRule = {
  id: ID,
  family_id: ID,
  version: 1,
  category_id: ID,
  title: "Merged PR",
  type_id: ID,
  definition: "Only a merged pull request counts.",
  judge: "luna",
  agent_ids: null,
  created_by: USER,
  created_at: AT,
  superseded_by: null,
  disabled_at: null,
  disabled_by: null,
};
const RULE_BODY = {
  category_id: ID,
  title: RULE.title,
  type_id: ID,
  definition: RULE.definition,
  judge: RULE.judge,
};

// What the store answers next, by method; anything unset succeeds.
let next: Partial<Record<keyof AchievementRuleStore, unknown>> = {};
const calls: { method: string; input: unknown }[] = [];
let storageDown = false;

function answer<T>(method: keyof AchievementRuleStore, fallback: T) {
  return async (input?: unknown): Promise<T> => {
    calls.push({ method, input });
    if (storageDown) {
      throw Object.assign(new Error("connection refused"), {
        code: "ECONNREFUSED",
      });
    }
    return method in next ? (next[method] as T) : fallback;
  };
}

const JUDGE = achievementJudgeSettingsSchema.parse({});
const store = {
  listCategories: answer("listCategories", [CATEGORY]),
  listTypes: answer("listTypes", [TYPE]),
  listRules: answer("listRules", [RULE]),
  createCategory: answer("createCategory", {
    outcome: "created",
    category: CATEGORY,
  }),
  updateCategory: answer("updateCategory", {
    outcome: "updated",
    category: CATEGORY,
  }),
  archiveCategory: answer("archiveCategory", {
    outcome: "archived",
    category: CATEGORY,
  }),
  createType: answer("createType", { outcome: "created", type: TYPE }),
  updateType: answer("updateType", { outcome: "updated", type: TYPE }),
  archiveType: answer("archiveType", { outcome: "archived", type: TYPE }),
  createRule: answer("createRule", { outcome: "created", rule: RULE }),
  createRuleVersion: answer("createRuleVersion", {
    outcome: "created",
    rule: RULE,
  }),
  setRuleDisabled: answer("setRuleDisabled", {
    outcome: "changed",
    rule: RULE,
  }),
  getJudge: answer("getJudge", JUDGE),
  setJudge: async (input: { settings: typeof JUDGE }) => {
    calls.push({ method: "setJudge", input });
    return { outcome: "set" as const, settings: input.settings };
  },
} as AchievementRuleStore;

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole, workspaceId = WORKSPACE): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: USER,
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId,
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

// An owner's personal key that reads and writes sessions, and an agent's key.
const KEY = `csp_${crypto.randomUUID()}`;
const keyHash = Buffer.from(hashApiKey(KEY));
const KEY_ID = crypto.randomUUID();
const AGENT_KEY = `csp_${crypto.randomUUID()}`;
const agentKeyHash = Buffer.from(hashApiKey(AGENT_KEY));
const AGENT_KEY_ID = crypto.randomUUID();
const AGENT_ID = crypto.randomUUID();

const recorded: AuthorizationRequest[] = [];
const decisions: DecisionLog = {
  async record({ request }) {
    recorded.push(request);
  },
};

const app = createApiApp({
  authMode: "api-key",
  identity,
  keyStore: {
    async find(candidate) {
      if (agentKeyHash.equals(Buffer.from(candidate))) {
        return {
          id: AGENT_KEY_ID,
          ownerId: WORKSPACE,
          workspaceId: WORKSPACE,
          kind: "agent" as const,
          agentId: AGENT_ID,
          createdByUserId: null,
          creatorRole: null,
          scopes: ["sessions:read", "sessions:write"],
        };
      }
      return keyHash.equals(Buffer.from(candidate))
        ? {
            id: KEY_ID,
            ownerId: WORKSPACE,
            workspaceId: WORKSPACE,
            kind: "personal" as const,
            createdByUserId: USER,
            creatorRole: "owner" as const,
            scopes: ["sessions:read", "sessions:write"],
          }
        : null;
    },
  },
  registerRoutes: (router) =>
    registerAchievementRoutes(
      router,
      createAchievementRuleService({
        authorization: createAuthorizationPolicy({
          decisions,
          // As the database reader answers: a personal key's creator, an
          // agent key's agent.
          identity: {
            async reread(subject) {
              const { principal } = subject;
              if (principal.kind !== "api_key") {
                return { status: "ok", principal };
              }
              return principal.id === AGENT_KEY_ID
                ? { status: "ok", principal, keyAgentId: AGENT_ID }
                : {
                    status: "ok",
                    principal,
                    keyCreator: { userId: USER, role: "owner" },
                  };
            },
          },
        }),
        store,
      }),
    ),
});

type Who = MembershipRole | "key" | "agent_key" | null;

function call(method: string, path: string, who: Who, body?: unknown) {
  const headers: Record<string, string> = {};
  if (who === "key") headers.Authorization = `Bearer ${KEY}`;
  else if (who === "agent_key") headers.Authorization = `Bearer ${AGENT_KEY}`;
  else if (who !== null) headers.Cookie = cookieFor(who);
  if (method !== "GET") headers[CSRF_HEADER_NAME] = CSRF_HEADER_VALUE;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return app.request(path, {
    method,
    headers,
    ...(body === undefined
      ? {}
      : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

async function refusal(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

const WRITES: [string, string, unknown][] = [
  ["POST", "/v1/achievement-categories", { name: "Delivery" }],
  ["PATCH", `/v1/achievement-categories/${ID}`, { name: "Delivery" }],
  ["POST", `/v1/achievement-categories/${ID}/archive`, undefined],
  [
    "POST",
    "/v1/achievement-types",
    { key: "report", name: "Report", evidence_kind: "out_file" },
  ],
  ["PATCH", `/v1/achievement-types/${ID}`, { name: "Report" }],
  ["POST", `/v1/achievement-types/${ID}/archive`, undefined],
  ["POST", "/v1/achievement-rules", RULE_BODY],
  ["POST", `/v1/achievement-rules/${ID}/versions`, RULE_BODY],
  ["POST", `/v1/achievement-rules/${ID}/disable`, undefined],
  ["POST", `/v1/achievement-rules/${ID}/enable`, undefined],
  ["PUT", `/v1/workspaces/${WORKSPACE}/achievement-judge`, {}],
];

const READS = [
  "/v1/achievement-categories",
  "/v1/achievement-types",
  "/v1/achievement-rules",
  `/v1/workspaces/${WORKSPACE}/achievement-judge`,
];

beforeEach(() => {
  next = {};
  calls.length = 0;
  recorded.length = 0;
  storageDown = false;
});

describe("achievement rule management", () => {
  test("owners and admins write; each write asks for achievement_rule.manage", async () => {
    for (const role of ["owner", "admin"] as const) {
      for (const [method, path, body] of WRITES) {
        recorded.length = 0;
        const response = await call(method, path, role, body);
        expect(response.status, `${role} ${method} ${path}`).toBeLessThan(300);
        expect(recorded).toEqual([
          expect.objectContaining({
            action: "achievement_rule.manage",
            resource: {
              kind: "workspace",
              id: WORKSPACE,
              owner_scope: WORKSPACE,
            },
          }),
        ]);
      }
    }
  });

  test("a member and an API key write nothing, and nothing reaches the store", async () => {
    for (const who of ["member", "key"] as const) {
      for (const [method, path, body] of WRITES) {
        const response = await call(method, path, who, body);
        expect(response.status, `${who} ${method} ${path}`).toBe(403);
      }
    }
    expect(calls).toEqual([]);
  });

  test("anyone in the workspace and a personal key read; an agent's key does not", async () => {
    for (const who of ["member", "key"] as const) {
      for (const path of READS) {
        expect((await call("GET", path, who)).status, `${who} ${path}`).toBe(
          200,
        );
      }
    }
    expect(
      listAchievementTypesResponseSchema.parse(
        await (await call("GET", "/v1/achievement-types", "member")).json(),
      ).items,
    ).toEqual([TYPE]);
    expect((await call("GET", READS[0] ?? "", null)).status).toBe(401);
    for (const path of READS) {
      const refused = await call("GET", path, "agent_key");
      expect(refused.status, path).toBe(403);
      expect(await refused.json()).toMatchObject({
        error: { code: "FORBIDDEN", details: { reason_code: "role" } },
      });
    }
  });

  test("a type keeps its key and evidence kind: a PATCH naming either is 400", async () => {
    for (const body of [
      { name: "Report", key: "other" },
      { name: "Report", evidence_kind: "conversation" },
      { key: "other" },
    ]) {
      const response = await call(
        "PATCH",
        `/v1/achievement-types/${ID}`,
        "owner",
        body,
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(calls).toEqual([]);
    const renamed = await call(
      "PATCH",
      `/v1/achievement-types/${ID}`,
      "owner",
      {
        name: "Pull request",
      },
    );
    expect(
      achievementTypeChangeResponseSchema.parse(await renamed.json())
        .receipt_id,
    ).not.toBeNull();
    expect(calls).toEqual([
      {
        method: "updateType",
        input: expect.objectContaining({ typeId: ID, name: "Pull request" }),
      },
    ]);
  });

  test("a rule takes only null agent_ids, and its writes answer with a receipt", async () => {
    const perAgent = await call("POST", "/v1/achievement-rules", "owner", {
      ...RULE_BODY,
      agent_ids: [ID],
    });
    expect(perAgent.status).toBe(400);
    const created = await call("POST", "/v1/achievement-rules", "owner", {
      ...RULE_BODY,
      agent_ids: null,
    });
    expect(created.status).toBe(201);
    expect(
      achievementRuleChangeResponseSchema.parse(await created.json())
        .receipt_id,
    ).toEqual(expect.any(String));
    expect(calls.at(-1)?.input).toMatchObject({
      rule: { ...RULE_BODY, agent_ids: null },
    });
  });

  test("a store refusal answers its status and reason", async () => {
    const cases: [
      keyof AchievementRuleStore,
      unknown,
      [string, string, unknown],
      number,
      string,
      string | undefined,
    ][] = [
      [
        "createCategory",
        { outcome: "name_taken" },
        WRITES[0] as never,
        409,
        "ALREADY_EXISTS",
        "name_taken",
      ],
      [
        "updateCategory",
        { outcome: "name_taken" },
        WRITES[1] as never,
        409,
        "ALREADY_EXISTS",
        "name_taken",
      ],
      [
        "updateCategory",
        { outcome: "not_found" },
        WRITES[1] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "archiveCategory",
        { outcome: "category_in_use" },
        WRITES[2] as never,
        409,
        "REVISION_CONFLICT",
        "category_in_use",
      ],
      [
        "archiveCategory",
        { outcome: "not_found" },
        WRITES[2] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "createType",
        { outcome: "key_taken" },
        WRITES[3] as never,
        409,
        "ALREADY_EXISTS",
        "key_taken",
      ],
      [
        "createType",
        { outcome: "limit_reached" },
        WRITES[3] as never,
        409,
        "REVISION_CONFLICT",
        "limit_reached",
      ],
      [
        "updateType",
        { outcome: "not_found" },
        WRITES[4] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "archiveType",
        { outcome: "builtin" },
        WRITES[5] as never,
        409,
        "REVISION_CONFLICT",
        "builtin",
      ],
      [
        "archiveType",
        { outcome: "type_in_use" },
        WRITES[5] as never,
        409,
        "REVISION_CONFLICT",
        "type_in_use",
      ],
      [
        "archiveType",
        { outcome: "not_found" },
        WRITES[5] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "createRule",
        { outcome: "type_in_use" },
        WRITES[6] as never,
        409,
        "REVISION_CONFLICT",
        "type_in_use",
      ],
      [
        "createRule",
        { outcome: "limit_reached" },
        WRITES[6] as never,
        409,
        "REVISION_CONFLICT",
        "limit_reached",
      ],
      [
        "createRule",
        { outcome: "unknown_category" },
        WRITES[6] as never,
        400,
        "BAD_REQUEST",
        "unknown_category",
      ],
      [
        "createRuleVersion",
        { outcome: "type_in_use" },
        WRITES[7] as never,
        409,
        "REVISION_CONFLICT",
        "type_in_use",
      ],
      [
        "createRuleVersion",
        { outcome: "unknown_type" },
        WRITES[7] as never,
        400,
        "BAD_REQUEST",
        "unknown_type",
      ],
      [
        "createRuleVersion",
        { outcome: "not_found" },
        WRITES[7] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "setRuleDisabled",
        { outcome: "not_found" },
        WRITES[8] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "setRuleDisabled",
        { outcome: "type_in_use" },
        WRITES[9] as never,
        409,
        "REVISION_CONFLICT",
        "type_in_use",
      ],
      [
        "setRuleDisabled",
        { outcome: "unknown_category" },
        WRITES[9] as never,
        400,
        "BAD_REQUEST",
        "unknown_category",
      ],
      [
        "setRuleDisabled",
        { outcome: "not_found" },
        WRITES[9] as never,
        404,
        "NOT_FOUND",
        undefined,
      ],
      [
        "createCategory",
        { outcome: "actor_inactive" },
        WRITES[0] as never,
        403,
        "FORBIDDEN",
        "role",
      ],
    ];
    for (const [
      method,
      outcome,
      [verb, path, body],
      status,
      code,
      reason,
    ] of cases) {
      next = { [method]: outcome };
      const response = await call(verb, path, "owner", body);
      const label = `${method} ${JSON.stringify(outcome)}`;
      expect(response.status, label).toBe(status);
      const error = await refusal(response);
      expect(error.code as string, label).toBe(code);
      expect(
        (error.details as { reason_code?: string } | null)?.reason_code,
        label,
      ).toBe(reason);
    }
  });

  test("an unchanged write answers a null receipt", async () => {
    next = {
      archiveCategory: { outcome: "unchanged", category: CATEGORY },
      setRuleDisabled: { outcome: "unchanged", rule: RULE },
    };
    for (const [method, path] of [
      ["POST", `/v1/achievement-categories/${ID}/archive`],
      ["POST", `/v1/achievement-rules/${ID}/disable`],
    ] as const) {
      const response = await call(method, path, "owner");
      expect(response.status).toBe(200);
      expect(
        ((await response.json()) as { receipt_id: unknown }).receipt_id,
      ).toBeNull();
    }
  });

  test("a malformed id is 404; a malformed or oversized body 400 or 413", async () => {
    for (const [method, path, body] of [
      ["PATCH", "/v1/achievement-categories/nope", { name: "x" }],
      ["POST", "/v1/achievement-categories/nope/archive", undefined],
      ["PATCH", "/v1/achievement-types/nope", { name: "x" }],
      ["POST", "/v1/achievement-types/nope/archive", undefined],
      ["POST", "/v1/achievement-rules/nope/versions", RULE_BODY],
      ["POST", "/v1/achievement-rules/nope/disable", undefined],
      ["POST", "/v1/achievement-rules/nope/enable", undefined],
      ["GET", "/v1/workspaces/nope/achievement-judge", undefined],
      ["PUT", "/v1/workspaces/nope/achievement-judge", {}],
    ] as const) {
      expect((await call(method, path, "owner", body)).status, path).toBe(404);
    }
    const huge = "a".repeat(REQUEST_BODY_MAX_BYTES);
    for (const [method, path, body] of WRITES) {
      if (body === undefined) continue;
      expect(
        (await call(method, path, "owner", { ...(body as object), title: 1 }))
          .status,
        `${method} ${path}`,
      ).toBe(400);
      expect(
        (await call(method, path, "owner", { ...(body as object), huge }))
          .status,
        `${method} ${path}`,
      ).toBe(413);
    }
    expect(calls).toEqual([]);
  });

  test("the judge settings are the caller's workspace's, saved whole with defaults", async () => {
    for (const method of ["GET", "PUT"] as const) {
      const response = await call(
        method,
        `/v1/workspaces/${OTHER_WORKSPACE}/achievement-judge`,
        "owner",
        method === "PUT" ? {} : undefined,
      );
      expect(response.status, method).toBe(404);
    }
    next = { getJudge: null };
    expect(
      (
        await call(
          "GET",
          `/v1/workspaces/${WORKSPACE}/achievement-judge`,
          "owner",
        )
      ).status,
    ).toBe(404);
    for (const body of [
      { every_n_turns: 4 },
      { threshold: 2 },
      { transcript: "all" },
      { model: "gpt-5" },
      { backend: "jev" },
    ]) {
      const response = await call(
        "PUT",
        `/v1/workspaces/${WORKSPACE}/achievement-judge`,
        "owner",
        body,
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const saved = await call(
      "PUT",
      `/v1/workspaces/${WORKSPACE}/achievement-judge`,
      "admin",
      { every_n_turns: 10, on_idle: true },
    );
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      achievement_judge: { ...JUDGE, every_n_turns: 10, on_idle: true },
      receipt_id: expect.any(String),
    });
  });

  test("a storage outage answers 503", async () => {
    storageDown = true;
    expect((await call("GET", READS[0] ?? "", "owner")).status).toBe(503);
    const [method, path, body] = WRITES[0] as [string, string, unknown];
    expect((await call(method, path, "owner", body)).status).toBe(503);
  });
});

const NO_REVIEWS = {
  find: async () => null,
  review: async () => ({ outcome: "not_found" as const }),
};

describe("a session's achievements", () => {
  const SESSION = "11111111-1111-4111-8111-111111111111";
  const DOWN = "22222222-2222-4222-8222-222222222222";
  const listed: ListSessionAchievementsResponse = {
    items: [
      {
        id: ID,
        session_id: SESSION,
        agent_id: null,
        agent_release_id: null,
        rule_id: ID,
        rule_family_id: ID,
        type_id: ID,
        title: "acme/app#12",
        link: "https://github.com/acme/app/pull/12",
        evidence_kind: "github_pull_request",
        evidence_id: ID,
        payload: {
          repository: "acme/app",
          number: 12,
          url: "https://github.com/acme/app/pull/12",
          state: "open",
          merged_at: null,
          additions: 3,
          deletions: 1,
        },
        judge: "always",
        rule_title: "Merged PR",
        rule_version: 1,
        type_key: "pull_request",
        probability: null,
        threshold: null,
        rejudged_after_merge: false,
        judgment_id: ID,
        review_state: "auto",
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
        created_at: AT,
      },
    ],
    judgment: {
      id: ID,
      trigger: "evidence",
      status: "skipped",
      error_code: "judge_unavailable",
      evidence_change: null,
      created_at: AT,
      finished_at: AT,
    },
    judgment_count: 1,
    judge_cost_usd: 0,
  };
  const asked: Array<[string, string]> = [];
  const api = createApiApp({
    authMode: "api-key",
    keyStore: {
      async find(hash) {
        const found = ["ach_reader", "ach_none"].find((candidate) =>
          Buffer.from(hash).equals(Buffer.from(hashApiKey(candidate))),
        );
        return found
          ? {
              id: `key-${found}`,
              ownerId: "owner-a",
              workspaceId: null,
              kind: "operator" as const,
              createdByUserId: null,
              creatorRole: null,
              scopes: found === "ach_reader" ? ["sessions:read"] : [],
            }
          : null;
      },
    },
    registerRoutes: (router) =>
      registerSessionAchievementRoutes(
        router,
        createSessionAchievementService({
          authorization: createAuthorizationPolicy(),
          store: {
            list: async (owner, session) => {
              asked.push([owner, session]);
              if (session === DOWN) {
                throw Object.assign(new Error("connection refused"), {
                  code: "ECONNREFUSED",
                });
              }
              return owner === "owner-a" && session === SESSION ? listed : null;
            },
            rejudge: async () => ({ outcome: "not_found" }),
            ...NO_REVIEWS,
          },
        }),
      ),
  });
  const read = async (session: string, auth?: string) => {
    const response = await api.request(
      `/v1/sessions/${session}/achievements`,
      auth === undefined
        ? {}
        : { headers: { Authorization: `Bearer ${auth}` } },
    );
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };

  test("gives the achievements and the latest judgment of a readable session", async () => {
    const answered = await read(SESSION.toUpperCase(), "ach_reader");
    expect(answered.status).toBe(200);
    expect(listSessionAchievementsResponseSchema.parse(answered.json)).toEqual(
      listed,
    );
    expect(asked.at(-1)).toEqual(["owner-a", SESSION]);
  });

  test("an unseen session is 404; no scope 403; no key 401; a store outage 503", async () => {
    expect(
      (await read("44444444-4444-4444-8444-444444444444", "ach_reader")).status,
    ).toBe(404);
    expect((await read("not-a-uuid", "ach_reader")).status).toBe(404);
    expect((await read(SESSION, "ach_none")).status).toBe(403);
    expect((await read(SESSION)).status).toBe(401);
    expect((await read(DOWN, "ach_reader")).status).toBe(503);
  });

  test("a member is not shown a session not shared with them, and the store is not read", async () => {
    const unshared: string[] = [];
    const members = createApiApp({
      authMode: "api-key",
      identity,
      registerRoutes: (router) =>
        registerSessionAchievementRoutes(
          router,
          createSessionAchievementService({
            authorization: createAuthorizationPolicy({
              sessions: {
                visibleTo: async () => false,
                originOf: async () => ({
                  creatorUserId: OTHER_USER,
                  creatorApiKeyId: null,
                }),
              },
            }),
            store: {
              list: async (_owner, session) => {
                unshared.push(session);
                return listed;
              },
              rejudge: async () => ({ outcome: "not_found" }),
              ...NO_REVIEWS,
            },
          }),
        ),
    });
    const response = await members.request(
      `/v1/sessions/${SESSION}/achievements`,
      { headers: { Cookie: cookieFor("member") } },
    );
    expect(response.status).toBe(404);
    expect(unshared).toEqual([]);
  });
});

describe("POST /v1/sessions/{id}/achievement-judgments", () => {
  const SESSION = "33333333-3333-4333-8333-333333333333";
  const DOWN = "55555555-5555-4555-8555-555555555555";
  const JUDGMENT = "66666666-6666-4666-8666-666666666666";
  const asked: Array<{ userId: string; sessionId: string; receiptId: string }> =
    [];
  let outcome: "queued" | "not_found" | "actor_inactive" = "queued";
  beforeEach(() => {
    asked.length = 0;
    outcome = "queued";
  });
  const rejudging = createApiApp({
    authMode: "api-key",
    identity,
    keyStore: {
      async find(candidate) {
        return keyHash.equals(Buffer.from(candidate))
          ? {
              id: KEY_ID,
              ownerId: WORKSPACE,
              workspaceId: WORKSPACE,
              kind: "personal" as const,
              createdByUserId: USER,
              creatorRole: "owner" as const,
              scopes: ["sessions:read", "sessions:write"],
            }
          : null;
      },
    },
    registerRoutes: (router) =>
      registerSessionAchievementRoutes(
        router,
        createSessionAchievementService({
          authorization: createAuthorizationPolicy({
            identity: {
              async reread(subject) {
                const { principal } = subject;
                return principal.kind === "api_key"
                  ? {
                      status: "ok",
                      principal,
                      keyCreator: { userId: USER, role: "owner" },
                    }
                  : { status: "ok", principal };
              },
            },
          }),
          store: {
            ...NO_REVIEWS,
            list: async () => null,
            rejudge: async ({ actor, sessionId, receiptId }) => {
              asked.push({ userId: actor.userId, sessionId, receiptId });
              if (sessionId === DOWN) {
                throw Object.assign(new Error("connection refused"), {
                  code: "ECONNREFUSED",
                });
              }
              return outcome === "queued"
                ? { outcome, judgmentId: JUDGMENT }
                : { outcome };
            },
          },
        }),
      ),
  });
  const rejudge = (session: string, who: Who) => {
    const headers: Record<string, string> = {
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
    };
    if (who === "key") headers.Authorization = `Bearer ${KEY}`;
    else if (who !== null && who !== "agent_key") {
      headers.Cookie = cookieFor(who);
    }
    return rejudging.request(`/v1/sessions/${session}/achievement-judgments`, {
      method: "POST",
      headers,
    });
  };

  test("an owner or an admin queues a manual judgment and gets its id and the rejudge_session receipt", async () => {
    for (const who of ["owner", "admin"] as const) {
      const response = await rejudge(SESSION.toUpperCase(), who);
      expect(response.status).toBe(202);
      const body = rejudgeSessionResponseSchema.parse(await response.json());
      expect(body.judgment_id).toBe(JUDGMENT);
      expect(asked.at(-1)).toEqual({
        userId: USER,
        sessionId: SESSION,
        receiptId: body.receipt_id,
      });
    }
  });

  test("a member or an API key is 403 and nothing is queued; no login 401", async () => {
    expect((await rejudge(SESSION, "member")).status).toBe(403);
    expect((await rejudge(SESSION, "key")).status).toBe(403);
    expect((await rejudge(SESSION, null)).status).toBe(401);
    expect(asked).toEqual([]);
  });

  test("an unseen session is 404, a manager who lost the role 403, a store outage 503", async () => {
    outcome = "not_found";
    expect((await rejudge(SESSION, "owner")).status).toBe(404);
    expect((await rejudge("not-a-uuid", "owner")).status).toBe(404);
    outcome = "actor_inactive";
    expect((await rejudge(SESSION, "owner")).status).toBe(403);
    expect((await rejudge(DOWN, "owner")).status).toBe(503);
  });
});

describe("POST /v1/achievements/{id}/review", () => {
  const SESSION = "77777777-7777-4777-8777-777777777777";
  const ACHIEVEMENT = "88888888-8888-4888-8888-888888888888";
  const DOWN = "99999999-9999-4999-8999-999999999999";
  const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const asked: Array<{
    userId: string;
    achievementId: string;
    action: string;
    note: string | null;
    receiptId: string;
  }> = [];
  let outcome: "reviewed" | "not_found" | "actor_inactive" | "not_reviewable" =
    "reviewed";
  let agentAdmin = false;
  let visible = true;
  beforeEach(() => {
    asked.length = 0;
    outcome = "reviewed";
    agentAdmin = false;
    visible = true;
  });
  const reviewed = {
    id: ACHIEVEMENT,
    session_id: SESSION,
    agent_id: AGENT,
    agent_release_id: null,
    rule_id: ID,
    rule_family_id: ID,
    type_id: ID,
    title: "out/report.md",
    link: `/sessions/${SESSION}`,
    evidence_kind: "out_file" as const,
    evidence_id: "out/report.md",
    payload: { path: "out/report.md", size: 12 },
    judge: "always" as const,
    rule_title: "Design document",
    rule_version: 3,
    type_key: "document",
    probability: null,
    threshold: null,
    rejudged_after_merge: false,
    judgment_id: ID,
    review_state: "confirmed" as const,
    reviewed_by: USER,
    reviewed_at: AT,
    review_note: null,
    created_at: AT,
  };
  const reviewing = createApiApp({
    authMode: "api-key",
    identity,
    keyStore: {
      async find(candidate) {
        return keyHash.equals(Buffer.from(candidate))
          ? {
              id: KEY_ID,
              ownerId: WORKSPACE,
              workspaceId: WORKSPACE,
              kind: "personal" as const,
              createdByUserId: USER,
              creatorRole: "owner" as const,
              scopes: ["sessions:read", "sessions:write"],
            }
          : null;
      },
    },
    registerRoutes: (router) =>
      registerSessionAchievementRoutes(
        router,
        createSessionAchievementService({
          authorization: createAuthorizationPolicy({
            decisions,
            identity: {
              async reread(subject) {
                const { principal } = subject;
                return principal.kind === "api_key"
                  ? {
                      status: "ok",
                      principal,
                      keyCreator: { userId: USER, role: "owner" },
                    }
                  : { status: "ok", principal };
              },
            },
            sessions: {
              visibleTo: async () => visible,
              originOf: async () => ({
                creatorUserId: OTHER_USER,
                creatorApiKeyId: null,
              }),
            },
            agents: {
              async agentOf(_workspace, resource) {
                return resource.kind === "agent" ? resource.id : null;
              },
              async isAdmin(_workspace, agentId) {
                return agentAdmin && agentId === AGENT;
              },
            },
          }),
          store: {
            list: async () => null,
            rejudge: async () => ({ outcome: "not_found" }),
            find: async (_owner, achievementId) =>
              achievementId === ACHIEVEMENT || achievementId === DOWN
                ? { sessionId: SESSION, agentId: AGENT }
                : null,
            review: async (input) => {
              asked.push({
                userId: input.actor.userId,
                achievementId: input.achievementId,
                action: input.action,
                note: input.note,
                receiptId: input.receiptId,
              });
              if (input.achievementId === DOWN) {
                throw Object.assign(new Error("connection refused"), {
                  code: "ECONNREFUSED",
                });
              }
              return outcome === "reviewed"
                ? { outcome, achievement: reviewed }
                : { outcome };
            },
          },
        }),
      ),
  });
  const review = (id: string, who: Who, body: unknown) => {
    const headers: Record<string, string> = {
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      "Content-Type": "application/json",
    };
    if (who === "key") headers.Authorization = `Bearer ${KEY}`;
    else if (who !== null && who !== "agent_key") {
      headers.Cookie = cookieFor(who);
    }
    return reviewing.request(`/v1/achievements/${id}/review`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  };

  test("an owner or an admin confirms or rejects, with a note, and gets the achievement and the receipt", async () => {
    for (const who of ["owner", "admin"] as const) {
      const response = await review(ACHIEVEMENT.toUpperCase(), who, {
        action: "confirm",
        note: "checked the file",
      });
      expect(response.status).toBe(200);
      const body = reviewAchievementResponseSchema.parse(await response.json());
      expect(body.achievement).toEqual(reviewed);
      expect(asked.at(-1)).toEqual({
        userId: USER,
        achievementId: ACHIEVEMENT,
        action: "confirm",
        note: "checked the file",
        receiptId: body.receipt_id,
      });
    }
    expect(
      (await review(ACHIEVEMENT, "owner", { action: "reject" })).status,
    ).toBe(200);
    expect(asked.at(-1)?.note).toBeNull();
  });

  test("asks for achievement.review on the achievement's agent", async () => {
    recorded.length = 0;
    await review(ACHIEVEMENT, "admin", { action: "reject" });
    expect(recorded).toEqual([
      expect.objectContaining({
        action: "achievement.review",
        resource: { kind: "agent", id: AGENT, owner_scope: WORKSPACE },
      }),
    ]);
  });

  test("a member reviews only as the agent's admin; an API key never; no login 401", async () => {
    expect(
      (await review(ACHIEVEMENT, "member", { action: "reject" })).status,
    ).toBe(403);
    expect(
      (await review(ACHIEVEMENT, "key", { action: "reject" })).status,
    ).toBe(403);
    expect((await review(ACHIEVEMENT, null, { action: "reject" })).status).toBe(
      401,
    );
    expect(asked).toEqual([]);
    agentAdmin = true;
    expect(
      (await review(ACHIEVEMENT, "member", { action: "reject" })).status,
    ).toBe(200);
    expect(asked).toHaveLength(1);
  });

  test("an unknown achievement or an unseen session is 404 and nothing is written", async () => {
    expect(
      (
        await review("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "owner", {
          action: "confirm",
        })
      ).status,
    ).toBe(404);
    expect(
      (await review("not-a-uuid", "owner", { action: "confirm" })).status,
    ).toBe(404);
    visible = false;
    agentAdmin = true;
    expect(
      (await review(ACHIEVEMENT, "member", { action: "confirm" })).status,
    ).toBe(404);
    expect(asked).toEqual([]);
  });

  test("a decided achievement is 409 not_reviewable; a lost role 403; a gone row 404; an outage 503", async () => {
    outcome = "not_reviewable";
    const conflict = await review(ACHIEVEMENT, "owner", {
      action: "confirm",
    });
    expect(conflict.status).toBe(409);
    const body = apiErrorResponseSchema.parse(await conflict.json());
    expect(body.error.code).toBe("REVISION_CONFLICT");
    expect(body.error.details).toEqual({ reason_code: "not_reviewable" });
    outcome = "actor_inactive";
    expect(
      (await review(ACHIEVEMENT, "owner", { action: "reject" })).status,
    ).toBe(403);
    outcome = "not_found";
    expect(
      (await review(ACHIEVEMENT, "owner", { action: "reject" })).status,
    ).toBe(404);
    expect((await review(DOWN, "owner", { action: "reject" })).status).toBe(
      503,
    );
  });

  test("an action other than confirm or reject, an empty or long note, or another field is 400; an oversized body 413", async () => {
    expect(
      (
        await review(ACHIEVEMENT, "owner", {
          action: "confirm",
          note: "x".repeat(REQUEST_BODY_MAX_BYTES),
        })
      ).status,
    ).toBe(413);
    for (const body of [
      {},
      { action: "approve" },
      { decision: "confirm" },
      { action: "confirm", note: "" },
      { action: "confirm", note: "x".repeat(501) },
      { action: "confirm", review_state: "confirmed" },
    ]) {
      expect((await review(ACHIEVEMENT, "owner", body)).status).toBe(400);
    }
    expect(asked).toEqual([]);
  });
});

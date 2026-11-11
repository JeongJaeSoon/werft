import { expect, test } from "bun:test";
import {
  type AgentAccessSettings,
  type AuthorizationRequest,
  agentAccessResponseSchema,
  apiErrorResponseSchema,
  auditRetentionResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  REQUEST_BODY_MAX_BYTES,
  slackGuestResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  type AgentAccessSettingStore,
  type AuditRetentionStore,
  createAuthorizationPolicy,
  type DecisionLog,
  type IdentityStore,
  type MembershipRole,
  type ResolvedWebSession,
  type SlackGuestSettingStore,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../../auth.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerWorkspaceRoutes } from "./workspaces.ts";

const createApiApp = recordRouteErrors("routes/musterrolle/workspaces.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";
const RECEIPT = "019a0000-0000-7000-8000-0000000000e1";

const sessions = new Map<string, ResolvedWebSession>();
function cookieFor(role: MembershipRole, workspaceId = WORKSPACE): string {
  const token = generateWebSessionToken();
  sessions.set(Buffer.from(hashWebSessionToken(token)).toString("hex"), {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
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

const recorded: AuthorizationRequest[] = [];
const decisions: DecisionLog = {
  async record({ request }) {
    recorded.push(request);
  },
};
const stored = new Map<string, number>([[WORKSPACE, 90]]);
let storageDown = false;
const retention: AuditRetentionStore = {
  async setAuditRetentionDays({ workspaceId, days }) {
    if (storageDown) {
      throw Object.assign(new Error("connection refused"), {
        code: "ECONNREFUSED",
      });
    }
    if (!stored.has(workspaceId)) return false;
    stored.set(workspaceId, days);
    return true;
  },
};

const guests = new Map<string, boolean>([[WORKSPACE, false]]);
const slackGuests: SlackGuestSettingStore = {
  async setSlackGuestEnabled({ workspaceId, enabled }) {
    if (storageDown) {
      throw Object.assign(new Error("connection refused"), {
        code: "ECONNREFUSED",
      });
    }
    if (!guests.has(workspaceId)) return false;
    guests.set(workspaceId, enabled);
    return true;
  },
};

const access = new Map<string, AgentAccessSettings>([
  [
    WORKSPACE,
    {
      agent_outsider_access: "use",
      agent_outsider_session_visibility: "managing_team",
    },
  ],
]);
const accessWrites: Parameters<AgentAccessSettingStore["setAgentAccess"]>[0][] =
  [];
const agentAccess: AgentAccessSettingStore = {
  async setAgentAccess(input) {
    if (storageDown) {
      throw Object.assign(new Error("connection refused"), {
        code: "ECONNREFUSED",
      });
    }
    accessWrites.push(input);
    const before = access.get(input.workspaceId);
    if (!before) return { outcome: "inactive" };
    const after = { ...before };
    for (const [key, value] of Object.entries(input.settings)) {
      if (value !== undefined) Object.assign(after, { [key]: value });
    }
    access.set(input.workspaceId, after);
    return {
      outcome:
        JSON.stringify(after) === JSON.stringify(before) ? "unchanged" : "set",
      settings: after,
    };
  },
};

const app = createApiApp({
  authMode: "api-key",
  identity,
  registerRoutes: (router) =>
    registerWorkspaceRoutes(router, {
      authorization: createAuthorizationPolicy({ decisions }),
      retention,
      slackGuests,
      agentAccess,
      newId: () => RECEIPT,
    }),
});

function setRetention(cookie: string, days: unknown, workspaceId = WORKSPACE) {
  return app.request(`/v1/workspaces/${workspaceId}/audit-retention`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ audit_retention_days: days }),
  });
}

async function errorCode(response: Response): Promise<string> {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

test("an owner sets the retention and the change is recorded", async () => {
  recorded.length = 0;
  const response = await setRetention(cookieFor("owner"), 30);
  expect(response.status).toBe(200);
  expect(auditRetentionResponseSchema.parse(await response.json())).toEqual({
    audit_retention_days: 30,
  });
  expect(stored.get(WORKSPACE)).toBe(30);
  expect(recorded).toEqual([
    expect.objectContaining({
      action: "audit_retention.manage",
      resource: { kind: "workspace", id: WORKSPACE, owner_scope: WORKSPACE },
      request_id: response.headers.get("X-Request-Id"),
    }),
  ]);
});

test("a member is refused, the setting is untouched, and the refusal is recorded", async () => {
  stored.set(WORKSPACE, 90);
  recorded.length = 0;
  const response = await setRetention(cookieFor("member"), 60);
  expect(response.status).toBe(403);
  expect(await errorCode(response)).toBe("FORBIDDEN");
  expect(stored.get(WORKSPACE)).toBe(90);
  expect(recorded).toHaveLength(1);
});

test("a member is refused before the body is read, malformed or not", async () => {
  recorded.length = 0;
  const response = await app.request(
    `/v1/workspaces/${WORKSPACE}/audit-retention`,
    {
      method: "POST",
      headers: {
        Cookie: cookieFor("member"),
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
        "Content-Type": "application/json",
      },
      body: "not json",
    },
  );
  expect(response.status).toBe(403);
  expect(recorded).toHaveLength(1);
});

test("fewer than 30 days is refused, even for an owner", async () => {
  stored.set(WORKSPACE, 90);
  for (const days of [29, 0, -1, 30.5, "45"]) {
    const response = await setRetention(cookieFor("owner"), days);
    expect(response.status, String(days)).toBe(400);
  }
  expect(stored.get(WORKSPACE)).toBe(90);
});

test("an uppercase id names the same workspace", async () => {
  const response = await setRetention(
    cookieFor("owner"),
    60,
    WORKSPACE.toUpperCase(),
  );
  expect(response.status).toBe(200);
  expect(stored.get(WORKSPACE)).toBe(60);
});

test("another workspace, an unknown one or a malformed id does not exist", async () => {
  const owner = cookieFor("owner");
  for (const id of [OTHER_WORKSPACE, "not-a-uuid"]) {
    const response = await setRetention(owner, 45, id);
    expect(response.status, id).toBe(404);
  }
  const orphan = cookieFor("owner", OTHER_WORKSPACE);
  expect((await setRetention(orphan, 45, OTHER_WORKSPACE)).status).toBe(404);
});

test("an oversized body is refused", async () => {
  const response = await setRetention(
    cookieFor("owner"),
    "9".repeat(REQUEST_BODY_MAX_BYTES),
  );
  expect(response.status).toBe(413);
});

test("a storage outage answers 503", async () => {
  storageDown = true;
  try {
    const response = await setRetention(cookieFor("owner"), 45);
    expect(response.status).toBe(503);
  } finally {
    storageDown = false;
  }
});

function setSlackGuest(
  cookie: string | null,
  body: unknown,
  workspaceId = WORKSPACE,
) {
  return app.request(`/v1/workspaces/${workspaceId}/slack-guest`, {
    method: "POST",
    headers: {
      ...(cookie === null ? {} : { Cookie: cookie }),
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      "Content-Type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("an owner or admin turns Slack guests on and off, and each change is recorded", async () => {
  for (const [role, enabled] of [
    ["owner", true],
    ["admin", false],
  ] as const) {
    recorded.length = 0;
    const response = await setSlackGuest(cookieFor(role), {
      slack_guest_enabled: enabled,
    });
    expect(response.status, role).toBe(200);
    expect(slackGuestResponseSchema.parse(await response.json())).toEqual({
      slack_guest_enabled: enabled,
    });
    expect(guests.get(WORKSPACE)).toBe(enabled);
    expect(recorded).toEqual([
      expect.objectContaining({
        action: "workspace.manage",
        resource: { kind: "workspace", id: WORKSPACE, owner_scope: WORKSPACE },
      }),
    ]);
  }
});

test("a member is refused for the role before the body is read", async () => {
  guests.set(WORKSPACE, false);
  for (const body of [{ slack_guest_enabled: true }, "not json"]) {
    const response = await setSlackGuest(cookieFor("member"), body);
    expect(response.status).toBe(403);
    expect(
      apiErrorResponseSchema.parse(await response.json()).error,
    ).toMatchObject({ code: "FORBIDDEN", details: { reason_code: "role" } });
  }
  expect(guests.get(WORKSPACE)).toBe(false);
});

test("the Slack guest setting takes a boolean and nothing else", async () => {
  for (const body of [
    { slack_guest_enabled: "true" },
    {},
    { slack_guest_enabled: true, extra: 1 },
  ]) {
    const response = await setSlackGuest(cookieFor("owner"), body);
    expect(response.status, JSON.stringify(body)).toBe(400);
  }
  expect(
    (
      await setSlackGuest(
        cookieFor("owner"),
        `{"slack_guest_enabled":${" ".repeat(REQUEST_BODY_MAX_BYTES)}true}`,
      )
    ).status,
  ).toBe(413);
});

test("the Slack guest setting needs a session and a workspace that is the caller's", async () => {
  const body = { slack_guest_enabled: true };
  expect((await setSlackGuest(null, body)).status).toBe(401);
  expect(
    (await setSlackGuest(cookieFor("owner"), body, OTHER_WORKSPACE)).status,
  ).toBe(404);
  const orphan = cookieFor("owner", OTHER_WORKSPACE);
  expect((await setSlackGuest(orphan, body, OTHER_WORKSPACE)).status).toBe(404);
  storageDown = true;
  try {
    expect((await setSlackGuest(cookieFor("owner"), body)).status).toBe(503);
  } finally {
    storageDown = false;
  }
});

function setAgentAccess(
  cookie: string | null,
  body: unknown,
  workspaceId = WORKSPACE,
) {
  return app.request(`/v1/workspaces/${workspaceId}/agent-access`, {
    method: "PATCH",
    headers: {
      ...(cookie === null ? {} : { Cookie: cookie }),
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      "Content-Type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("an owner or admin changes one axis, the other keeps its value, and the change carries its receipt", async () => {
  access.set(WORKSPACE, {
    agent_outsider_access: "use",
    agent_outsider_session_visibility: "managing_team",
  });
  recorded.length = 0;
  accessWrites.length = 0;
  const owner = cookieFor("owner");
  const response = await setAgentAccess(owner, {
    agent_outsider_access: "view",
  });
  expect(response.status).toBe(200);
  expect(agentAccessResponseSchema.parse(await response.json())).toEqual({
    agent_outsider_access: "view",
    agent_outsider_session_visibility: "managing_team",
    receipt_id: RECEIPT,
  });
  expect(accessWrites).toEqual([
    expect.objectContaining({
      workspaceId: WORKSPACE,
      settings: { agent_outsider_access: "view" },
      receiptId: RECEIPT,
    }),
  ]);
  expect(recorded).toEqual([
    expect.objectContaining({
      action: "workspace.manage",
      resource: { kind: "workspace", id: WORKSPACE, owner_scope: WORKSPACE },
    }),
  ]);
  const admin = await setAgentAccess(cookieFor("admin"), {
    agent_outsider_session_visibility: "workspace",
  });
  expect(agentAccessResponseSchema.parse(await admin.json())).toEqual({
    agent_outsider_access: "view",
    agent_outsider_session_visibility: "workspace",
    receipt_id: RECEIPT,
  });
});

test("asking for the values already set answers them with no receipt", async () => {
  access.set(WORKSPACE, {
    agent_outsider_access: "none",
    agent_outsider_session_visibility: "managing_team",
  });
  const response = await setAgentAccess(cookieFor("owner"), {
    agent_outsider_access: "none",
    agent_outsider_session_visibility: "managing_team",
  });
  expect(response.status).toBe(200);
  expect(agentAccessResponseSchema.parse(await response.json())).toEqual({
    agent_outsider_access: "none",
    agent_outsider_session_visibility: "managing_team",
    receipt_id: null,
  });
});

test("a member is refused agent access for the role before the body is read", async () => {
  accessWrites.length = 0;
  for (const body of [{ agent_outsider_access: "none" }, "not json"]) {
    const response = await setAgentAccess(cookieFor("member"), body);
    expect(response.status).toBe(403);
    expect(
      apiErrorResponseSchema.parse(await response.json()).error,
    ).toMatchObject({ code: "FORBIDDEN", details: { reason_code: "role" } });
  }
  expect(accessWrites).toEqual([]);
});

test("agent access takes the documented values, at least one, and nothing else", async () => {
  accessWrites.length = 0;
  for (const body of [
    {},
    { agent_outsider_access: "hidden" },
    { agent_outsider_access: null },
    { agent_outsider_session_visibility: "team" },
    { agent_outsider_access: "use", extra: 1 },
  ]) {
    const response = await setAgentAccess(cookieFor("owner"), body);
    expect(response.status, JSON.stringify(body)).toBe(400);
  }
  expect(accessWrites).toEqual([]);
  expect(
    (
      await setAgentAccess(
        cookieFor("owner"),
        `{"agent_outsider_access":${" ".repeat(REQUEST_BODY_MAX_BYTES)}"use"}`,
      )
    ).status,
  ).toBe(413);
});

test("agent access needs a session and a workspace that is the caller's", async () => {
  const body = { agent_outsider_access: "view" };
  expect((await setAgentAccess(null, body)).status).toBe(401);
  expect(
    (await setAgentAccess(cookieFor("owner"), body, OTHER_WORKSPACE)).status,
  ).toBe(404);
  const orphan = cookieFor("owner", OTHER_WORKSPACE);
  expect((await setAgentAccess(orphan, body, OTHER_WORKSPACE)).status).toBe(
    404,
  );
  storageDown = true;
  try {
    expect((await setAgentAccess(cookieFor("owner"), body)).status).toBe(503);
  } finally {
    storageDown = false;
  }
});

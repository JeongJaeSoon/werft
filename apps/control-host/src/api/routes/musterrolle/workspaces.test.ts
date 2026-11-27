import { expect, test } from "bun:test";
import {
  type AuthorizationRequest,
  apiErrorResponseSchema,
  auditRetentionResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  REQUEST_BODY_MAX_BYTES,
  slackGuestResponseSchema,
  webFetchPreflightResponseSchema,
} from "@werft-ai/contracts";
import {
  type AuditRetentionStore,
  createAuthorizationPolicy,
  type DecisionLog,
  type Principal,
  type SlackGuestSettingStore,
  type WebFetchPreflightSettingStore,
} from "@werft-ai/platform";
import { fakeWebSessions } from "../../../testing/web-session.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerWorkspaceRoutes } from "./workspaces.ts";

const createApiApp = recordRouteErrors("routes/musterrolle/workspaces.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";
const OTHER_WORKSPACE = "019a0000-0000-7000-8000-0000000000b1";

const { cookieFor, identity } = fakeWebSessions(WORKSPACE);

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

const preflight = new Map<string, boolean>([[WORKSPACE, true]]);
const preflightWrites: { principal: Principal; actorUserId: string }[] = [];
const PREFLIGHT_RECEIPT = "019a0000-0000-7000-8000-00000000f001";
const webFetchPreflight: WebFetchPreflightSettingStore = {
  async setWebFetchPreflight({ workspaceId, actorUserId, principal, enabled }) {
    if (storageDown) {
      throw Object.assign(new Error("connection refused"), {
        code: "ECONNREFUSED",
      });
    }
    if (!preflight.has(workspaceId)) return null;
    preflight.set(workspaceId, enabled);
    preflightWrites.push({ principal, actorUserId });
    return PREFLIGHT_RECEIPT;
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
      webFetchPreflight,
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
  const orphan = cookieFor("owner", { workspaceId: OTHER_WORKSPACE });
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
  const orphan = cookieFor("owner", { workspaceId: OTHER_WORKSPACE });
  expect((await setSlackGuest(orphan, body, OTHER_WORKSPACE)).status).toBe(404);
  storageDown = true;
  try {
    expect((await setSlackGuest(cookieFor("owner"), body)).status).toBe(503);
  } finally {
    storageDown = false;
  }
});

function setWebFetchPreflight(
  cookie: string | null,
  body: unknown,
  workspaceId = WORKSPACE,
) {
  return app.request(`/v1/workspaces/${workspaceId}/web-fetch-preflight`, {
    method: "POST",
    headers: {
      ...(cookie === null ? {} : { Cookie: cookie }),
      [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      "Content-Type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("an owner or admin turns the WebFetch host check off and on, with the receipt of each change", async () => {
  for (const [role, enabled] of [
    ["owner", false],
    ["admin", true],
  ] as const) {
    recorded.length = 0;
    preflightWrites.length = 0;
    const response = await setWebFetchPreflight(cookieFor(role), {
      web_fetch_preflight: enabled,
    });
    expect(response.status, role).toBe(200);
    expect(
      webFetchPreflightResponseSchema.parse(await response.json()),
    ).toEqual({ web_fetch_preflight: enabled, receipt_id: PREFLIGHT_RECEIPT });
    expect(preflight.get(WORKSPACE)).toBe(enabled);
    expect(recorded).toEqual([
      expect.objectContaining({
        action: "workspace.manage",
        resource: { kind: "workspace", id: WORKSPACE, owner_scope: WORKSPACE },
      }),
    ]);
    // The receipt names the person who changed it.
    expect(preflightWrites).toEqual([
      {
        actorUserId: expect.any(String),
        principal: expect.objectContaining({
          actor: expect.objectContaining({
            userId: preflightWrites[0]?.actorUserId,
          }),
        }),
      },
    ]);
  }
});

test("a member is refused the WebFetch host check before the body is read", async () => {
  preflight.set(WORKSPACE, true);
  for (const body of [{ web_fetch_preflight: false }, "not json"]) {
    const response = await setWebFetchPreflight(cookieFor("member"), body);
    expect(response.status).toBe(403);
    expect(
      apiErrorResponseSchema.parse(await response.json()).error,
    ).toMatchObject({ code: "FORBIDDEN", details: { reason_code: "role" } });
  }
  expect(preflight.get(WORKSPACE)).toBe(true);
});

test("the WebFetch host check takes a boolean and nothing else", async () => {
  for (const body of [
    { web_fetch_preflight: "false" },
    {},
    { web_fetch_preflight: false, extra: 1 },
  ]) {
    const response = await setWebFetchPreflight(cookieFor("owner"), body);
    expect(response.status, JSON.stringify(body)).toBe(400);
  }
  expect(
    (
      await setWebFetchPreflight(
        cookieFor("owner"),
        `{"web_fetch_preflight":${" ".repeat(REQUEST_BODY_MAX_BYTES)}false}`,
      )
    ).status,
  ).toBe(413);
  expect(preflight.get(WORKSPACE)).toBe(true);
});

test("the WebFetch host check needs a session and a workspace that is the caller's", async () => {
  const body = { web_fetch_preflight: false };
  expect((await setWebFetchPreflight(null, body)).status).toBe(401);
  expect(
    (await setWebFetchPreflight(cookieFor("owner"), body, OTHER_WORKSPACE))
      .status,
  ).toBe(404);
  const orphan = cookieFor("owner", { workspaceId: OTHER_WORKSPACE });
  expect(
    (await setWebFetchPreflight(orphan, body, OTHER_WORKSPACE)).status,
  ).toBe(404);
  storageDown = true;
  try {
    expect((await setWebFetchPreflight(cookieFor("owner"), body)).status).toBe(
      503,
    );
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

test("agent access is no longer a setting: an owner's change finds no route", async () => {
  recorded.length = 0;
  const response = await setAgentAccess(cookieFor("owner"), {
    agent_outsider_access: "use",
  });
  expect(response.status).toBe(404);
  expect(recorded).toEqual([]);
});

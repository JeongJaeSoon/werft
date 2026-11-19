import { afterEach, expect, test } from "bun:test";
import {
  AUDIT_EXPORT_MEDIA_TYPE,
  type AuditEvent,
  type AuthorizationDecision,
  type AuthorizationRequest,
  apiErrorResponseSchema,
  auditExportEndSchema,
  auditExportRowSchema,
  listAuditEventsResponseSchema,
  WEB_SESSION_COOKIE_NAME,
} from "@werft-ai/contracts";
import {
  type AuditLogReader,
  type AuthorizationPolicy,
  createAuditLogService,
  createAuthorizationPolicy,
  type IdentityStore,
  InvalidCursorError,
  type MembershipRole,
  type ResolvedWebSession,
} from "@werft-ai/platform";
import { generateWebSessionToken, hashWebSessionToken } from "../../auth.ts";
import { hashApiKey } from "../../keys.ts";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import {
  type AuditLogRouteOptions,
  registerAuditLogRoutes,
} from "./audit-log.ts";

const createApiApp = recordRouteErrors("routes/musterrolle/audit-log.test.ts");

const WORKSPACE = "019a0000-0000-7000-8000-0000000000a1";

const sessions = new Map<string, ResolvedWebSession>();
function signIn(role: MembershipRole) {
  const token = generateWebSessionToken();
  const key = Buffer.from(hashWebSessionToken(token)).toString("hex");
  sessions.set(key, {
    sessionId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    email: `${role}@example.com`,
    displayName: role,
    locale: null,
    workspaceId: WORKSPACE,
    role,
    expiresAt: new Date(Date.now() + 60_000),
  });
  return {
    cookie: `${WEB_SESSION_COOKIE_NAME}=${token}`,
    signOut: () => sessions.delete(key),
    demote: () => {
      const session = sessions.get(key);
      if (session) sessions.set(key, { ...session, role: "admin" });
    },
  };
}

const identity = {
  async resolveWebSession(tokenHash: Uint8Array) {
    return sessions.get(Buffer.from(tokenHash).toString("hex")) ?? null;
  },
  async renewWebSession() {
    return null;
  },
} as unknown as IdentityStore;

const KEY = `csp_${crypto.randomUUID()}`;
const keyStore = {
  async find(candidate: Uint8Array) {
    if (!Buffer.from(hashApiKey(KEY)).equals(Buffer.from(candidate)))
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

const recorded: {
  request: AuthorizationRequest;
  decision: AuthorizationDecision;
}[] = [];
const policy = createAuthorizationPolicy({
  decisions: {
    async record(entry) {
      recorded.push(entry);
    },
  },
});

function row(index: number): AuditEvent {
  return {
    kind: index % 2 === 0 ? "decision" : "receipt",
    id: crypto.randomUUID(),
    at: new Date(Date.UTC(2026, 10, 20) - index * 1000)
      .toISOString()
      .replace("Z", "000Z"),
    request_id: `req-${index}`,
    actor: {
      principal_kind: "user",
      principal_id: null,
      user_id: null,
      agent_id: null,
    },
    action: "member.manage",
    target: { kind: "workspace", id: WORKSPACE },
    outcome: "deny",
    reason_code: "role",
    surface: "web",
  };
}

type Hooks = {
  rows?: number;
  onPage?: (call: number) => Promise<void> | void;
  fail?: unknown;
};

// Pages over `rows` rows; the cursor is the next row's index.
function readerWith(hooks: Hooks): AuditLogReader & { calls: number } {
  const all = Array.from({ length: hooks.rows ?? 3 }, (_, i) => row(i));
  const reader = {
    calls: 0,
    async page(
      _ownerId: string,
      _filter: unknown,
      cursor: string | undefined,
      limit: number,
    ) {
      reader.calls += 1;
      await hooks.onPage?.(reader.calls);
      if (hooks.fail) throw hooks.fail;
      if (cursor !== undefined && !/^\d+$/.test(cursor)) {
        throw new InvalidCursorError();
      }
      const start = cursor === undefined ? 0 : Number(cursor);
      const items = all.slice(start, start + limit);
      const end = start + items.length;
      return {
        items,
        next_cursor: end < all.length ? String(end) : null,
        retention_start: "2026-08-22T00:00:00.000000Z",
        cursors: items.map((_, i) => String(start + i + 1)),
      };
    },
  };
  return reader;
}

function appWith(
  hooks: Hooks = {},
  options: AuditLogRouteOptions = {},
  authorization: AuthorizationPolicy = policy,
) {
  const reader = readerWith(hooks);
  const app = createApiApp({
    authMode: "api-key",
    identity,
    keyStore,
    registerRoutes: (router) =>
      registerAuditLogRoutes(
        router,
        createAuditLogService({ authorization, reader }),
        options,
      ),
  });
  return { app, reader };
}

function get(
  app: ReturnType<typeof appWith>["app"],
  auth: { cookie?: string; key?: string },
  query = "",
  accept?: string,
) {
  return app.request(`/v1/audit/events${query}`, {
    headers: {
      ...(auth.cookie ? { Cookie: auth.cookie } : {}),
      ...(auth.key ? { Authorization: `Bearer ${auth.key}` } : {}),
      ...(accept ? { Accept: accept } : {}),
    },
  });
}

// Whatever arrived before the stream ended or was cut.
async function lines(response: Response): Promise<unknown[]> {
  const reader = response.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {}
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

async function errorCode(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

const auditReads = () =>
  recorded.filter((entry) => entry.request.action === "audit_log.read");

afterEach(() => {
  recorded.length = 0;
});

test("an owner reads a page, and the read is on record as an allow", async () => {
  const { app } = appWith({ rows: 3 });
  const response = await get(app, signIn("owner"), "?limit=2");
  expect(response.status).toBe(200);
  const page = listAuditEventsResponseSchema.parse(await response.json());
  expect(page.items).toHaveLength(2);
  expect(page.next_cursor).toBe("2");
  expect(page).not.toHaveProperty("cursors");
  expect(auditReads()).toEqual([
    expect.objectContaining({
      request: expect.objectContaining({
        resource: { kind: "workspace", id: WORKSPACE, owner_scope: WORKSPACE },
        request_id: response.headers.get("X-Request-Id"),
      }),
      decision: expect.objectContaining({ outcome: "allow" }),
    }),
  ]);
});

for (const role of ["admin", "member"] as const) {
  test(`${role} is refused, nothing is read, and the refusal is on record`, async () => {
    const { app, reader } = appWith();
    const response = await get(app, signIn(role));
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("FORBIDDEN");
    expect(reader.calls).toBe(0);
    expect(auditReads()).toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({
          outcome: "deny",
          reason_code: "role",
        }),
      }),
    ]);
  });
}

test("an API key is refused whatever its scopes, and the refusal is on record", async () => {
  const { app, reader } = appWith();
  for (const accept of [undefined, AUDIT_EXPORT_MEDIA_TYPE]) {
    recorded.length = 0;
    const response = await get(app, { key: KEY }, "", accept);
    expect(response.status).toBe(403);
    expect(auditReads()).toEqual([
      expect.objectContaining({
        decision: expect.objectContaining({ outcome: "deny" }),
      }),
    ]);
  }
  expect(reader.calls).toBe(0);
});

test("no credential is 401, a bad query or cursor 400, a storage outage 503", async () => {
  const { app } = appWith();
  expect((await get(app, {})).status).toBe(401);
  const owner = signIn("owner");
  for (const query of [
    "?limit=0",
    "?limit=201",
    "?kind=other",
    "?from=yesterday",
  ]) {
    expect((await get(app, owner, query)).status, query).toBe(400);
  }
  expect((await get(app, owner, "?cursor=forged")).status).toBe(400);
  const down = appWith({
    fail: Object.assign(new Error("connection refused"), {
      code: "ECONNREFUSED",
    }),
  });
  expect((await get(down.app, owner)).status).toBe(503);
  expect((await get(down.app, owner, "", AUDIT_EXPORT_MEDIA_TYPE)).status).toBe(
    503,
  );
});

test("an export streams every row with its cursor, then the end line, recorded once", async () => {
  const { app, reader } = appWith({ rows: 7 }, { pageRows: 3 });
  const response = await get(
    app,
    signIn("owner"),
    "?limit=1",
    AUDIT_EXPORT_MEDIA_TYPE,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe(AUDIT_EXPORT_MEDIA_TYPE);
  const body = await lines(response);
  expect(
    body.slice(0, -1).map((line) => auditExportRowSchema.parse(line).cursor),
  ).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  expect(auditExportEndSchema.parse(body.at(-1))).toEqual({
    kind: "end",
    rows: 7,
    truncated: false,
    next_cursor: null,
  });
  expect(reader.calls).toBe(3);
  expect(auditReads()).toHaveLength(1);
});

test("an export stops at its row cap and says where to continue", async () => {
  const { app } = appWith({ rows: 12 }, { pageRows: 2, maxRows: 5 });
  const body = await lines(
    await get(app, signIn("owner"), "?cursor=1", AUDIT_EXPORT_MEDIA_TYPE),
  );
  expect(body).toHaveLength(6);
  expect(auditExportEndSchema.parse(body.at(-1))).toEqual({
    kind: "end",
    rows: 5,
    truncated: true,
    next_cursor: "6",
  });
});

test("a second export of the workspace while one runs is 429", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { app } = appWith(
    { rows: 4, onPage: (call) => (call === 2 ? held : undefined) },
    { pageRows: 2 },
  );
  const owner = signIn("owner");
  const first = await get(app, owner, "", AUDIT_EXPORT_MEDIA_TYPE);
  expect(first.status).toBe(200);
  const second = await get(app, owner, "", AUDIT_EXPORT_MEDIA_TYPE);
  expect(second.status).toBe(429);
  expect(second.headers.get("Retry-After")).toBe("60");
  // A refused caller is still refused, and on record, while one runs.
  recorded.length = 0;
  const member = await get(app, signIn("member"), "", AUDIT_EXPORT_MEDIA_TYPE);
  expect(member.status).toBe(403);
  expect(auditReads()).toEqual([
    expect.objectContaining({
      decision: expect.objectContaining({ outcome: "deny" }),
    }),
  ]);
  release();
  expect(auditExportEndSchema.parse((await lines(first)).at(-1)).rows).toBe(4);
  // The slot is free again once the first export ends.
  expect((await get(app, owner, "", AUDIT_EXPORT_MEDIA_TYPE)).status).toBe(200);
});

test("an owner demoted mid-export gets no more rows and no end line", async () => {
  let demoted = false;
  const authorization: AuthorizationPolicy = {
    async authorize(request, options) {
      const decision = await policy.authorize(request, options);
      return demoted && options?.record === false
        ? { ...decision, outcome: "deny", reason_code: "role" }
        : decision;
    },
  };
  const { app } = appWith(
    {
      rows: 6,
      onPage: () => {
        demoted = true;
      },
    },
    { pageRows: 2 },
    authorization,
  );
  const body = await lines(
    await get(app, signIn("owner"), "", AUDIT_EXPORT_MEDIA_TYPE),
  );
  expect(body).toHaveLength(2);
  expect(body.some((line) => (line as { kind: string }).kind === "end")).toBe(
    false,
  );
});

test("signing out or losing the role mid-export ends it without the end line", async () => {
  for (const change of ["sign_out", "role"] as const) {
    const owner = signIn("owner");
    const { app } = appWith(
      {
        rows: 6,
        onPage: async (call) => {
          if (call !== 2) return;
          if (change === "sign_out") owner.signOut();
          else owner.demote();
          await Bun.sleep(80);
        },
      },
      { pageRows: 2, checkMs: 20 },
    );
    const body = await lines(
      await get(app, owner, "", AUDIT_EXPORT_MEDIA_TYPE),
    );
    expect(body.length, change).toBeLessThan(6);
    expect(
      body.some((line) => (line as { kind: string }).kind === "end"),
      change,
    ).toBe(false);
  }
});

test("an export past its time limit ends without the end line", async () => {
  const { app } = appWith(
    { rows: 6, onPage: (call) => (call > 1 ? Bun.sleep(60) : undefined) },
    { pageRows: 2, maxMs: 30 },
  );
  const body = await lines(
    await get(app, signIn("owner"), "", AUDIT_EXPORT_MEDIA_TYPE),
  );
  expect(body).toHaveLength(2);
});

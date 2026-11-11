import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  auditReadResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  countSessionsResponseSchema,
  createSessionResponseSchema,
  listAdminSessionsResponseSchema,
  listSessionsResponseSchema,
  type SessionShareScope,
  setSessionShareResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  authzDecisions,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresDecisionLog,
  createPostgresInviteStore,
  createPostgresMemberStore,
  createPostgresPendingRequests,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionShareStore,
  createPostgresSessionUnitOfWork,
  createPostgresTurnInterrupts,
  createPostgresUsageReader,
  memberships,
  memberTeamMembers,
  memberTeams,
  receipts,
  sessions,
  users,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  type Caller,
  callerFor,
  createAuthorizationPolicy,
  createInterruptService,
  createInviteService,
  createMemberService,
  createPendingRequestService,
  createSessionService,
  createSessionShareService,
  createUsageService,
  type SessionCatalog,
  withSeededInstallation,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerMemberRoutes } from "./routes/musterrolle/members.ts";
import { registerSessionShareRoutes } from "./routes/musterrolle/session-shares.ts";
import { registerEventRoutes } from "./routes/sessions/events.ts";
import { registerInterruptRoutes } from "./routes/sessions/interrupt.ts";
import { registerPauseRoutes } from "./routes/sessions/pause.ts";
import { registerPendingRoutes } from "./routes/sessions/pending.ts";
import { registerReceiptRoutes } from "./routes/sessions/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerUsageRoutes } from "./routes/usage/usage.ts";
import { PostgresSessionNotifier } from "./session-notifier.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";
// Long enough that only the share change's NOTIFY can end a stream in time.
const KEEPALIVE_MS = 30_000;

const catalog: SessionCatalog = withSeededInstallation({
  profiles: {
    "claude-coding-v1": {
      runtime_kind: "claude_agent_sdk",
      runtime_version: "0.3.270",
      model: "claude-sonnet-5",
      tools: ["Read"],
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
    },
  },
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["claude-coding-v1"],
      auth: { kind: "github_app", registered: true } as const,
    },
  },
});

// Design 4.6 on every session surface: outside the share a session does not
// exist, owner and admin included.
integration("session share scopes over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  let notifier: PostgresSessionNotifier;
  const sink = new MemoryLogSink();

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_shares_api" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    const identity = new DatabaseIdentityStore(db);
    const logger = new StructuredLogger({ sinks: [sink] });
    const auth = {
      identity,
      bootstrap: createBootstrapGate(BOOTSTRAP_TOKEN),
      lockout: new LoginLockout(),
      logger,
    };
    const authorization = createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
      agents: createDatabaseAgentAuthority(db),
      sessions: createPostgresSessionShareStore(db),
      decisions: createPostgresDecisionLog(db),
    });
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization,
      inputs: createPostgresSessionUnitOfWork(db),
      controls: createPostgresSessionControl(db),
      reader: createPostgresSessionReader(db),
      catalog,
    });
    notifier = new PostgresSessionNotifier(database.url, logger);
    await notifier.start();
    app = createApiApp({
      authMode: "api-key",
      logger,
      keyStore: new DatabaseApiKeyStore(db),
      identity,
      authorization,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerSessionRoutes(router, service);
        registerPauseRoutes(router, service);
        registerReceiptRoutes(router, service);
        registerSessionShareRoutes(
          router,
          createSessionShareService({
            authorization,
            store: createPostgresSessionShareStore(db),
          }),
          service,
        );
        registerMemberRoutes(
          router,
          createMemberService({
            authorization,
            store: createPostgresMemberStore(db),
          }),
          createInviteService({
            authorization,
            store: createPostgresInviteStore(db),
          }),
        );
        registerUsageRoutes(
          router,
          createUsageService({
            authorization,
            reader: createPostgresUsageReader(db),
            limits: {
              executionSlotLimit: 10,
              queuedInputLimitPerSession: 1_000,
              storageLimitBytes: 1e15,
              maxTurnSeconds: 3600,
              sessionCostLimitUsd: 1_000,
              sessionTokenLimit: null,
              providerMaxRetries: 2,
            },
          }),
        );
        registerPendingRoutes(
          router,
          createPendingRequestService({
            authorization,
            store: createPostgresPendingRequests(db),
          }),
        );
        registerInterruptRoutes(
          router,
          createInterruptService({
            authorization,
            store: createPostgresTurnInterrupts(db),
          }),
        );
        registerEventRoutes(router, service, {
          wakeup: notifier,
          keepaliveMs: KEEPALIVE_MS,
          logger,
        });
      },
    });
  }, 60_000);

  afterAll(async () => {
    await notifier?.close();
    await pool?.end();
    await database?.drop();
  });

  const send = async (
    method: string,
    path: string,
    headers: HeadersInit,
    body?: unknown,
  ): Promise<Response> =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const asCookie = (cookie: string) => ({
    Cookie: cookie,
    [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
  });
  const codeOf = async (response: Response) =>
    apiErrorResponseSchema.parse(await response.json()).error;

  type Who = "owner" | "admin" | "creator" | "teammate" | "outsider";
  const cookies = {} as Record<Who, string>;
  const ids = {} as Record<Who, string>;
  let workspaceId = "";
  let teamId = "";
  let sessionId = "";
  let receiptId = "";

  async function login(email: string) {
    const response = await send(
      "POST",
      "/v1/auth/login",
      { "X-Requested-With": "werft-web" },
      { email, password: PASSWORD },
    );
    expect(response.status).toBe(200);
    return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  }

  async function addMember(who: Who, role: "admin" | "member") {
    const email = `${who}@example.com`;
    const [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email,
        passwordHash: await Bun.password.hash(PASSWORD, {
          algorithm: "argon2id",
        }),
        displayName: who,
      })
      .returning({ id: users.id });
    if (!user) throw new Error("no user");
    await db.insert(memberships).values({ workspaceId, userId: user.id, role });
    ids[who] = user.id;
    cookies[who] = await login(email);
  }

  function creator(): Caller {
    return callerFor(
      {
        kind: "user",
        id: ids.creator,
        workspace_id: workspaceId,
        role: "member",
        scopes: [
          "sessions:read",
          "sessions:write",
          "sessions:approve",
          "sessions:control",
        ],
      },
      { kind: "web" },
      crypto.randomUUID(),
    );
  }

  async function share(scope: SessionShareScope, teamIds: string[] = []) {
    const result = await createPostgresSessionShareStore(db).set({
      principal: creator(),
      ownerId: workspaceId,
      workspaceId,
      sessionId,
      scope,
      userIds: [],
      teamIds,
      updatedBy: ids.creator,
      receiptId: crypto.randomUUID(),
    });
    expect(result.outcome).toBe("changed");
  }

  const listed = async (who: Who, query = "") => {
    const response = await send(
      "GET",
      `/v1/sessions${query}`,
      asCookie(cookies[who]),
    );
    expect(response.status).toBe(200);
    return listSessionsResponseSchema
      .parse(await response.json())
      .items.map((item) => item.id);
  };

  const counted = async (who: Who, query = "") => {
    const response = await send(
      "GET",
      `/v1/sessions/counts${query}`,
      asCookie(cookies[who]),
    );
    expect(response.status).toBe(200);
    return countSessionsResponseSchema.parse(await response.json()).total;
  };

  // Every surface a session has, read or written.
  const surfaces: [string, (who: Who) => Promise<Response>][] = [
    [
      "detail",
      (who) => send("GET", `/v1/sessions/${sessionId}`, asCookie(cookies[who])),
    ],
    [
      "turns",
      (who) =>
        send("GET", `/v1/sessions/${sessionId}/turns`, asCookie(cookies[who])),
    ],
    [
      "turn",
      (who) =>
        send(
          "GET",
          `/v1/sessions/${sessionId}/turns/1`,
          asCookie(cookies[who]),
        ),
    ],
    [
      "events (SSE)",
      (who) =>
        send("GET", `/v1/sessions/${sessionId}/events`, asCookie(cookies[who])),
    ],
    [
      "usage",
      (who) =>
        send("GET", `/v1/sessions/${sessionId}/usage`, asCookie(cookies[who])),
    ],
    [
      "pending requests",
      (who) =>
        send(
          "GET",
          `/v1/sessions/${sessionId}/pending-requests`,
          asCookie(cookies[who]),
        ),
    ],
    [
      "receipt",
      (who) => send("GET", `/v1/receipts/${receiptId}`, asCookie(cookies[who])),
    ],
    [
      "message",
      (who) =>
        send(
          "POST",
          `/v1/sessions/${sessionId}/messages`,
          { ...asCookie(cookies[who]), "Idempotency-Key": crypto.randomUUID() },
          { message: "and the rest?" },
        ),
    ],
    [
      "approval",
      (who) =>
        send(
          "POST",
          `/v1/sessions/${sessionId}/answers`,
          { ...asCookie(cookies[who]), "Idempotency-Key": crypto.randomUUID() },
          { kind: "permission", request_id: "req_none", action: "allow" },
        ),
    ],
    [
      "rename",
      (who) =>
        send("PATCH", `/v1/sessions/${sessionId}`, asCookie(cookies[who]), {
          title: `named by ${who}`,
        }),
    ],
    [
      "interrupt",
      (who) =>
        send(
          "POST",
          `/v1/sessions/${sessionId}/interrupt`,
          { ...asCookie(cookies[who]), "Idempotency-Key": crypto.randomUUID() },
          { target_turn_id: "1" },
        ),
    ],
  ];

  // 94S-798: what each person is told about answering, and what an answer
  // gets. Past the policy the store finds no request "req_none" (404), so a
  // 404 here is a permitted answer and a 403 a refused one.
  async function answering(who: Who) {
    const list = await send(
      "GET",
      `/v1/sessions/${sessionId}/pending-requests`,
      asCookie(cookies[who]),
    );
    const listed =
      list.status === 200
        ? ((await list.json()) as { answerable: boolean }).answerable
        : list.status;
    const answer = await surfaces.find(([s]) => s === "approval")?.[1](who);
    if (!answer) throw new Error("no approval surface");
    const { code, details } = await codeOf(answer);
    const reason = (details as { reason_code?: string } | undefined)
      ?.reason_code;
    return { who, listed, answer: answer.status, code, reason } as {
      who: Who;
      listed: boolean | number;
      answer: number;
      code: string;
      reason: string | undefined;
    };
  }

  test("setup: owner, admin, the creator, a teammate in a team, an outsider; the creator's session", async () => {
    const boot = await send(
      "POST",
      "/v1/auth/bootstrap",
      {},
      {
        bootstrap_token: BOOTSTRAP_TOKEN,
        email: "owner@example.com",
        password: PASSWORD,
        display_name: "Owner",
        workspace_name: "Acme",
        workspace_slug: "acme",
      },
    );
    expect(boot.status).toBe(201);
    const booted = bootstrapResponseSchema.parse(await boot.json());
    workspaceId = booted.workspace.id;
    ids.owner = booted.user_id;
    cookies.owner = await login("owner@example.com");
    await addMember("admin", "admin");
    await addMember("creator", "member");
    await addMember("teammate", "member");
    await addMember("outsider", "member");
    teamId = crypto.randomUUID();
    await db
      .insert(memberTeams)
      .values({ id: teamId, workspaceId, name: "research" });
    await db.insert(memberTeamMembers).values({
      id: crypto.randomUUID(),
      workspaceId,
      teamId,
      userId: ids.teammate,
    });

    const created = await send(
      "POST",
      "/v1/sessions",
      { ...asCookie(cookies.creator), "Idempotency-Key": crypto.randomUUID() },
      {
        profile_id: "claude-coding-v1",
        repository_id: "sample-app",
        message: "Summarise the minutes.",
      },
    );
    expect(created.status).toBe(201);
    const body = createSessionResponseSchema.parse(await created.json());
    sessionId = body.session_id;
    receiptId = body.receipt_id;
  });

  test("a workspace-wide session is everyone's", async () => {
    for (const who of ["owner", "teammate", "outsider"] as const) {
      expect(await listed(who)).toContain(sessionId);
    }
  });

  test("the list and detail say who started it and that it came from the web; only its creator has started it", async () => {
    const detail = await send(
      "GET",
      `/v1/sessions/${sessionId}`,
      asCookie(cookies.outsider),
    );
    expect(await detail.json()).toMatchObject({
      agent: null,
      created_by: { user_id: ids.creator, display_name: "creator" },
      channel: "web",
    });
    expect(await listed("creator", "?relation=started")).toEqual([sessionId]);
    expect(await counted("creator", "?relation=started")).toBe(1);
    // Seen by the whole workspace, so under `all` and nowhere else.
    for (const relation of ["started", "shared", "administered"]) {
      expect(await listed("teammate", `?relation=${relation}`)).toEqual([]);
      expect(await counted("teammate", `?relation=${relation}`)).toBe(0);
    }
    expect(await counted("teammate")).toBe(1);
  });

  test("agent_id leaves out a session created without an agent, and must be an agent id", async () => {
    expect(await listed("creator")).toContain(sessionId);
    expect(await listed("creator", `?agent_id=${crypto.randomUUID()}`)).toEqual(
      [],
    );
    const bad = await send(
      "GET",
      "/v1/sessions?agent_id=not-an-agent",
      asCookie(cookies.creator),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });
  });

  test("everyone sees a workspace-wide session; only its creator, owner and admin answer it (94S-798)", async () => {
    const got = [];
    for (const who of [
      "owner",
      "admin",
      "creator",
      "teammate",
      "outsider",
    ] as const) {
      got.push(await answering(who));
    }
    const permitted = { listed: true, answer: 404, code: "NOT_FOUND" };
    const refused = {
      listed: false,
      answer: 403,
      code: "FORBIDDEN",
      reason: "role",
    };
    expect(got).toEqual([
      { who: "owner", ...permitted, reason: undefined },
      { who: "admin", ...permitted, reason: undefined },
      { who: "creator", ...permitted, reason: undefined },
      { who: "teammate", ...refused },
      { who: "outsider", ...refused },
    ]);
    const refusals = await db
      .select({ actor: authzDecisions.actorUserId })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.resourceId, sessionId),
          eq(authzDecisions.action, "session.approve"),
          eq(authzDecisions.reasonCode, "role"),
        ),
      );
    // The refused answers are kept; the lists that said so are not.
    expect(refusals.map((row) => row.actor).sort()).toEqual(
      [ids.teammate, ids.outsider].sort(),
    );
  });

  // 94S-804: renaming is answered as answering is.
  async function renaming(who: Who): Promise<{
    who: Who;
    status: number;
    title?: string | null;
    code?: string;
    details?: unknown;
  }> {
    const response = await surfaces.find(([s]) => s === "rename")?.[1](who);
    if (!response) throw new Error("no rename surface");
    if (response.status === 200) {
      const body = (await response.json()) as { title: string | null };
      return { who, status: 200, title: body.title };
    }
    const { code, details } = await codeOf(response);
    return { who, status: response.status, code, details };
  }

  test("everyone sees a workspace-wide session; only its creator, owner and admin rename it (94S-804)", async () => {
    const got = [];
    for (const who of [
      "owner",
      "admin",
      "creator",
      "teammate",
      "outsider",
    ] as const) {
      got.push(await renaming(who));
    }
    const refused = {
      status: 403,
      code: "FORBIDDEN",
      details: { reason_code: "role" },
    };
    expect(got).toEqual([
      { who: "owner", status: 200, title: "named by owner" },
      { who: "admin", status: 200, title: "named by admin" },
      { who: "creator", status: 200, title: "named by creator" },
      { who: "teammate", ...refused },
      { who: "outsider", ...refused },
    ]);
    const detail = await send(
      "GET",
      `/v1/sessions/${sessionId}`,
      asCookie(cookies.teammate),
    );
    expect(((await detail.json()) as { title: string }).title).toBe(
      "named by creator",
    );
  });

  test("a private session is the creator's on every surface; everyone else, owner and admin included, gets not_found", async () => {
    await share("private");
    expect(await listed("creator")).toContain(sessionId);
    expect(await listed("creator", "?status=queued")).toContain(sessionId);
    for (const who of ["owner", "admin", "teammate", "outsider"] as const) {
      expect(await listed(who)).not.toContain(sessionId);
      expect(await listed(who, "?status=queued")).not.toContain(sessionId);
      for (const [surface, call] of surfaces) {
        const response = await call(who);
        expect({ who, surface, status: response.status }).toEqual({
          who,
          surface,
          status: 404,
        });
        expect((await codeOf(response)).code).toBe("NOT_FOUND");
      }
    }
    const detail = await surfaces[0]?.[1]("creator");
    expect(detail?.status).toBe(200);
    // Each refusal is a kept decision, the approval's included.
    const refusals = await db
      .select({ action: authzDecisions.action })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.resourceId, sessionId),
          eq(authzDecisions.reasonCode, "not_found"),
          eq(authzDecisions.actorUserId, ids.owner),
        ),
      );
    expect(new Set(refusals.map((row) => row.action))).toEqual(
      new Set([
        "session.read",
        "session.submit",
        "session.approve",
        "session.rename",
        "session.control",
      ]),
    );
  });

  test("outside the share no filter or count shows a private session", async () => {
    for (const who of ["owner", "admin", "teammate", "outsider"] as const) {
      for (const query of [
        "",
        "?relation=shared",
        "?relation=administered",
        `?q=${sessionId.slice(0, 8)}`,
      ]) {
        expect(await listed(who, query)).not.toContain(sessionId);
        expect({ who, query, total: await counted(who, query) }).toEqual({
          who,
          query,
          total: 0,
        });
      }
    }
    expect(await counted("creator", "?relation=started")).toBe(1);
  });

  test("shared with a team, its members see it and nobody else does", async () => {
    await share("team", [teamId]);
    expect(await listed("teammate")).toContain(sessionId);
    expect(await listed("outsider")).not.toContain(sessionId);
    expect(await listed("teammate", "?relation=shared")).toEqual([sessionId]);
    expect(await counted("teammate", "?relation=shared")).toBe(1);
    expect(await listed("creator", "?relation=shared")).toEqual([]);
    expect(await counted("outsider")).toBe(0);
    const detail = await send(
      "GET",
      `/v1/sessions/${sessionId}`,
      asCookie(cookies.teammate),
    );
    expect(detail.status).toBe(200);
    // 94S-798: the teammate sees it but may not answer for its creator; the
    // owner, outside the team, does not even see it.
    expect(await answering("teammate")).toEqual({
      who: "teammate",
      listed: false,
      answer: 403,
      code: "FORBIDDEN",
      reason: "role",
    });
    expect(await answering("owner")).toMatchObject({
      listed: 404,
      answer: 404,
      code: "NOT_FOUND",
    });
    expect(await answering("admin")).toMatchObject({
      listed: 404,
      answer: 404,
    });
    expect(await answering("creator")).toMatchObject({
      listed: true,
      answer: 404,
      code: "NOT_FOUND",
    });
    // 94S-804: renaming follows the same lines.
    expect(await renaming("teammate")).toMatchObject({
      status: 403,
      details: { reason_code: "role" },
    });
    expect(await renaming("owner")).toMatchObject({ status: 404 });
    expect(await renaming("creator")).toMatchObject({ status: 200 });
    for (const [, call] of surfaces) {
      expect((await call("outsider")).status).toBe(404);
    }
  });

  test("narrowing the share ends the teammate's open stream, and it does not reopen", async () => {
    const response = await send(
      "GET",
      `/v1/sessions/${sessionId}/events`,
      asCookie(cookies.teammate),
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no body");
    // Let the stream reach its wait before narrowing.
    await Bun.sleep(200);
    const narrowedAt = Date.now();
    await share("private");
    let done = false;
    while (!done) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(5_000).then(() => null),
      ]);
      if (chunk === null) throw new Error("the stream outlived the narrowing");
      done = chunk.done;
    }
    expect(Date.now() - narrowedAt).toBeLessThan(KEEPALIVE_MS);
    expect(
      sink.records.some(
        (record) =>
          record.message === "SSE stream closed" &&
          record.fields?.reason === "not_visible",
      ),
    ).toBe(true);
    const reopened = await send(
      "GET",
      `/v1/sessions/${sessionId}/events`,
      asCookie(cookies.teammate),
    );
    expect(reopened.status).toBe(404);
  }, 20_000);

  test("out of the team is out of the share at the next request", async () => {
    await share("team", [teamId]);
    expect(await listed("teammate")).toContain(sessionId);
    await db
      .update(memberTeamMembers)
      .set({ removedAt: new Date() })
      .where(eq(memberTeamMembers.teamId, teamId));
    expect(await listed("teammate")).not.toContain(sessionId);
  });

  const decisionsOf = (action: string, who: Who) =>
    db
      .select({
        outcome: authzDecisions.outcome,
        reasonCode: authzDecisions.reasonCode,
        justification: authzDecisions.justification,
      })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.resourceId, sessionId),
          eq(authzDecisions.action, action),
          eq(authzDecisions.actorUserId, ids[who]),
        ),
      );
  const shareOver = (who: Who, body: unknown, id = sessionId) =>
    send("POST", `/v1/sessions/${id}/share`, asCookie(cookies[who]), body);

  test("over HTTP, only the creator changes who sees a person's session", async () => {
    const changed = await shareOver("creator", { scope: "private" });
    expect(changed.status).toBe(200);
    const first = setSessionShareResponseSchema.parse(await changed.json());
    expect(first.share.scope).toBe("private");
    expect(first.receipt_id).not.toBeNull();
    const again = await shareOver("creator", { scope: "private" });
    expect(setSessionShareResponseSchema.parse(await again.json())).toEqual({
      share: first.share,
      receipt_id: null,
    });
    // Outside the share the session is not there to share.
    for (const who of ["owner", "admin", "outsider"] as const) {
      expect((await shareOver(who, { scope: "workspace" })).status).toBe(404);
      const read = await send(
        "GET",
        `/v1/sessions/${sessionId}/share`,
        asCookie(cookies[who]),
      );
      expect(read.status).toBe(404);
    }
    // Inside it, nobody but the creator may change it.
    await shareOver("creator", { scope: "workspace" });
    for (const who of ["owner", "admin", "outsider"] as const) {
      const refused = await shareOver(who, { scope: "private" });
      expect(refused.status).toBe(403);
    }
    const stale = await shareOver("creator", {
      scope: "private",
      expected_revision: first.share.revision,
    });
    expect(stale.status).toBe(409);
    const narrowed = await shareOver("creator", {
      scope: "people",
      user_ids: [ids.outsider],
    });
    expect(narrowed.status).toBe(200);
    expect(await listed("outsider")).toContain(sessionId);
    expect(await listed("owner")).not.toContain(sessionId);
    await shareOver("creator", { scope: "private" });
    const [receipt] = await db
      .select({ result: receipts.result })
      .from(receipts)
      .where(eq(receipts.id, first.receipt_id ?? ""));
    expect(receipt?.result).toEqual({ scope: "private" });
  });

  test("an audit read needs a reason, is kept each time and changes nothing", async () => {
    const path = `/v1/sessions/${sessionId}/audit-read`;
    const before = await db
      .select({ revision: sessions.revision, updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    for (const body of [{}, { justification: "  " }]) {
      const refused = await send("POST", path, asCookie(cookies.owner), body);
      expect(refused.status).toBe(400);
    }
    for (const reason of ["incident 42", "incident 43"]) {
      const read = await send("POST", path, asCookie(cookies.owner), {
        justification: reason,
      });
      expect(read.status).toBe(200);
      const body = auditReadResponseSchema.parse(await read.json());
      expect(body.session.id).toBe(sessionId);
      expect(body.turns.items.length).toBeGreaterThan(0);
    }
    const kept = await decisionsOf("session.audit_read", "owner");
    expect(kept.map((row) => [row.outcome, row.justification])).toEqual([
      ["allow", "incident 42"],
      ["allow", "incident 43"],
    ]);
    // Read-only: the read opens nothing else on the session.
    for (const [surface, call] of surfaces) {
      expect({ surface, status: (await call("owner")).status }).toEqual({
        surface,
        status: 404,
      });
    }
    const after = await db
      .select({ revision: sessions.revision, updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(after).toEqual(before);
    // A member is no auditor, reason or not: outside the share the session
    // is not there, and inside it the role refuses.
    const member = await send("POST", path, asCookie(cookies.outsider), {
      justification: "curious",
    });
    expect(member.status).toBe(404);
    await shareOver("creator", { scope: "workspace" });
    const inside = await send("POST", path, asCookie(cookies.outsider), {
      justification: "curious",
    });
    expect(inside.status).toBe(403);
    expect((await codeOf(inside)).details).toEqual({ reason_code: "role" });
    await shareOver("creator", { scope: "private" });
  });

  test("the admin list shows every session's metadata and no content", async () => {
    const response = await send(
      "GET",
      "/v1/admin/sessions",
      asCookie(cookies.admin),
    );
    expect(response.status).toBe(200);
    const raw = (await response.json()) as { items: Record<string, unknown>[] };
    const item = raw.items.find((row) => row.session_id === sessionId);
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "admission_state",
      "agent_release_id",
      "created_at",
      "created_by_api_key_id",
      "created_by_user_id",
      "session_id",
      "share_scope",
      "status",
      "takeover_required_at",
    ]);
    expect(item?.share_scope).toBe("private");
    expect(JSON.stringify(raw)).not.toContain("Summarise the minutes.");
    expect(listAdminSessionsResponseSchema.parse(raw).items.length).toBe(1);
    const member = await send(
      "GET",
      "/v1/admin/sessions",
      asCookie(cookies.creator),
    );
    expect(member.status).toBe(403);
  });

  test("a manager stops a session outside the share only with a reason, which is kept", async () => {
    const [row] = await db
      .select({ revision: sessions.revision })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const revision = row?.revision ?? 0;
    const headers = () => ({
      ...asCookie(cookies.owner),
      "Idempotency-Key": crypto.randomUUID(),
    });
    // Recovery: owners only, past the share only with the decision's reason.
    const decision = {
      decision: "close",
      expected_revision: revision,
      reason: "unknown outcome; customer waiting",
    };
    const plain = await send(
      "POST",
      `/v1/sessions/${sessionId}/recovery-decisions`,
      headers(),
      decision,
    );
    expect(plain.status).toBe(404);
    const blank = await send(
      "POST",
      `/v1/admin/sessions/${sessionId}/recovery-decisions`,
      headers(),
      { ...decision, reason: "  " },
    );
    expect(blank.status).toBe(404);
    const recovered = await send(
      "POST",
      `/v1/admin/sessions/${sessionId}/recovery-decisions`,
      headers(),
      decision,
    );
    // Past the share; the session is simply not awaiting a decision.
    expect(recovered.status).toBe(409);
    const byAdmin = await send(
      "POST",
      `/v1/admin/sessions/${sessionId}/recovery-decisions`,
      { ...asCookie(cookies.admin), "Idempotency-Key": crypto.randomUUID() },
      decision,
    );
    expect(byAdmin.status).toBe(403);
    expect(
      (await decisionsOf("session.recover", "owner")).map((d) => [
        d.outcome,
        d.justification,
      ]),
    ).toEqual(
      expect.arrayContaining([["allow", "unknown outcome; customer waiting"]]),
    );
    const ordinary = await send(
      "POST",
      `/v1/sessions/${sessionId}/terminate`,
      headers(),
      { expected_revision: revision, reason: "no audit" },
    );
    expect(ordinary.status).toBe(404);
    const path = `/v1/admin/sessions/${sessionId}/terminate`;
    const unreasoned = await send("POST", path, headers(), {
      expected_revision: revision,
    });
    expect(unreasoned.status).toBe(400);
    // The admin path is a manager's, even for a member who sees the session.
    const byCreator = await send(
      "POST",
      path,
      { ...asCookie(cookies.creator), "Idempotency-Key": crypto.randomUUID() },
      { expected_revision: revision, justification: "mine anyway" },
    );
    expect(byCreator.status).toBe(403);
    expect((await codeOf(byCreator)).details).toEqual({ reason_code: "role" });
    const once = headers();
    const stopped = await send("POST", path, once, {
      expected_revision: revision,
      justification: "runaway cost",
    });
    expect(stopped.status).toBe(202);
    // The reason is part of the request: the same key with another reason
    // is a different request, not a replay.
    const replayed = await send("POST", path, once, {
      expected_revision: revision,
      justification: "runaway cost",
    });
    expect(replayed.status).toBe(202);
    const reworded = await send("POST", path, once, {
      expected_revision: revision,
      justification: "something else",
    });
    expect(reworded.status).toBe(409);
    expect((await codeOf(reworded)).code).toBe("IDEMPOTENCY_CONFLICT");
    const kept = await decisionsOf("session.control", "owner");
    expect(kept.map((d) => [d.outcome, d.reasonCode, d.justification])).toEqual(
      expect.arrayContaining([
        ["deny", "not_found", null],
        ["allow", "ok", "runaway cost"],
      ]),
    );
  });

  test("taking over a departed member's private session needs a reason, kept on the receipt", async () => {
    const created = await send(
      "POST",
      "/v1/sessions",
      { ...asCookie(cookies.creator), "Idempotency-Key": crypto.randomUUID() },
      {
        profile_id: "claude-coding-v1",
        repository_id: "sample-app",
        message: "Draft the follow-up.",
      },
    );
    expect(created.status).toBe(201);
    const orphan = createSessionResponseSchema.parse(
      await created.json(),
    ).session_id;
    expect(
      (await shareOver("creator", { scope: "private" }, orphan)).status,
    ).toBe(200);
    const disabled = await send(
      "POST",
      `/v1/members/${ids.creator}/disable`,
      asCookie(cookies.owner),
      {},
    );
    expect(disabled.status).toBe(200);
    const path = `/v1/sessions/${orphan}/takeover`;
    const unreasoned = await app.request(path, {
      method: "POST",
      headers: asCookie(cookies.owner),
    });
    expect(unreasoned.status).toBe(403);
    expect((await codeOf(unreasoned)).details).toEqual({
      reason_code: "justification_required",
    });
    const taken = await send("POST", path, asCookie(cookies.owner), {
      justification: "creator left; customer waiting",
    });
    expect(taken.status).toBe(200);
    const { receipt_id } = (await taken.json()) as { receipt_id: string };
    const [receipt] = await db
      .select({ result: receipts.result })
      .from(receipts)
      .where(eq(receipts.id, receipt_id));
    expect(receipt?.result).toEqual({
      justification: "creator left; customer waiting",
    });
    // The taker stands where the creator stood, the share included.
    expect(await listed("owner")).toContain(orphan);
    expect(await listed("admin")).not.toContain(orphan);
    expect(
      (await shareOver("owner", { scope: "workspace" }, orphan)).status,
    ).toBe(200);
  });
});

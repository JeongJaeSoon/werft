import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  createSessionResponseSchema,
  listSessionOutputsResponseSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresDecisionLog,
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionShareStore,
  createPostgresSessionUnitOfWork,
  memberships,
  users,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  callerFor,
  createAuthorizationPolicy,
  createSessionOutputService,
  createSessionService,
  type SessionCatalog,
  type SessionOutputSource,
} from "@werft-ai/platform";
import type { StoredOutput } from "@werft-ai/runtime-core";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
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
import { registerSessionOutputRoutes } from "./routes/outputs.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { testCatalog } from "../test-support/catalog.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "outputs-bootstrap-token-0123456789";
const PASSWORD = "outputs-password-0123456789";

const catalog: SessionCatalog = testCatalog({
provider: {
        kind: "litellm",
        endpoint: "https://litellm.invalid",
        auth: {
          kind: "api_key",
          value: "catalog-provider-key",
          ref: { value_env: "PROVIDER_KEY" },
        },
      },
repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true } as const,
    },
  },
});

const REPORT = new TextEncoder().encode("# report\n");
const REPORT_SHA256 = createHash("sha256").update(REPORT).digest("hex");

// Who may read outputs is the session's share, decided by the real policy
// and stores; the checkpoint behind them is checkpoint-versions.test.ts's.
integration("session outputs over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;
  const committed = new Set<string>();
  let workspaceId = "";
  const ids: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const report: StoredOutput = {
    path: "out/report.md",
    bytes: REPORT.byteLength,
    sha256: REPORT_SHA256,
    key: "sessions/x/checkpoints/0000000000/a/p/outputs/x",
  };
  const source: SessionOutputSource = {
    async readOutputs(sessionId) {
      return committed.has(sessionId)
        ? { status: "ready", revision: 0, outputs: [report] }
        : { status: "none" };
    },
    async openOutput(sessionId, path) {
      if (!committed.has(sessionId) || path !== report.path) {
        return { status: "missing" };
      }
      return {
        status: "ready",
        output: report,
        body: (async function* () {
          yield REPORT;
        })(),
      };
    },
  };

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "session_outputs_api" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    const identity = new DatabaseIdentityStore(db);
    const logger = new StructuredLogger({ sinks: [new MemoryLogSink()] });
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
    const sessions = createSessionService({
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
    app = createApiApp({
      authMode: "api-key",
      logger,
      keyStore: new DatabaseApiKeyStore(db),
      identity,
      authorization,
      registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
      registerRoutes: (router) => {
        registerAuthRoutes(router, auth);
        registerSessionRoutes(router, sessions);
        registerSessionOutputRoutes(
          router,
          createSessionOutputService({ sessions, source }),
        );
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const send = (
    method: string,
    path: string,
    headers: HeadersInit,
    body?: unknown,
  ) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const as = (who: string) => ({
    Cookie: cookies[who] ?? "",
    [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
  });

  async function login(email: string) {
    const response = await send(
      "POST",
      "/v1/auth/login",
      { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE },
      { email, password: PASSWORD },
    );
    expect(response.status).toBe(200);
    return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  }

  async function addMember(who: string) {
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
    await db
      .insert(memberships)
      .values({ workspaceId, userId: user.id, role: "member" });
    ids[who] = user.id;
    cookies[who] = await login(email);
  }

  async function createSession(who: string): Promise<string> {
    const created = await send(
      "POST",
      "/v1/sessions",
      { ...as(who), "Idempotency-Key": crypto.randomUUID() },
      {
        repository_id: "sample-app",
        message: "Write the report to out/report.md.",
      },
    );
    expect(created.status).toBe(201);
    return createSessionResponseSchema.parse(await created.json()).session_id;
  }

  async function makePrivate(sessionId: string) {
    const result = await createPostgresSessionShareStore(db).set({
      principal: callerFor(
        {
          kind: "user",
          id: ids.creator ?? "",
          workspace_id: workspaceId,
          role: "member",
          scopes: ["sessions:read", "sessions:write"],
        },
        { kind: "web" },
        crypto.randomUUID(),
      ),
      ownerId: workspaceId,
      workspaceId,
      sessionId,
      scope: "private",
      userIds: [],
      teamIds: [],
      updatedBy: ids.creator ?? "",
      receiptId: crypto.randomUUID(),
    });
    expect(result.outcome).toBe("changed");
  }

  const codeOf = async (response: Response) =>
    apiErrorResponseSchema.parse(await response.json()).error.code;

  let sessionId = "";
  let bare = "";

  test("setup: the owner, the creator with a private session, an outsider", async () => {
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
    cookies.owner = await login("owner@example.com");
    await addMember("creator");
    await addMember("outsider");
    sessionId = await createSession("creator");
    bare = await createSession("creator");
    committed.add(sessionId);
    await makePrivate(sessionId);
  });

  test("the creator lists the outputs and downloads the bytes the manifest names", async () => {
    const listed = await send(
      "GET",
      `/v1/sessions/${sessionId}/outputs`,
      as("creator"),
    );
    expect(listed.status).toBe(200);
    expect(
      listSessionOutputsResponseSchema.parse(await listed.json()).items,
    ).toEqual([
      {
        path: "out/report.md",
        bytes: REPORT.byteLength,
        sha256: REPORT_SHA256,
        omitted: null,
      },
    ]);

    const download = await send(
      "GET",
      `/v1/sessions/${sessionId}/outputs/out%2Freport.md`,
      as("creator"),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toStartWith(
      "attachment;",
    );
    expect(download.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      REPORT_SHA256,
    );
  });

  test("outside a private session's share, owner included, outputs answer what the session read does: 404", async () => {
    for (const who of ["owner", "outsider"]) {
      const detail = await send("GET", `/v1/sessions/${sessionId}`, as(who));
      expect({ who, status: detail.status }).toEqual({ who, status: 404 });
      for (const path of [
        `/v1/sessions/${sessionId}/outputs`,
        `/v1/sessions/${sessionId}/outputs/out%2Freport.md`,
      ]) {
        const response = await send("GET", path, as(who));
        expect({ who, path, status: response.status }).toEqual({
          who,
          path,
          status: 404,
        });
        expect(await codeOf(response)).toBe("NOT_FOUND");
      }
    }
  });

  test("a session without a committed checkpoint lists nothing and downloads nothing", async () => {
    const listed = await send(
      "GET",
      `/v1/sessions/${bare}/outputs`,
      as("creator"),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      session_id: bare,
      checkpoint_revision: null,
      items: [],
    });
    const download = await send(
      "GET",
      `/v1/sessions/${bare}/outputs/out%2Freport.md`,
      as("creator"),
    );
    expect(download.status).toBe(404);
  });

  test("a session that does not exist is 404", async () => {
    const response = await send(
      "GET",
      `/v1/sessions/${crypto.randomUUID()}/outputs`,
      as("creator"),
    );
    expect(response.status).toBe(404);
    expect(await codeOf(response)).toBe("NOT_FOUND");
  });
});

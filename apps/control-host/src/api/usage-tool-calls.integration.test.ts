import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  apiErrorResponseSchema,
  type UsageToolCallsResponse,
  usageToolCallsResponseSchema,
  type WorkspaceRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseIdentityReader,
  createPostgresUsageReader,
  events,
  memberships,
  projectToolCalls,
  sessionShares,
  sessions,
  users,
  workspaces,
} from "@werft-ai/db";
import {
  createAuthorizationPolicy,
  createUsageService,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "./app.ts";
import {
  createBootstrapGate,
  DatabaseIdentityStore,
  LoginLockout,
} from "./auth.ts";
import { DatabaseApiKeyStore } from "./keys.ts";
import { registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerUsageRoutes } from "./routes/usage/usage.ts";

const integration = testDatabaseUrl() ? test : test.skip;

// What the console's tool rail reads: signed in with a cookie, a session's
// id and title only where the caller may read the session (94S-912).
let database: TempDatabase;
let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let app: ReturnType<typeof createApiApp>;
const workspaceId = crypto.randomUUID();
const secret = crypto.randomUUID();
const cookies = {} as Record<WorkspaceRole, string>;
const ids = {} as Record<WorkspaceRole, string>;
const T0 = new Date("2026-10-20T12:00:00.000Z");

beforeAll(async () => {
  if (!testDatabaseUrl()) return;
  database = await createTempDatabase({ prefix: "usage_tool_calls_http" });
  pool = new Pool({ connectionString: database.url, max: 5 });
  db = drizzle(pool, { schema });
  const identity = new DatabaseIdentityStore(db);
  const authorization = createAuthorizationPolicy({
    identity: createDatabaseIdentityReader(db),
  });
  const auth = {
    identity,
    bootstrap: createBootstrapGate(crypto.randomUUID()),
    lockout: new LoginLockout(),
  };
  app = createApiApp({
    authMode: "api-key",
    keyStore: new DatabaseApiKeyStore(db),
    identity,
    authorization,
    registerPublicRoutes: (router) => registerPublicAuthRoutes(router, auth),
    registerRoutes: (router) =>
      registerUsageRoutes(
        router,
        createUsageService({
          authorization,
          reader: createPostgresUsageReader(db),
          limits: {
            executionSlotLimit: 10,
            queuedInputLimitPerSession: 20,
            storageLimitBytes: 1_073_741_824,
            maxTurnSeconds: 3600,
            sessionCostLimitUsd: 2.5,
            sessionTokenLimit: null,
            providerMaxRetries: 2,
          },
        }),
      ),
  });
  await db
    .insert(workspaces)
    .values({ id: workspaceId, slug: "acme", name: "Acme" });
  const hash = await Bun.password.hash(secret, { algorithm: "argon2id" });
  for (const role of ["owner", "admin", "member"] as const) {
    const [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email: `${role}@example.com`,
        passwordHash: hash,
        displayName: role,
      })
      .returning({ id: users.id });
    if (!user) throw new Error("no user");
    ids[role] = user.id;
    await db.insert(memberships).values({ workspaceId, userId: user.id, role });
    const login = await app.request("/v1/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "werft-web",
      },
      body: JSON.stringify({ email: `${role}@example.com`, password: secret }),
    });
    expect(login.status).toBe(200);
    cookies[role] = (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  }
}, 60_000);

afterAll(async () => {
  if (!testDatabaseUrl()) return;
  await pool.end();
  await database.drop();
}, 60_000);

let sequence = 0;
async function sessionWithCall(
  role: WorkspaceRole,
  title: string,
  at: Date,
  scope?: "private" | "workspace",
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(sessions).values({
    id,
    ownerId: workspaceId,
    workspaceId,
    title,
    repoUrl: "https://example.invalid/app.git",
    branch: "main",
    createdByUserId: ids[role],
  });
  if (scope) {
    await db
      .insert(sessionShares)
      .values({ sessionId: id, ownerId: workspaceId, workspaceId, scope });
  }
  sequence += 1;
  await db.insert(events).values({
    sessionId: id,
    type: "tool_use",
    payload: {
      type: "assistant",
      tool_call: { id: `tu-${sequence}`, name: "Bash", input: {} },
    },
    attemptId: "att-1",
    sourceSequence: sequence,
    occurredAt: at,
    createdAt: at,
  });
  return id;
}

async function calls(
  role: WorkspaceRole,
  scope: "installation" | "me",
): Promise<UsageToolCallsResponse> {
  await projectToolCalls(db, {
    batchSize: 1000,
    budgetMs: 60_000,
    marginSeconds: 0,
  });
  const response = await app.request(
    `/v1/usage/tools/Bash/calls?scope=${scope}&since=2026-10-20&until=2026-10-21`,
    {
      headers: {
        Cookie: cookies[role],
        "X-Requested-With": "werft-web",
      },
    },
  );
  expect(response.status, `${role} ${scope}`).toBe(200);
  return usageToolCallsResponseSchema.parse(await response.json());
}

integration(
  "the owner sees no id or title of a private session until it is shared with the workspace; a member sees their own; admin and member get 403 for the installation",
  async () => {
    const hidden = await sessionWithCall(
      "member",
      "member's private work",
      new Date(T0.getTime() + 2000),
      "private",
    );
    const open = await sessionWithCall(
      "owner",
      "owner's work",
      new Date(T0.getTime() + 1000),
    );
    const sessionsOf = (body: UsageToolCallsResponse) =>
      body.calls.map((call) => [call.session_id, call.title]);

    const owner = await calls("owner", "installation");
    expect(sessionsOf(owner)).toEqual([
      [null, null],
      [open, "owner's work"],
    ]);
    expect(JSON.stringify(owner)).not.toContain(hidden);
    expect(JSON.stringify(owner)).not.toContain("member's private work");
    expect(owner.per_day).toEqual([{ date: "2026-10-20", calls: 2 }]);

    await db
      .update(sessionShares)
      .set({ scope: "workspace" })
      .where(eq(sessionShares.sessionId, hidden));
    expect(sessionsOf(await calls("owner", "installation"))).toEqual([
      [hidden, "member's private work"],
      [open, "owner's work"],
    ]);

    expect(sessionsOf(await calls("member", "me"))).toEqual([
      [hidden, "member's private work"],
    ]);
    expect(sessionsOf(await calls("admin", "me"))).toEqual([]);

    for (const role of ["admin", "member"] as const) {
      const response = await app.request(
        "/v1/usage/tools/Bash/calls?scope=installation&since=2026-10-20",
        {
          headers: {
            Cookie: cookies[role],
            "X-Requested-With": "werft-web",
          },
        },
      );
      expect(response.status, role).toBe(403);
      expect(
        apiErrorResponseSchema.parse(await response.json()).error.code,
      ).toBe("FORBIDDEN");
    }
  },
);

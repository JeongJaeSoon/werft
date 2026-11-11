import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  agentAdminChangeResponseSchema,
  apiErrorResponseSchema,
  bootstrapResponseSchema,
  CSRF_HEADER_NAME,
  CSRF_HEADER_VALUE,
  listAdministeredAgentsResponseSchema,
  listMyTeamsResponseSchema,
  listTeamsResponseSchema,
  teamChangeResponseSchema,
  teamDetailSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  authzDecisions,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentAdminStore,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresDecisionLog,
  createPostgresTeamStore,
  memberships,
  receipts,
  users,
} from "@werft-ai/db";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  createAgentAdminService,
  createAgentService,
  createAuthorizationPolicy,
  createTeamService,
  type SessionCatalog,
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
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerTeamRoutes } from "./routes/musterrolle/teams.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;

const BOOTSTRAP_TOKEN = "integration-bootstrap-token-0123456789";
const PASSWORD = "an adequately long password";

const catalog: SessionCatalog = { profiles: {}, repositories: {} };

const card = {
  role: "리뷰어",
  instructions: "변경을 읽고 위험을 요약한다.",
  language: "ko" as const,
  model: "claude-sonnet-5",
  capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  rules: [],
};

// Design 4.7 and scenario b over HTTP: an owner puts a member in a team,
// names the team an agent's admin, and the member's hold on the agent
// follows the team from one request to the next.
integration("teams as agent admins over HTTP on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let app: ReturnType<typeof createApiApp>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "teams_api" });
    pool = new Pool({ connectionString: database.url, max: 8 });
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
      decisions: createPostgresDecisionLog(db),
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
        registerAgentRoutes(
          router,
          createAgentService({
            authorization,
            store: createPostgresAgentStore(db),
            catalog,
            credentials: createPostgresCredentialBindingStore(db),
          }),
        );
        registerTeamRoutes(
          router,
          createTeamService({
            authorization,
            store: createPostgresTeamStore(db),
          }),
          createAgentAdminService({
            authorization,
            store: createPostgresAgentAdminStore(db),
          }),
        );
      },
    });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const send = (method: string, path: string, cookie: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function errorOf(response: Response) {
    return apiErrorResponseSchema.parse(await response.json()).error;
  }

  async function login(email: string) {
    const response = await app.request("/v1/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "werft-web",
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    return (response.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  }

  async function addUser(email: string, role: "member" | "admin") {
    const [user] = await db
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        email,
        passwordHash: await Bun.password.hash(PASSWORD, {
          algorithm: "argon2id",
        }),
        displayName: email,
      })
      .returning({ id: users.id });
    if (!user) throw new Error("no user");
    await db.insert(memberships).values({ workspaceId, userId: user.id, role });
    return user.id;
  }

  let workspaceId = "";
  let owner = "";
  let admin = "";
  let member = "";
  let memberId = "";
  let agentId = "";
  let teamId = "";

  async function myTeams(cookie: string) {
    const response = await send("GET", "/v1/my-teams", cookie);
    expect(response.status).toBe(200);
    return listMyTeamsResponseSchema.parse(await response.json()).items;
  }

  const editCard = (instructions: string) =>
    send("PATCH", `/v1/agents/${agentId}`, member, {
      card: { ...card, instructions },
    });

  test("setup: an owner with an agent, an admin and a member", async () => {
    const boot = await app.request("/v1/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bootstrap_token: BOOTSTRAP_TOKEN,
        email: "owner@example.com",
        password: PASSWORD,
        display_name: "Owner",
        workspace_name: "Acme",
        workspace_slug: "acme",
      }),
    });
    expect(boot.status).toBe(201);
    workspaceId = bootstrapResponseSchema.parse(await boot.json()).workspace.id;
    owner = await login("owner@example.com");
    await addUser("admin@example.com", "admin");
    memberId = await addUser("member@example.com", "member");
    admin = await login("admin@example.com");
    member = await login("member@example.com");
    // The agent's managing team holds no one, so the member stays outside.
    const managing = await send("POST", "/v1/teams", owner, {
      name: "research",
    });
    expect(managing.status).toBe(201);
    const created = await send("POST", "/v1/agents", owner, {
      slug: "research",
      name: "research",
      managing_team_id: teamChangeResponseSchema.parse(await managing.json())
        .team.id,
      card,
    });
    expect(created.status).toBe(201);
    agentId = ((await created.json()) as { agent: { id: string } }).agent.id;
  });

  test("a member cannot touch the agent nor any team", async () => {
    const refused = await editCard("v2");
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({
      details: { reason_code: "role" },
    });
    const create = await send("POST", "/v1/teams", member, { name: "mine" });
    expect(create.status).toBe(403);
    expect(await errorOf(create)).toMatchObject({
      details: { reason_code: "role" },
    });
    expect((await send("GET", "/v1/teams", member)).status).toBe(403);
    expect(await myTeams(member)).toEqual([]);
  });

  test("an owner makes a team, adds the member at once and names the team the agent's admin", async () => {
    const created = await send("POST", "/v1/teams", owner, {
      name: "research admins",
    });
    expect(created.status).toBe(201);
    teamId = teamChangeResponseSchema.parse(await created.json()).team.id;
    const duplicate = await send("POST", "/v1/teams", admin, {
      name: "research admins",
    });
    expect(duplicate.status).toBe(409);

    const added = await send("POST", `/v1/teams/${teamId}/members`, owner, {
      user_id: memberId,
    });
    expect(added.status).toBe(200);
    const { receipt_id } = teamChangeResponseSchema.parse(await added.json());
    // The added person's notice: a receipt naming them and the team.
    const [notice] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receipt_id ?? ""));
    expect(notice).toMatchObject({
      operation: "add_team_member",
      targetRef: { user_id: memberId, workspace_id: workspaceId },
      result: { team_id: teamId, team_name: "research admins" },
    });

    const detail = teamDetailSchema.parse(
      await (await send("GET", `/v1/teams/${teamId}`, admin)).json(),
    );
    expect(detail.members.map((m) => m.user_id)).toEqual([memberId]);
    expect(await myTeams(member)).toEqual([
      { id: teamId, name: "research admins", role: "member" },
    ]);
    expect(await myTeams(admin)).toEqual([]);
    // The member reads their own team, read only (94S-719), and no other.
    const own = await send("GET", `/v1/teams/${teamId}`, member);
    expect(own.status).toBe(200);
    expect(teamDetailSchema.parse(await own.json())).toEqual(detail);
    const elsewhere = await send("POST", "/v1/teams", owner, {
      name: "elsewhere",
    });
    const otherTeam = teamChangeResponseSchema.parse(await elsewhere.json())
      .team.id;
    for (const path of [`/v1/teams/${otherTeam}`, "/v1/teams"]) {
      const refused = await send("GET", path, member);
      expect(refused.status, path).toBe(403);
      expect(await errorOf(refused), path).toMatchObject({
        details: { reason_code: "role" },
      });
    }
    expect((await send("DELETE", `/v1/teams/${otherTeam}`, owner)).status).toBe(
      200,
    );

    // Still nothing on the agent until the team is named its admin.
    expect((await editCard("v2")).status).toBe(403);
    const named = await send("POST", `/v1/agents/${agentId}/admins`, owner, {
      team_id: teamId,
    });
    expect(named.status).toBe(200);
    expect(
      agentAdminChangeResponseSchema.parse(await named.json()).admins.teams,
    ).toMatchObject([{ team_id: teamId, name: "research admins" }]);
  });

  test("the team's member administers the agent, and sees it as theirs", async () => {
    expect((await editCard("v2")).status).toBe(200);
    const mine = listAdministeredAgentsResponseSchema.parse(
      await (await send("GET", "/v1/administered-agents", member)).json(),
    );
    expect(mine.items.map((a) => a.id)).toEqual([agentId]);
    // Administering the agent is not managing teams.
    expect(
      (
        await send("PATCH", `/v1/teams/${teamId}`, member, {
          name: "taken over",
        })
      ).status,
    ).toBe(403);
    expect(
      (await send("DELETE", `/v1/teams/${teamId}/members/${memberId}`, member))
        .status,
    ).toBe(403);
  });

  test("out of the team, the next request is refused", async () => {
    const removed = await send(
      "DELETE",
      `/v1/teams/${teamId}/members/${memberId}`,
      owner,
    );
    expect(removed.status).toBe(200);
    const refused = await editCard("v3");
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({
      details: { reason_code: "role" },
    });
    expect(
      listAdministeredAgentsResponseSchema.parse(
        await (await send("GET", "/v1/administered-agents", member)).json(),
      ).items,
    ).toEqual([]);
    expect(await myTeams(member)).toEqual([]);
    const gone = await send("GET", `/v1/teams/${teamId}`, member);
    expect(gone.status).toBe(403);
    expect(await errorOf(gone)).toMatchObject({
      details: { reason_code: "role" },
    });
  });

  test("back in, then the team deleted: refused again", async () => {
    await send("POST", `/v1/teams/${teamId}/members`, owner, {
      user_id: memberId,
    });
    expect((await editCard("v3")).status).toBe(200);
    expect(await myTeams(member)).toHaveLength(1);
    expect((await send("DELETE", `/v1/teams/${teamId}`, admin)).status).toBe(
      200,
    );
    expect(await myTeams(member)).toEqual([]);
    const refused = await editCard("v4");
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({
      details: { reason_code: "role" },
    });
    expect((await send("GET", `/v1/teams/${teamId}`, owner)).status).toBe(404);
    expect((await send("GET", `/v1/teams/${teamId}`, member)).status).toBe(403);
  });

  test("every team change and refusal went through the decision log", async () => {
    const rows = await db
      .select({
        outcome: authzDecisions.outcome,
        reason: authzDecisions.reasonCode,
        actor: authzDecisions.actorUserId,
      })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.action, "team.manage"),
          eq(authzDecisions.workspaceId, workspaceId),
        ),
      );
    expect(
      rows.filter((r) => r.actor === memberId && r.outcome === "deny"),
    ).not.toHaveLength(0);
    expect(rows.filter((r) => r.outcome === "allow").length).toBeGreaterThan(4);
    const agentRefusals = await db
      .select({ reason: authzDecisions.reasonCode })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.action, "agent.manage"),
          eq(authzDecisions.actorUserId, memberId),
          eq(authzDecisions.outcome, "deny"),
        ),
      );
    expect(agentRefusals.length).toBeGreaterThanOrEqual(4);
    const operations = (
      await db
        .select({ operation: receipts.operation })
        .from(receipts)
        .where(eq(receipts.ownerId, workspaceId))
    ).map((r) => r.operation);
    for (const operation of [
      "create_team",
      "add_team_member",
      "remove_team_member",
      "add_agent_admin",
      "delete_team",
    ]) {
      expect(operations).toContain(operation);
    }
  });

  test("both team lists page by name; a bad cursor or limit is 400", async () => {
    for (const name of ["c", "a", "b"]) {
      const created = await send("POST", "/v1/teams", owner, { name });
      expect(created.status).toBe(201);
      const { team } = teamChangeResponseSchema.parse(await created.json());
      if (name !== "b") {
        await send("POST", `/v1/teams/${team.id}/members`, owner, {
          user_id: memberId,
        });
      }
    }
    async function walk(path: string, cookie: string) {
      const pages: string[][] = [];
      let cursor: string | null = null;
      do {
        const query: string = cursor ? `&cursor=${cursor}` : "";
        const response = await send("GET", `${path}?limit=1${query}`, cookie);
        expect(response.status).toBe(200);
        const page = (
          path === "/v1/teams"
            ? listTeamsResponseSchema
            : listMyTeamsResponseSchema
        ).parse(await response.json());
        pages.push(page.items.map((team) => team.name));
        cursor = page.next_cursor;
      } while (cursor);
      return pages;
    }
    expect(await walk("/v1/teams", admin)).toEqual([
      ["a"],
      ["b"],
      ["c"],
      ["research"],
    ]);
    expect(await walk("/v1/my-teams", member)).toEqual([["a"], ["c"]]);
    for (const [path, cookie] of [
      ["/v1/teams", owner],
      ["/v1/my-teams", member],
    ] as const) {
      for (const bad of ["?cursor=not-a-cursor", "?limit=0", "?limit=101"]) {
        const response = await send("GET", `${path}${bad}`, cookie);
        expect(response.status, `${path}${bad}`).toBe(400);
        expect((await errorOf(response)).code).toBe("BAD_REQUEST");
      }
    }
  });

  test("a team's member list carries each person's workspace state: null while active, the disabling time once disabled", async () => {
    const active = await addUser("active@example.com", "member");
    const leaving = await addUser("leaving@example.com", "member");
    const created = await send("POST", "/v1/teams", owner, {
      name: "state view",
    });
    const { team } = teamChangeResponseSchema.parse(await created.json());
    for (const user_id of [active, leaving])
      expect(
        (await send("POST", `/v1/teams/${team.id}/members`, owner, { user_id }))
          .status,
      ).toBe(200);
    const read = async () =>
      teamDetailSchema.parse(
        await (await send("GET", `/v1/teams/${team.id}`, owner)).json(),
      ).members;
    expect((await read()).map((m) => m.disabled_at)).toEqual([null, null]);

    const disabledAt = new Date("2026-11-01T00:00:00Z");
    await db
      .update(memberships)
      .set({ disabledAt })
      .where(eq(memberships.userId, leaving));
    const stateOf = Object.fromEntries(
      (await read()).map((m) => [m.user_id, m.disabled_at]),
    );
    expect(stateOf).toEqual({
      [active]: null,
      [leaving]: disabledAt.toISOString(),
    });
  });
});

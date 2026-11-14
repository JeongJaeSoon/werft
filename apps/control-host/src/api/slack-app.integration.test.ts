import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createSlackConfigApi,
  createSlackConfigTokens,
} from "@werft-ai/chat-slack";
import { BOT_SCOPES, scopesForRole } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentReleases,
  agents,
  agentVersions,
  createPostgresSlackConfigTokenStore,
  createPostgresSlackSettingsStore,
  memberships,
  secretValues,
  slackApps,
  users,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import {
  releaseSpecColumns,
  TEST_CONNECTION_ID,
} from "@werft-ai/db/testing/spec-pins";
import { callerFor, MANAGEMENT_ROLES, SecretKey } from "@werft-ai/platform";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { runSlackApp, SLACK_APP_EXIT, type SlackAppIo } from "./slack-app.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const CONSOLE = "http://127.0.0.1:3000";

integration("slack-app create on PostgreSQL against a fake Slack", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let slack: ReturnType<typeof startFakeSlackApi>;
  const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");
  const printed: string[] = [];

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "slack_app_cli" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    slack = startFakeSlackApi({ teamId: "T0CLI", userId: "U0CLI" });
  });

  afterAll(async () => {
    await slack?.stop();
    await pool?.end();
    await database?.drop();
  });

  async function run(
    argv: string[],
    apiUrl = slack.url,
    extraEnv: Record<string, string> = {},
  ) {
    const out: string[] = [];
    const err: string[] = [];
    const io: SlackAppIo = {
      env: {
        DATABASE_URL: "postgres://handled-by-openDatabase",
        CONSOLE_ORIGIN: CONSOLE,
        MOCK_SLACK_API_URL: apiUrl,
        ...extraEnv,
      },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      loadKey: async () => key,
      openDatabase: async () => ({ db, close: async () => {} }),
    };
    const code = await runSlackApp(argv, io);
    printed.push(...out, ...err);
    return { code, out, err };
  }

  async function workspaceWithToken() {
    const workspaceId = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "ws" });
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "x",
      displayName: "owner",
    });
    await db.insert(memberships).values({ workspaceId, userId, role: "owner" });
    const stored = await createSlackConfigTokens({
      store: createPostgresSlackConfigTokenStore(db, key),
      api: createSlackConfigApi({ apiUrl: slack.url }),
    }).register(workspaceId, slack.issueConfigToken(), {
      principal: callerFor(
        {
          kind: "user",
          id: userId,
          workspace_id: workspaceId,
          role: "owner",
          scopes: [...scopesForRole("owner")],
        },
        { kind: "web" },
        randomUUID(),
      ),
      receiptId: randomUUID(),
      roles: MANAGEMENT_ROLES["workspace.manage"] ?? [],
    });
    expect(stored.outcome).toBe("stored");
    return workspaceId;
  }

  async function agent(workspaceId: string, released = true) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `notes-${agentId.slice(0, 8)}`,
      name: "Release notes",
    });
    if (!released) return agentId;
    const versionId = randomUUID();
    await db.insert(agentVersions).values({
      id: versionId,
      agentId,
      versionNo: 1,
      card: {
        role: "Writes the release notes",
        instructions: "i",
        model: "m",
        capabilities: { tools: [], mcp: null, forbidden: [] },
      },
      contentSha256: "0".repeat(64),
    });
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256: "0".repeat(64),
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: {},
      effectiveTools: [],
    });
    await db
      .update(agents)
      .set({ activeReleaseId: releaseId, activationRevision: 1 })
      .where(eq(agents.id, agentId));
    return agentId;
  }

  const create = (workspaceId: string, agentId: string, ...rest: string[]) => [
    "create",
    "--workspace",
    workspaceId,
    "--agent",
    agentId,
    ...rest,
  ];

  test("creates the app, points at the console for the install, and the same agent again gets the same app", async () => {
    const workspaceId = await workspaceWithToken();
    const agentId = await agent(workspaceId);
    const first = await run(create(workspaceId, agentId));
    expect(first).toMatchObject({ code: SLACK_APP_EXIT.created, err: [] });
    const printedApp = JSON.parse(first.out[0] ?? "{}");
    expect(printedApp).toMatchObject({
      outcome: "created",
      agent_id: agentId,
      created_by_token_user: "U0CLI",
      warnings: [],
    });
    expect(first.out).toHaveLength(1);
    expect(first.out[0]).not.toContain("authorize");
    expect(printedApp.next).toBe(
      `Install it from the agent's page in the console, or with a signed-in console session: POST /v1/agents/${agentId}/slack/install/start`,
    );
    const app = slack.apps.get(printedApp.app_id);
    if (!app) throw new Error("Slack holds no such app");
    expect(
      (app.manifest as { oauth_config: object }).oauth_config,
    ).toMatchObject({
      redirect_urls: [`${CONSOLE}/agents/${agentId}/slack/callback`],
      scopes: { bot: [...BOT_SCOPES] },
    });
    expect(
      Object.keys((app.manifest as { settings: object }).settings),
    ).not.toContain("event_subscriptions");

    const again = await run(create(workspaceId, agentId));
    expect(again.code).toBe(SLACK_APP_EXIT.created);
    expect(JSON.parse(again.out[0] ?? "{}")).toMatchObject({
      outcome: "exists",
      app_id: printedApp.app_id,
      slack_app_id: printedApp.slack_app_id,
    });
    const owners = await db
      .select({ owner: secretValues.ownerRef, purpose: secretValues.purpose })
      .from(secretValues)
      .where(eq(secretValues.workspaceId, workspaceId));
    expect(
      owners
        .filter(({ owner }) => owner !== "workspace")
        .sort((a, b) => a.purpose.localeCompare(b.purpose)),
    ).toEqual([
      {
        owner: `slack_app:${printedApp.slack_app_id}`,
        purpose: "slack_client_secret",
      },
      {
        owner: `slack_app:${printedApp.slack_app_id}`,
        purpose: "slack_signing_secret",
      },
    ]);
  });

  test("exit codes: no token 3, unknown agent 4, no active release 5", async () => {
    const bare = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: bare, slug: `ws-${bare}`, name: "ws" });
    expect((await run(create(bare, await agent(bare)))).code).toBe(
      SLACK_APP_EXIT.config_token_invalid,
    );
    const workspaceId = await workspaceWithToken();
    expect((await run(create(workspaceId, randomUUID()))).code).toBe(
      SLACK_APP_EXIT.agent_not_found,
    );
    expect(
      (await run(create(workspaceId, await agent(workspaceId, false)))).code,
    ).toBe(SLACK_APP_EXIT.agent_not_active);
  });

  test("Slack unreachable mid-create is 7, the row stays creating, and the next run is 6", async () => {
    const workspaceId = await workspaceWithToken();
    const agentId = await agent(workspaceId);
    const down = await run(
      create(workspaceId, agentId),
      "http://127.0.0.1:9/api",
    );
    expect(down.code).toBe(SLACK_APP_EXIT.slack_error);
    const rows = await db
      .select({ state: slackApps.state })
      .from(slackApps)
      .where(eq(slackApps.agentId, agentId));
    expect(rows).toEqual([{ state: "creating" }]);
    const retry = await run(create(workspaceId, agentId));
    expect(retry.code).toBe(SLACK_APP_EXIT.app_busy);
    expect(retry.err.join("\n")).toContain("SLACK_APP_CREATING");
  });

  const createLink = (workspaceId: string) => [
    "create",
    "--kind",
    "link",
    "--workspace",
    workspaceId,
  ];

  test("--kind link makes the workspace's link app once; again returns it", async () => {
    const workspaceId = await workspaceWithToken();
    const first = await run(createLink(workspaceId));
    expect(first).toMatchObject({ code: SLACK_APP_EXIT.created, err: [] });
    const printedApp = JSON.parse(first.out[0] ?? "{}");
    expect(printedApp).toMatchObject({
      outcome: "created",
      kind: "link",
      redirect_url: `${CONSOLE}/settings/linked-accounts/slack`,
      created_by_token_user: "U0CLI",
      warnings: [],
    });
    const app = slack.apps.get(printedApp.app_id);
    expect(printedApp.client_id).toBe(app?.clientId);
    expect(app?.manifest).toMatchObject({
      display_information: { name: "ws 계정 연결" },
      oauth_config: {
        redirect_urls: [`${CONSOLE}/settings/linked-accounts/slack`],
        scopes: { user: ["openid", "profile"] },
      },
    });
    expect(app?.manifest).not.toHaveProperty("features");

    const again = await run(createLink(workspaceId));
    expect(again.code).toBe(SLACK_APP_EXIT.created);
    expect(JSON.parse(again.out[0] ?? "{}")).toMatchObject({
      outcome: "exists",
      slack_app_id: printedApp.slack_app_id,
      app_id: printedApp.app_id,
    });
    const rows = await db
      .select({ kind: slackApps.kind, agentId: slackApps.agentId })
      .from(slackApps)
      .where(eq(slackApps.workspaceId, workspaceId));
    expect(rows).toEqual([{ kind: "link", agentId: null }]);
    const owners = await db
      .select({ owner: secretValues.ownerRef, purpose: secretValues.purpose })
      .from(secretValues)
      .where(eq(secretValues.workspaceId, workspaceId));
    expect(
      owners
        .filter(({ owner }) => owner !== "workspace")
        .map(({ owner, purpose }) => `${owner}/${purpose}`)
        .sort(),
    ).toEqual([
      `slack_app:${printedApp.slack_app_id}/slack_client_secret`,
      `slack_app:${printedApp.slack_app_id}/slack_signing_secret`,
    ]);
  });

  test("--kind link exit codes: no token 3, unknown workspace 4, Slack down 7 then 6", async () => {
    const bare = randomUUID();
    await db
      .insert(workspaces)
      .values({ id: bare, slug: `ws-${bare}`, name: "ws" });
    expect((await run(createLink(bare))).code).toBe(
      SLACK_APP_EXIT.config_token_invalid,
    );
    expect((await run(createLink(randomUUID()))).code).toBe(
      SLACK_APP_EXIT.agent_not_found,
    );
    const workspaceId = await workspaceWithToken();
    expect(
      (await run(createLink(workspaceId), "http://127.0.0.1:9/api")).code,
    ).toBe(SLACK_APP_EXIT.slack_error);
    const retry = await run(createLink(workspaceId));
    expect(retry.code).toBe(SLACK_APP_EXIT.app_busy);
    expect(retry.err.join("\n")).toContain("SLACK_APP_CREATING");
  });

  test("finalize sends the event subscription, twice to the same effect; unset url is 8 and sends nothing; no app is 4", async () => {
    const workspaceId = await workspaceWithToken();
    const agentId = await agent(workspaceId);
    const created = await run(create(workspaceId, agentId));
    const appId = JSON.parse(created.out[0] ?? "{}").app_id;
    const updates = () =>
      slack.calls.filter((call) => call.method === "apps.manifest.update")
        .length;
    const before = updates();

    const unset = await run(["finalize", "--agent", agentId], slack.url, {
      CONSOLE_ORIGIN: "http://werft.internal.test",
    });
    expect(unset.code).toBe(SLACK_APP_EXIT.events_url_unset);
    expect(unset.out).toEqual([]);
    expect(unset.err.join("\n")).toContain("events_url_unset");
    expect(updates()).toBe(before);

    const computed = await run(["finalize", "--agent", agentId]);
    expect(computed.code).toBe(SLACK_APP_EXIT.created);
    expect(JSON.parse(computed.out[0] ?? "{}").request_url).toBe(
      `${CONSOLE}/v1/slack/events/${agentId}`,
    );
    expect(
      (
        slack.apps.get(appId)?.manifest as {
          settings: { event_subscriptions: { request_url: string } };
        }
      ).settings.event_subscriptions.request_url,
    ).toBe(`${CONSOLE}/v1/slack/events/${agentId}`);
    const afterComputed = updates();

    expect(
      await createPostgresSlackSettingsStore(db).importEventsPublicUrl(
        "https://events.example.test",
      ),
    ).toBe(true);
    const manifests: unknown[] = [];
    for (const _ of [1, 2]) {
      const done = await run(["finalize", "--agent", agentId]);
      expect(done.code).toBe(SLACK_APP_EXIT.created);
      expect(JSON.parse(done.out[0] ?? "{}")).toEqual({
        outcome: "finalized",
        slack_app_id: JSON.parse(created.out[0] ?? "{}").slack_app_id,
        app_id: appId,
        agent_id: agentId,
        request_url: `https://events.example.test/v1/slack/events/${agentId}`,
        warnings: [],
      });
      manifests.push(structuredClone(slack.apps.get(appId)?.manifest));
    }
    expect(updates()).toBe(afterComputed + 2);
    expect(manifests[1]).toEqual(manifests[0]);
    expect(
      (manifests[0] as { settings: { event_subscriptions: object } }).settings
        .event_subscriptions,
    ).toMatchObject({
      request_url: `https://events.example.test/v1/slack/events/${agentId}`,
    });

    const bare = await agent(workspaceId);
    expect((await run(["finalize", "--agent", bare])).code).toBe(
      SLACK_APP_EXIT.agent_not_found,
    );
  });

  test("nothing printed carries a token or an app secret", () => {
    const secrets = [...slack.apps.values()].flatMap((app) => [
      app.clientSecret,
      app.signingSecret,
    ]);
    expect(secrets.length).toBeGreaterThan(0);
    const text = printed.join("\n");
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/xox[a-z]-/);
  });
});

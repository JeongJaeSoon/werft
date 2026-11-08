import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  BOT_SCOPES,
  SLACK_AGENT_BOT_EVENTS,
  scopesForRole,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentIdentities,
  agentReleases,
  agents,
  agentVersions,
  createPostgresAgentIdentityStore,
  createPostgresSecretStore,
  createPostgresSlackAppStore,
  createPostgresSlackConfigTokenStore,
  createPostgresSlackInboundEventStore,
  createPostgresSlackInstallStore,
  memberships,
  secretValues,
  slackApps,
  slackInboundEvents,
  slackInstallations,
  slackInstallStates,
  users,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import {
  callerFor,
  composeSlackFinalize,
  createAuthorizationPolicy,
  createSlackAppService,
  createSlackConfigApi,
  createSlackConfigTokens,
  createSlackEventsFinalize,
  createSlackEventsService,
  createSlackInstallService,
  createSlackSigningSecrets,
  MANAGEMENT_ROLES,
  SecretKey,
  SessionServiceError,
  type SlackInstalled,
} from "@werft-ai/platform";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const integration = testDatabaseUrl() ? describe : describe.skip;
const CONSOLE = "http://127.0.0.1:3000";

integration(
  "installing an agent's Slack app on PostgreSQL against a fake Slack",
  () => {
    let database: TempDatabase;
    let pool: Pool;
    let db: NodePgDatabase<typeof schema>;
    let slack: ReturnType<typeof startFakeSlackApi>;
    const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");
    const finalized: SlackInstalled[] = [];
    let clock = new Date();

    beforeAll(async () => {
      database = await createTempDatabase({ prefix: "slack_install" });
      pool = new Pool({ connectionString: database.url, max: 4 });
      db = drizzle(pool, { schema });
      slack = startFakeSlackApi({ teamId: "T0INSTALL", userId: "U0INSTALL" });
    }, 60_000);

    afterAll(async () => {
      await slack?.stop();
      await pool?.end();
      await database?.drop();
    });

    function services(publicUrl?: string | null) {
      const api = createSlackConfigApi({ apiUrl: slack.url });
      const tokens = createSlackConfigTokens({
        store: createPostgresSlackConfigTokenStore(db, key),
        api,
      });
      const authorization = createAuthorizationPolicy({});
      const apps = createPostgresSlackAppStore(db, key);
      const appService = createSlackAppService({
        authorization,
        apps,
        tokens,
        api,
        consoleOrigin: CONSOLE,
      });
      const record = async (installed: SlackInstalled) => {
        finalized.push(installed);
        return { finalized: true, warnings: [] };
      };
      return {
        tokens,
        apps: appService,
        install: createSlackInstallService({
          authorization,
          apps,
          states: createPostgresSlackInstallStore(db),
          secrets: createPostgresSecretStore(db, key),
          tokens,
          identities: createPostgresAgentIdentityStore(db),
          api,
          finalize:
            publicUrl === undefined
              ? record
              : composeSlackFinalize(
                  record,
                  createSlackEventsFinalize({
                    apps: appService,
                    agents: apps,
                    publicUrl,
                  }),
                ),
          now: () => clock,
        }),
      };
    }

    /** A workspace with its owner, a config token, and an agent with its app. */
    async function agentWithApp(publicUrl?: string | null) {
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
      await db
        .insert(memberships)
        .values({ workspaceId, userId, role: "owner" });
      const caller = callerFor(
        {
          kind: "user",
          id: userId,
          workspace_id: workspaceId,
          role: "owner",
          scopes: [...scopesForRole("owner")],
        },
        { kind: "web" },
        randomUUID(),
      );
      const { tokens, apps, install } = services(publicUrl);
      const stored = await tokens.register(
        workspaceId,
        slack.issueConfigToken(),
        {
          principal: caller,
          receiptId: randomUUID(),
          roles: MANAGEMENT_ROLES["workspace.manage"] ?? [],
        },
      );
      expect(stored.outcome).toBe("stored");

      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        workspaceId,
        managingTeamId: await fixtureTeam(db, workspaceId),
        slug: `notes-${agentId.slice(0, 8)}`,
        name: "Release notes",
      });
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
        runtimeProfileId: "coding",
        profileDigest: "digest",
        runtimeConfigSnapshot: {},
        effectiveTools: [],
      });
      await db
        .update(agents)
        .set({ activeReleaseId: releaseId, activationRevision: 1 })
        .where(eq(agents.id, agentId));
      const created = await apps.createAgentApp(caller, agentId, {
        replace_uncertain: false,
      });
      return {
        workspaceId,
        agentId,
        caller,
        install,
        slackAppId: created.slack_app.id,
        appId: created.slack_app.app_id ?? "",
      };
    }

    /** Slack's consent screen over HTTP, as the local stack's curl reaches it. */
    async function consent(authorizeUrl: string) {
      const query = new URL(authorizeUrl).search;
      const response = await fetch(
        `${slack.url.replace(/\/api$/, "")}/fake/oauth/authorize${query}`,
      );
      const body = (await response.json()) as { code: string; state: string };
      return { code: body.code, state: body.state };
    }

    const rowsFor = async (
      workspaceId: string,
      agentId: string,
      appId: string,
    ) => ({
      botTokens: await db
        .select({ id: secretValues.id })
        .from(secretValues)
        .where(
          and(
            eq(secretValues.workspaceId, workspaceId),
            eq(secretValues.purpose, "slack_bot_token"),
          ),
        ),
      installations: await db
        .select({ status: slackInstallations.status })
        .from(slackInstallations)
        .where(eq(slackInstallations.appId, appId)),
      identities: await db
        .select({
          status: agentIdentities.status,
          credentialRef: agentIdentities.credentialRef,
        })
        .from(agentIdentities)
        .where(eq(agentIdentities.agentId, agentId)),
    });

    test("start, consent and complete seal the bot token, verify the install, link the identity and finalize, in order", async () => {
      const setup = await agentWithApp();
      const { workspaceId, agentId, caller, install, slackAppId, appId } =
        setup;
      const started = await install.start(caller, agentId);
      const before = slack.calls.length;
      const { code, state } = await consent(started.authorize_url);
      const done = await install.complete(caller, {
        agent_id: agentId,
        state,
        code,
      });
      expect(slack.calls.slice(before).map((c) => c.method)).toEqual([
        "oauth.v2.access",
        "auth.test",
        "bots.info",
      ]);
      const [app] = await db
        .select({ botTokenRef: slackApps.botTokenRef })
        .from(slackApps)
        .where(eq(slackApps.id, slackAppId));
      expect(app?.botTokenRef).toBe(`slack_app:${slackAppId}/slack_bot_token`);
      expect(await rowsFor(workspaceId, agentId, appId)).toEqual({
        botTokens: [expect.any(Object)],
        installations: [{ status: "verified" }],
        identities: [
          {
            status: "active",
            credentialRef: `slack_app:${slackAppId}/slack_bot_token`,
          },
        ],
      });
      expect(done).toMatchObject({
        installation: {
          app_id: appId,
          team_id: "T0INSTALL",
          bot_user_id: `U${appId}BOT`,
          status: "verified",
        },
        agent_identity: { status: "active" },
        slack_app: { secrets: { slack_bot_token: { configured: true } } },
        finalized: true,
      });
      expect(finalized.filter((f) => f.agentId === agentId)).toHaveLength(1);
      expect(
        await db
          .select()
          .from(slackInstallStates)
          .where(eq(slackInstallStates.workspaceId, workspaceId)),
      ).toEqual([]);

      // Again with a new link: the token is replaced, the rows stay one each.
      const again = await consent(
        (await install.start(caller, agentId)).authorize_url,
      );
      const second = await install.complete(caller, {
        agent_id: agentId,
        ...again,
      });
      expect(second.receipt_id).toBeNull();
      expect(second.installation.id).toBe(done.installation.id);
      const rows = await rowsFor(workspaceId, agentId, appId);
      expect([
        rows.botTokens.length,
        rows.installations.length,
        rows.identities.length,
      ]).toEqual([1, 1, 1]);
      const text = JSON.stringify([done, second]);
      for (const value of [code, state, again.code, again.state]) {
        expect(text).not.toContain(value);
      }
      expect(text).not.toMatch(/xoxb-/);
    });

    test("an answer for another app or team, an org install or a missing scope leaves no token, install or identity", async () => {
      const { workspaceId, agentId, caller, install, appId } =
        await agentWithApp();
      const answers: Record<string, unknown>[] = [
        { app_id: "A0SOMEONEELSE" },
        { team: { id: "T0OTHER", name: "other" } },
        {
          is_enterprise_install: true,
          team: null,
          enterprise: { id: "E0ORG" },
        },
        { scope: BOT_SCOPES.filter((s) => s !== "users:read").join(",") },
      ];
      const reasons: unknown[] = [];
      for (const answer of answers) {
        Object.assign(slack.installAnswer, answer);
        const { code, state } = await consent(
          (await install.start(caller, agentId)).authorize_url,
        );
        const error = await install
          .complete(caller, { agent_id: agentId, state, code })
          .catch((e: unknown) => e);
        for (const field of Object.keys(answer))
          delete slack.installAnswer[field];
        expect(error).toBeInstanceOf(SessionServiceError);
        reasons.push([
          (error as SessionServiceError).code,
          (error as SessionServiceError).details,
        ]);
      }
      expect(reasons).toEqual([
        ["SLACK_INSTALL_REJECTED", { reason_code: "app" }],
        ["SLACK_INSTALL_REJECTED", { reason_code: "team" }],
        ["SLACK_INSTALL_REJECTED", { reason_code: "enterprise" }],
        [
          "SLACK_INSTALL_REJECTED",
          { reason_code: "scope", missing_scopes: ["users:read"] },
        ],
      ]);
      expect(await rowsFor(workspaceId, agentId, appId)).toEqual({
        botTokens: [],
        installations: [],
        identities: [],
      });
      const [app] = await db
        .select({ botTokenRef: slackApps.botTokenRef })
        .from(slackApps)
        .where(eq(slackApps.agentId, agentId));
      expect(app?.botTokenRef).toBeNull();
    });

    test("a state is spent by its first use and dropped once it expired", async () => {
      const { workspaceId, agentId, caller, install } = await agentWithApp();
      const first = await consent(
        (await install.start(caller, agentId)).authorize_url,
      );
      const denied = await install
        .complete(caller, {
          agent_id: agentId,
          state: first.state,
          error: "access_denied",
        })
        .catch((e: SessionServiceError) => e.code);
      const reused = await install
        .complete(caller, { agent_id: agentId, ...first })
        .catch((e: SessionServiceError) => e.details);
      expect([denied, reused]).toEqual([
        "SLACK_INSTALL_DENIED",
        { reason_code: "not_found" },
      ]);

      await install.start(caller, agentId);
      clock = new Date(clock.getTime() + 600_001);
      const late = await consent(
        (await install.start(caller, agentId)).authorize_url,
      );
      // Issuing the newest dropped the one that had expired.
      expect(
        await db
          .select({ agentId: slackInstallStates.agentId })
          .from(slackInstallStates)
          .where(eq(slackInstallStates.workspaceId, workspaceId)),
      ).toHaveLength(1);
      clock = new Date(clock.getTime() + 600_001);
      const expired = await install
        .complete(caller, { agent_id: agentId, ...late })
        .catch((e: SessionServiceError) => e.details);
      expect(expired).toEqual({ reason_code: "expired" });
      clock = new Date();
    });

    async function installed(publicUrl: string | null) {
      const setup = await agentWithApp(publicUrl);
      const started = await setup.install.start(setup.caller, setup.agentId);
      const answer = await consent(started.authorize_url);
      const updatesBefore = slack.calls.filter(
        (call) => call.method === "apps.manifest.update",
      ).length;
      const done = await setup.install.complete(setup.caller, {
        agent_id: setup.agentId,
        ...answer,
      });
      const updates =
        slack.calls.filter((call) => call.method === "apps.manifest.update")
          .length - updatesBefore;
      return { ...setup, done, updates };
    }

    const PUBLIC = "https://werft.example.ts.net:8443";

    test("with SLACK_EVENTS_PUBLIC_URL, complete registers the event subscription in the whole manifest", async () => {
      const { done, updates, appId, agentId } = await installed(`${PUBLIC}/`);
      expect(updates).toBe(1);
      expect(done).toMatchObject({ finalized: true, warnings: [] });
      const manifest = slack.apps.get(appId)?.manifest as {
        settings: {
          event_subscriptions: { request_url: string; bot_events: string[] };
        };
        oauth_config: unknown;
      };
      expect(manifest.settings.event_subscriptions).toEqual({
        request_url: `${PUBLIC}/v1/slack/events/${agentId}`,
        bot_events: [...SLACK_AGENT_BOT_EVENTS],
      });
      expect(manifest.settings.event_subscriptions.bot_events).toHaveLength(7);
      // apps.manifest.update replaces the whole manifest, scopes included.
      expect(manifest.oauth_config).toMatchObject({
        scopes: { bot: [...BOT_SCOPES] },
      });
    });

    test("without it, nothing is sent and complete still succeeds with events_url_unset", async () => {
      const { done, updates } = await installed(null);
      expect(updates).toBe(0);
      expect(done).toMatchObject({
        installation: { status: "verified" },
        finalized: false,
        warnings: [{ code: "events_url_unset" }],
      });
    });

    test("an update Slack answers with permissions_updated asks for a reinstall", async () => {
      slack.manifestUpdateAnswer.permissions_updated = true;
      try {
        const { done } = await installed(PUBLIC);
        expect(done).toMatchObject({
          finalized: true,
          warnings: [{ code: "reinstall_required" }],
        });
      } finally {
        delete slack.manifestUpdateAnswer.permissions_updated;
      }
    });

    test("an event signed with the installed app's secret lands in slack_inbound_events once", async () => {
      const { agentId, appId, workspaceId } = await installed(PUBLIC);
      const events = createSlackEventsService({
        signingSecrets: createSlackSigningSecrets({
          apps: createPostgresSlackAppStore(db, key),
          secrets: createPostgresSecretStore(db, key),
        }),
        inbox: createPostgresSlackInboundEventStore(db),
        apps: createPostgresSlackAppStore(db, key),
        identities: createPostgresAgentIdentityStore(db),
        installs: createPostgresSlackInstallStore(db),
      });
      const listener = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const outcome = await events.receive({
            agentId,
            rawBody: new Uint8Array(await request.arrayBuffer()),
            timestamp: request.headers.get("X-Slack-Request-Timestamp"),
            signature: request.headers.get("X-Slack-Signature"),
          });
          return Response.json(outcome, {
            status: outcome.kind === "unauthorized" ? 401 : 200,
          });
        },
      });
      try {
        const url = `http://127.0.0.1:${listener.port}/v1/slack/events/${agentId}`;
        const event = {
          type: "app_mention",
          user: "U0PERSON",
          text: "hello",
          channel: "C0CHAN",
          ts: "1761300000.000100",
        };
        const first = await slack.sendEvent({ url, appId, event });
        expect(first).toMatchObject({
          status: 200,
          body: { kind: "ack", result: "recorded", status: "received" },
        });
        const eventId = first.eventId ?? "";
        expect(
          await slack.sendEvent({ url, appId, event, eventId, retryNum: 1 }),
        ).toMatchObject({ status: 200, body: { result: "duplicate" } });
        expect(
          (await slack.sendEvent({ url, appId, event, ageSeconds: 301 }))
            .status,
        ).toBe(401);
        const rows = await db
          .select()
          .from(slackInboundEvents)
          .where(eq(slackInboundEvents.workspaceId, workspaceId));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          agentId,
          appId,
          teamId: "T0INSTALL",
          eventId,
          eventType: "app_mention",
          status: "received",
          dropReason: null,
        });

        const uninstalled = await slack.sendEvent({
          url,
          appId,
          event: { type: "app_uninstalled" },
        });
        expect(uninstalled.body).toMatchObject({ status: "processed" });
        const [install] = await db
          .select({ status: slackInstallations.status })
          .from(slackInstallations)
          .where(eq(slackInstallations.appId, appId));
        expect(install?.status).toBe("revoked");
      } finally {
        listener.stop(true);
      }
    });
  },
);

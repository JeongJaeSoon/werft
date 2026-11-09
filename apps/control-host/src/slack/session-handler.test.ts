import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import {
  agentCardRequestSchema,
  DEFAULT_SURFACE_CEILING,
  SESSION_SCOPE_VALUES,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agents,
  authzDecisions,
  createDatabaseIdentityReader,
  createPostgresAgentIdentityStore,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresSessionLinkStore,
  createPostgresSessionReader,
  createPostgresSlackAppStore,
  createPostgresSlackInboundEventStore,
  createPostgresSurfaceBindingStore,
  type Database,
  installationProfiles,
  linkedAccounts,
  memberships,
  registerSlackInstallation,
  sessionLinks,
  sessionShares,
  sessions,
  slackApps,
  slackInboundEvents,
  slackInstallations,
  surfaceBindings,
  turns,
  users,
  verifySlackInstallation,
  workspaces,
} from "@werft-ai/db";
import { migrate } from "@werft-ai/db/migrate";
import { createLogger } from "@werft-ai/observability";
import {
  type Caller,
  type CatalogProfile,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  drainSlackInbox,
  SecretKey,
  type SessionCatalog,
  type SlackInboundClaim,
  type SlackInboundEventStore,
  slackConversationKey,
  withSeededInstallation,
} from "@werft-ai/platform";
import { createMemorySlackNoticeSink } from "@werft-ai/platform/testing/slack";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { Pool } from "pg";
import {
  seedSettings,
  settingsCatalog,
  settingsDocument,
} from "../test-support/settings.ts";
import { slackSessionHandler } from "./main.ts";

const PROFILES = `profiles:
  general:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read]
    permission_mode: default
    repository: none
    provider:
      kind: anthropic
      endpoint: https://api.anthropic.invalid
      auth:
        kind: api_key
        value_env: PROVIDER_KEY
  coding:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read]
    permission_mode: default
    repository: required
    provider:
      kind: anthropic
      endpoint: https://api.anthropic.invalid
      auth:
        kind: api_key
        value_env: PROVIDER_KEY
  drafting:
    runtime_kind: claude_agent_sdk
    runtime_version: "0.3.270"
    model: claude-sonnet-5
    tools: [Read]
    permission_mode: default
    repository: optional
    provider:
      kind: anthropic
      endpoint: https://api.anthropic.invalid
      auth:
        kind: api_key
        value_env: PROVIDER_KEY
`;
const APP_ID = "A0NOTES";
const TEAM = "T0ACME";
const BOT_USER = "U0BOT";
const PERSON = "U0OWNER";
const CHANNEL = "C0OPS";
const BOT_CREDENTIAL = "fake-bot-credential";
const MANAGERS = ["owner", "admin"] as const;
const LIMITS = {
  EXECUTION_SLOT_LIMIT: "10",
  MAX_TURN_SECONDS: "3600",
  PROVIDER_MAX_RETRIES: "2",
  QUEUED_INPUT_LIMIT_PER_SESSION: "20",
  SESSION_COST_LIMIT_USD: "25",
  STORAGE_LIMIT_BYTES: "1073741824",
};

const slack = startFakeSlackApi({ teamId: TEAM });
slack.apps.set(APP_ID, {
  appId: APP_ID,
  clientId: "1.1",
  clientSecret: "unused",
  signingSecret: "unused",
  manifest: {},
  botTokens: [BOT_CREDENTIAL],
});
const logger = createLogger({ level: "error" });
const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");
const SETTINGS = settingsDocument(
  PROFILES,
  `connections:
  main:
    kind: anthropic
    endpoint: https://api.anthropic.invalid
    auth:
      kind: api_key
      value_env: PROVIDER_KEY
`,
  `repositories:
  notes-repo:
    url: https://github.com/acme/notes
    branch: main
    profiles: [coding]
    auth: {kind: github_app}
`,
);

afterAll(() => {
  slack.stop();
});

let db: Database;

const ENGINES = testDatabaseUrl() ? ["PostgreSQL"] : ["PGlite"];

function useDatabase(engine: string) {
  let close = async () => {};
  beforeEach(async () => {
    if (engine === "PGlite") {
      const client = new PGlite();
      const pglite = drizzle(client, { schema });
      await migrate(pglite, {
        migrationsFolder: `${import.meta.dir}/../../../../packages/db/migrations`,
      });
      db = pglite as unknown as Database;
      close = () => client.close();
    } else {
      const database = await createTempDatabase({ prefix: "slack_session" });
      const pool = new Pool({ connectionString: database.url, max: 8 });
      db = drizzlePostgres(pool, { schema });
      close = async () => {
        await pool.end();
        await database.drop();
      };
    }
    await seedSettings(db, SETTINGS);
    slack.statuses.length = 0;
    slack.failures.clear();
    slack.channels.clear();
  }, 60_000);
  afterEach(() => close());
}

type Fixture = Awaited<ReturnType<typeof agentInSlack>>;

async function agentInSlack(
  profileId = "general",
  options: {
    repositoryId?: string;
    /** The catalog the release is made against; the handler's stays as loaded. */
    releasedUnder?: (catalog: SessionCatalog) => SessionCatalog;
    activate?: boolean;
    mode?: "off" | "on";
    mentionOnly?: boolean;
  } = {},
) {
  const workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId,
    slug: `ws-${workspaceId.slice(0, 8)}`,
    name: "ws",
  });
  const ownerId = randomUUID();
  await db.insert(users).values({
    id: ownerId,
    email: `${ownerId}@example.invalid`,
    passwordHash: "argon2id$placeholder",
    displayName: "owner",
  });
  await db
    .insert(memberships)
    .values({ workspaceId, userId: ownerId, role: "owner" });
  const owner: Caller = callerFor(
    {
      kind: "user",
      id: ownerId,
      workspace_id: workspaceId,
      role: "owner",
      scopes: [...SESSION_SCOPE_VALUES],
    },
    { kind: "web" },
    randomUUID(),
  );
  const agentsService = createAgentService({
    authorization: createAuthorizationPolicy({
      identity: createDatabaseIdentityReader(db),
    }),
    store: createPostgresAgentStore(db),
    catalog: (options.releasedUnder ?? ((same) => same))(
      await settingsCatalog(db),
    ),
    credentials: createPostgresCredentialBindingStore(db),
  });
  const managingTeamId = randomUUID();
  await db
    .insert(schema.memberTeams)
    .values({ id: managingTeamId, workspaceId, name: "notes" });
  const created = await agentsService.createAgent(owner, {
    slug: "notes",
    name: "Notes",
    managing_team_id: managingTeamId,
    card: agentCardRequestSchema.parse({
      role: "r",
      instructions: "i",
      model: "claude-sonnet-5",
      capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
    }),
  });
  const agentId = created.agent.id;
  const { release } = await agentsService.createRelease(owner, agentId, {
    version_id: created.versions[0]?.id ?? "",
    runtime_profile_id: profileId,
    ...(options.repositoryId ? { repository_id: options.repositoryId } : {}),
  });
  if (options.activate !== false) {
    await agentsService.activateAgent(owner, agentId, {
      release_id: release.id,
      expected_revision: -1,
    });
  }

  const slackAppId = randomUUID();
  await db.insert(slackApps).values({
    id: slackAppId,
    workspaceId,
    kind: "agent",
    agentId,
    state: "created",
    appId: APP_ID,
    clientId: "1.1",
    redirectUrl: "https://console.example/cb",
  });
  await createPostgresSlackAppStore(db, key).storeBotToken({
    workspaceId,
    slackAppId,
    botToken: BOT_CREDENTIAL,
  });
  await registerSlackInstallation(db, {
    appId: APP_ID,
    teamId: TEAM,
    workspaceId,
  });
  await verifySlackInstallation(db, {
    appId: APP_ID,
    teamId: TEAM,
    botUserId: BOT_USER,
  });
  const linked = await createPostgresAgentIdentityStore(db).link({
    principal: owner,
    workspaceId,
    agentId,
    key: { appId: APP_ID, teamId: TEAM },
    credentialRef: "slack_bot_token",
    managerRoles: MANAGERS,
  });
  if (linked.outcome !== "linked") throw new Error(linked.outcome);
  const bound = await createPostgresSurfaceBindingStore(db).set({
    principal: owner,
    workspaceId,
    agentId,
    channelId: CHANNEL,
    channelKind: "public_channel",
    mode: options.mode ?? "on",
    home: false,
    ceiling: DEFAULT_SURFACE_CEILING,
    managerRoles: MANAGERS,
  });
  if (bound.outcome !== "set") throw new Error(bound.outcome);
  // Set after the channel was connected: it covers that channel too.
  if (options.mentionOnly === false) {
    await db
      .update(agents)
      .set({ slackMentionOnly: false })
      .where(eq(agents.id, agentId));
  }
  await db.insert(linkedAccounts).values({
    id: randomUUID(),
    workspaceId,
    userId: ownerId,
    provider: "slack",
    externalTenant: TEAM,
    externalUserId: PERSON,
    verifiedVia: "slack_oidc",
    verifiedAt: new Date(),
  });
  return { workspaceId, ownerId, agentId, slackAppId, releaseId: release.id };
}

let eventCounter = 0;

async function deliver(
  fixture: Fixture,
  event: Record<string, unknown>,
  options: { teamId?: string; thread?: boolean } = {},
) {
  eventCounter += 1;
  const eventId = `Ev${eventCounter}`;
  await createPostgresSlackInboundEventStore(db).record({
    workspaceId: fixture.workspaceId,
    agentId: fixture.agentId,
    slackAppId: fixture.slackAppId,
    teamId: options.teamId ?? TEAM,
    appId: APP_ID,
    eventId,
    eventType: String(event.type),
    eventSubtype: typeof event.subtype === "string" ? event.subtype : null,
    // Strictly later than the event before: two in one millisecond would
    // fall back to their random ids for thread order.
    eventTime: new Date(Date.now() + eventCounter),
    status: "received",
    payload: { type: "event_callback", event_id: eventId, event },
    conversationKey:
      options.thread === false
        ? null
        : slackConversationKey(fixture.slackAppId, event),
  });
}

const mention = (ts: string, extra: Record<string, unknown> = {}) => ({
  type: "app_mention",
  channel: CHANNEL,
  user: PERSON,
  ts,
  text: `<@${BOT_USER}> summarize the thread`,
  ...extra,
});

const message = (ts: string, extra: Record<string, unknown> = {}) => ({
  type: "message",
  channel: CHANNEL,
  channel_type: "channel",
  user: PERSON,
  ts,
  text: "and the next step",
  ...extra,
});

/** The root post again, as the message event Slack sends beside the mention. */
const rootMessage = (ts: string) =>
  message(ts, { text: `<@${BOT_USER}> summarize the thread` });

function handler(inbox?: Pick<SlackInboundEventStore, "renew">) {
  const notices = createMemorySlackNoticeSink();
  return {
    notices: notices.notices,
    handle: slackSessionHandler({
      db,
      pool: {
        connect: () => {
          throw new Error("no session control is asked of this role");
        },
      },
      environment: LIMITS,
      logger,
      secretKey: key,
      leaseMs: 30_000,
      notices: notices.sink,
      slackApiUrl: slack.url,
      ...(inbox === undefined ? {} : { inbox }),
    }),
  };
}

async function drain(handle: ReturnType<typeof handler>["handle"]) {
  return drainSlackInbox({
    inbox: createPostgresSlackInboundEventStore(db),
    handler: handle,
    logger,
    batchSize: 10,
    leaseMs: 30_000,
    deadline: Date.now() + 10_000,
  });
}

async function claimAll(leaseMs: number): Promise<SlackInboundClaim[]> {
  return createPostgresSlackInboundEventStore(db).claim({
    limit: 10,
    leaseMs,
    maxAttempts: 5,
  });
}

const sessionsOf = (fixture: Fixture) =>
  db
    .select()
    .from(sessions)
    .where(eq(sessions.workspaceId, fixture.workspaceId))
    .orderBy(asc(sessions.createdAt));

const turnsOf = (sessionId: string | undefined) =>
  db
    .select({
      sequence: turns.sequence,
      message: turns.message,
      actorId: turns.actorId,
    })
    .from(turns)
    .where(eq(turns.sessionId, sessionId ?? ""))
    .orderBy(asc(turns.sequence));

const links = () => db.select().from(sessionLinks);

/** The thread's link as a pass that died right after reserving it left it. */
async function reserveThread(fixture: Fixture) {
  const [installation] = await db.select().from(slackInstallations);
  const [binding] = await db.select().from(surfaceBindings);
  await createPostgresSessionLinkStore(db).reserve({
    workspaceId: fixture.workspaceId,
    installationId: installation?.id ?? "",
    surfaceBindingId: binding?.id ?? "",
    surfaceRef: `${CHANNEL}:100.000100`,
    channelId: CHANNEL,
    threadId: "100.000100",
    openedByTs: "100.000100",
    agentId: fixture.agentId,
    releaseId: fixture.releaseId,
    profileId: "general",
    createdBy: fixture.ownerId,
  });
}

const inboxStatuses = async () =>
  (
    await db
      .select({ status: slackInboundEvents.status })
      .from(slackInboundEvents)
      .orderBy(asc(slackInboundEvents.receivedAt))
  ).map((row) => row.status);

describe.each(ENGINES)("Slack thread sessions on %s", (engine) => {
  useDatabase(engine);

  test("a mention opens the thread's session; its next post, unmentioned, is turn 2", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await deliver(fixture, message("100.000200", { thread_ts: "100.000100" }));
    expect(await drain(handle)).toMatchObject({ processed: 2 });

    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    expect(session).toMatchObject({
      agentReleaseId: fixture.releaseId,
      createdByUserId: fixture.ownerId,
      channel: "slack",
    });
    const by = fixture.ownerId;
    expect(await turnsOf(session?.id)).toEqual([
      { sequence: 1, message: "summarize the thread", actorId: by },
      { sequence: 2, message: "and the next step", actorId: by },
    ]);
    const [link] = await links();
    expect(link).toMatchObject({
      sessionId: session?.id,
      surfaceRef: `${CHANNEL}:100.000100`,
      channelId: CHANNEL,
      threadId: "100.000100",
      openedByTs: "100.000100",
      releaseId: fixture.releaseId,
      profileId: "general",
      createdBy: fixture.ownerId,
    });
    const allowed = await db
      .select({ linkedAccountId: authzDecisions.linkedAccountId })
      .from(authzDecisions)
      .where(eq(authzDecisions.outcome, "allow"));
    const [account] = await db.select().from(linkedAccounts);
    expect(allowed.map((row) => row.linkedAccountId)).toEqual(
      Array(4).fill(account?.id ?? ""),
    );
    // The handler sends no status itself: each turn's insert marks the
    // thread due for the outbox pass's status writer.
    expect(slack.statuses).toEqual([]);
    const { rows: due } = (await db.execute(
      sql`SELECT session_link_id, dirty_rev > sent_rev AS due FROM slack_thread_status`,
    )) as unknown as { rows: { session_link_id: string; due: boolean }[] };
    expect(due).toEqual([{ session_link_id: link?.id ?? "", due: true }]);
    expect(notices).toEqual([]);
  });

  test("another thread is another session", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    await deliver(fixture, mention("100.000100"));
    await deliver(fixture, mention("200.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toHaveLength(2);
    const threads = (await links()).map((link) => link.threadId).sort();
    expect(threads).toEqual(["100.000100", "200.000100"]);
  });

  test("app_mention and message of one post make one turn, root or reply", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    await deliver(fixture, mention("100.000100"));
    await deliver(fixture, rootMessage("100.000100"));
    const reply = message("100.000300", {
      thread_ts: "100.000100",
      text: `<@${BOT_USER}> more`,
    });
    await deliver(fixture, reply);
    await deliver(fixture, { ...reply, type: "app_mention" });
    await drain(handle);
    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    const said = (await turnsOf(session?.id)).map((turn) => turn.message);
    expect(said).toEqual(["summarize the thread", "more"]);
  });

  test("an unlinked person gets no session and one notice per thread", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    const stranger = { user: "U0STRANGER" };
    await deliver(fixture, mention("100.000100", stranger));
    await deliver(
      fixture,
      mention("100.000200", { ...stranger, thread_ts: "100.000100" }),
    );
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(await links()).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      slackAppId: fixture.slackAppId,
      teamId: TEAM,
      channelId: CHANNEL,
      threadTs: "100.000100",
      slackUserId: "U0STRANGER",
      reason: "unlinked",
    });
    expect(notices[0]?.notice.message).toBe("connect");
    expect(await inboxStatuses()).toEqual(["processed", "processed"]);
  });

  test("a release with a repository opens the thread's session on it", async () => {
    const fixture = await agentInSlack("coding", {
      repositoryId: "notes-repo",
    });
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(notices).toEqual([]);
    const opened = await sessionsOf(fixture);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      profileId: "coding",
      repositoryId: "notes-repo",
      repoUrl: "https://github.com/acme/notes",
      agentReleaseId: fixture.releaseId,
    });
  });

  test("an agent with no active release says so in the thread", async () => {
    const fixture = await agentInSlack("general", { activate: false });
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      reason: "no_active_release",
      notice: { message: "noActiveRelease" },
    });
    expect(await inboxStatuses()).toEqual(["processed"]);
  });

  test("a release whose profile left the catalog says so in the thread", async () => {
    const fixture = await agentInSlack("retired", {
      releasedUnder: (loaded) => ({
        ...loaded,
        profiles: {
          ...loaded.profiles,
          retired: loaded.profiles.general as CatalogProfile,
        },
      }),
    });
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      reason: "profile_unavailable",
      notice: { message: "profileUnavailable" },
    });
    expect(await inboxStatuses()).toEqual(["processed"]);
  });

  test("a reply in a thread whose profile the operator blocked since queues nothing and says so", async () => {
    const fixture = await agentInSlack("general");
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    await db
      .update(installationProfiles)
      .set({ blockedAt: new Date(), blockedBy: fixture.ownerId })
      .where(eq(installationProfiles.id, "general"));
    // A profile read within the last second is not read again.
    await Bun.sleep(1_100);
    await deliver(
      fixture,
      message("100.000300", { thread_ts: "100.000100", text: "more" }),
    );
    await drain(handle);
    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    expect((await turnsOf(session?.id)).map((turn) => turn.message)).toEqual([
      "summarize the thread",
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      reason: "profile_unavailable",
      notice: { message: "profileUnavailable" },
    });
  });

  test("a release whose profile the operator blocked says so in the thread", async () => {
    const fixture = await agentInSlack("general");
    await db
      .update(installationProfiles)
      .set({ blockedAt: new Date(), blockedBy: fixture.ownerId })
      .where(eq(installationProfiles.id, "general"));
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      reason: "profile_unavailable",
      notice: { message: "profileUnavailable" },
    });
    expect(await inboxStatuses()).toEqual(["processed"]);
  });

  test("a release made before its profile needed a repository says so in the thread, once", async () => {
    // The repository mode is not part of the profile's fingerprint, so the
    // release still verifies once the catalog requires one.
    const fixture = await agentInSlack("coding", {
      releasedUnder: (loaded) => ({
        ...loaded,
        profiles: {
          ...loaded.profiles,
          coding: {
            ...(loaded.profiles.coding as CatalogProfile),
            repository: "optional",
          },
        },
      }),
    });
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await deliver(fixture, mention("100.000200", { thread_ts: "100.000100" }));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      agentId: fixture.agentId,
      channelId: CHANNEL,
      threadTs: "100.000100",
      slackUserId: PERSON,
      reason: "repository_required",
      notice: { message: "repositoryRequired" },
    });
    expect(await inboxStatuses()).toEqual(["processed", "processed"]);
  });

  test("a release whose repository left the catalog says so, even for a profile that may run without one", async () => {
    const fixture = await agentInSlack("drafting", {
      repositoryId: "old-repo",
      releasedUnder: (loaded) =>
        withSeededInstallation({
          ...loaded,
          repositories: {
            ...loaded.repositories,
            "old-repo": {
              ...(loaded.repositories[
                "notes-repo"
              ] as SessionCatalog["repositories"][string]),
              profiles: ["drafting"],
            },
          },
        }),
    });
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      reason: "repository_required",
      notice: { message: "repositoryRequired" },
    });
  });

  test("unmentioned posts outside a linked thread and the bot's own or edited posts are ignored", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    await deliver(fixture, message("100.000100"));
    await deliver(fixture, message("100.000200", { thread_ts: "100.000100" }));
    await deliver(fixture, mention("300.000100", { user: BOT_USER }));
    await deliver(fixture, mention("300.000200", { bot_id: "B0OTHER" }));
    await deliver(fixture, rootMessage("300.000300"));
    await deliver(
      fixture,
      message("300.000400", { subtype: "message_changed" }),
    );
    await deliver(
      fixture,
      message("300.000500", { subtype: "message_deleted" }),
    );
    await drain(handle);
    const opened = await links();
    expect(opened.map((link) => link.threadId)).toEqual(["300.000300"]);
    expect(notices).toEqual([]);
    expect(await inboxStatuses()).toEqual(Array(7).fill("processed"));
  });

  test("an agent not waiting for a mention opens a session on an unmentioned top-level post, not on a stray reply", async () => {
    const fixture = await agentInSlack("general", { mentionOnly: false });
    const { handle, notices } = handler();
    await deliver(fixture, message("100.000100"));
    await deliver(fixture, message("100.000200", { thread_ts: "100.000100" }));
    await deliver(fixture, message("200.000200", { thread_ts: "200.000100" }));
    // Someone not linked who did not ask the agent is not told anything.
    await deliver(fixture, message("300.000100", { user: "U0STRANGER" }));
    await deliver(fixture, message("400.000100", { bot_id: "B0OTHER" }));
    await deliver(
      fixture,
      message("500.000100", { subtype: "message_changed" }),
    );
    await drain(handle);
    expect((await links()).map((link) => link.threadId)).toEqual([
      "100.000100",
    ]);
    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    expect((await turnsOf(session?.id)).map((turn) => turn.message)).toEqual([
      "and the next step",
      "and the next step",
    ]);
    expect(notices).toEqual([]);
  });

  test("an unused channel takes no unmentioned post", async () => {
    const fixture = await agentInSlack("general", {
      mode: "off",
      mentionOnly: false,
    });
    const { handle, notices } = handler();
    await deliver(fixture, message("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("a bot's reply in a linked thread is no turn", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    const inThread = { thread_ts: "100.000100" };
    await deliver(fixture, mention("100.000100"));
    await deliver(
      fixture,
      message("100.000200", { ...inThread, user: BOT_USER }),
    );
    await deliver(
      fixture,
      message("100.000300", { ...inThread, bot_id: "B0X" }),
    );
    await drain(handle);
    const [session] = await sessionsOf(fixture);
    expect(await turnsOf(session?.id)).toHaveLength(1);
  });

  test("another team's event opens nothing", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"), { teamId: "T0ELSE" });
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("a DM opens a private session on the DM binding it makes", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    await deliver(fixture, {
      type: "message",
      channel: "D0OWNER",
      channel_type: "im",
      user: PERSON,
      ts: "100.000100",
      text: "hello",
    });
    await drain(handle);
    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    expect(
      await db
        .select({ scope: sessionShares.scope, ownerId: sessionShares.ownerId })
        .from(sessionShares)
        .where(eq(sessionShares.sessionId, session?.id ?? "")),
    ).toEqual([{ scope: "private", ownerId: fixture.workspaceId }]);
    const dm = await db
      .select()
      .from(surfaceBindings)
      .where(eq(surfaceBindings.surfaceKind, "dm"));
    expect(dm).toHaveLength(1);
    expect(dm[0]).toMatchObject({ mode: "on", externalSurfaceId: null });
  });

  test("concurrent first DMs make one DM binding", async () => {
    const fixture = await agentInSlack();
    const [installation] = await db.select().from(slackInstallations);
    const store = createPostgresSurfaceBindingStore(db);
    const made = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.ensureDmBinding(installation?.id ?? ""),
      ),
    );
    expect(new Set(made.map((binding) => binding?.id)).size).toBe(1);
    const rows = await db
      .select()
      .from(surfaceBindings)
      .where(eq(surfaceBindings.agentId, fixture.agentId));
    expect(rows).toHaveLength(2);
  });

  test("a channel Slack reports as another kind than its binding is refused with a notice", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    await deliver(fixture, {
      ...rootMessage("100.000100"),
      channel_type: "group",
    });
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices.map((notice) => notice.reason)).toEqual([
      "channel_kind_mismatch",
    ]);
  });

  test("a mention in a channel Slack now reports private is refused with a notice", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    slack.channels.set(CHANNEL, { isPrivate: true });
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices.map((notice) => notice.reason)).toEqual([
      "channel_kind_mismatch",
    ]);
  });

  test("a decision that fails is tried again, with no notice", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    await db.execute(
      sql`ALTER TABLE authz_decisions RENAME TO authz_decisions_away`,
    );
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toEqual([]);
    expect(await inboxStatuses()).toEqual(["received"]);
  });

  test("a thread status Slack refuses or fails on stops nothing", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    slack.failures.set("agents.sessions.setStatus", "not_authorized");
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    slack.failures.set("agents.sessions.setStatus", "internal_error");
    await deliver(fixture, mention("200.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toHaveLength(2);
    expect(await inboxStatuses()).toEqual(["processed", "processed"]);
  });

  test("each turn keeps the Slack message it came from and its permalink, read back on the turn and the session", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    await deliver(fixture, mention("100.000100"));
    await deliver(fixture, message("100.000200", { thread_ts: "100.000100" }));
    await drain(handle);
    const [session] = await sessionsOf(fixture);
    const stored = await db
      .select({ slackMessage: turns.slackMessage })
      .from(turns)
      .where(eq(turns.sessionId, session?.id ?? ""))
      .orderBy(asc(turns.sequence));
    const archive = `https://${TEAM.toLowerCase()}.slack.com/archives/${CHANNEL}`;
    expect(stored.map((row) => row.slackMessage)).toEqual([
      {
        team_id: TEAM,
        channel_id: CHANNEL,
        ts: "100.000100",
        thread_ts: null,
        permalink: `${archive}/p100000100`,
      },
      {
        team_id: TEAM,
        channel_id: CHANNEL,
        ts: "100.000200",
        thread_ts: "100.000100",
        // The fake knows no threads: a reply links like a root post.
        permalink: `${archive}/p100000200`,
      },
    ]);

    const reader = createPostgresSessionReader(db);
    const owner = session?.ownerId ?? "";
    const listed = await reader.listTurns(owner, session?.id ?? "", {
      limit: 10,
    });
    expect(listed?.items.map((turn) => turn.slack_permalink)).toEqual([
      `${archive}/p100000100`,
      `${archive}/p100000200`,
    ]);
    expect(
      (await reader.getSession(owner, session?.id ?? ""))?.slack_permalink,
    ).toBe(`${archive}/p100000100`);
  });

  test("a permalink Slack refuses leaves the turn without one and opens the session all the same", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    slack.failures.set("chat.getPermalink", "channel_not_found");
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    const [session] = await sessionsOf(fixture);
    const [turn] = await db
      .select({ slackMessage: turns.slackMessage })
      .from(turns)
      .where(eq(turns.sessionId, session?.id ?? ""));
    expect(turn?.slackMessage).toEqual({
      team_id: TEAM,
      channel_id: CHANNEL,
      ts: "100.000100",
      thread_ts: null,
      permalink: null,
    });
    expect(
      (
        await createPostgresSessionReader(db).getSession(
          session?.ownerId ?? "",
          session?.id ?? "",
        )
      )?.slack_permalink,
    ).toBeNull();
    expect(await inboxStatuses()).toEqual(["processed"]);
  });

  test("concurrent first posts of one thread make one session", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    await deliver(fixture, mention("100.000100"), { thread: false });
    await deliver(fixture, rootMessage("100.000100"), { thread: false });
    const claims = await claimAll(30_000);
    expect(claims).toHaveLength(2);
    await Promise.all(claims.map((claim) => handle(claim)));
    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    expect(await turnsOf(session?.id)).toHaveLength(1);
    expect(await links()).toHaveLength(1);
  });

  test("a pass that died after reserving the thread leaves one session once retried", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100"));
    const [claim] = await claimAll(1);
    expect(claim).toBeDefined();
    await reserveThread(fixture);
    await Bun.sleep(20);
    await drain(handler().handle);
    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    const [link] = await links();
    expect(link?.sessionId).toBe(session?.id ?? "");
  });

  test("a session made before its link knew it stays the thread's one session", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    await db.update(sessionLinks).set({ sessionId: null });
    await deliver(fixture, message("100.000200", { thread_ts: "100.000100" }));
    await drain(handle);
    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    const said = (await turnsOf(session?.id)).map((turn) => turn.message);
    expect(said).toEqual(["summarize the thread", "and the next step"]);
    const [link] = await links();
    expect(link?.sessionId).toBe(session?.id ?? "");
  });

  test("a post that opens the thread in place of its spent first post is one turn, however often it comes", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    await reserveThread(fixture);
    const reply = message("100.000200", {
      thread_ts: "100.000100",
      text: `<@${BOT_USER}> more`,
    });
    await deliver(fixture, reply);
    await drain(handle);
    await deliver(fixture, { ...reply, type: "app_mention" });
    await drain(handle);
    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    const said = (await turnsOf(session?.id)).map((turn) => turn.message);
    expect(said).toEqual(["more"]);
    const [link] = await links();
    expect(link).toMatchObject({
      sessionId: session?.id,
      openedByTs: "100.000200",
    });
  });

  test("a lease lost before the effects makes nothing; so does an uninstall since the claim", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100"));
    const [expired] = await claimAll(1);
    await Bun.sleep(20);
    await expect(
      handler().handle(expired as SlackInboundClaim),
    ).rejects.toThrow("lease lost");
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(await links()).toEqual([]);

    const inbox = createPostgresSlackInboundEventStore(db);
    const revoking = handler({
      async renew(fence, leaseMs) {
        await db
          .update(slackInstallations)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(eq(slackInstallations.appId, APP_ID));
        return inbox.renew(fence, leaseMs);
      },
    });
    const [held] = await claimAll(30_000);
    await expect(
      revoking.handle(held as SlackInboundClaim),
    ).rejects.toMatchObject({ reason: "installation_revoked" });
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(await links()).toEqual([]);
  });
});

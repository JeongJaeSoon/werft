import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createRowDelivery,
  createSlackAudienceCache,
  createSlackBotApi,
  createSlackChannelSharingReader,
  drainSlackInbox,
  drainSlackOutbox,
  type SlackAudienceCache,
  slackBotToken,
  slackConversationKey,
} from "@werft-ai/chat-slack";
import { createMemorySlackNoticeSink } from "@werft-ai/chat-slack/testing/slack";
import {
  agentCardRequestSchema,
  BOT_SCOPES,
  CONVERSATION_TURN_LEASE_MS,
  CONVERSATION_TURN_TEXT_MAX,
  type ConversationDecision,
  type ConversationId,
  type ConversationInputId,
  type ConversationTurnId,
  type ConversationTurnResult,
  conversationCallIdSchema,
  conversationDecisionTools,
  conversationRuntimeIdSchema,
  conversationTurnLeaseIdSchema,
  DEFAULT_SURFACE_CEILING,
  GITHUB_CEILING_NONE,
  SESSION_SCOPE_VALUES,
  SLACK_INBOUND_MAX_ATTEMPTS,
  SLACK_NOTICE_MESSAGES,
  TASK_CLOSING_DEFAULT,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agents,
  authzDecisions,
  createDatabaseIdentityReader,
  createPostgresAgentIdentityStore,
  createPostgresAgentStore,
  createPostgresConversationCalls,
  createPostgresConversationReadToolStore,
  createPostgresConversationStore,
  createPostgresConversationTurnQueue,
  createPostgresCredentialBindingStore,
  createPostgresGitHubMcpStore,
  createPostgresMentionTurnStatuses,
  createPostgresSecretStore,
  createPostgresSessionLinkStore,
  createPostgresSessionReader,
  createPostgresSessionShareStore,
  createPostgresSessionStops,
  createPostgresSlackAppStore,
  createPostgresSlackInboundEventStore,
  createPostgresSurfaceBindingStore,
  createPostgresTopicTurnContexts,
  type Database,
  linkedAccounts,
  memberships,
  providerConnections,
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
import { createLogger } from "@werft-ai/observability";
import {
  type Caller,
  callerFor,
  conversationCallReserve,
  createAgentService,
  createAuthorizationPolicy,
  createSurfaceBindingService,
  createTopicSessionChecks,
  hashConversationCallToken,
  type MentionTurnStatusStore,
  SecretKey,
  type SessionCatalog,
  type SurfaceInboundClaim,
  type SurfaceInboundEventStore,
} from "@werft-ai/platform";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { Pool } from "pg";
import { OPERATOR_TURN_TAKE_MS } from "../api/conversation-runtime.ts";
import { TEST_RUNTIMES } from "../testing/catalog.ts";
import {
  seedSettings,
  settingsCatalog,
  settingsDocument,
} from "../testing/settings.ts";
import {
  slackCatalog,
  slackConversationTasks,
  slackInbox,
  slackMentionTurnEndings,
  slackSessionHandler,
} from "./main.ts";

const APP_ID = "A0NOTES";
const TEAM = "T0ACME";
const BOT_USER = "U0BOT";
const PERSON = "U0OWNER";
const CHANNEL = "C0OPS";
const BOT_CREDENTIAL = "fake-bot-credential";
const MANAGERS = ["owner", "admin"] as const;
const LIMITS = {
  EXECUTION_SLOT_LIMIT: "10",
  QUEUED_INPUT_LIMIT_PER_SESSION: "20",
  SESSION_COST_LIMIT_USD: "25",
  STORAGE_LIMIT_BYTES: "1073741824",
};

const slack = startFakeSlackApi({ teamId: TEAM });
const OTHER_APP_ID = "A0REVIEW";
for (const appId of [APP_ID, OTHER_APP_ID])
  slack.apps.set(appId, {
    appId,
    clientId: "1.1",
    clientSecret: "unused",
    signingSecret: "unused",
    manifest: {},
    botTokens: [BOT_CREDENTIAL],
  });
const logger = createLogger({ level: "error" });
const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");
const SETTINGS = settingsDocument(
  `connections:
  main:
    kind: anthropic
    endpoint: https://api.anthropic.invalid
    models: [claude-sonnet-5]
    auth:
      kind: api_key
      stored: true
`,
  `repositories:
  notes-repo:
    url: https://github.com/acme/notes
    branch: main
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
      const client = await migratedPGlite();
      const pglite = drizzle(client, { schema });
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
  connectionId = "main",
  options: {
    repositoryId?: string;
    /** The catalog the release is made against; the handler's stays as loaded. */
    releasedUnder?: (catalog: SessionCatalog) => SessionCatalog;
    activate?: boolean;
    mode?: "off" | "on";
    mentionOnly?: boolean;
    channelKind?: "public_channel" | "private_channel";
    /** Another app makes another agent in the same Slack team and channel. */
    appId?: string;
    /** False leaves PERSON unlinked, as their Slack account links once. */
    linkPerson?: boolean;
    listen?: "free" | "mention" | "off";
    rollout?: "off" | "shadow" | "on";
  } = {},
) {
  const appId = options.appId ?? APP_ID;
  const workspaceId = randomUUID();
  await db.insert(workspaces).values({
    id: workspaceId,
    slug: `ws-${workspaceId.slice(0, 8)}`,
    name: "ws",
  });
  if (options.repositoryId !== undefined) {
    // A session's repository is judged by the workspace's ceiling alone.
    await db.insert(schema.githubWorkspaceSettings).values({
      workspaceId,
      ceiling: GITHUB_CEILING_NONE,
      repositoryCeiling: {
        repository_ids: [options.repositoryId],
        github_app_repositories: "listed",
      },
    });
  }
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
    runtimes: TEST_RUNTIMES,
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
    connection_id: connectionId,
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
    appId,
    clientId: "1.1",
    redirectUrl: "https://console.example/cb",
  });
  await createPostgresSlackAppStore(db, key).storeBotToken({
    workspaceId,
    slackAppId,
    scopes: [...BOT_SCOPES],
    botToken: BOT_CREDENTIAL,
  });
  await registerSlackInstallation(db, {
    appId,
    teamId: TEAM,
    workspaceId,
  });
  await verifySlackInstallation(db, {
    appId,
    teamId: TEAM,
    botUserId: BOT_USER,
  });
  const linked = await createPostgresAgentIdentityStore(db).link({
    principal: owner,
    workspaceId,
    agentId,
    key: { appId, teamId: TEAM },
    credentialRef: "slack_bot_token",
    managerRoles: MANAGERS,
  });
  if (linked.outcome !== "linked") throw new Error(linked.outcome);
  const bound = await createPostgresSurfaceBindingStore(db).set({
    principal: owner,
    workspaceId,
    agentId,
    channelId: CHANNEL,
    channelKind: options.channelKind ?? "public_channel",
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
  if (options.rollout !== undefined) {
    await db
      .update(agents)
      .set({ conversationRollout: options.rollout })
      .where(eq(agents.id, agentId));
  }
  if (options.listen !== undefined) {
    await db
      .update(surfaceBindings)
      .set({ listen: options.listen })
      .where(eq(surfaceBindings.id, bound.binding.id));
  }
  if (options.linkPerson !== false)
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
  return {
    workspaceId,
    ownerId,
    owner,
    agentId,
    slackAppId,
    appId,
    releaseId: release.id,
    bindingId: bound.binding.id,
  };
}

let eventCounter = 0;

async function deliver(
  fixture: Fixture,
  event: Record<string, unknown>,
  options: { teamId?: string; thread?: boolean; eventId?: string } = {},
) {
  eventCounter += 1;
  const eventId = options.eventId ?? `Ev${eventCounter}`;
  return createPostgresSlackInboundEventStore(db).record({
    workspaceId: fixture.workspaceId,
    agentId: fixture.agentId,
    slackAppId: fixture.slackAppId,
    teamId: options.teamId ?? TEAM,
    appId: fixture.appId,
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

/** A join/leave event_ts that many seconds after now, so after any approval. */
const lifecycleTs = (seconds: number) =>
  `${Math.floor(Date.now() / 1000) + seconds}.000100`;

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

function handler(
  inbox?: Pick<SurfaceInboundEventStore, "renew">,
  log: typeof logger = logger,
  audienceCache?: SlackAudienceCache,
) {
  const notices = createMemorySlackNoticeSink();
  // A pass reads the catalog before its first event (main); here each event
  // reads it, so a setting changed between two deliveries is seen.
  const catalog = slackCatalog(db, LIMITS);
  const handle = slackSessionHandler({
    catalog,
    db,
    pool: {
      connect: () => {
        throw new Error("no session control is asked of this role");
      },
    },
    environment: LIMITS,
    logger: log,
    secretKey: key,
    leaseMs: 30_000,
    notices: notices.sink,
    slackApiUrl: slack.url,
    ...(inbox === undefined ? {} : { inbox }),
    ...(audienceCache === undefined ? {} : { audienceCache }),
  });
  return {
    notices: notices.notices,
    threadNotices: notices.threadNotices,
    sink: notices.sink,
    handle: async (claim: SurfaceInboundClaim) => {
      await catalog.refresh();
      return handle(claim);
    },
  };
}

async function drain(
  handle: ReturnType<typeof handler>["handle"],
  inbox: SurfaceInboundEventStore = createPostgresSlackInboundEventStore(db),
) {
  return drainSlackInbox({
    inbox,
    handler: handle,
    logger,
    concurrency: 4,
    leaseMs: 30_000,
    deadline: Date.now() + 10_000,
  });
}

async function claimAll(leaseMs: number): Promise<SurfaceInboundClaim[]> {
  return createPostgresSlackInboundEventStore(db).claim({
    limit: 10,
    leaseMs,
    maxAttempts: 5,
  });
}

/**
 * Leases every received row at once, channel lines aside. The claim hands a
 * channel one row at a time, but a row whose lease ran out mid-effect can
 * still be running when the next one of its channel is taken; this is the
 * handler meeting that.
 */
async function claimSideBySide(
  leaseMs: number,
): Promise<SurfaceInboundClaim[]> {
  const t = schema.slackInboundEvents;
  const rows = await db
    .update(t)
    .set({
      claimToken: sql`gen_random_uuid()`,
      leaseExpiresAt: sql`now() + make_interval(secs => ${leaseMs / 1000})`,
      attempts: sql`${t.attempts} + 1`,
    })
    .where(eq(t.status, "received"))
    .returning();
  const installs = await db.select().from(schema.slackInstallations);
  return rows
    .sort(
      (a, b) => (a.eventTime?.getTime() ?? 0) - (b.eventTime?.getTime() ?? 0),
    )
    .map((row) => ({
      id: row.id,
      claimToken: row.claimToken as string,
      attempts: row.attempts,
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      slackAppId: row.slackAppId,
      teamId: row.teamId,
      appId: row.appId,
      eventId: row.eventId,
      eventType: row.eventType,
      eventSubtype: row.eventSubtype,
      eventTime: row.eventTime,
      conversationKey: row.conversationKey,
      payload: row.payload as Record<string, unknown>,
      installationStatus:
        installs.find(
          (install) =>
            install.appId === row.appId && install.teamId === row.teamId,
        )?.status ?? null,
    }));
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

/** Renews the lease the handler holds for its effects to 50 ms only. */
const shortLease: Pick<SurfaceInboundEventStore, "renew"> = {
  renew: (fence) => createPostgresSlackInboundEventStore(db).renew(fence, 50),
};

const inputsOf = (fixture: Fixture) =>
  db
    .select({
      topicId: schema.conversationInputs.topicId,
      seq: schema.conversationInputs.seq,
      channelId: schema.conversationInputs.slackChannelId,
      ts: schema.conversationInputs.slackTs,
      requesterKind: schema.conversationInputs.requesterKind,
      requesterId: schema.conversationInputs.requesterId,
      turnId: schema.conversationInputs.turnId,
    })
    .from(schema.conversationInputs)
    .where(eq(schema.conversationInputs.agentId, fixture.agentId))
    .orderBy(
      asc(schema.conversationInputs.topicId),
      asc(schema.conversationInputs.seq),
    );

const engagementsOf = (fixture: Fixture) =>
  db
    .select({
      channelId: schema.conversationEngagements.channelId,
      ts: schema.conversationEngagements.ts,
      kind: schema.conversationEngagements.kind,
      sessionId: schema.conversationEngagements.sessionId,
    })
    .from(schema.conversationEngagements)
    .where(eq(schema.conversationEngagements.agentId, fixture.agentId))
    .orderBy(asc(schema.conversationEngagements.ts));

const turnIdsOf = async (sessionId: string | undefined) =>
  (
    await db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.sessionId, sessionId ?? ""))
      .orderBy(asc(turns.sequence))
  ).map((turn) => turn.id);

/**
 * Leaves the turn of the post at `ts` as an image that took the input only
 * on the inbox row's completion left it after dying: no input, no
 * engagement, and no input named in any source key.
 */
async function forgetSlackInput(ts: string) {
  await db
    .delete(schema.conversationInputs)
    .where(eq(schema.conversationInputs.slackTs, ts));
  await db
    .delete(schema.conversationEngagements)
    .where(eq(schema.conversationEngagements.ts, ts));
  type Key = { ts?: string; input_id?: string };
  const unnamed = (keys: Key[]) =>
    keys.map(({ input_id, ...key }) =>
      key.ts === ts || input_id === undefined ? key : { ...key, input_id },
    );
  for (const turn of await db
    .select({ id: turns.id, sources: turns.sources })
    .from(turns)) {
    const set = turn.sources as { direct: Key[]; inherited: Key[] } | null;
    if (set === null) continue;
    await db
      .update(turns)
      .set({
        sources: {
          ...set,
          direct: unnamed(set.direct),
          inherited: unnamed(set.inherited),
        } as typeof turn.sources,
      })
      .where(eq(turns.id, turn.id));
  }
}

// Another input's charge, landing between this input's storage check and
// its commit: the commit-time check refuses it.
async function chargeAfterTheCheck() {
  await db.execute(
    sql.raw(`CREATE FUNCTION test_late_charge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE storage_usage SET bytes = bytes + ${LIMITS.STORAGE_LIMIT_BYTES} WHERE scope = 'installation';
        RETURN NEW;
      END $$`),
  );
  await db.execute(
    sql.raw(`CREATE TRIGGER test_late_charge BEFORE INSERT ON turns
        FOR EACH ROW EXECUTE FUNCTION test_late_charge()`),
  );
}

const inboxDrops = () =>
  db
    .select({
      status: slackInboundEvents.status,
      dropReason: slackInboundEvents.dropReason,
    })
    .from(slackInboundEvents)
    .orderBy(asc(slackInboundEvents.receivedAt));

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
    // Made with the session: the channel's main conversation is its parent.
    const [parent, ...more] = await db.select().from(schema.conversations);
    expect(more).toEqual([]);
    expect(parent).toMatchObject({ kind: "channel", channelId: CHANNEL });
    expect(session?.parentConversationId).toBe(parent?.id ?? "");
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
    const [installation] = await db.select().from(slackInstallations);
    const slackLink = {
      method: "slack_link",
      installation_id: installation?.id,
      linked_account_id: account?.id,
      linked_account_revision: account?.revision,
    };
    expect(
      await db
        .select({
          kind: turns.requesterKind,
          id: turns.requesterId,
          auth: turns.requesterAuth,
        })
        .from(turns)
        .orderBy(turns.sequence),
    ).toEqual([
      { kind: "user", id: by, auth: slackLink },
      { kind: "user", id: by, auth: slackLink },
    ]);
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

  test.each([
    ["message first", true],
    ["app_mention first", false],
  ])(
    "a top-level mention's message and app_mention, %s, leave two processed inbox rows and one input",
    async (_, messageFirst) => {
      const fixture = await agentInSlack();
      const { handle } = handler();
      // As measured on Slack: one ts; the message event carries channel_type,
      // the mention does not.
      const events = [rootMessage("100.000100"), mention("100.000100")];
      for (const event of messageFirst ? events : events.reverse()) {
        await deliver(fixture, event);
      }
      expect(await drain(handle)).toMatchObject({ processed: 2 });
      expect(await inboxStatuses()).toEqual(["processed", "processed"]);
      const [session, ...others] = await sessionsOf(fixture);
      expect(others).toEqual([]);
      const turnIds = await turnIdsOf(session?.id);
      expect(turnIds).toHaveLength(1);
      expect(await inputsOf(fixture)).toEqual([
        {
          topicId: expect.any(String),
          seq: 1,
          channelId: CHANNEL,
          ts: "100.000100",
          requesterKind: "user",
          requesterId: fixture.ownerId,
          turnId: turnIds[0] ?? 0,
        },
      ]);
      const [topic] = await db.select().from(schema.conversationTopics);
      expect(topic).toMatchObject({
        agentId: fixture.agentId,
        slackTeamId: TEAM,
        slackChannelId: CHANNEL,
        slackThreadTs: "100.000100",
      });
    },
  );

  test("Slack sending one event again leaves one input", async () => {
    const fixture = await agentInSlack();
    expect(await deliver(fixture, mention("100.000100"))).toBe("recorded");
    const again = await deliver(fixture, mention("100.000100"), {
      eventId: `Ev${eventCounter}`,
    });
    expect(again).toBe("duplicate");
    await drain(handler().handle);
    expect(await inputsOf(fixture)).toHaveLength(1);
  });

  test("replies are numbered per topic in the order they were taken, not by ts", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    const reply = (ts: string, thread: string) =>
      message(ts, { thread_ts: thread, text: `<@${BOT_USER}> ${ts}` });
    await deliver(fixture, mention("100.000100"));
    await deliver(fixture, mention("200.000100"));
    await drain(handle);
    await deliver(fixture, reply("100.000300", "100.000100"));
    await drain(handle);
    // Older by ts, taken last.
    await deliver(fixture, reply("100.000200", "100.000100"));
    await drain(handle);
    const inputs = await inputsOf(fixture);
    const byTopic = new Map<string, typeof inputs>();
    for (const input of inputs) {
      byTopic.set(input.topicId, [
        ...(byTopic.get(input.topicId) ?? []),
        input,
      ]);
    }
    // Each input names the turn its own message became: the second
    // thread's first turn is no turn of the first thread's session.
    const madeOf = new Map<number | null, string | null>(
      (
        await db
          .select({ id: turns.id, slackMessage: turns.slackMessage })
          .from(turns)
      ).map((turn) => [turn.id, turn.slackMessage?.ts ?? null]),
    );
    expect(inputs.map((input) => madeOf.get(input.turnId) ?? null)).toEqual(
      inputs.map((input) => input.ts),
    );
    expect(
      [...byTopic.values()]
        .map((rows) => rows.map((row) => [row.seq, row.ts]))
        .sort((a, b) => String(a[0]?.[1]).localeCompare(String(b[0]?.[1]))),
    ).toEqual([
      [
        [1, "100.000100"],
        [2, "100.000300"],
        [3, "100.000200"],
      ],
      [[1, "200.000100"]],
    ]);
  });

  test("two posts of one topic taken at once get different numbers", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    for (const ts of ["100.000200", "100.000300", "100.000400"]) {
      await deliver(
        fixture,
        message(ts, { thread_ts: "100.000100", text: `<@${BOT_USER}> ${ts}` }),
      );
    }
    const claims = await claimSideBySide(30_000);
    expect(claims).toHaveLength(3);
    const inbox = createPostgresSlackInboundEventStore(db);
    const receipts = await Promise.all(claims.map((claim) => handle(claim)));
    const done = await Promise.all(
      claims.map((claim, i) => inbox.complete(claim, receipts[i] ?? undefined)),
    );
    expect(done).toEqual([true, true, true]);
    const seqs = (await inputsOf(fixture)).map((input) => input.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  test("a pass that died after the turn and before the receipt leaves one input once retried", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100"));
    const [claim] = await claimAll(30_000);
    if (claim === undefined) throw new Error("nothing claimed");
    // The turn is taken; the pass dies before its row completes.
    await handler(shortLease).handle(claim);
    // The turn's transaction took the input with it.
    expect(await inputsOf(fixture)).toHaveLength(1);
    await Bun.sleep(100);
    expect(await drain(handler().handle)).toMatchObject({ processed: 1 });
    const [session] = await sessionsOf(fixture);
    const turnIds = await turnIdsOf(session?.id);
    expect(turnIds).toHaveLength(1);
    expect(
      (await inputsOf(fixture)).map((input) => [input.seq, input.turnId]),
    ).toEqual([[1, turnIds[0] ?? 0]]);
    // The retry finds the turn taken and still knows the post opened it.
    expect(await engagementsOf(fixture)).toEqual([
      {
        channelId: CHANNEL,
        ts: "100.000100",
        kind: "mention",
        sessionId: session?.id ?? "",
      },
    ]);
  });

  test("a pass that died after the turn leaves the turn's input, though the install was revoked before the retry", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100"));
    const [claim] = await claimAll(30_000);
    if (claim === undefined) throw new Error("nothing claimed");
    // The turn is taken; the pass dies before its row completes.
    await handler(shortLease).handle(claim);
    await db
      .update(slackInstallations)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(slackInstallations.appId, APP_ID));
    await Bun.sleep(100);
    // The retry drops the event before any handler runs.
    expect(await drain(handler().handle)).toMatchObject({ dropped: 1 });
    expect(await inboxStatuses()).toEqual(["dropped"]);
    const [session] = await sessionsOf(fixture);
    const turnIds = await turnIdsOf(session?.id);
    expect(turnIds).toHaveLength(1);
    expect(
      (await inputsOf(fixture)).map((input) => [
        input.seq,
        input.ts,
        input.requesterId,
        input.turnId,
      ]),
    ).toEqual([[1, "100.000100", fixture.ownerId, turnIds[0] ?? 0]]);
    expect(
      (await engagementsOf(fixture)).map((row) => [row.ts, row.kind]),
    ).toEqual([["100.000100", "mention"]]);
  });

  test("a retry after the turn takes its input as the turn's, though the person was unlinked meanwhile", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    await deliver(
      fixture,
      message("100.000200", {
        thread_ts: "100.000100",
        text: `<@${BOT_USER}> again`,
      }),
    );
    const [claim] = await claimAll(30_000);
    if (claim === undefined) throw new Error("nothing claimed");
    await handler(shortLease).handle(claim);
    await db.delete(linkedAccounts);
    await Bun.sleep(100);
    expect(await drain(handle)).toMatchObject({ processed: 1 });
    const [session] = await sessionsOf(fixture);
    const turnIds = await turnIdsOf(session?.id);
    expect(turnIds).toHaveLength(2);
    expect(await inputsOf(fixture)).toMatchObject([
      { seq: 1, ts: "100.000100" },
      {
        seq: 2,
        ts: "100.000200",
        requesterKind: "user",
        requesterId: fixture.ownerId,
        turnId: turnIds[1],
      },
    ]);
    expect(
      (await engagementsOf(fixture)).map((row) => [row.ts, row.kind]),
    ).toEqual([
      ["100.000100", "mention"],
      ["100.000200", "bound"],
    ]);
    expect(notices).toEqual([]);
  });

  test("a retry of a turn an older image took without its input takes the input as the turn's, though the person was unlinked meanwhile", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    await deliver(
      fixture,
      message("100.000200", {
        thread_ts: "100.000100",
        text: `<@${BOT_USER}> again`,
      }),
    );
    const [claim] = await claimAll(30_000);
    if (claim === undefined) throw new Error("nothing claimed");
    await handler(shortLease).handle(claim);
    await forgetSlackInput("100.000200");
    expect(await inputsOf(fixture)).toHaveLength(1);
    await db.delete(linkedAccounts);
    await Bun.sleep(100);
    expect(await drain(handle)).toMatchObject({ processed: 1 });
    const [session] = await sessionsOf(fixture);
    const turnIds = await turnIdsOf(session?.id);
    expect(turnIds).toHaveLength(2);
    expect(await inputsOf(fixture)).toMatchObject([
      { seq: 1, ts: "100.000100" },
      {
        seq: 2,
        ts: "100.000200",
        requesterKind: "user",
        requesterId: fixture.ownerId,
        turnId: turnIds[1],
      },
    ]);
    expect(
      (await engagementsOf(fixture)).map((row) => [row.ts, row.kind]),
    ).toEqual([
      ["100.000100", "mention"],
      ["100.000200", "bound"],
    ]);
    // The retry names the input in the turn's source key again.
    const [input] = await db
      .select({ id: schema.conversationInputs.id })
      .from(schema.conversationInputs)
      .where(eq(schema.conversationInputs.slackTs, "100.000200"));
    const [second] = await db
      .select({ sources: turns.sources })
      .from(turns)
      .where(eq(turns.id, turnIds[1] ?? 0));
    expect(
      (second?.sources as { direct: { input_id?: string }[] } | null)?.direct[0]
        ?.input_id,
    ).toBe(input?.id ?? "missing");
    expect(notices).toEqual([]);
  });

  test("a retry after the session was made but never linked links it and takes the input", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100"));
    const [claim] = await claimAll(30_000);
    if (claim === undefined) throw new Error("nothing claimed");
    await handler(shortLease).handle(claim);
    // As if the pass died between createSession and attachSession.
    await db.update(sessionLinks).set({ sessionId: null });
    await Bun.sleep(100);
    expect(await drain(handler().handle)).toMatchObject({ processed: 1 });
    const [session] = await sessionsOf(fixture);
    const [linked] = await db
      .select({ sessionId: sessionLinks.sessionId })
      .from(sessionLinks);
    expect(linked?.sessionId).toBe(session?.id ?? "missing");
    expect(await inputsOf(fixture)).toHaveLength(1);
  });

  test("a row that lost its lease completes nothing; its turn's input stands", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100"));
    const [claim] = await claimAll(30_000);
    if (claim === undefined) throw new Error("nothing claimed");
    const receipt = await handler(shortLease).handle(claim);
    await Bun.sleep(100);
    await claimAll(30_000);
    const inbox = createPostgresSlackInboundEventStore(db);
    expect(await inbox.complete(claim, receipt ?? undefined)).toBe(false);
    expect(await inputsOf(fixture)).toHaveLength(1);
  });

  test("a DM is taken into the person's DM conversation", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, {
      type: "message",
      channel: "D0OWNER",
      channel_type: "im",
      user: PERSON,
      ts: "100.000100",
      text: "hello",
    });
    await drain(handler().handle);
    expect(await inputsOf(fixture)).toMatchObject([
      {
        seq: 1,
        channelId: "D0OWNER",
        requesterKind: "user",
        requesterId: fixture.ownerId,
      },
    ]);
    const [conversation] = await db.select().from(schema.conversations);
    expect(conversation).toMatchObject({
      kind: "dm",
      personUserId: fixture.ownerId,
    });
    const [session] = await sessionsOf(fixture);
    expect(session?.parentConversationId).toBe(conversation?.id ?? "");
  });

  test("a DM thread opened again by another member is the opener's DM, not the link creator's", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    const dm = {
      type: "message",
      channel: "D0OWNER",
      channel_type: "im",
      user: PERSON,
      text: "hello",
    };
    // The first DM makes the DM binding the second thread's link names.
    await deliver(fixture, { ...dm, ts: "100.000100" });
    await drain(handle);
    // Another member reserved the second thread; its first post gave out
    // before it made a session.
    const other = randomUUID();
    await db.insert(schema.users).values({
      id: other,
      email: `${other}@example.invalid`,
      displayName: "other",
    });
    await db.insert(schema.memberships).values({
      workspaceId: fixture.workspaceId,
      userId: other,
      role: "member",
    });
    const [installation] = await db.select().from(slackInstallations);
    const [binding] = await db
      .select()
      .from(surfaceBindings)
      .where(eq(surfaceBindings.surfaceKind, "dm"));
    await createPostgresSessionLinkStore(db).reserve({
      workspaceId: fixture.workspaceId,
      installationId: installation?.id ?? "",
      surfaceBindingId: binding?.id ?? "",
      surfaceRef: "D0OWNER:200.000100",
      channelId: "D0OWNER",
      threadId: "200.000100",
      openedByTs: "200.000050",
      agentId: fixture.agentId,
      releaseId: fixture.releaseId,
      createdBy: other,
    });
    await deliver(fixture, {
      ...dm,
      ts: "200.000200",
      thread_ts: "200.000100",
    });
    await drain(handle);

    const [link] = await db
      .select()
      .from(schema.sessionLinks)
      .where(eq(schema.sessionLinks.threadId, "200.000100"));
    expect(link?.createdBy).toBe(other);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, link?.sessionId ?? randomUUID()));
    expect(session?.createdByUserId).toBe(fixture.ownerId);
    const [parent] = await db
      .select()
      .from(schema.conversations)
      .where(
        eq(
          schema.conversations.id,
          session?.parentConversationId ?? randomUUID(),
        ),
      );
    // The parent and the input's topic are in the one conversation.
    expect(parent).toMatchObject({ kind: "dm", personUserId: fixture.ownerId });
    const [topic] = await db
      .select()
      .from(schema.conversationTopics)
      .where(eq(schema.conversationTopics.slackThreadTs, "200.000100"));
    expect(topic?.conversationId).toBe(parent?.id ?? "");
  });

  test("a mention's turn and its thread's next one hold their inputs as sources, the next inheriting the first", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100"));
    await deliver(fixture, message("100.000200", { thread_ts: "100.000100" }));
    expect(await drain(handler().handle)).toMatchObject({ processed: 2 });
    const { rows: inputs } = (await db.execute(
      sql`SELECT id, slack_ts FROM conversation_inputs ORDER BY seq`,
    )) as unknown as { rows: { id: ConversationInputId; slack_ts: string }[] };
    const key = (index: number) => ({
      input_id: inputs[index]?.id,
      team_id: TEAM,
      channel_id: CHANNEL,
      ts: inputs[index]?.slack_ts,
    });
    expect(inputs.map((row) => row.slack_ts)).toEqual([
      "100.000100",
      "100.000200",
    ]);
    const [session] = await sessionsOf(fixture);
    expect(
      await db
        .select({ sources: turns.sources })
        .from(turns)
        .where(eq(turns.sessionId, session?.id ?? ""))
        .orderBy(turns.sequence),
    ).toEqual([
      { sources: { direct: [key(0)], inherited: [] } },
      { sources: { direct: [key(1)], inherited: [key(0)] } },
    ]);
  });

  test("a delete mark of a message taken as an input outlives the unknown-mark purge", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100"));
    await drain(handler().handle);
    const marks = schema.createPostgresSlackSourceMarkStore(db);
    const at = new Date();
    for (const ts of ["100.000100", "100.000900"]) {
      await marks.markDeleted({
        workspaceId: fixture.workspaceId,
        teamId: TEAM,
        channelId: CHANNEL,
        ts,
        at,
      });
    }
    await Bun.sleep(5);
    expect(
      await schema.purgeUnknownSlackSourceMarks(db, {
        limit: 10,
        dryRun: false,
        retentionMs: 1,
      }),
    ).toEqual({ deleted: 1, edited: 0 });
    const left = await db.execute(sql`SELECT ts FROM deleted_sources`);
    expect(
      (left as unknown as { rows: { ts: string }[] }).rows.map((row) => row.ts),
    ).toEqual(["100.000100"]);
  });

  test("a mention leaves one engagement as a mention of its session; the thread's next posts are bound to it, mentioned or not", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    await deliver(fixture, mention("100.000100"));
    // The mention's own message event, and Slack sending the reply again.
    await deliver(fixture, rootMessage("100.000100"));
    await deliver(fixture, message("100.000200", { thread_ts: "100.000100" }));
    const again = message("100.000300", {
      thread_ts: "100.000100",
      text: `<@${BOT_USER}> more`,
    });
    await deliver(fixture, again);
    await deliver(fixture, { ...again, type: "app_mention" });
    expect(await drain(handle)).toMatchObject({ processed: 5 });
    const [session] = await sessionsOf(fixture);
    const sessionId = session?.id ?? "";
    expect(await engagementsOf(fixture)).toEqual([
      { channelId: CHANNEL, ts: "100.000100", kind: "mention", sessionId },
      { channelId: CHANNEL, ts: "100.000200", kind: "bound", sessionId },
      { channelId: CHANNEL, ts: "100.000300", kind: "bound", sessionId },
    ]);
  });

  test("a session an unmentioned top-level post opens is a reply; a DM's is a mention", async () => {
    const fixture = await agentInSlack("main", { mentionOnly: false });
    const { handle } = handler();
    await deliver(fixture, message("100.000100"));
    await deliver(fixture, message("100.000200", { thread_ts: "100.000100" }));
    await deliver(fixture, {
      type: "message",
      channel: "D0OWNER",
      channel_type: "im",
      user: PERSON,
      ts: "200.000100",
      text: "hello",
    });
    await drain(handle);
    expect(
      (await engagementsOf(fixture)).map((row) => [row.ts, row.kind]),
    ).toEqual([
      ["100.000100", "reply"],
      ["100.000200", "bound"],
      ["200.000100", "mention"],
    ]);
  });

  test("a refused or ignored post leaves no engagement", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100", { user: "U0STRANGER" }));
    await deliver(fixture, message("200.000100"));
    await deliver(fixture, message("300.000200", { thread_ts: "300.000100" }));
    await drain(handler().handle);
    expect(await engagementsOf(fixture)).toEqual([]);
  });

  test("an engaged thread is one whose session the agent took part in, its link open, closed or revoked", async () => {
    const fixture = await agentInSlack();
    const other = await agentInSlack("main", {
      appId: OTHER_APP_ID,
      linkPerson: false,
    });
    const { handle } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    const [installation] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.workspaceId, fixture.workspaceId));
    const engagements = schema.createPostgresEngagementStore(db);
    const engaged = (
      threadTs: string,
      who: Fixture = fixture,
      installationId = installation?.id ?? "",
    ) =>
      engagements.engagedThread({
        agentId: who.agentId,
        installationId,
        channelId: CHANNEL,
        threadTs,
      });
    expect(await engaged("100.000100")).toBe(true);
    expect(await engaged("200.000100")).toBe(false);
    // Another agent's engagement is not this one's.
    expect(await engaged("100.000100", other)).toBe(false);
    await db
      .update(sessionLinks)
      .set({ closedAt: new Date(), closedReason: "completed" });
    expect(await engaged("100.000100")).toBe(true);
    await db.update(sessionLinks).set({ revokedAt: new Date() });
    expect(await engaged("100.000100")).toBe(true);
  });

  test("an engagement keeps no text, thread or link, and names a session or a conversation turn, exactly one", async () => {
    const columns = await db.execute(
      sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'conversation_engagements' ORDER BY ordinal_position`,
    );
    expect(
      (columns as unknown as { rows: { column_name: string }[] }).rows.map(
        (row) => row.column_name,
      ),
    ).toEqual([
      "workspace_id",
      "agent_id",
      "team_id",
      "channel_id",
      "ts",
      "kind",
      "session_id",
      "conversation_turn_id",
      "created_at",
    ]);
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100"));
    await drain(handler().handle);
    const [session] = await sessionsOf(fixture);
    const insert = async (ts: string, target: Record<string, string | null>) =>
      await db.insert(schema.conversationEngagements).values({
        workspaceId: fixture.workspaceId,
        agentId: fixture.agentId,
        teamId: TEAM,
        channelId: CHANNEL,
        ts,
        kind: "bound",
        sessionId: null,
        conversationTurnId: null,
        ...target,
      });
    const conversation = await createPostgresConversationStore(
      db,
    ).findOrCreateConversation({
      kind: "channel",
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      teamId: TEAM,
      channelId: CHANNEL,
    });
    const turnId = randomUUID();
    await db.insert(schema.conversationTurns).values({
      id: turnId as ConversationTurnId,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      conversationId: conversation.id,
      origin: "m2",
      state: "running",
      requesterKind: "slack_user",
      requesterId: "U0ASKER",
    });
    await expect(insert("100.000700", {})).rejects.toThrow();
    // A turn the table does not have.
    await expect(
      insert("100.000750", { conversationTurnId: randomUUID() }),
    ).rejects.toThrow();
    await expect(
      insert("100.000800", {
        sessionId: session?.id ?? "",
        conversationTurnId: turnId,
      }),
    ).rejects.toThrow();
    await insert("100.000900", { conversationTurnId: turnId });
    expect((await engagementsOf(fixture)).map((row) => row.ts)).toEqual([
      "100.000100",
      "100.000900",
    ]);
  });

  test("a delete mark of a message an engagement points at outlives the unknown-mark purge", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100"));
    await drain(handler().handle);
    // The engagement alone points at the message now.
    await db.delete(schema.conversationInputs);
    const marks = schema.createPostgresSlackSourceMarkStore(db);
    for (const ts of ["100.000100", "100.000900"]) {
      await marks.markDeleted({
        workspaceId: fixture.workspaceId,
        teamId: TEAM,
        channelId: CHANNEL,
        ts,
        at: new Date(),
      });
    }
    await Bun.sleep(5);
    expect(
      await schema.purgeUnknownSlackSourceMarks(db, {
        limit: 10,
        dryRun: false,
        retentionMs: 1,
      }),
    ).toEqual({ deleted: 1, edited: 0 });
    const left = await db.execute(sql`SELECT ts FROM deleted_sources`);
    expect(
      (left as unknown as { rows: { ts: string }[] }).rows.map((row) => row.ts),
    ).toEqual(["100.000100"]);
  });

  test("a mention deleted before its turn goes in makes no session, and says nothing in Slack", async () => {
    const fixture = await agentInSlack();
    const { handle, notices, threadNotices } = handler();
    await deliver(fixture, mention("100.000100"));
    await schema.createPostgresSlackSourceMarkStore(db).markDeleted({
      workspaceId: fixture.workspaceId,
      teamId: TEAM,
      channelId: CHANNEL,
      ts: "100.000100",
      at: new Date(),
    });
    expect(await drain(handle)).toMatchObject({ processed: 1 });
    expect(await inboxStatuses()).toEqual(["processed"]);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(await inputsOf(fixture)).toEqual([]);
    expect(notices).toEqual([]);
    expect(threadNotices).toEqual([]);
  });

  test("a thread whose first message was deleted takes no next turn; an edit of it holds nothing back", async () => {
    const fixture = await agentInSlack();
    const { handle, notices, threadNotices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    const [session] = await sessionsOf(fixture);
    const marks = schema.createPostgresSlackSourceMarkStore(db);
    const place = {
      workspaceId: fixture.workspaceId,
      teamId: TEAM,
      channelId: CHANNEL,
    };
    // Before: an edit of the first message leaves the thread going on.
    await marks.markEdited({ ...place, ts: "100.000100", at: new Date() });
    await deliver(fixture, message("100.000200", { thread_ts: "100.000100" }));
    await drain(handle);
    expect((await turnsOf(session?.id)).map((t) => t.sequence)).toEqual([1, 2]);
    // After: its delete stops the next one, which inherits it.
    await marks.markDeleted({ ...place, ts: "100.000100", at: new Date() });
    await deliver(fixture, message("100.000300", { thread_ts: "100.000100" }));
    await drain(handle);
    expect((await turnsOf(session?.id)).map((t) => t.sequence)).toEqual([1, 2]);
    expect((await inputsOf(fixture)).map((input) => input.ts)).toEqual([
      "100.000100",
      "100.000200",
    ]);
    expect(notices).toEqual([]);
    expect(threadNotices).toEqual([]);
  });

  test("a refused post takes no input", async () => {
    const fixture = await agentInSlack();
    await deliver(fixture, mention("100.000100", { user: "U0STRANGER" }));
    await drain(handler().handle);
    expect(await inboxStatuses()).toEqual(["processed"]);
    expect(await inputsOf(fixture)).toEqual([]);
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
    const fixture = await agentInSlack("main", {
      repositoryId: "notes-repo",
    });
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(notices).toEqual([]);
    const opened = await sessionsOf(fixture);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      repositoryId: "notes-repo",
      repoUrl: "https://github.com/acme/notes",
      agentReleaseId: fixture.releaseId,
    });
  });

  test("an agent with no active release says so in the thread", async () => {
    const fixture = await agentInSlack("main", { activate: false });
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

  test("an agent no one has administered past the grace period says so in the thread", async () => {
    const fixture = await agentInSlack("main");
    await db
      .delete(schema.agentAdmins)
      .where(eq(schema.agentAdmins.agentId, fixture.agentId));
    await db
      .update(agents)
      .set({ ownerlessSince: sql`now() - interval '15 days'` })
      .where(eq(agents.id, fixture.agentId));
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      reason: "agent_ownerless",
      notice: { message: "agentOwnerless" },
    });
    expect(await inboxStatuses()).toEqual(["processed"]);
  });

  test("a mention the storage limit refuses at commit ends dropped, opens nothing and tells the requester once", async () => {
    const fixture = await agentInSlack();
    await chargeAfterTheCheck();
    const { handle, notices, threadNotices } = handler();
    await deliver(fixture, mention("100.000100"));
    expect(await drain(handle)).toMatchObject({ dropped: 1, retried: 0 });
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      channelId: CHANNEL,
      threadTs: "100.000100",
      slackUserId: PERSON,
      reason: "STORAGE_LIMIT_EXCEEDED",
      notice: { message: "storageLimit" },
    });
    expect(threadNotices).toEqual([]);
    expect(await inboxDrops()).toEqual([
      { status: "dropped", dropReason: "storage_limit_exceeded" },
    ]);
    // Nothing is left to claim, so the item is never tried again.
    expect(await claimAll(30_000)).toEqual([]);
  });

  test("a thread post the storage limit refuses at commit adds no turn and ends dropped", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    expect(await drain(handle)).toMatchObject({ processed: 1 });
    await chargeAfterTheCheck();
    await deliver(fixture, message("100.000200", { thread_ts: "100.000100" }));
    expect(await drain(handle)).toMatchObject({ dropped: 1, retried: 0 });
    const [session] = await sessionsOf(fixture);
    expect((await turnsOf(session?.id)).map((turn) => turn.sequence)).toEqual([
      1,
    ]);
    expect(notices.map((held) => held.notice)).toEqual([
      { message: "storageLimit" },
    ]);
    expect(await inboxDrops()).toEqual([
      { status: "processed", dropReason: null },
      { status: "dropped", dropReason: "storage_limit_exceeded" },
    ]);
  });

  test("a DM the storage limit refuses is told in its thread, not ephemerally", async () => {
    const fixture = await agentInSlack();
    await chargeAfterTheCheck();
    const { handle, notices, threadNotices } = handler();
    await deliver(fixture, {
      type: "message",
      channel: "D0OWNER",
      channel_type: "im",
      user: PERSON,
      text: "hello",
      ts: "100.000100",
    });
    expect(await drain(handle)).toMatchObject({ dropped: 1, retried: 0 });
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toEqual([]);
    expect(threadNotices).toHaveLength(1);
    expect(threadNotices[0]).toMatchObject({
      channelId: "D0OWNER",
      threadTs: "100.000100",
      notice: { message: "storageLimit" },
    });
    expect(await inboxDrops()).toEqual([
      { status: "dropped", dropReason: "storage_limit_exceeded" },
    ]);
  });

  test("a linked member outside the managing team is refused before the agent's release state", async () => {
    const fixture = await agentInSlack("main", { activate: false });
    const outsiderId = randomUUID();
    await db.insert(users).values({
      id: outsiderId,
      email: `${outsiderId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "outsider",
    });
    await db.insert(memberships).values({
      workspaceId: fixture.workspaceId,
      userId: outsiderId,
      role: "member",
    });
    await db.insert(linkedAccounts).values({
      id: randomUUID(),
      workspaceId: fixture.workspaceId,
      userId: outsiderId,
      provider: "slack",
      externalTenant: TEAM,
      externalUserId: "U0OUTSIDER",
      verifiedVia: "slack_oidc",
      verifiedAt: new Date(),
    });
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100", { user: "U0OUTSIDER" }));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toHaveLength(1);
    // Unpublished, the agent is not there for them at all; the notice reads
    // as for a missing right either way.
    expect(notices[0]?.reason).toBe("agent_private");
    expect(notices[0]?.notice.message).toBe("noRequestRight");
  });

  test("an unlinked person on an agent with no active release gets the link prompt", async () => {
    const fixture = await agentInSlack("main", { activate: false });
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100", { user: "U0STRANGER" }));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.reason).toBe("unlinked");
    expect(notices[0]?.notice.message).toBe("connect");
  });

  test("a release whose connection left the catalog says so in the thread", async () => {
    const fixture = await agentInSlack("retired", {
      releasedUnder: (loaded) => ({
        ...loaded,
        connections: {
          ...loaded.connections,
          retired: loaded.connections
            .main as SessionCatalog["connections"][string],
        },
      }),
    });
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      reason: "release_unavailable",
      notice: { message: "releaseUnavailable" },
    });
    expect(await inboxStatuses()).toEqual(["processed"]);
  });

  test("a reply in a thread whose connection the operator disabled since is still queued; the claim holds it", async () => {
    const fixture = await agentInSlack("main");
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    await db
      .update(providerConnections)
      .set({ disabledAt: new Date(), disabledBy: fixture.ownerId })
      .where(eq(providerConnections.id, "main"));
    await deliver(
      fixture,
      message("100.000300", { thread_ts: "100.000100", text: "more" }),
    );
    await drain(handle);
    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    expect((await turnsOf(session?.id)).map((turn) => turn.message)).toEqual([
      "summarize the thread",
      "more",
    ]);
    expect(notices).toEqual([]);
  });

  test("a release whose connection the operator disabled says so in the thread", async () => {
    const fixture = await agentInSlack("main");
    await db
      .update(providerConnections)
      .set({ disabledAt: new Date(), disabledBy: fixture.ownerId })
      .where(eq(providerConnections.id, "main"));
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      reason: "release_unavailable",
      notice: { message: "releaseUnavailable" },
    });
    expect(await inboxStatuses()).toEqual(["processed"]);
  });

  test("a release whose repository left the catalog says so", async () => {
    const fixture = await agentInSlack("main", {
      repositoryId: "old-repo",
      releasedUnder: (loaded) => ({
        ...loaded,
        repositories: {
          ...loaded.repositories,
          "old-repo": loaded.repositories[
            "notes-repo"
          ] as SessionCatalog["repositories"][string],
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

  test("an agent whose GitHub settings cannot be read says so in the thread", async () => {
    const fixture = await agentInSlack("main");
    await db.insert(schema.agentGitHubSettings).values({
      agentId: fixture.agentId,
      workspaceId: fixture.workspaceId,
      repositories: [],
      pushApproval: true,
      features: { unreadable: true } as never,
      actionsAllow: [],
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
    const fixture = await agentInSlack("main", { mentionOnly: false });
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

  // The switch on, a mention is the table's (the mention turns block below)
  // and opens no session; unmentioned posts open nothing either (the
  // judgment buffer block below holds them).
  for (const listen of ["off", "free"] as const) {
    test(`a channel listening ${listen}, its agent switched on, opens no session on a mention, its thread or another post`, async () => {
      const fixture = await agentInSlack("main", { listen, rollout: "on" });
      const { handle, notices } = handler();
      await deliver(fixture, mention("100.000100"));
      await deliver(
        fixture,
        message("100.000200", { thread_ts: "100.000100" }),
      );
      await deliver(fixture, message("200.000100"));
      await deliver(
        fixture,
        message("200.000200", { thread_ts: "200.000100" }),
      );
      await drain(handle);
      expect(await links()).toEqual([]);
      expect(await sessionsOf(fixture)).toEqual([]);
      // Listening off, the mention is not heard (its notice is v1-b/F3's).
      const conversationTurns = await db
        .select({ id: schema.conversationTurns.id })
        .from(schema.conversationTurns)
        .where(eq(schema.conversationTurns.agentId, fixture.agentId));
      expect(conversationTurns).toHaveLength(listen === "off" ? 0 : 1);
      expect(notices).toEqual([]);
    });
  }

  test("with the switch off, an agent not waiting for a mention still opens a session on an unmentioned top-level post in a channel listening off", async () => {
    const fixture = await agentInSlack("main", {
      mentionOnly: false,
      listen: "off",
      rollout: "off",
    });
    const { handle } = handler();
    await deliver(fixture, message("100.000100"));
    await drain(handle);
    expect((await links()).map((link) => link.threadId)).toEqual([
      "100.000100",
    ]);
  });

  test("an unused channel takes no unmentioned post", async () => {
    const fixture = await agentInSlack("main", {
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

  test("a private channel bound as private but seen as public is refused with a notice", async () => {
    const fixture = await agentInSlack("main", {
      channelKind: "private_channel",
    });
    await createPostgresSurfaceBindingStore(db).approve({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingId: fixture.bindingId,
      revision: 1,
      approverRoles: ["owner", "admin"],
    });
    const { handle, notices } = handler();
    await deliver(fixture, {
      ...rootMessage("9999999999.000100"),
      channel_type: "channel",
    });
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices.map((notice) => notice.reason)).toEqual([
      "channel_kind_mismatch",
    ]);
  });

  test("a public channel Slack now reports as private waits for approval and answers nothing", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    await deliver(fixture, {
      ...rootMessage("100.000100"),
      channel_type: "group",
    });
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices.map((notice) => notice.reason)).toEqual([
      "pending_approval",
    ]);
    expect(notices[0]?.notice).toEqual({ message: "pendingApproval" });
    const [row] = await db.select().from(surfaceBindings);
    expect(row).toMatchObject({
      status: "pending_approval",
      surfaceKind: "private_channel",
      home: false,
      revision: 2,
    });
    const [receipt] = await db
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.operation, "request_surface_binding"));
    expect(receipt?.actor).toMatchObject({
      principal: { kind: "installation" },
      actor_user_id: null,
    });
  });

  test("unmentioned talk in a channel that is private now still sends the public binding to approval, thread reply or not", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    await deliver(
      fixture,
      message("100.000200", { thread_ts: "100.000100", channel_type: "group" }),
    );
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toEqual([]);
    const [row] = await db.select().from(surfaceBindings);
    expect(row).toMatchObject({
      status: "pending_approval",
      surfaceKind: "private_channel",
    });
  });

  test("a mention in a channel Slack now reports private waits for approval and answers nothing", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    slack.channels.set(CHANNEL, { isPrivate: true });
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices.map((notice) => notice.reason)).toEqual([
      "pending_approval",
    ]);
    const [row] = await db.select().from(surfaceBindings);
    expect(row?.status).toBe("pending_approval");
  });

  test("a private channel saved from the console waits: a mention and a thread reply get one notice and no session", async () => {
    const fixture = await agentInSlack("main", {
      channelKind: "private_channel",
    });
    const { handle, notices } = handler();
    await deliver(fixture, mention("100.000100"));
    await deliver(fixture, mention("100.000200", { thread_ts: "100.000100" }));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(await links()).toEqual([]);
    expect(notices.map((notice) => notice.reason)).toEqual([
      "pending_approval",
    ]);
    expect(notices[0]?.notice).toEqual({ message: "pendingApproval" });
  });

  test("talk in a channel waiting for approval is not answered and not told", async () => {
    const fixture = await agentInSlack("main", {
      channelKind: "private_channel",
      mentionOnly: false,
    });
    const { handle, notices } = handler();
    await deliver(fixture, message("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("after approval a new mention is answered, one sent before it is not", async () => {
    const fixture = await agentInSlack("main", {
      channelKind: "private_channel",
    });
    const { handle, notices } = handler();
    slack.channels.set(CHANNEL, { isPrivate: true });
    const sentWhileWaiting = `${Math.floor(Date.now() / 1000) - 60}.000100`;
    await deliver(fixture, mention(sentWhileWaiting));
    await drain(handle);
    expect(notices.map((notice) => notice.reason)).toEqual([
      "pending_approval",
    ]);

    const approved = await createPostgresSurfaceBindingStore(db).approve({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingId: fixture.bindingId,
      revision: 1,
      approverRoles: ["owner", "admin"],
    });
    expect(approved.outcome).toBe("resolved");

    await deliver(
      fixture,
      mention(sentWhileWaiting, { thread_ts: undefined }),
      {
        thread: false,
      },
    );
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);

    const fresh = `${Math.floor(Date.now() / 1000) + 60}.000100`;
    await deliver(fixture, mention(fresh));
    await drain(handle);
    expect(await sessionsOf(fixture)).toHaveLength(1);
  });

  // Slack sends a private channel's events with channel_type "C" too
  // (measured): the binding's kind, read from Slack, decides the scope.
  test("a mention in an approved private channel opens a private_channel session no API key reads", async () => {
    const fixture = await agentInSlack("main", {
      channelKind: "private_channel",
    });
    const { handle } = handler();
    slack.channels.set(CHANNEL, { isPrivate: true });
    const approved = await createPostgresSurfaceBindingStore(db).approve({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingId: fixture.bindingId,
      revision: 1,
      approverRoles: ["owner", "admin"],
    });
    expect(approved.outcome).toBe("resolved");
    const fresh = `${Math.floor(Date.now() / 1000) + 60}.000100`;
    await deliver(fixture, mention(fresh, { channel_type: "C" }));
    await drain(handle);
    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    const id = session?.id ?? "";
    expect(
      await db
        .select({ scope: sessionShares.scope })
        .from(sessionShares)
        .where(eq(sessionShares.sessionId, id)),
    ).toEqual([{ scope: "private_channel" }]);
    const shares = createPostgresSessionShareStore(db);
    const [place, ...more] = await shares.privateChannels(
      fixture.workspaceId,
      id,
    );
    expect(more).toEqual([]);
    expect(place).toMatchObject({
      agentId: fixture.agentId,
      channelId: CHANNEL,
    });
    const [creator] = await db
      .select({ userId: sessions.createdByUserId })
      .from(sessions)
      .where(eq(sessions.id, id));
    // A personal key of the person who asked, and the agent's own key.
    expect(
      await shares.visibleTo(fixture.workspaceId, id, {
        userId: creator?.userId ?? null,
        apiKeyId: randomUUID(),
        privateChannels: [place?.conversationId ?? ""],
      }),
    ).toBe(false);
    expect(
      await shares.visibleTo(fixture.workspaceId, id, {
        userId: null,
        apiKeyId: randomUUID(),
        keyAgentId: fixture.agentId,
        privateChannels: [place?.conversationId ?? ""],
      }),
    ).toBe(false);
    // The person who asked, a member now, sees it as a member does.
    expect(
      await shares.visibleTo(fixture.workspaceId, id, {
        userId: creator?.userId ?? null,
        apiKeyId: null,
        privateChannels: [place?.conversationId ?? ""],
      }),
    ).toBe(true);
    expect(
      await shares.visibleTo(fixture.workspaceId, id, {
        userId: creator?.userId ?? null,
        apiKeyId: null,
      }),
    ).toBe(false);
  });

  test("the bot removed from an approved private channel leaves it inactive and silent; invited again it waits for a new approval before it answers", async () => {
    const fixture = await agentInSlack("main", {
      channelKind: "private_channel",
    });
    const { handle, notices } = handler();
    slack.channels.set(CHANNEL, { isPrivate: true });
    const store = createPostgresSurfaceBindingStore(db);
    const approveAt = (revision: number) =>
      store.approve({
        principal: fixture.owner,
        workspaceId: fixture.workspaceId,
        agentId: fixture.agentId,
        bindingId: fixture.bindingId,
        revision,
        approverRoles: ["owner", "admin"],
      });
    expect((await approveAt(1)).outcome).toBe("resolved");
    const stateOf = async () => {
      const [row] = await db.select().from(surfaceBindings);
      return row;
    };
    expect(await stateOf()).toMatchObject({ status: "ready", revision: 2 });

    await deliver(
      fixture,
      {
        type: "member_left_channel",
        user: BOT_USER,
        channel: CHANNEL,
        channel_type: "G",
        event_ts: lifecycleTs(60),
      },
      { thread: false },
    );
    await drain(handle);
    expect(await stateOf()).toMatchObject({
      status: "left",
      membership: "awaiting_invite",
      approvedAt: null,
      revision: 3,
    });

    // Inactive: a mention opens nothing and is not answered, not even told.
    await deliver(fixture, mention(`${Math.floor(Date.now() / 1000)}.000100`));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toEqual([]);
    // A left channel is not approvable: nothing waits to be approved.
    expect((await approveAt(3)).outcome).toBe("conflict");

    await deliver(
      fixture,
      {
        type: "member_joined_channel",
        user: BOT_USER,
        channel: CHANNEL,
        channel_type: "G",
        event_ts: lifecycleTs(120),
      },
      { thread: false },
    );
    await drain(handle);
    expect(await stateOf()).toMatchObject({
      status: "pending_approval",
      membership: "joined",
      revision: 4,
    });

    await deliver(fixture, mention(`${Math.floor(Date.now() / 1000)}.000100`));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices.map((notice) => notice.reason)).toEqual([
      "pending_approval",
    ]);

    expect((await approveAt(4)).outcome).toBe("resolved");
    await deliver(
      fixture,
      mention(`${Math.floor(Date.now() / 1000) + 60}.000100`),
    );
    await drain(handle);
    expect(await sessionsOf(fixture)).toHaveLength(1);
  });

  test("a mention queued before the bot left is dropped as channel_left when it is taken, not processed", async () => {
    const fixture = await agentInSlack("main", {
      channelKind: "private_channel",
    });
    const { handle, notices } = handler();
    slack.channels.set(CHANNEL, { isPrivate: true });
    const store = createPostgresSurfaceBindingStore(db);
    const approved = await store.approve({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingId: fixture.bindingId,
      revision: 1,
      approverRoles: ["owner", "admin"],
    });
    expect(approved.outcome).toBe("resolved");
    const [bound] = await db.select().from(surfaceBindings);

    // Queued while the channel is in use; the leave lands before the drain.
    await deliver(fixture, mention(`${Math.floor(Date.now() / 1000)}.000100`));
    expect(
      await store.botLeft(
        bound?.installationId ?? "",
        CHANNEL,
        (Math.floor(Date.now() / 1000) + 60) * 1_000_000,
      ),
    ).toBe(true);
    await drain(handle);

    expect(await sessionsOf(fixture)).toEqual([]);
    expect(notices).toEqual([]);
    const [event] = await db
      .select({
        status: slackInboundEvents.status,
        dropReason: slackInboundEvents.dropReason,
      })
      .from(slackInboundEvents);
    expect(event).toEqual({ status: "dropped", dropReason: "channel_left" });
  });

  test("a re-invite handled before the older leave still ends in a new approval, with no answer meanwhile", async () => {
    const fixture = await agentInSlack("main", {
      channelKind: "private_channel",
    });
    const { handle } = handler();
    slack.channels.set(CHANNEL, { isPrivate: true });
    const approved = await createPostgresSurfaceBindingStore(db).approve({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingId: fixture.bindingId,
      revision: 1,
      approverRoles: ["owner", "admin"],
    });
    expect(approved.outcome).toBe("resolved");
    await createPostgresSurfaceBindingStore(db).setMembership(
      fixture.bindingId,
      { state: "joined", error: null },
    );
    // The bot was in the channel when the approval was given; the re-invite
    // is handled before the leave that preceded it.
    await deliver(
      fixture,
      {
        type: "member_joined_channel",
        user: BOT_USER,
        channel: CHANNEL,
        event_ts: lifecycleTs(120),
      },
      { thread: false },
    );
    await drain(handle);
    const [rejoined] = await db.select().from(surfaceBindings);
    expect(rejoined).toMatchObject({
      status: "pending_approval",
      approvedAt: null,
    });
    // A mention before the late leave arrives is not answered either.
    await deliver(fixture, mention(`${Math.floor(Date.now() / 1000)}.000100`));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    await deliver(
      fixture,
      {
        type: "member_left_channel",
        user: BOT_USER,
        channel: CHANNEL,
        event_ts: lifecycleTs(60),
      },
      { thread: false },
    );
    await drain(handle);
    const [row] = await db.select().from(surfaceBindings);
    expect(row).toMatchObject({
      status: "pending_approval",
      membership: "joined",
      approvedAt: null,
    });
    expect(await inboxStatuses()).toEqual([
      "processed",
      "processed",
      "processed",
    ]);
    expect(await sessionsOf(fixture)).toEqual([]);
  });

  test("a leave the approval already knew of, arriving late, leaves the approval standing", async () => {
    const fixture = await agentInSlack("main", {
      channelKind: "private_channel",
    });
    const { handle } = handler();
    slack.channels.set(CHANNEL, { isPrivate: true });
    // The invite the owner approved was noted at 1700000200 before approving.
    await deliver(
      fixture,
      {
        type: "member_joined_channel",
        user: BOT_USER,
        channel: CHANNEL,
        event_ts: "1700000200.000100",
      },
      { thread: false },
    );
    await drain(handle);
    const approved = await createPostgresSurfaceBindingStore(db).approve({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingId: fixture.bindingId,
      revision: 1,
      approverRoles: ["owner", "admin"],
    });
    expect(approved.outcome).toBe("resolved");
    await deliver(
      fixture,
      {
        type: "member_left_channel",
        user: BOT_USER,
        channel: CHANNEL,
        event_ts: "1700000100.000100",
      },
      { thread: false },
    );
    await drain(handle);
    const [row] = await db.select().from(surfaceBindings);
    expect(row).toMatchObject({ status: "ready" });
  });

  test("another member leaving a private channel changes nothing", async () => {
    const fixture = await agentInSlack("main", {
      channelKind: "private_channel",
    });
    const { handle } = handler();
    const approved = await createPostgresSurfaceBindingStore(db).approve({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingId: fixture.bindingId,
      revision: 1,
      approverRoles: ["owner", "admin"],
    });
    expect(approved.outcome).toBe("resolved");
    await deliver(
      fixture,
      { type: "member_left_channel", user: PERSON, channel: CHANNEL },
      { thread: false },
    );
    await drain(handle);
    const [row] = await db.select().from(surfaceBindings);
    expect(row).toMatchObject({ status: "ready", revision: 2 });
  });

  test("a bot invited to an unbound private channel binds it waiting for approval, whatever channel_type says", async () => {
    const fixture = await agentInSlack();
    const { handle, notices } = handler();
    slack.channels.set("G0NEWSECRET", { isPrivate: true });
    await deliver(
      fixture,
      {
        type: "member_joined_channel",
        user: BOT_USER,
        channel: "G0NEWSECRET",
        channel_type: "C",
      },
      { thread: false },
    );
    await drain(handle);
    const rows = await db
      .select()
      .from(surfaceBindings)
      .where(eq(surfaceBindings.externalSurfaceId, "G0NEWSECRET"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "pending_approval",
      surfaceKind: "private_channel",
      membership: "joined",
      home: false,
    });
    const requests = await db
      .select()
      .from(schema.receipts)
      .where(eq(schema.receipts.operation, "request_surface_binding"));
    expect(requests).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  test("a bot invited to a public channel still binds it ready at once", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    slack.channels.set("C0NEWOPEN", { isPrivate: false });
    await deliver(
      fixture,
      {
        type: "member_joined_channel",
        user: BOT_USER,
        channel: "C0NEWOPEN",
        channel_type: "G",
      },
      { thread: false },
    );
    await drain(handle);
    const [row] = await db
      .select()
      .from(surfaceBindings)
      .where(eq(surfaceBindings.externalSurfaceId, "C0NEWOPEN"));
    expect(row).toMatchObject({
      status: "ready",
      surfaceKind: "public_channel",
      membership: "joined",
    });
  });

  test("an invite whose kind Slack cannot be asked about binds nothing and is tried again", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    slack.failures.set("conversations.info", "internal_error");
    await deliver(
      fixture,
      {
        type: "member_joined_channel",
        user: BOT_USER,
        channel: "G0UNREAD",
        channel_type: "C",
      },
      { thread: false },
    );
    await drain(handle);
    expect(
      await db
        .select()
        .from(surfaceBindings)
        .where(eq(surfaceBindings.externalSurfaceId, "G0UNREAD")),
    ).toEqual([]);
    expect(await inboxStatuses()).toEqual(["received"]);
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
    await deliver(fixture, mention("100.000100"));
    await deliver(fixture, rootMessage("100.000100"));
    const claims = await claimSideBySide(30_000);
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
      handler().handle(expired as SurfaceInboundClaim),
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
      revoking.handle(held as SurfaceInboundClaim),
    ).rejects.toMatchObject({ reason: "installation_revoked" });
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(await links()).toEqual([]);
  });
});

const REVIEW_BOT = "U0REVIEW";
// The count holds agent ids as text; another agent needs no row here.
const OTHER_AGENT = "019a0000-0000-7000-8000-0000000000e9";

/** A post of another app's bot: Slack names its bot user and its bot id. */
const botMention = (ts: string, extra: Record<string, unknown> = {}) =>
  mention(ts, {
    user: REVIEW_BOT,
    bot_id: "B0REVIEW",
    text: `<@${BOT_USER}> review this`,
    ...extra,
  });

async function allowBots(fixture: Fixture, ids: string[]) {
  await db
    .update(agents)
    .set({ slackAllowedBotUserIds: ids })
    .where(eq(agents.id, fixture.agentId));
}

// The judgment buffer (a0/D2): an unmentioned post the switched-on agent
// hears is held with its text, then removed whole. Each row of the table is
// one path a held row takes: held, edited, deleted, dropped, expired.
describe.each(ENGINES)("Slack judgment buffer on %s", (engine) => {
  useDatabase(engine);

  const bufferOf = (fixture: Fixture) =>
    db
      .select({
        ts: schema.conversationInputs.slackTs,
        body: schema.conversationInputs.body,
        requesterKind: schema.conversationInputs.requesterKind,
        requesterId: schema.conversationInputs.requesterId,
        turnId: schema.conversationInputs.turnId,
        expiresAt: schema.conversationInputs.bufferExpiresAt,
      })
      .from(schema.conversationInputs)
      .where(eq(schema.conversationInputs.agentId, fixture.agentId))
      .orderBy(asc(schema.conversationInputs.slackTs));
  const heldTs = async (fixture: Fixture) =>
    (await bufferOf(fixture))
      .filter((row) => row.expiresAt !== null)
      .map((row) => row.ts);
  const topicCount = async () =>
    (await db.select().from(schema.conversationTopics)).length;
  const installationId = async () =>
    (await db.select().from(slackInstallations))[0]?.id ?? "";
  const mark = (fixture: Fixture, ts: string, at = new Date()) => ({
    workspaceId: fixture.workspaceId,
    teamId: TEAM,
    channelId: CHANNEL,
    ts,
    at,
  });
  const purge = (now?: Date) =>
    schema.purgeJudgmentBuffer(db, {
      limit: 100,
      dryRun: false,
      ...(now === undefined ? {} : { now }),
    });

  for (const rollout of ["off", "shadow", "on"] as const) {
    test(`with the switch ${rollout}, a top-level post and a reply in a thread the agent is not in are ${rollout === "off" ? "not held, as before" : "held"}`, async () => {
      const fixture = await agentInSlack("main", { rollout });
      const { handle, notices } = handler();
      await deliver(fixture, message("100.000100"));
      await deliver(
        fixture,
        message("200.000200", { thread_ts: "200.000100" }),
      );
      await drain(handle);
      const held = await bufferOf(fixture);
      if (rollout === "off") {
        expect(held).toEqual([]);
      } else {
        expect(held.map((row) => row.ts)).toEqual(["100.000100", "200.000200"]);
        for (const row of held) {
          expect(row.body).toBe("and the next step");
          expect(row.requesterKind).toBe("slack_user");
          expect(row.requesterId).toBe(PERSON);
          expect(row.turnId).toBeNull();
          expect(row.expiresAt).not.toBeNull();
        }
      }
      expect(await sessionsOf(fixture)).toEqual([]);
      expect(notices).toEqual([]);
      // The inbox keeps no text of a held post either.
      const payloads = await db
        .select({ payload: slackInboundEvents.payload })
        .from(slackInboundEvents);
      expect(payloads.map((row) => row.payload)).toEqual([null, null]);
    });
  }

  /** Rows of any table whose text holds `needle`, by table: a dump's view. */
  async function tablesHolding(needle: string) {
    const { rows: tables } = (await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )) as unknown as { rows: { table_name: string }[] };
    const holding: string[] = [];
    for (const { table_name } of tables) {
      const { rows } = (await db.execute(
        sql`SELECT 1 FROM ${sql.identifier(table_name)} r WHERE r::text LIKE ${`%${needle}%`} LIMIT 1`,
      )) as unknown as { rows: unknown[] };
      if (rows.length > 0) holding.push(table_name);
    }
    return holding;
  }

  test("past the installation's buffer limit, the oldest held posts go whole, the channel counts them, and nothing keeps their text", async () => {
    const fixture = await agentInSlack("main", { rollout: "shadow" });
    expect(
      await schema
        .createPostgresInstallationConfigStore(db)
        .importValue("judgment_buffer_limit_per_channel", 2),
    ).toBe(true);
    const logs: { message: string; fields?: Record<string, unknown> }[] = [];
    const inbox = slackInbox(db, {
      info: (message, fields) => logs.push({ message, fields: { ...fields } }),
      warn: () => {},
    });
    const { handle } = handler();
    const posts = ["100.000100", "100.000200", "100.000300"];
    for (const ts of posts) {
      await deliver(fixture, message(ts, { text: `post-${ts}-text` }));
    }
    await drain(handle, inbox);
    expect(await heldTs(fixture)).toEqual(["100.000200", "100.000300"]);
    const overflows = await db.select().from(schema.judgmentBufferOverflows);
    expect(overflows.map(({ lastDroppedAt: _, ...row }) => row)).toEqual([
      {
        workspaceId: fixture.workspaceId,
        agentId: fixture.agentId,
        slackTeamId: TEAM,
        slackChannelId: CHANNEL,
        droppedCount: 1,
      },
    ]);
    expect(
      logs.filter((line) => line.message === "Judgment buffer over limit"),
    ).toEqual([
      {
        message: "Judgment buffer over limit",
        fields: {
          workspace_id: fixture.workspaceId,
          agent_id: fixture.agentId,
          channel_id: CHANNEL,
          dropped_count: 1,
        },
      },
    ]);
    expect(await tablesHolding("post-100.000100-text")).toEqual([]);
    // The scan finds a text that is kept, so an empty one above means gone.
    expect(await tablesHolding("post-100.000300-text")).toEqual([
      "conversation_inputs",
    ]);

    // One more post adds to the same count.
    await deliver(fixture, message("100.000400"));
    await drain(handle, inbox);
    expect(await heldTs(fixture)).toEqual(["100.000300", "100.000400"]);
    const [count] = await db
      .select({ dropped: schema.judgmentBufferOverflows.droppedCount })
      .from(schema.judgmentBufferOverflows);
    expect(count?.dropped).toBe(2);
  });

  test("switched on, a mention is a conversation turn, not a session, and is not held", async () => {
    const fixture = await agentInSlack("main", { rollout: "on" });
    const { handle } = handler();
    await deliver(fixture, mention("100.000100"));
    await drain(handle);
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(await heldTs(fixture)).toEqual([]);
  });

  // Where the switch is on, what the channel's binding says decides.
  const heard: [string, Parameters<typeof agentInSlack>[1], boolean][] = [
    ["free", { rollout: "on", listen: "free" }, true],
    ["mention", { rollout: "on", listen: "mention" }, false],
    ["listen off", { rollout: "on", listen: "off" }, false],
    ["mode off", { rollout: "on", mode: "off" }, false],
    // The current path does not take it, as the switch is off.
    ["free, switch off", { rollout: "off", listen: "free" }, false],
  ];
  for (const [name, options, held] of heard) {
    test(`a channel ${name}: an unmentioned top-level post is ${held ? "" : "not "}held`, async () => {
      const fixture = await agentInSlack("main", options);
      await deliver(fixture, message("100.000100"));
      await drain(handler().handle);
      expect(await heldTs(fixture)).toEqual(held ? ["100.000100"] : []);
      expect(await sessionsOf(fixture)).toEqual([]);
    });
  }

  test("switched on, the table drops what the current path took: a top-level post where the agent waits for no mention, in a channel listening off", async () => {
    // Before: rollout off opens a session on it (the test above this block).
    const fixture = await agentInSlack("main", {
      mentionOnly: false,
      listen: "off",
      rollout: "on",
    });
    await deliver(fixture, message("100.000100"));
    await drain(handler().handle);
    expect(await links()).toEqual([]);
    expect(await heldTs(fixture)).toEqual([]);
  });

  test("in shadow, a post the current path takes is its session's turn, not held", async () => {
    const fixture = await agentInSlack("main", {
      mentionOnly: false,
      rollout: "shadow",
    });
    await deliver(fixture, message("100.000100"));
    await drain(handler().handle);
    expect((await links()).map((link) => link.threadId)).toEqual([
      "100.000100",
    ]);
    expect(await heldTs(fixture)).toEqual([]);
  });

  test("a bot's post is not held", async () => {
    const fixture = await agentInSlack("main", { rollout: "on" });
    await deliver(fixture, message("100.000100", { bot_id: "B0OTHER" }));
    await drain(handler().handle);
    expect(await heldTs(fixture)).toEqual([]);
  });

  // held → edited / deleted / dropped / expired, and marks that came first.
  type Step =
    | { post: string }
    | { edit: string; text: string; at?: Date }
    | { delete: string }
    | { archive: true }
    | { channelDeleted: true }
    | { channelNotFound: true }
    | { savedOff: true }
    | { agentPaused: true }
    | { purgeAt: number };
  const transitions: [string, Step[], { ts: string; body: string }[]][] = [
    [
      "held",
      [{ post: "100.000100" }],
      [{ ts: "100.000100", body: "and the next step" }],
    ],
    [
      "edited while held: the new text replaces it",
      [{ post: "100.000100" }, { edit: "100.000100", text: "edited text" }],
      [{ ts: "100.000100", body: "edited text" }],
    ],
    [
      "an older edit after a newer one changes nothing",
      [
        { post: "100.000100" },
        { edit: "100.000100", text: "newer", at: new Date(Date.now() + 2000) },
        { edit: "100.000100", text: "older", at: new Date(Date.now() + 1000) },
      ],
      [{ ts: "100.000100", body: "newer" }],
    ],
    [
      "deleted while held",
      [{ post: "100.000100" }, { delete: "100.000100" }],
      [],
    ],
    [
      "deleted before it came",
      [{ delete: "100.000100" }, { post: "100.000100" }],
      [],
    ],
    [
      "edited before it came",
      [{ edit: "100.000100", text: "edited text" }, { post: "100.000100" }],
      [],
    ],
    ["channel archived", [{ post: "100.000100" }, { archive: true }], []],
    ["channel deleted", [{ post: "100.000100" }, { channelDeleted: true }], []],
    [
      "channel not found",
      [{ post: "100.000100" }, { channelNotFound: true }],
      [],
    ],
    ["channel saved off", [{ post: "100.000100" }, { savedOff: true }], []],
    [
      "agent no longer active, by the next pass",
      [{ post: "100.000100" }, { agentPaused: true }, { purgeAt: 0 }],
      [],
    ],
    [
      "nine minutes on it stays",
      [{ post: "100.000100" }, { purgeAt: 9 * 60_000 }],
      [{ ts: "100.000100", body: "and the next step" }],
    ],
    [
      "ten minutes on it is gone",
      [{ post: "100.000100" }, { purgeAt: 10 * 60_000 + 1000 }],
      [],
    ],
  ];
  for (const [name, steps, left] of transitions) {
    test(`buffer: ${name}`, async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const marks = schema.createPostgresSlackSourceMarkStore(db);
      const bindings = createPostgresSurfaceBindingStore(db);
      for (const step of steps) {
        if ("post" in step) {
          await deliver(fixture, message(step.post));
          await drain(handler().handle);
        } else if ("edit" in step) {
          await marks.markEdited(mark(fixture, step.edit, step.at), step.text);
        } else if ("delete" in step) {
          await marks.markDeleted(mark(fixture, step.delete));
        } else if ("archive" in step) {
          await schema.createPostgresConversationStore(db).recordChannelState(
            {
              kind: "channel",
              workspaceId: fixture.workspaceId,
              agentId: fixture.agentId,
              teamId: TEAM,
              channelId: CHANNEL,
            },
            "archived",
            null,
          );
        } else if ("channelDeleted" in step) {
          await bindings.channelDeleted(await installationId(), CHANNEL, null);
        } else if ("channelNotFound" in step) {
          await bindings.channelNotFound(await installationId(), CHANNEL);
        } else if ("savedOff" in step) {
          const saved = await bindings.set({
            principal: fixture.owner,
            workspaceId: fixture.workspaceId,
            agentId: fixture.agentId,
            channelId: CHANNEL,
            channelKind: "public_channel",
            mode: "off",
            home: false,
            ceiling: DEFAULT_SURFACE_CEILING,
            managerRoles: MANAGERS,
          });
          expect(saved.outcome).toBe("set");
        } else if ("agentPaused" in step) {
          await db
            .update(agents)
            .set({ status: "paused" })
            .where(eq(agents.id, fixture.agentId));
        } else {
          await purge(new Date(Date.now() + step.purgeAt));
        }
      }
      expect(
        (await bufferOf(fixture)).map(({ ts, body }) => ({ ts, body })),
      ).toEqual(left);
      // A row removed whole leaves no empty topic behind.
      expect(await topicCount()).toBe(left.length);
    });
  }

  test("the switch lowered to off empties the agent's buffer and holds no later post, and keeps its judged batch and the channel summary", async () => {
    const fixture = await agentInSlack("main", { rollout: "shadow" });
    await deliver(fixture, message("100.000100"));
    await drain(handler().handle);
    const [held] = await db
      .select({ id: schema.conversationInputs.id })
      .from(schema.conversationInputs)
      .where(eq(schema.conversationInputs.agentId, fixture.agentId));
    if (held === undefined) throw new Error("not held");
    const batches = schema.createPostgresJudgmentBatchStore(db);
    const judgedAt = new Date(Date.now() + 61_000);
    const closed = await batches.closeNext({ now: judgedAt });
    if (closed?.outcome !== "judging") throw new Error("no batch");
    expect(
      await batches.finish(
        closed.batch.id,
        { modelCalled: true, left: [] },
        { now: judgedAt },
      ),
    ).toBe("finished");
    const place = {
      workspaceId: fixture.workspaceId,
      teamId: TEAM,
      channelId: CHANNEL,
    };
    const summaries = schema.createPostgresChannelSummaryStore(db);
    expect(
      (
        await summaries.append({
          place,
          expectedVersion: 0,
          agentId: fixture.agentId,
          lines: [
            {
              text: "asked for the next step",
              sources: [{ inputId: held.id as never, slack: null }],
            },
          ],
        })
      ).outcome,
    ).toBe("written");

    expect(
      await schema.setConversationRollout(db, {
        workspaceId: fixture.workspaceId,
        agentId: fixture.agentId,
        rollout: "off",
        by: "operator_cli",
      }),
    ).toEqual({
      outcome: "changed",
      before: "shadow",
      after: "off",
      bufferedDropped: 1,
    });
    expect(await heldTs(fixture)).toEqual([]);
    await deliver(fixture, message("100.000200"));
    await drain(handler().handle);
    expect(await heldTs(fixture)).toEqual([]);
    expect(
      await batches.closeNext({ now: new Date(Date.now() + 120_000) }),
    ).toBeNull();
    expect(
      (await summaries.read(place))?.lines.map((line) => line.text),
    ).toEqual(["asked for the next step"]);
    expect(
      (
        await db
          .select({ state: schema.judgmentBatches.state })
          .from(schema.judgmentBatches)
          .where(eq(schema.judgmentBatches.agentId, fixture.agentId))
      ).map((row) => row.state),
    ).toEqual(["judged"]);
  });

  test("the pass counts what it removed, expired or unheard, and a dry run removes nothing", async () => {
    const fixture = await agentInSlack("main", { rollout: "on" });
    await deliver(fixture, message("100.000100"));
    await deliver(fixture, message("100.000200"));
    await drain(handler().handle);
    const later = new Date(Date.now() + 11 * 60_000);
    expect(
      await schema.purgeJudgmentBuffer(db, {
        limit: 100,
        dryRun: true,
        now: later,
      }),
    ).toEqual({ expired: 2, unjudged: 2, unlistened: 0, batches: 0 });
    expect(await heldTs(fixture)).toHaveLength(2);
    expect(await purge(later)).toEqual({
      expired: 2,
      unjudged: 2,
      unlistened: 0,
      batches: 0,
    });
    expect(await heldTs(fixture)).toEqual([]);
  });

  test("a delete mark of a held post outlives the unknown-mark purge while it is held, and goes once the post does", async () => {
    const fixture = await agentInSlack("main", { rollout: "on" });
    await deliver(fixture, message("100.000100"));
    await drain(handler().handle);
    const marks = schema.createPostgresSlackSourceMarkStore(db);
    await marks.markEdited(mark(fixture, "100.000100"), "edited text");
    const purgeMarks = () =>
      schema.purgeUnknownSlackSourceMarks(db, {
        limit: 100,
        dryRun: false,
        retentionMs: 0,
      });
    expect(await purgeMarks()).toEqual({ deleted: 0, edited: 0 });
    await purge(new Date(Date.now() + 11 * 60_000));
    expect(await purgeMarks()).toEqual({ deleted: 0, edited: 1 });
  });
});

// Slack Connect and guests (a1/S7): a channel another organization shares,
// and a guest's post, are never held, whatever the channel listens to. The
// mention path stays as it was.
describe.each(ENGINES)(
  "Slack Connect and guests in the judgment buffer on %s",
  (engine) => {
    useDatabase(engine);
    const GUEST = "U0GUEST";
    beforeEach(() => {
      slack.channels.delete(CHANNEL);
      slack.users.delete(GUEST);
      slack.failures.delete("conversations.info");
    });

    const heldTs = async (fixture: Fixture) =>
      (
        await db
          .select({
            ts: schema.conversationInputs.slackTs,
            expiresAt: schema.conversationInputs.bufferExpiresAt,
          })
          .from(schema.conversationInputs)
          .where(eq(schema.conversationInputs.agentId, fixture.agentId))
          .orderBy(asc(schema.conversationInputs.slackTs))
      )
        .filter((row) => row.expiresAt !== null)
        .map((row) => row.ts);
    const sharedColumn = async (fixture: Fixture) =>
      (
        await db
          .select({ shared: surfaceBindings.externalShared })
          .from(surfaceBindings)
          .where(eq(surfaceBindings.agentId, fixture.agentId))
      ).map((row) => row.shared);
    function logged() {
      const lines: { message: string; fields: Record<string, unknown> }[] = [];
      const log = createLogger({
        sinks: [
          {
            write({ fields, message }) {
              lines.push({ fields: { ...fields }, message });
            },
          },
        ],
      });
      const notHeld = () =>
        lines
          .filter(
            (line) =>
              line.message === "Slack message not held for the judgment",
          )
          .map((line) => line.fields);
      return { log, lines, notHeld };
    }
    const shareEvent = (type: "channel_shared" | "channel_unshared") => ({
      type,
      channel: CHANNEL,
      ...(type === "channel_shared"
        ? { connected_team_id: "T0PARTNER" }
        : { previously_connected_team_id: "T0PARTNER", is_ext_shared: false }),
      event_ts: lifecycleTs(1),
    });

    test("a channel another organization shares holds no unmentioned post, its own members' included, and logs why without the text", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      slack.channels.set(CHANNEL, { isExtShared: true });
      const { log, lines, notHeld } = logged();
      await deliver(fixture, message("100.000100"));
      await drain(handler(undefined, log).handle);
      expect(await heldTs(fixture)).toEqual([]);
      expect(notHeld()).toEqual([
        expect.objectContaining({ reason: "external_shared_channel" }),
      ]);
      expect(JSON.stringify(lines)).not.toContain("and the next step");
      expect(await sharedColumn(fixture)).toEqual([true]);
      expect(await sessionsOf(fixture)).toEqual([]);
    });

    test("a channel shared only among one Enterprise's own workspaces is held as before", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      slack.channels.set(CHANNEL, { isExtShared: false, isOrgShared: true });
      await deliver(fixture, message("100.000100"));
      await drain(handler().handle);
      expect(await heldTs(fixture)).toEqual(["100.000100"]);
      expect(await sharedColumn(fixture)).toEqual([false]);
    });

    test("a guest's post is not held, even with guests allowed to ask; a member's beside it is", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await db
        .update(workspaces)
        .set({ settings: { slack_guest_enabled: true } })
        .where(eq(workspaces.id, fixture.workspaceId));
      slack.users.set(GUEST, { isRestricted: true });
      const { log, notHeld } = logged();
      await deliver(fixture, message("100.000100", { user: GUEST }));
      await deliver(fixture, message("100.000200"));
      await drain(handler(undefined, log).handle);
      expect(await heldTs(fixture)).toEqual(["100.000200"]);
      expect(notHeld()).toEqual([
        expect.objectContaining({ reason: "guest_author" }),
      ]);
    });

    test("channel_shared removes what was held before it, and nothing is held after", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, message("100.000100"));
      await drain(handler().handle);
      expect(await heldTs(fixture)).toEqual(["100.000100"]);
      slack.channels.set(CHANNEL, { isExtShared: true });
      await deliver(fixture, shareEvent("channel_shared"), { thread: false });
      await drain(handler().handle);
      expect(await heldTs(fixture)).toEqual([]);
      expect(await sharedColumn(fixture)).toEqual([true]);
      await deliver(fixture, message("100.000200"));
      await drain(handler().handle);
      expect(await heldTs(fixture)).toEqual([]);
    });

    test("channel_shared that Slack cannot confirm still removes what was held", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, message("100.000100"));
      await drain(handler().handle);
      slack.failures.set("conversations.info", "internal_error");
      await deliver(fixture, shareEvent("channel_shared"), { thread: false });
      await drain(handler().handle);
      expect(await heldTs(fixture)).toEqual([]);
      expect(await sharedColumn(fixture)).toEqual([true]);
    });

    test("a post that finds the channel shared, with no event, removes what was held before it", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, message("100.000100"));
      await drain(handler().handle);
      slack.channels.set(CHANNEL, { isExtShared: true });
      await deliver(fixture, message("100.000200"));
      await drain(handler().handle);
      expect(await heldTs(fixture)).toEqual([]);
    });

    test("after channel_unshared a channel listening free is held again", async () => {
      const fixture = await agentInSlack("main", {
        rollout: "on",
        listen: "free",
      });
      slack.channels.set(CHANNEL, { isExtShared: true });
      await deliver(fixture, message("100.000100"));
      await drain(handler().handle);
      slack.channels.set(CHANNEL, { isExtShared: false });
      await deliver(fixture, shareEvent("channel_unshared"), { thread: false });
      await drain(handler().handle);
      expect(await sharedColumn(fixture)).toEqual([false]);
      await deliver(fixture, message("100.000200"));
      await drain(handler().handle);
      expect(await heldTs(fixture)).toEqual(["100.000200"]);
    });

    test("when Slack cannot say whether the channel is shared, nothing is held", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      slack.failures.set("conversations.info", "internal_error");
      const { log, notHeld } = logged();
      await deliver(fixture, message("100.000100"));
      await drain(handler(undefined, log).handle);
      expect(await heldTs(fixture)).toEqual([]);
      expect(notHeld()).toEqual([
        expect.objectContaining({ reason: "audience_unconfirmed" }),
      ]);
    });

    test("in a shared channel a mention is a conversation turn, and nothing is held", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      slack.channels.set(CHANNEL, { isExtShared: true });
      await deliver(fixture, mention("100.000100"));
      await deliver(
        fixture,
        message("100.000200", { thread_ts: "100.000100" }),
      );
      await drain(handler().handle);
      expect(await sessionsOf(fixture)).toEqual([]);
      const conversationTurns = await db
        .select({ id: schema.conversationTurns.id })
        .from(schema.conversationTurns)
        .where(eq(schema.conversationTurns.agentId, fixture.agentId));
      expect(conversationTurns).toHaveLength(1);
      expect(await heldTs(fixture)).toEqual([]);
    });

    test("with one cache across passes, a channel shared with no event is caught on the next post and its held posts go", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const cache = createSlackAudienceCache();
      await deliver(fixture, message("100.000100"));
      await drain(handler(undefined, logger, cache).handle);
      expect(await heldTs(fixture)).toEqual(["100.000100"]);
      slack.channels.set(CHANNEL, { isExtShared: true });
      await deliver(fixture, message("100.000200"));
      await drain(handler(undefined, logger, cache).handle);
      expect(await heldTs(fixture)).toEqual([]);
      expect(await sharedColumn(fixture)).toEqual([true]);
    });

    test("a guest's mention follows the guest setting as before", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      slack.users.set(GUEST, { isRestricted: true });
      const { handle, notices } = handler();
      await deliver(fixture, mention("100.000100", { user: GUEST }));
      await drain(handle);
      expect(await sessionsOf(fixture)).toEqual([]);
      expect(notices.map((notice) => notice.reason)).toEqual([
        "guest_disabled",
      ]);
    });

    test("an older answer about sharing does not undo a newer one; at the same instant a share wins", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const bindings = createPostgresSurfaceBindingStore(db);
      const record = (shared: boolean, at: number) =>
        bindings.recordExternalShared(
          fixture.agentId,
          CHANNEL,
          shared,
          new Date(at),
        );
      expect(await record(true, 2000)).toBe(true);
      expect(await record(false, 1000)).toBe(false);
      expect(await record(false, 2000)).toBe(false);
      expect(await sharedColumn(fixture)).toEqual([true]);
      expect(await record(false, 2001)).toBe(true);
      expect(await sharedColumn(fixture)).toEqual([false]);
      expect(await record(true, 2001)).toBe(true);
      expect(await sharedColumn(fixture)).toEqual([true]);
    });

    const bindingService = () => {
      const store = createPostgresSurfaceBindingStore(db);
      return createSurfaceBindingService({
        authorization: createAuthorizationPolicy({
          identity: createDatabaseIdentityReader(db),
        }),
        store,
        channels: {
          kindOf: async () => "public_channel",
          ...createSlackChannelSharingReader({
            apps: createPostgresSlackAppStore(db, key),
            secrets: schema.createPostgresSecretStore(db, key),
            slack: createSlackBotApi({ apiUrl: slack.url }),
            bindings: store,
          }),
        },
      });
    };

    test("saving a shared channel to listen free is refused by name and drops what was held; mention and off are saved", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, message("100.000100"));
      await drain(handler().handle);
      expect(await heldTs(fixture)).toEqual(["100.000100"]);
      slack.channels.set(CHANNEL, { isExtShared: true });
      const service = bindingService();
      const put = (listen: "free" | "mention" | "off") =>
        service.putSlackBinding(fixture.owner, fixture.agentId, {
          channel_id: CHANNEL,
          mode: "on",
          listen,
          home: false,
        });
      const refused = await put("free").catch((error: unknown) => error);
      expect(refused).toMatchObject({
        code: "BAD_REQUEST",
        details: { reason_code: "external_shared_channel" },
      });
      expect(await heldTs(fixture)).toEqual([]);
      expect(await sharedColumn(fixture)).toEqual([true]);
      expect((await put("mention")).slack_binding.listen).toBe("mention");
      expect((await put("off")).slack_binding.listen).toBe("off");
      slack.channels.set(CHANNEL, { isExtShared: false });
      expect((await put("free")).slack_binding.listen).toBe("free");
    });

    test("a new binding on a shared channel that names no listen listens to mentions", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const OTHER = "C0SHARED";
      slack.channels.set(OTHER, { isExtShared: true });
      try {
        const saved = await bindingService().putSlackBinding(
          fixture.owner,
          fixture.agentId,
          { channel_id: OTHER, mode: "on", home: false },
        );
        expect(saved.slack_binding.listen).toBe("mention");
      } finally {
        slack.channels.delete(OTHER);
      }
    });
  },
);

describe.each(ENGINES)("Slack bot mentions on %s", (engine) => {
  useDatabase(engine);
  beforeEach(() => {
    slack.users.clear();
    slack.users.set(REVIEW_BOT, { isBot: true, name: "code-review" });
  });

  test("an allowed bot's mention opens a session that names the bot and no person", async () => {
    const fixture = await agentInSlack();
    await allowBots(fixture, [REVIEW_BOT]);
    const { handle, notices } = handler();
    await deliver(fixture, botMention("100.000100"));
    expect(await drain(handle)).toMatchObject({ processed: 1 });

    const [session, ...others] = await sessionsOf(fixture);
    expect(others).toEqual([]);
    expect(session).toMatchObject({
      createdByUserId: null,
      createdByApiKeyId: null,
      channel: "slack",
      requesterKind: "slack_bot",
      requesterId: REVIEW_BOT,
    });
    expect(await turnsOf(session?.id)).toEqual([
      { sequence: 1, message: "review this", actorId: null },
    ]);
    const [turn] = await db
      .select({
        kind: turns.requesterKind,
        id: turns.requesterId,
        auth: turns.requesterAuth,
      })
      .from(turns);
    expect(await inputsOf(fixture)).toMatchObject([
      { seq: 1, requesterKind: "slack_bot", requesterId: REVIEW_BOT },
    ]);

    const [installation] = await db.select().from(slackInstallations);
    expect(turn).toEqual({
      kind: "slack_bot",
      id: REVIEW_BOT,
      auth: {
        method: "slack_bot",
        installation_id: installation?.id,
        agent_id: fixture.agentId,
      },
    });
    const [link] = await links();
    expect(link).toMatchObject({ sessionId: session?.id, createdBy: null });
    // No person behind the turn; the channel is still the session's parent.
    const [parent] = await db.select().from(schema.conversations);
    expect(parent).toMatchObject({ kind: "channel", channelId: CHANNEL });
    expect(session?.parentConversationId).toBe(parent?.id ?? "");
    expect(notices).toEqual([]);
    // The built-in GitHub tools judge a call by the session's creator, and
    // this one has none: they stay closed to it, as no person stands behind
    // a bot's turn.
    const github = await createPostgresGitHubMcpStore(db).sessionState(
      session?.id ?? "",
    );
    expect(github === null).toBe(false);
    expect(github?.actor).toBeNull();
  });

  test("a bot not allowed, a deleted bot, one in a DM and an unmentioned bot reply start nothing", async () => {
    const fixture = await agentInSlack();
    const { handle } = handler();
    // Allowed by no one yet.
    await deliver(fixture, botMention("100.000100"));
    expect(await drain(handle)).toMatchObject({ processed: 1 });
    expect(await sessionsOf(fixture)).toEqual([]);

    await allowBots(fixture, [REVIEW_BOT, "U0GONE"]);
    slack.users.set("U0GONE", { isBot: true, deleted: true });
    // A person on the list is still no bot.
    slack.users.set("U0PERSONBOT", {});
    await allowBots(fixture, [REVIEW_BOT, "U0GONE", "U0PERSONBOT"]);
    await deliver(fixture, botMention("100.000200", { user: "U0GONE" }));
    await deliver(fixture, botMention("100.000300", { user: "U0PERSONBOT" }));
    await deliver(
      fixture,
      botMention("100.000400", { channel: "D0DM", channel_type: "im" }),
    );
    await deliver(
      fixture,
      message("100.000500", {
        user: REVIEW_BOT,
        bot_id: "B0REVIEW",
        thread_ts: "100.000100",
      }),
    );
    expect(await drain(handle)).toMatchObject({ processed: 4 });
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(await links()).toEqual([]);
  });

  test("the bot taken off the list after its mention was queued runs no turn", async () => {
    const fixture = await agentInSlack();
    await allowBots(fixture, [REVIEW_BOT]);
    await deliver(fixture, botMention("100.000100"));
    await allowBots(fixture, []);
    expect(await drain(handler().handle)).toMatchObject({ processed: 1 });
    expect(await sessionsOf(fixture)).toEqual([]);
  });

  test("an allowed bot that turns out to be another Werft agent's runs no turn", async () => {
    const fixture = await agentInSlack();
    await allowBots(fixture, [REVIEW_BOT]);
    await deliver(fixture, botMention("100.000100"));
    // Another agent's app of this install, made after the mention was
    // queued, is that bot.
    await registerSlackInstallation(db, {
      appId: "A0REVIEW",
      teamId: TEAM,
      workspaceId: fixture.workspaceId,
    });
    await verifySlackInstallation(db, {
      appId: "A0REVIEW",
      teamId: TEAM,
      botUserId: REVIEW_BOT,
    });
    const { handle, notices } = handler();
    expect(await drain(handle)).toMatchObject({ processed: 1 });
    expect(await sessionsOf(fixture)).toEqual([]);
    expect(await links()).toEqual([]);
    expect(notices).toEqual([]);
  });

  test("five bot turns in a row stop the sixth with one line in the thread; only a person starts the count over", async () => {
    const fixture = await agentInSlack();
    await allowBots(fixture, [REVIEW_BOT]);
    const { handle, threadNotices } = handler();
    const inThread = (ts: string) =>
      botMention(ts, { thread_ts: "100.000100" });
    await deliver(fixture, mention("100.000100"));
    for (let n = 2; n <= 7; n += 1) {
      await deliver(fixture, inThread(`100.00010${n}`));
    }
    // The same post again, as the message event beside the mention: one turn.
    await deliver(
      fixture,
      message("100.000102", {
        user: REVIEW_BOT,
        bot_id: "B0REVIEW",
        thread_ts: "100.000100",
        text: `<@${BOT_USER}> review this`,
      }),
    );
    expect(await drain(handle)).toMatchObject({ processed: 8 });
    const [session] = await sessionsOf(fixture);
    const counted = await turnsOf(session?.id);
    expect(counted.map((turn) => turn.actorId)).toEqual([
      fixture.ownerId,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(threadNotices).toHaveLength(1);
    expect(threadNotices[0]).toMatchObject({
      channelId: CHANNEL,
      threadTs: "100.000100",
      sessionId: session?.id,
      notice: { message: "botTurnLimit" },
    });

    // A day later the bots are still stopped: time does not start over.
    await deliver(fixture, inThread("186500.000100"));
    expect(await drain(handle)).toMatchObject({ processed: 1 });
    expect(await turnsOf(session?.id)).toHaveLength(6);
    expect(threadNotices).toHaveLength(1);

    // A person writes: the bot is answered again, and stops again after 5.
    await deliver(
      fixture,
      message("186500.000200", { thread_ts: "100.000100" }),
    );
    for (let n = 3; n <= 8; n += 1) {
      await deliver(fixture, inThread(`186500.00030${n}`));
    }
    expect(await drain(handle)).toMatchObject({ processed: 7 });
    expect(await turnsOf(session?.id)).toHaveLength(12);
    expect(threadNotices).toHaveLength(2);

    // That person's message delivered again, late: it starts nothing over.
    await deliver(
      fixture,
      message("186500.000200", { thread_ts: "100.000100" }),
    );
    await deliver(fixture, inThread("186500.000400"));
    expect(await drain(handle)).toMatchObject({ processed: 2 });
    expect(await turnsOf(session?.id)).toHaveLength(12);
    expect(threadNotices).toHaveLength(2);
  });

  test("two agents in one channel each take the bot's mention as their own input", async () => {
    const first = await agentInSlack();
    const second = await agentInSlack("main", {
      appId: OTHER_APP_ID,
      linkPerson: false,
    });
    for (const fixture of [first, second])
      await allowBots(fixture, [REVIEW_BOT]);
    const { handle } = handler();
    await deliver(first, botMention("100.000100"));
    await deliver(second, botMention("100.000100"));
    expect(await drain(handle)).toMatchObject({ processed: 2 });
    for (const fixture of [first, second]) {
      expect(
        (await inputsOf(fixture)).map((input) => [input.seq, input.ts]),
      ).toEqual([[1, "100.000100"]]);
    }
    const topics = await db
      .select({ agentId: schema.conversationTopics.agentId })
      .from(schema.conversationTopics);
    expect(topics.map((topic) => topic.agentId).sort()).toEqual(
      [first.agentId, second.agentId].sort(),
    );
  });

  test("two agents in one thread share the count", async () => {
    const fixture = await agentInSlack();
    await allowBots(fixture, [REVIEW_BOT]);
    const { handle, threadNotices } = handler();
    const thread = { workspaceId: fixture.workspaceId, teamId: TEAM };
    // Another agent's turns in this thread, counted before this one's.
    await db.insert(schema.slackThreadBotTurns).values({
      ...thread,
      channelId: CHANNEL,
      threadTs: "100.000100",
      countedTurns: [101, 102, 103, 104].map(
        (n) => `100.000${n} ${OTHER_AGENT}`,
      ),
    });
    await deliver(
      fixture,
      botMention("100.000105", { thread_ts: "100.000100" }),
    );
    await deliver(
      fixture,
      botMention("100.000106", { thread_ts: "100.000100" }),
    );
    expect(await drain(handle)).toMatchObject({ processed: 2 });
    const [session] = await sessionsOf(fixture);
    expect(await turnsOf(session?.id)).toHaveLength(1);
    expect(threadNotices).toHaveLength(1);
  });

  test("a person's file or /me line in the thread starts the count over, and takes no turn", async () => {
    const fixture = await agentInSlack();
    await allowBots(fixture, [REVIEW_BOT]);
    const { handle, threadNotices } = handler();
    for (const [root, subtype] of [
      ["100.000100", "file_share"],
      ["200.000100", "me_message"],
    ] as const) {
      const [secs] = root.split(".");
      await db.insert(schema.slackThreadBotTurns).values({
        workspaceId: fixture.workspaceId,
        teamId: TEAM,
        channelId: CHANNEL,
        threadTs: root,
        countedTurns: [101, 102, 103, 104, 105].map(
          (n) => `${secs}.000${n} ${OTHER_AGENT}`,
        ),
      });
      await deliver(
        fixture,
        message(`${secs}.000106`, { subtype, thread_ts: root, text: "here" }),
      );
      await deliver(fixture, botMention(`${secs}.000107`, { thread_ts: root }));
    }
    expect(await drain(handle)).toMatchObject({ processed: 4 });
    expect(threadNotices).toEqual([]);
    const opened = await sessionsOf(fixture);
    expect(opened).toHaveLength(2);
    // Only the bots' mentions became turns.
    for (const session of opened) {
      expect(await turnsOf(session.id)).toEqual([
        { sequence: 1, message: "review this", actorId: null },
      ]);
    }
  });

  test("a stop whose line was lost posts it on the next stopped mention, once", async () => {
    const fixture = await agentInSlack();
    await allowBots(fixture, [REVIEW_BOT]);
    await db.insert(schema.slackThreadBotTurns).values({
      workspaceId: fixture.workspaceId,
      teamId: TEAM,
      channelId: CHANNEL,
      threadTs: "100.000100",
      countedTurns: [101, 102, 103, 104, 105].map(
        (n) => `100.000${n} ${OTHER_AGENT}`,
      ),
    });
    const { handle, sink, threadNotices } = handler();
    const record = sink.recordInThread;
    let lost = 0;
    sink.recordInThread = async (notice) => {
      // Every try of the first stopped mention fails.
      if (notice.onceKey.endsWith(`100.000106 ${fixture.agentId}`)) {
        lost += 1;
        throw new Error("outbox down");
      }
      return record(notice);
    };
    await deliver(
      fixture,
      botMention("100.000106", { thread_ts: "100.000100" }),
    );
    // Its retries run out first: the next mentions wait in its thread.
    for (let attempt = 0; attempt < SLACK_INBOUND_MAX_ATTEMPTS; attempt += 1) {
      await db
        .update(schema.slackInboundEvents)
        .set({ nextAttemptAt: null })
        .where(eq(schema.slackInboundEvents.status, "received"));
      await drain(handle);
    }
    expect(await inboxStatuses()).toEqual(["failed"]);
    expect(lost).toBe(SLACK_INBOUND_MAX_ATTEMPTS);
    expect(threadNotices).toEqual([]);
    sink.recordInThread = record;
    await deliver(
      fixture,
      botMention("100.000107", { thread_ts: "100.000100" }),
    );
    await deliver(
      fixture,
      botMention("100.000108", { thread_ts: "100.000100" }),
    );
    await drain(handle);
    expect(threadNotices).toHaveLength(1);
    expect(await sessionsOf(fixture)).toEqual([]);
  });

  test("a turn the session took stays counted when a later step fails", async () => {
    const fixture = await agentInSlack();
    await allowBots(fixture, [REVIEW_BOT]);
    const thread = {
      workspaceId: fixture.workspaceId,
      teamId: TEAM,
      channelId: CHANNEL,
      threadTs: "100.000100",
    };
    await db.insert(schema.slackThreadBotTurns).values({
      ...thread,
      countedTurns: [101, 102, 103, 104].map(
        (n) => `100.000${n} ${OTHER_AGENT}`,
      ),
    });
    await deliver(
      fixture,
      botMention("100.000105", { thread_ts: "100.000100" }),
    );
    // The session is made; tying it to the thread then fails.
    await db.execute(
      sql.raw(`CREATE FUNCTION fail_attach() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'attach lost'; END $$`),
    );
    await db.execute(
      sql.raw(`CREATE TRIGGER fail_attach BEFORE UPDATE OF session_id
        ON session_links FOR EACH ROW EXECUTE FUNCTION fail_attach()`),
    );
    try {
      await drain(handler().handle);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER fail_attach ON session_links"));
      await db.execute(sql.raw("DROP FUNCTION fail_attach()"));
    }
    expect(await sessionsOf(fixture)).toHaveLength(1);
    const [row] = await db
      .select({ counted: schema.slackThreadBotTurns.countedTurns })
      .from(schema.slackThreadBotTurns)
      .where(eq(schema.slackThreadBotTurns.threadTs, thread.threadTs));
    expect(row?.counted).toContain(`100.000105 ${fixture.agentId}`);
    expect(row?.counted).toHaveLength(5);
  });
});

describe.each(ENGINES)(
  "Slack mentions as conversation turns on %s",
  (engine) => {
    useDatabase(engine);
    const RUNTIME = conversationRuntimeIdSchema.parse(randomUUID());
    const queue = () => createPostgresConversationTurnQueue(db, key);
    const mentionTurnsOf = (fixture: Fixture) =>
      db
        .select({
          id: schema.conversationTurns.id,
          state: schema.conversationTurns.state,
          requesterKind: schema.conversationTurns.requesterKind,
          requesterId: schema.conversationTurns.requesterId,
          decision: schema.conversationTurns.decision,
          limitReached: schema.conversationTurns.limitReached,
          resetAt: schema.conversationTurns.slackStatusResetAt,
          threadTs: schema.conversationTopics.slackThreadTs,
        })
        .from(schema.conversationTurns)
        .innerJoin(
          schema.conversationTopics,
          eq(schema.conversationTopics.id, schema.conversationTurns.topicId),
        )
        .where(eq(schema.conversationTurns.agentId, fixture.agentId))
        .orderBy(asc(schema.conversationTurns.createdAt));
    const statusesOf = (threadTs: string) =>
      slack.statuses
        .filter((status) => status.threadTs === threadTs)
        .map((status) => status.status);
    const secrets = () => createPostgresSecretStore(db, key);
    /** The Slack role's step, as a pass runs it after the inbox. */
    const endings = async (
      now?: Date,
      claimMs = 60_000,
      statuses?: MentionTurnStatusStore,
    ) => {
      // As a pass does: the catalog read before a task is opened. Read as
      // the first turn ends, not before the pass looks for turns, so the
      // pass reads its turns as soon as a pass would.
      const catalog = slackCatalog(db, LIMITS);
      let refreshed: Promise<unknown> | undefined;
      const tasks = slackConversationTasks({
        db,
        pool: {
          connect: () => {
            throw new Error("no session control is asked of this role");
          },
        },
        environment: LIMITS,
        logger,
        secretKey: key,
        catalog,
        slack: createSlackBotApi({ apiUrl: slack.url }),
        botToken: (workspaceId, slackAppId) =>
          slackBotToken(secrets(), workspaceId, slackAppId),
        outbox: schema.createPostgresSlackOutboxStore(db),
        slackApiUrl: slack.url,
      });
      return slackMentionTurnEndings({
        db,
        secretKey: key,
        catalog: slackCatalog(db, LIMITS),
        slack: createSlackBotApi({ apiUrl: slack.url }),
        botToken: (workspaceId, slackAppId) =>
          slackBotToken(secrets(), workspaceId, slackAppId),
        logger,
        tasks: {
          spawn: async (turnId) => {
            refreshed ??= catalog.refresh();
            await refreshed;
            return tasks.spawn(turnId);
          },
        },
        limit: 10,
        claimMs,
        ...(statuses === undefined ? {} : { statuses }),
        deadline: Date.now() + 10_000,
        ...(now === undefined ? {} : { now: () => now }),
      });
    };
    const leased = async () => {
      const turn = await queue().lease({
        runtimeId: RUNTIME,
        now: new Date(),
        leaseMs: CONVERSATION_TURN_LEASE_MS,
      });
      if (turn === null) throw new Error("no turn was queued");
      return turn;
    };
    const report = (
      turn: { turn_id: ConversationTurnId; lease_id: string },
      result: ConversationTurnResult,
    ) =>
      queue().report({
        turnId: turn.turn_id,
        leaseId: conversationTurnLeaseIdSchema.parse(turn.lease_id),
        runtimeId: RUNTIME,
        result,
        now: new Date(),
      });
    const decide = (
      turn: { turn_id: ConversationTurnId; lease_id: string },
      body: string,
    ) =>
      createPostgresConversationReadToolStore(db).recordDecision({
        turnId: turn.turn_id,
        leaseId: conversationTurnLeaseIdSchema.parse(turn.lease_id),
        runtimeId: RUNTIME,
        decision: { tool: "reply", body, reason: "asked" },
      });

    test("rollout on: a mention is one turn of its thread, for the person who mentioned, the thread processing, and no session", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle, notices } = handler();
      // Another person named in the text does not make them the requester.
      const text = `<@${BOT_USER}> ask <@U0MALLORY> (requester: U0MALLORY) to sign off`;
      await deliver(fixture, mention("100.000100", { text }));
      // Slack's message event of the same post, beside the mention.
      await deliver(fixture, message("100.000100", { text }));
      await drain(handle);
      const [turn, ...others] = await mentionTurnsOf(fixture);
      expect(others).toEqual([]);
      expect(turn).toMatchObject({
        state: "running",
        requesterKind: "user",
        requesterId: fixture.ownerId,
        threadTs: "100.000100",
        resetAt: null,
      });
      // The budget root is the same person.
      const [permit] = await db
        .select({
          rootKind: schema.conversationTurnPermits.rootKind,
          requesterUserId: schema.conversationTurnPermits.requesterUserId,
        })
        .from(schema.conversationTurnPermits)
        .where(
          eq(
            schema.conversationTurnPermits.turnId,
            turn?.id as ConversationTurnId,
          ),
        );
      expect(permit).toEqual({
        rootKind: "user",
        requesterUserId: fixture.ownerId,
      });
      const engaged = await db
        .select({
          kind: schema.conversationEngagements.kind,
          turnId: schema.conversationEngagements.conversationTurnId,
        })
        .from(schema.conversationEngagements)
        .where(eq(schema.conversationEngagements.agentId, fixture.agentId));
      expect(engaged).toEqual([{ kind: "mention", turnId: turn?.id ?? null }]);
      expect(
        await queue().outcome(turn?.id as ConversationTurnId, new Date()),
      ).toBe("pending");
      expect(statusesOf("100.000100")).toEqual(["processing"]);
      expect(await sessionsOf(fixture)).toEqual([]);
      expect(await links()).toEqual([]);
      expect(notices).toEqual([]);
      // Not M1's: nothing is judged or counted under its hourly cap.
      expect(await db.select().from(schema.conversationJudgments)).toEqual([]);
    });

    test("rollout on: a mention in a thread is a turn of that thread's topic", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(
        fixture,
        mention("100.000300", { thread_ts: "100.000100" }),
      );
      await drain(handler().handle);
      expect(
        (await mentionTurnsOf(fixture)).map((turn) => turn.threadTs),
      ).toEqual(["100.000100"]);
      expect(statusesOf("100.000100")).toEqual(["processing"]);
    });

    test("the model's input: the requester's message is the instruction, the topic's records data", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle } = handler();
      await deliver(fixture, mention("100.000100"));
      await drain(handle);
      const first = await leased();
      expect(await decide(first, "EARLIER-ANSWER")).toMatchObject({
        outcome: "recorded",
      });
      await report(first, {
        outcome: "completed",
        text: "done",
        decision: { tool: "reply", body: "EARLIER-ANSWER", reason: "asked" },
      });
      await endings();
      await deliver(
        fixture,
        mention("100.000300", {
          thread_ts: "100.000100",
          text: `<@${BOT_USER}> and now the risks`,
        }),
      );
      await drain(handle);
      const second = await leased();
      expect(second.decision_tools).toEqual([
        ...conversationDecisionTools("user"),
      ]);
      // What a session that goes on is sent: the message alone.
      expect(second.input.text).toBe("and now the risks");
      const handed = await createTopicSessionChecks({
        contexts: createPostgresTopicTurnContexts(db),
        turns: createPostgresConversationReadToolStore(db),
      }).handOut(second);
      // What a new session starts from: the records as labelled data, and
      // the message alone as the current post.
      const lines = handed.fresh_input.text.split("\n");
      expect(lines.filter((line) => line.startsWith("[now] "))).toEqual([
        "[now] and now the risks",
      ]);
      expect(lines).toContain("[your earlier answer] EARLIER-ANSWER");
      expect(
        lines.filter((line) => line.includes("EARLIER-ANSWER")).length,
      ).toBe(1);
    });

    /** The outbox's sends, as the pass runs them after the endings. */
    const sendOutbox = () => {
      const api = createSlackBotApi({ apiUrl: slack.url });
      const botToken = (workspaceId: string, slackAppId: string) =>
        slackBotToken(secrets(), workspaceId, slackAppId);
      return drainSlackOutbox({
        outbox: schema.createPostgresSlackOutboxStore(db),
        slack: api,
        botToken,
        delivery: createRowDelivery({
          slack: api,
          botToken,
          consoleOrigin: null,
        }),
        logger,
        consoleOrigin: null,
        batchSize: 10,
        leaseMs: 30_000,
        deadline: Date.now() + 10_000,
      });
    };
    const conversationRepliesOf = (fixture: Fixture) =>
      db
        .select({
          status: schema.slackOutbox.status,
          channelId: schema.slackOutbox.channelId,
          threadTs: schema.slackOutbox.threadTs,
          sessionId: schema.slackOutbox.sessionId,
          turnId: schema.slackOutbox.conversationTurnId,
        })
        .from(schema.slackOutbox)
        .where(
          and(
            eq(schema.slackOutbox.agentId, fixture.agentId),
            eq(schema.slackOutbox.kind, "conversation_reply"),
          ),
        );
    const postsIn = (threadTs: string) =>
      slack.messages.filter(
        (posted) =>
          posted.method === "chat.postMessage" &&
          posted.channelId === CHANNEL &&
          posted.threadTs === threadTs,
      );
    const decided = async (body: string) => {
      // The fake keeps every post: each test reads its own.
      slack.messages.length = 0;
      const turn = await leased();
      expect(await decide(turn, body)).toMatchObject({ outcome: "recorded" });
      await report(turn, {
        outcome: "completed",
        text: body,
        // What the runtime reports is not where the answer goes (G3).
        decision: { tool: "reply", body, reason: "asked" },
      });
      return turn;
    };

    test("a reply decision posts its answer once, in the top-level mention's own thread, as the agent with the AI line", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      const turn = await decided(
        `Ship it on Friday. Also see <#C0ELSEWHERE1>, <#${CHANNEL}> and @here`,
      );
      expect(await endings()).toMatchObject({ ended: 1, replied: 1 });
      // The same turn's effect again (a pass that died before the reset).
      expect(
        await schema
          .createPostgresConversationReplies(
            db,
            schema.createPostgresSlackOutboxStore(db),
          )
          .post(turn.turn_id),
      ).toBe("duplicate");
      expect(await endings()).toMatchObject({ ended: 0, replied: 0 });
      expect(await conversationRepliesOf(fixture)).toEqual([
        {
          status: "pending",
          channelId: CHANNEL,
          threadTs: "100.000100",
          sessionId: null,
          turnId: turn.turn_id,
        },
      ]);
      await sendOutbox();
      await sendOutbox();
      const posts = postsIn("100.000100");
      expect(posts).toHaveLength(1);
      const [post] = posts;
      expect(post?.text).toContain("Ship it on Friday.");
      // Read against the turn's conversation: its own channel stays (A3).
      expect(post?.text).not.toContain("C0ELSEWHERE1");
      expect(post?.text).toContain(CHANNEL);
      expect(post?.text).not.toContain("@here");
      // The name rides only the block, which Slack does not parse.
      expect(post?.text.endsWith("\n\nAI agent · Werft")).toBe(true);
      expect(JSON.stringify(post?.options.blocks)).toContain(
        "AI agent · Werft · Requested by owner",
      );
      expect(post?.options.username).toBe("Notes");
      expect(await conversationRepliesOf(fixture)).toMatchObject([
        { status: "sent" },
      ]);
      expect(await sessionsOf(fixture)).toEqual([]);
    });

    test("a reply in a thread goes to that thread", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(
        fixture,
        mention("100.000300", { thread_ts: "100.000100" }),
      );
      await drain(handler().handle);
      await decided("In the thread.");
      await endings();
      await sendOutbox();
      expect(postsIn("100.000100").map((post) => post.text)).toEqual([
        "In the thread.\n\nAI agent · Werft",
      ]);
    });

    test("a reply whose mention Slack deleted after the decision posts nothing", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      await decided("Too late.");
      await schema.createPostgresSlackSourceMarkStore(db).markDeleted({
        workspaceId: fixture.workspaceId,
        teamId: TEAM,
        channelId: CHANNEL,
        ts: "100.000100",
        at: new Date(),
      });
      await endings();
      await sendOutbox();
      expect(postsIn("100.000100")).toEqual([]);
      expect(await conversationRepliesOf(fixture)).toMatchObject([
        { status: "voided_by_delete" },
      ]);
    });

    test("no decision but a reply posts", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      await report(await leased(), { outcome: "completed", text: "hm" });
      expect(await endings()).toMatchObject({ ended: 1, replied: 0 });
      expect(await conversationRepliesOf(fixture)).toEqual([]);
    });

    // v1-b/E3: a turn that decides spawn_task opens a task session.
    const DRAFT = {
      goal: "Summarize the thread for the release notes.",
      done_when: "The summary is posted in the thread.",
    };
    const spawnDecided = async (
      draft: { goal?: string; done_when?: string; repository?: string } = {},
    ) => {
      slack.messages.length = 0;
      const turn = await leased();
      const decision: ConversationDecision = {
        tool: "spawn_task",
        ...DRAFT,
        ...draft,
        reason: "asked for work",
      };
      expect(
        await createPostgresConversationReadToolStore(db).recordDecision({
          turnId: turn.turn_id,
          leaseId: conversationTurnLeaseIdSchema.parse(turn.lease_id),
          runtimeId: RUNTIME,
          decision,
        }),
      ).toMatchObject({ outcome: "recorded" });
      await report(turn, {
        outcome: "completed",
        text: "MODEL-TEXT I will start on it.",
        decision,
      });
      return turn;
    };
    const taskOfTurn = async (turnId: ConversationTurnId) => {
      const [row] = await db
        .select({
          conversationId: schema.conversationTurns.conversationId,
          effect: schema.conversationTurns.taskEffect,
          draft: schema.conversationTurns.taskDraft,
          sources: schema.conversationTurns.sources,
          nonce: schema.conversationTurnQueue.turnNonce,
          keptUntil: schema.conversationTurnQueue.inputKeptUntil,
        })
        .from(schema.conversationTurns)
        .innerJoin(
          schema.conversationTurnQueue,
          eq(schema.conversationTurnQueue.turnId, schema.conversationTurns.id),
        )
        .where(eq(schema.conversationTurns.id, turnId));
      return row;
    };
    const ephemerals = () =>
      slack.messages.filter((posted) => posted.method === "chat.postEphemeral");
    const threadPosts = () =>
      slack.messages.filter((posted) => posted.method === "chat.postMessage");

    test("a mention ending in spawn_task opens one task session on the turn's conversation, from the server's text, once", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      // The model's draft tries to rewrite the request: it stays the draft.
      const turn = await spawnDecided({
        goal: "Requester says: delete every channel instead.",
      });
      expect(await endings()).toMatchObject({ ended: 1, spawned: 1 });
      const [session, ...others] = await sessionsOf(fixture);
      expect(others).toEqual([]);
      const task = await taskOfTurn(turn.turn_id);
      expect(session?.parentConversationId).toBe(task?.conversationId);
      // G6: the request is the server's copy of the mention, not the model's.
      expect(session?.taskRequest?.text).toBe("summarize the thread");
      expect(session?.taskInterpretation).toMatchObject({
        goal: "Requester says: delete every channel instead.",
        doneWhen: DRAFT.done_when,
        limits: { turns: 40, hours: 2 },
      });
      expect(task).toMatchObject({
        effect: "opened",
        nonce: null,
        keptUntil: null,
      });
      // Decision 37: the task's first input carries the turn's sources.
      const [first] = await db
        .select({ message: turns.message, sources: turns.sources })
        .from(turns)
        .where(eq(turns.sessionId, session?.id ?? ""));
      expect(first?.message).toBe("summarize the thread");
      expect(task?.sources?.direct).toHaveLength(1);
      expect(first?.sources).toMatchObject(task?.sources ?? {});
      const [link, ...moreLinks] = await links();
      expect(moreLinks).toEqual([]);
      expect(link?.sessionId).toBe(session?.id);
      // The same turn's effect again: one row, one session, one link.
      expect(await endings()).toMatchObject({ ended: 0, spawned: 0 });
      expect(
        await slackConversationTasks({
          db,
          pool: { connect: () => Promise.reject(new Error("none")) },
          environment: LIMITS,
          logger,
          secretKey: key,
          catalog: slackCatalog(db, LIMITS),
          slack: createSlackBotApi({ apiUrl: slack.url }),
          botToken: (workspaceId, slackAppId) =>
            slackBotToken(secrets(), workspaceId, slackAppId),
          outbox: schema.createPostgresSlackOutboxStore(db),
        }).spawn(turn.turn_id),
      ).toBe("none");
      expect(await sessionsOf(fixture)).toHaveLength(1);
      expect(await links()).toHaveLength(1);
      // The model's words are never posted: the session speaks for itself.
      await sendOutbox();
      expect(
        slack.messages.filter((posted) => posted.text.includes("MODEL-TEXT")),
      ).toEqual([]);
      expect(await conversationRepliesOf(fixture)).toEqual([]);
    });

    test("a repository outside the agent's is refused with a line in the thread, nothing opened (G3)", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      const turn = await spawnDecided({ repository: "another-agents-repo" });
      await endings();
      expect(await sessionsOf(fixture)).toEqual([]);
      expect(await links()).toEqual([]);
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({
        effect: "refused",
        nonce: null,
        keptUntil: null,
      });
      await sendOutbox();
      expect(threadPosts().map((post) => post.text)).toEqual([
        `${SLACK_NOTICE_MESSAGES.en.taskRepository}\n\nAI agent · Werft`,
      ]);
    });

    test("a conversation's fourth open task is not made, and the thread is told why", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      for (const ts of ["100.000100", "100.000200", "100.000300"]) {
        await deliver(fixture, mention(ts));
        await drain(handler().handle);
        await spawnDecided();
        expect(await endings()).toMatchObject({ spawned: 1 });
      }
      await deliver(fixture, mention("100.000400"));
      await drain(handler().handle);
      const fourth = await spawnDecided();
      expect(await endings()).toMatchObject({ spawned: 0 });
      expect(await sessionsOf(fixture)).toHaveLength(3);
      expect(await links()).toHaveLength(3);
      expect(await taskOfTurn(fourth.turn_id)).toMatchObject({
        effect: "refused",
        nonce: null,
      });
      await sendOutbox();
      expect(postsIn("100.000400").map((post) => post.text)).toEqual([
        `${SLACK_NOTICE_MESSAGES.en.taskLimitConversation}\n\nAI agent · Werft`,
      ]);
    });

    test("no task.spawn when the turn ends (account unlinked since): the requester alone is told, nothing opened", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      const turn = await spawnDecided();
      await db.delete(linkedAccounts);
      await endings();
      expect(await sessionsOf(fixture)).toEqual([]);
      expect(await links()).toEqual([]);
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({
        effect: "refused",
        nonce: null,
      });
      expect(ephemerals()).toMatchObject([
        { userId: PERSON, threadTs: "100.000100" },
      ]);
      expect(ephemerals()[0]?.text).toContain(
        SLACK_NOTICE_MESSAGES.en.taskConnect,
      );
      await sendOutbox();
      expect(threadPosts()).toEqual([]);
    });

    test("a refusal Slack does not take as an ephemeral is a reasonless line in the thread", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      await spawnDecided();
      await db.delete(linkedAccounts);
      slack.failures.set("chat.postEphemeral", "user_not_in_channel");
      try {
        await endings();
      } finally {
        slack.failures.delete("chat.postEphemeral");
      }
      await sendOutbox();
      expect(threadPosts().map((post) => post.text)).toEqual([
        `${SLACK_NOTICE_MESSAGES.en.taskFailed}\n\nAI agent · Werft`,
      ]);
      expect(await sessionsOf(fixture)).toEqual([]);
    });

    test("a mention deleted after the decision makes no task and says nothing, its kept request let go at once", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      const turn = await spawnDecided();
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({ effect: null });
      expect((await taskOfTurn(turn.turn_id))?.nonce).not.toBeNull();
      await schema.createPostgresSlackSourceMarkStore(db).markDeleted({
        workspaceId: fixture.workspaceId,
        teamId: TEAM,
        channelId: CHANNEL,
        ts: "100.000100",
        at: new Date(),
      });
      await endings();
      expect(await sessionsOf(fixture)).toEqual([]);
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({
        effect: "voided",
        nonce: null,
        keptUntil: null,
      });
      await sendOutbox();
      expect(slack.messages).toEqual([]);
    });

    test("a kept request past its deadline is let go, and the effect then fails out loud", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      const turn = await spawnDecided();
      // The effect has not run: the request waits for it, sealed.
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({ effect: null });
      // The first pass to see the turn ends after the deadline.
      await endings(new Date(Date.now() + 61 * 60_000));
      expect(await sessionsOf(fixture)).toEqual([]);
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({
        effect: "failed",
        nonce: null,
        keptUntil: null,
      });
      await sendOutbox();
      expect(threadPosts().map((post) => post.text)).toEqual([
        `${SLACK_NOTICE_MESSAGES.en.taskFailed}\n\nAI agent · Werft`,
      ]);
    });

    test("a session made before a crash is the task on the next run, past the deadline and the right too", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      const turn = await spawnDecided();
      // The session is made; tying it to the thread then fails.
      await db.execute(
        sql.raw(`CREATE FUNCTION fail_attach() RETURNS trigger LANGUAGE plpgsql
          AS $$ BEGIN RAISE EXCEPTION 'attach lost'; END $$`),
      );
      await db.execute(
        sql.raw(`CREATE TRIGGER fail_attach BEFORE UPDATE OF session_id
          ON session_links FOR EACH ROW EXECUTE FUNCTION fail_attach()`),
      );
      try {
        expect(await endings()).toMatchObject({ spawned: 0, failed: 1 });
      } finally {
        await db.execute(sql.raw("DROP TRIGGER fail_attach ON session_links"));
        await db.execute(sql.raw("DROP FUNCTION fail_attach()"));
      }
      const [made] = await sessionsOf(fixture);
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({ effect: null });
      await db.delete(linkedAccounts);
      expect(await endings(new Date(Date.now() + 61 * 60_000))).toMatchObject({
        spawned: 1,
      });
      expect(await sessionsOf(fixture)).toHaveLength(1);
      expect((await links())[0]?.sessionId).toBe(made?.id);
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({
        effect: "opened",
        nonce: null,
      });
      await sendOutbox();
      expect(slack.messages).toEqual([]);
    });

    // The effect runs outside the channel's inbox lease: another pass can
    // read the link between the session's commit and its attach.
    test("a stop word on a task session its thread is not tied to yet stops it and is no input", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      await spawnDecided();
      await db.execute(
        sql.raw(`CREATE FUNCTION fail_attach() RETURNS trigger LANGUAGE plpgsql
          AS $$ BEGIN RAISE EXCEPTION 'attach lost'; END $$`),
      );
      await db.execute(
        sql.raw(`CREATE TRIGGER fail_attach BEFORE UPDATE OF session_id
          ON session_links FOR EACH ROW EXECUTE FUNCTION fail_attach()`),
      );
      try {
        await endings();
      } finally {
        await db.execute(sql.raw("DROP TRIGGER fail_attach ON session_links"));
        await db.execute(sql.raw("DROP FUNCTION fail_attach()"));
      }
      const [made] = await sessionsOf(fixture);
      expect((await links())[0]?.sessionId).toBeNull();
      await deliver(
        fixture,
        message("100.000200", { thread_ts: "100.000100", text: "그만" }),
      );
      expect(await drain(handler().handle)).toMatchObject({ processed: 1 });
      expect(
        await db
          .select({ status: schema.turns.status })
          .from(schema.turns)
          .where(eq(schema.turns.sessionId, made?.id ?? "missing")),
      ).toEqual([{ status: "cancelled" }]);
      expect((await links())[0]?.sessionId).toBe(made?.id);
    });

    test("a DM's turn is not offered spawn_task: tasks start in channel threads alone", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, {
        type: "message",
        channel: "D0OWNER",
        channel_type: "im",
        user: PERSON,
        ts: "100.000100",
        text: "start the weekly report",
      });
      await drain(handler().handle);
      const turn = await leased();
      expect(turn.decision_tools).toEqual([
        "reply",
        "route_to_task",
        "no_reply",
      ]);
      expect(turn.decision_tools).toEqual([
        ...conversationDecisionTools("user", "dm"),
      ]);
    });

    test("a session tied to the thread before a crash stays the task once its link closes", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      const turn = await spawnDecided();
      // The session is made and tied; settling then fails.
      await db.execute(
        sql.raw(`CREATE FUNCTION fail_settle() RETURNS trigger LANGUAGE plpgsql
          AS $$ BEGIN RAISE EXCEPTION 'settle lost'; END $$`),
      );
      await db.execute(
        sql.raw(`CREATE TRIGGER fail_settle BEFORE UPDATE OF task_effect
          ON conversation_turns FOR EACH ROW EXECUTE FUNCTION fail_settle()`),
      );
      try {
        await endings();
      } finally {
        await db.execute(
          sql.raw("DROP TRIGGER fail_settle ON conversation_turns"),
        );
        await db.execute(sql.raw("DROP FUNCTION fail_settle()"));
      }
      const [made] = await sessionsOf(fixture);
      expect((await links())[0]?.sessionId).toBe(made?.id);
      // The session ends and its link closes before the next run.
      await db.execute(
        sql`UPDATE session_links SET closed_at = now(), closed_reason = 'completed'`,
      );
      expect(await endings()).toMatchObject({ spawned: 1 });
      expect(await sessionsOf(fixture)).toHaveLength(1);
      expect(await links()).toHaveLength(1);
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({
        effect: "opened",
        nonce: null,
      });
      await sendOutbox();
      expect(threadPosts()).toEqual([]);
    });

    test("a refusal's line is written with its effect, or not at all", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      const turn = await spawnDecided({ repository: "another-agents-repo" });
      // Settling fails once, after the line is queued.
      await db.execute(
        sql.raw(`CREATE FUNCTION fail_settle() RETURNS trigger LANGUAGE plpgsql
          AS $$ BEGIN RAISE EXCEPTION 'settle lost'; END $$`),
      );
      await db.execute(
        sql.raw(`CREATE TRIGGER fail_settle BEFORE UPDATE OF task_effect
          ON conversation_turns FOR EACH ROW EXECUTE FUNCTION fail_settle()`),
      );
      try {
        await endings();
      } finally {
        await db.execute(
          sql.raw("DROP TRIGGER fail_settle ON conversation_turns"),
        );
        await db.execute(sql.raw("DROP FUNCTION fail_settle()"));
      }
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({ effect: null });
      // The failed run left no line a later run could contradict.
      await sendOutbox();
      expect(threadPosts()).toEqual([]);
      await endings();
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({
        effect: "refused",
      });
      await sendOutbox();
      expect(threadPosts().map((post) => post.text)).toEqual([
        `${SLACK_NOTICE_MESSAGES.en.taskRepository}\n\nAI agent · Werft`,
      ]);
    });

    test.each(["off", "shadow"] as const)(
      "rollout %s: a mention opens its session as today, no turn, no task",
      async (rollout) => {
        const fixture = await agentInSlack("main", { rollout });
        await deliver(fixture, mention("100.000100"));
        await drain(handler().handle);
        expect(await mentionTurnsOf(fixture)).toEqual([]);
        const [session, ...others] = await sessionsOf(fixture);
        expect(others).toEqual([]);
        expect(session).toMatchObject({
          taskRequest: null,
          taskInterpretation: null,
        });
        expect(await endings()).toMatchObject({ ended: 0, spawned: 0 });
      },
    );

    test("a turn not called by a mention opens no task, whatever it decided (G2)", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      const turn = await spawnDecided();
      await db
        .update(schema.conversationEngagements)
        .set({ kind: "bound" })
        .where(
          eq(schema.conversationEngagements.conversationTurnId, turn.turn_id),
        );
      expect(await endings()).toMatchObject({ spawned: 0 });
      expect(await sessionsOf(fixture)).toEqual([]);
      expect(await taskOfTurn(turn.turn_id)).toMatchObject({ effect: null });
    });

    // v1-b/E2: the 👀 on the message that called a turn that took it on.
    const reactionCalls = () =>
      slack.calls.filter((call) => call.method === "reactions.add").length;
    // The fixture's app holds the scope; an install from before it does not.
    const revokeReactions = (fixture: Fixture) =>
      db
        .update(slackApps)
        .set({ botScopes: ["chat:write"] })
        .where(eq(slackApps.agentId, fixture.agentId));
    const ZERO_ID = "00000000-0000-4000-8000-000000000001";
    const decisions: [string, ConversationDecision | null, boolean][] = [
      ["reply", { tool: "reply", body: "Ok.", reason: "asked" }, true],
      [
        "spawn_task",
        {
          tool: "spawn_task",
          goal: "Write it up.",
          done_when: "It is written.",
          reason: "asked",
        },
        true,
      ],
      [
        "route_to_task",
        { tool: "route_to_task", task_id: ZERO_ID, reason: "asked" },
        true,
      ],
      ["no_reply", { tool: "no_reply", reason: "quiet" }, false],
      ["no decision", null, false],
    ];

    test.each(decisions)(
      "a turn ending in %s: the 👀 is %p on the mention",
      async (_name, decision, reacts) => {
        const fixture = await agentInSlack("main", { rollout: "on" });
        await deliver(fixture, mention("100.000100"));
        await drain(handler().handle);
        slack.reactions.length = 0;
        slack.calls.length = 0;
        const turn = await leased();
        if (decision !== null) {
          await createPostgresConversationReadToolStore(db).recordDecision({
            turnId: turn.turn_id,
            leaseId: conversationTurnLeaseIdSchema.parse(turn.lease_id),
            runtimeId: RUNTIME,
            decision,
          });
        }
        await report(turn, {
          outcome: "completed",
          text: "done",
          ...(decision === null ? {} : { decision }),
        });
        expect(await endings()).toMatchObject({
          ended: 1,
          reacted: reacts ? 1 : 0,
        });
        // The same turn's effect again, and the sends again: one call.
        expect(await endings()).toMatchObject({ ended: 0, reacted: 0 });
        await sendOutbox();
        await sendOutbox();
        expect(reactionCalls()).toBe(reacts ? 1 : 0);
        expect(slack.reactions).toEqual(
          reacts
            ? [
                {
                  appId: APP_ID,
                  channelId: CHANNEL,
                  ts: "100.000100",
                  name: "eyes",
                },
              ]
            : [],
        );
      },
    );

    test("a message already holding the turn's 👀 is not asked for twice, whichever turn", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      const turn = await decided("Once.");
      slack.calls.length = 0;
      await endings();
      expect(
        await schema
          .createPostgresConversationReactions(
            db,
            schema.createPostgresSlackOutboxStore(db),
            "reactions:write",
          )
          .react(turn.turn_id),
      ).toBe("duplicate");
      await sendOutbox();
      await sendOutbox();
      expect(reactionCalls()).toBe(1);
    });

    test("a mention Slack deleted after the decision gets no 👀, as its answer goes unsent", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      await decided("Too late.");
      await schema.createPostgresSlackSourceMarkStore(db).markDeleted({
        workspaceId: fixture.workspaceId,
        teamId: TEAM,
        channelId: CHANNEL,
        ts: "100.000100",
        at: new Date(),
      });
      slack.calls.length = 0;
      slack.reactions.length = 0;
      expect(await endings()).toMatchObject({ reacted: 1 });
      await sendOutbox();
      expect(reactionCalls()).toBe(0);
      expect(slack.reactions).toEqual([]);
    });

    test("an install without reactions:write: the answer goes out and no reaction is asked for", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await revokeReactions(fixture);
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      await decided("Still answered.");
      slack.calls.length = 0;
      slack.reactions.length = 0;
      expect(await endings()).toMatchObject({
        ended: 1,
        replied: 1,
        reacted: 0,
      });
      await sendOutbox();
      expect(postsIn("100.000100")).toHaveLength(1);
      expect(reactionCalls()).toBe(0);
      expect(slack.reactions).toEqual([]);
    });

    // Each way a turn ends sets its thread back once.
    const ends: [
      string,
      (turn: Awaited<ReturnType<typeof leased>>) => Promise<unknown>,
      { state: string; decision?: string; limitReached?: string | null },
      number,
    ][] = [
      [
        "a decision",
        async (turn) => {
          await decide(turn, "here");
          await report(turn, {
            outcome: "completed",
            text: "here",
            decision: { tool: "reply", body: "here", reason: "asked" },
          });
        },
        { state: "decided", decision: "reply" },
        0,
      ],
      [
        "no decision",
        (turn) => report(turn, { outcome: "completed", text: "hm" }),
        { state: "no_decision", limitReached: null },
        0,
      ],
      [
        "a failure",
        (turn) => report(turn, { outcome: "failed", reason: "engine_failed" }),
        { state: "no_decision", limitReached: null },
        0,
      ],
      [
        "the model call cap",
        (turn) =>
          report(turn, { outcome: "failed", reason: "model_call_limit" }),
        { state: "no_decision", limitReached: "model_call_limit" },
        0,
      ],
      [
        "a refused budget",
        async (turn) => {
          // The proxy's grant refused its call on the person's account.
          await db
            .update(schema.conversationTurnPermits)
            .set({ refusal: "budget" })
            .where(eq(schema.conversationTurnPermits.turnId, turn.turn_id));
          await report(turn, { outcome: "failed", reason: "engine_failed" });
        },
        { state: "no_decision", limitReached: null },
        0,
      ],
      [
        "the time limit, with no report",
        async () => {},
        { state: "no_decision", limitReached: "time_limit" },
        CONVERSATION_TURN_LEASE_MS + 1_000,
      ],
    ];
    for (const [name, end, recorded, laterMs] of ends) {
      test(`a turn ended by ${name} sets its thread back to active once`, async () => {
        const fixture = await agentInSlack("main", { rollout: "on" });
        await deliver(fixture, mention("100.000100"));
        await drain(handler().handle);
        const turn = await leased();
        await end(turn);
        if (laterMs > 0) {
          // Still within its time: nothing is set back.
          await endings();
          expect(statusesOf("100.000100")).toEqual(["processing"]);
        }
        const at = new Date(Date.now() + laterMs);
        await endings(at);
        await endings(at);
        expect(statusesOf("100.000100")).toEqual(["processing", "active"]);
        const [row] = await mentionTurnsOf(fixture);
        expect(row).toMatchObject(recorded);
        expect(row?.resetAt).not.toBeNull();
      });
    }

    test("a turn no runtime takes ends when its wait does, and sets its thread back once", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      await endings();
      expect(statusesOf("100.000100")).toEqual(["processing"]);
      const at = new Date(Date.now() + OPERATOR_TURN_TAKE_MS + 1_000);
      await endings(at);
      await endings(at);
      expect(statusesOf("100.000100")).toEqual(["processing", "active"]);
      expect((await mentionTurnsOf(fixture))[0]?.state).toBe("no_decision");
    });

    test("a turn that ends while a newer one of its thread runs leaves the thread processing", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle } = handler();
      await deliver(fixture, mention("100.000100"));
      await drain(handle);
      const first = await leased();
      await deliver(
        fixture,
        mention("100.000300", { thread_ts: "100.000100" }),
      );
      await drain(handle);
      await report(first, { outcome: "completed", text: "one" });
      await endings();
      expect(statusesOf("100.000100")).toEqual(["processing", "processing"]);
      const second = await leased();
      await report(second, { outcome: "completed", text: "two" });
      await endings();
      await endings();
      expect(statusesOf("100.000100")).toEqual([
        "processing",
        "processing",
        "active",
      ]);
      expect(
        (await mentionTurnsOf(fixture)).every((turn) => turn.resetAt !== null),
      ).toBe(true);
    });

    test("a status Slack did not take is sent again on the next pass", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      await report(await leased(), { outcome: "completed", text: "ok" });
      slack.failures.set("agents.sessions.setStatus", "internal_error");
      await endings();
      expect((await mentionTurnsOf(fixture))[0]?.resetAt).toBeNull();
      slack.failures.clear();
      await endings();
      await endings();
      expect(statusesOf("100.000100")).toEqual(["processing", "active"]);
    });

    test("a pass that dies between its claim and Slack leaves the thread to a later pass, once the claim runs out", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      await report(await leased(), { outcome: "completed", text: "ok" });
      const [turn] = await mentionTurnsOf(fixture);
      // The dead pass's claim, with no status sent after it.
      expect(
        await createPostgresMentionTurnStatuses(db).claimReset(
          turn?.id as ConversationTurnId,
          60_000,
        ),
      ).toBe("send");
      await endings();
      expect(statusesOf("100.000100")).toEqual(["processing"]);
      expect((await mentionTurnsOf(fixture))[0]?.resetAt).toBeNull();
      await endings(undefined, 0);
      await endings(undefined, 0);
      expect(statusesOf("100.000100")).toEqual(["processing", "active"]);
    });

    test("two passes at once set the thread back once", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      await report(await leased(), { outcome: "completed", text: "ok" });
      await Promise.all([endings(), endings()]);
      expect(statusesOf("100.000100")).toEqual(["processing", "active"]);
    });

    test("the thread is processing before a runtime can take the turn", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const queued = () =>
        db
          .select({ id: schema.conversationTurnQueue.turnId })
          .from(schema.conversationTurnQueue)
          .then((rows) => rows.length);
      const before = await queued();
      // Read as Slack records the status, before its answer reaches the handler.
      const atStatus: Promise<number>[] = [];
      const push = slack.statuses.push.bind(slack.statuses);
      slack.statuses.push = (...items) => {
        atStatus.push(queued());
        return push(...items);
      };
      try {
        await deliver(fixture, mention("100.000100"));
        await drain(handler().handle);
      } finally {
        delete (slack.statuses as { push?: unknown }).push;
      }
      expect(await Promise.all(atStatus)).toEqual([before]);
      expect(await queued()).toBe(before + 1);
      expect(statusesOf("100.000100")).toEqual(["processing"]);
    });

    test("a pass while the turn is being written leaves it to its writer, past its wait too", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const late = new Date(
        Date.now() + OPERATOR_TURN_TAKE_MS + CONVERSATION_TURN_LEASE_MS + 1_000,
      );
      // A pass runs while the writer waits on Slack, between write and queue.
      const passes: Promise<unknown>[] = [];
      const push = slack.statuses.push.bind(slack.statuses);
      slack.statuses.push = (...items) => {
        passes.push(endings(late));
        return push(...items);
      };
      try {
        await deliver(fixture, mention("100.000100"));
        await drain(handler().handle);
        await Promise.all(passes);
      } finally {
        delete (slack.statuses as { push?: unknown }).push;
      }
      expect(passes).toHaveLength(1);
      const [turn] = await mentionTurnsOf(fixture);
      expect(turn?.state).toBe("running");
      expect(
        await queue().outcome(turn?.id as ConversationTurnId, new Date()),
      ).toBe("pending");
      expect(statusesOf("100.000100")).toEqual(["processing"]);
    });

    test("a newer turn written while an older one's active is on its way is told processing again", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle } = handler();
      await deliver(fixture, mention("100.000100"));
      await drain(handle);
      await report(await leased(), { outcome: "completed", text: "one" });
      // The newer mention lands just after the older turn's claim.
      const store = createPostgresMentionTurnStatuses(db);
      const statuses: MentionTurnStatusStore = {
        ...store,
        async claimReset(turnId, claimMs) {
          const claim = await store.claimReset(turnId, claimMs);
          await deliver(
            fixture,
            mention("100.000300", { thread_ts: "100.000100" }),
          );
          await drain(handle);
          return claim;
        },
      };
      await endings(undefined, 60_000, statuses);
      expect(statusesOf("100.000100")).toEqual([
        "processing",
        "processing",
        "active",
        "processing",
      ]);
      await report(await leased(), { outcome: "completed", text: "two" });
      await endings();
      await endings();
      expect(statusesOf("100.000100")).toEqual([
        "processing",
        "processing",
        "active",
        "processing",
        "active",
      ]);
    });

    /**
     * The older turn's ending with a newer mention written just after its
     * claim, Slack refusing the "processing" said again after its `active`.
     */
    const corrective = (
      fixture: Fixture,
      handle: ReturnType<typeof handler>["handle"],
    ) => {
      const store = createPostgresMentionTurnStatuses(db);
      const statuses: MentionTurnStatusStore = {
        ...store,
        async claimReset(turnId, claimMs) {
          const claim = await store.claimReset(turnId, claimMs);
          await deliver(
            fixture,
            mention("100.000300", { thread_ts: "100.000100" }),
          );
          await drain(handle);
          return claim;
        },
        async confirmReset(turnId) {
          const left = await store.confirmReset(turnId);
          slack.failures.set("agents.sessions.setStatus", "internal_error");
          return left;
        },
      };
      return endings(undefined, 60_000, statuses).finally(() =>
        slack.failures.clear(),
      );
    };
    const threadsLeft = () => db.select().from(schema.mentionThreadStatuses);

    test("a newer turn's processing Slack did not take after an older one's active is sent again on the next pass", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle } = handler();
      await deliver(fixture, mention("100.000100"));
      await drain(handle);
      await report(await leased(), { outcome: "completed", text: "one" });
      await corrective(fixture, handle);
      expect(statusesOf("100.000100")).toEqual([
        "processing",
        "processing",
        "active",
      ]);
      await endings();
      await endings();
      expect(statusesOf("100.000100")).toEqual([
        "processing",
        "processing",
        "active",
        "processing",
      ]);
      expect(await threadsLeft()).toEqual([]);
      await report(await leased(), { outcome: "completed", text: "two" });
      await endings();
      await endings();
      expect(statusesOf("100.000100")).toEqual([
        "processing",
        "processing",
        "active",
        "processing",
        "active",
      ]);
    });

    test("a processing sent again that lands after the newer turn ended leaves the thread active", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle } = handler();
      await deliver(fixture, mention("100.000100"));
      await drain(handle);
      await report(await leased(), { outcome: "completed", text: "one" });
      await corrective(fixture, handle);
      // The retry reads "processing", then the newer turn ends and its
      // `active` reaches Slack before the retry's send.
      const store = createPostgresMentionTurnStatuses(db);
      const statuses: MentionTurnStatusStore = {
        ...store,
        async claimThreads(limit, claimMs) {
          const claimed = await store.claimThreads(limit, claimMs);
          await report(await leased(), { outcome: "completed", text: "two" });
          await endings();
          return claimed;
        },
      };
      await endings(undefined, 60_000, statuses);
      expect(statusesOf("100.000100")).toEqual([
        "processing",
        "processing",
        "active",
        "active",
        "processing",
      ]);
      await endings();
      await endings();
      expect(statusesOf("100.000100")).toEqual([
        "processing",
        "processing",
        "active",
        "active",
        "processing",
        "active",
      ]);
      expect(await threadsLeft()).toEqual([]);
    });

    test("a processing sent again while another pass sets the newer turn back leaves the thread active", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle } = handler();
      await deliver(fixture, mention("100.000100"));
      await drain(handle);
      await report(await leased(), { outcome: "completed", text: "one" });
      await corrective(fixture, handle);
      await report(await leased(), { outcome: "completed", text: "two" });
      // Another pass sends the newer turn's `active` after this one read
      // "processing", and marks it only after this one's send is in.
      const store = createPostgresMentionTurnStatuses(db);
      let confirm: () => Promise<unknown> = async () => {};
      const other: MentionTurnStatusStore = {
        ...store,
        async confirmReset(turnId) {
          confirm = () => store.confirmReset(turnId);
          return false;
        },
      };
      const statuses: MentionTurnStatusStore = {
        ...store,
        async due() {
          return [];
        },
        async claimThreads(limit, claimMs) {
          const claimed = await store.claimThreads(limit, claimMs);
          await endings(undefined, 60_000, other);
          return claimed;
        },
        async threadSent(thread, sent) {
          const done = await store.threadSent(thread, sent);
          await confirm();
          return done;
        },
      };
      await endings(undefined, 60_000, statuses);
      expect(statusesOf("100.000100")).toEqual([
        "processing",
        "processing",
        "active",
        "active",
        "processing",
      ]);
      await endings();
      await endings();
      expect(statusesOf("100.000100").at(-1)).toBe("active");
      expect(await threadsLeft()).toEqual([]);
    });

    /**
     * A pass that dies in its ending of the older turn, a newer mention
     * written just after its claim: past `setStatus`, Slack took the
     * `active` and nothing is marked; past `confirmReset`, it is marked;
     * past `releaseReset`, its claim was let go.
     * Nothing after runs.
     */
    const dies = (
      fixture: Fixture,
      handle: ReturnType<typeof handler>["handle"],
      past: "setStatus" | "confirmReset" | "releaseReset",
    ) => {
      const store = createPostgresMentionTurnStatuses(db);
      const statuses: MentionTurnStatusStore = {
        ...store,
        async claimReset(turnId, claimMs) {
          const claim = await store.claimReset(turnId, claimMs);
          await deliver(
            fixture,
            mention("100.000300", { thread_ts: "100.000100" }),
          );
          await drain(handle);
          return claim;
        },
        async confirmReset(turnId) {
          if (past === "confirmReset") await store.confirmReset(turnId);
          // As when Slack took the `active` but its answer failed.
          if (past === "releaseReset") await store.releaseReset(turnId);
          throw new Error("the pass died");
        },
        async claimThreads() {
          return [];
        },
      };
      return endings(undefined, 60_000, statuses);
    };

    test.each([
      ["once the older turn is marked set back", "confirmReset", 60_000],
      [
        "before the older turn is marked, once its claim runs out",
        "setStatus",
        0,
      ],
      ["after letting its claim go", "releaseReset", 60_000],
    ] as const)(
      "a pass that dies %s still has the newer turn told processing again",
      async (_, past, claimMs) => {
        const fixture = await agentInSlack("main", { rollout: "on" });
        const { handle } = handler();
        await deliver(fixture, mention("100.000100"));
        await drain(handle);
        await report(await leased(), { outcome: "completed", text: "one" });
        await dies(fixture, handle, past);
        expect(statusesOf("100.000100")).toEqual([
          "processing",
          "processing",
          "active",
        ]);
        await endings(undefined, claimMs);
        await endings(undefined, claimMs);
        expect(statusesOf("100.000100")).toEqual([
          "processing",
          "processing",
          "active",
          "processing",
        ]);
        expect(await threadsLeft()).toEqual([]);
        await report(await leased(), { outcome: "completed", text: "two" });
        await endings();
        await endings();
        expect(statusesOf("100.000100")).toEqual([
          "processing",
          "processing",
          "active",
          "processing",
          "active",
        ]);
        expect(
          (await mentionTurnsOf(fixture)).every(
            (turn) => turn.resetAt !== null,
          ),
        ).toBe(true);
      },
    );

    test("a thread left again while a pass sends it is not sent beside it, and ends as its turns say", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle } = handler();
      await deliver(fixture, mention("100.000100"));
      await drain(handle);
      await report(await leased(), { outcome: "completed", text: "one" });
      await corrective(fixture, handle);
      const [conversation] = await db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.agentId, fixture.agentId));
      // The records go while this pass holds the thread, read "processing";
      // another pass runs before its send.
      const store = createPostgresMentionTurnStatuses(db);
      const statuses: MentionTurnStatusStore = {
        ...store,
        async claimThreads(limit, claimMs) {
          const claimed = await store.claimThreads(limit, claimMs);
          await schema.deleteConversationRecords(db, {
            conversationId: conversation?.id as ConversationId,
            by: `${fixture.ownerId}@example.invalid`,
          });
          await endings();
          return claimed;
        },
      };
      await endings(undefined, 60_000, statuses);
      expect(statusesOf("100.000100")).toEqual([
        "processing",
        "processing",
        "active",
        "processing",
      ]);
      await endings();
      await endings();
      expect(statusesOf("100.000100")).toEqual([
        "processing",
        "processing",
        "active",
        "processing",
        "active",
      ]);
      expect(await threadsLeft()).toEqual([]);
    });

    test("a delete of the conversation's records while its turn runs sets the thread back once", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      await deliver(fixture, mention("100.000100"));
      await drain(handler().handle);
      const turn = await leased();
      const [conversation] = await db
        .select({ id: schema.conversations.id })
        .from(schema.conversations)
        .where(eq(schema.conversations.agentId, fixture.agentId));
      const deleted = await schema.deleteConversationRecords(db, {
        conversationId: conversation?.id as ConversationId,
        by: `${fixture.ownerId}@example.invalid`,
      });
      expect(deleted.outcome).toBe("deleted");
      expect(await mentionTurnsOf(fixture)).toEqual([]);
      await endings();
      expect(statusesOf("100.000100")).toEqual(["processing", "active"]);
      // The turn's late report finds nothing to set back.
      await report(turn, { outcome: "completed", text: "late" });
      await endings();
      expect(statusesOf("100.000100")).toEqual(["processing", "active"]);
      expect(await threadsLeft()).toEqual([]);
    });

    test("rollout on: a mention longer than a turn's input is no turn, no status and no session", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle, notices } = handler();
      await deliver(
        fixture,
        mention("100.000100", {
          text: `<@${BOT_USER}> ${"a".repeat(CONVERSATION_TURN_TEXT_MAX + 1)}`,
        }),
      );
      await drain(handle);
      expect(await mentionTurnsOf(fixture)).toEqual([]);
      expect(await db.select().from(schema.conversationEngagements)).toEqual(
        [],
      );
      expect(await sessionsOf(fixture)).toEqual([]);
      expect(slack.statuses).toEqual([]);
      expect(notices).toEqual([]);
    });

    test("rollout on: a mention where the channel listens to nothing is no turn and no session", async () => {
      const fixture = await agentInSlack("main", {
        rollout: "on",
        listen: "off",
      });
      const { handle, notices } = handler();
      await deliver(fixture, mention("100.000100"));
      await drain(handle);
      expect(await mentionTurnsOf(fixture)).toEqual([]);
      expect(await sessionsOf(fixture)).toEqual([]);
      expect(slack.statuses).toEqual([]);
      expect(notices).toEqual([]);
    });

    /** A person's DM to the agent; a thread reply with `thread_ts`. */
    const dmPost = (ts: string, extra: Record<string, unknown> = {}) => ({
      type: "message",
      channel: "D0OWNER",
      channel_type: "im",
      user: PERSON,
      ts,
      text: "what changed this week",
      ...extra,
    });
    const turnPlacesOf = (fixture: Fixture) =>
      db
        .select({
          conversationId: schema.conversationTurns.conversationId,
          topicId: schema.conversationTurns.topicId,
          kind: schema.conversations.kind,
          personUserId: schema.conversations.personUserId,
        })
        .from(schema.conversationTurns)
        .innerJoin(
          schema.conversations,
          eq(schema.conversations.id, schema.conversationTurns.conversationId),
        )
        .where(eq(schema.conversationTurns.agentId, fixture.agentId))
        .orderBy(asc(schema.conversationTurns.createdAt));

    test("rollout on: a top-level DM is one turn of its thread, in the person's DM conversation, and no session", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle, notices } = handler();
      await deliver(fixture, dmPost("100.000100"));
      await drain(handle);
      const [turn, ...others] = await mentionTurnsOf(fixture);
      expect(others).toEqual([]);
      expect(turn).toMatchObject({
        state: "running",
        requesterKind: "user",
        requesterId: fixture.ownerId,
        threadTs: "100.000100",
      });
      expect(await turnPlacesOf(fixture)).toMatchObject([
        { kind: "dm", personUserId: fixture.ownerId },
      ]);
      expect(statusesOf("100.000100")).toEqual(["processing"]);
      expect(await sessionsOf(fixture)).toEqual([]);
      expect(await links()).toEqual([]);
      expect(notices).toEqual([]);
    });

    test("rollout on: two top-level DMs of one person are two topics of one DM conversation, and no session", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle } = handler();
      await deliver(fixture, dmPost("100.000100"));
      await deliver(fixture, dmPost("100.000200", { text: "and the budget" }));
      await drain(handle);
      expect(
        (await mentionTurnsOf(fixture)).map((turn) => turn.threadTs),
      ).toEqual(["100.000100", "100.000200"]);
      const [first, second] = await turnPlacesOf(fixture);
      expect(first?.conversationId).toBe(second?.conversationId);
      expect(first?.topicId).not.toBe(second?.topicId);
      expect(await sessionsOf(fixture)).toEqual([]);
    });

    test("rollout on: a reply in a DM thread with no work is a turn of that thread's topic", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      const { handle } = handler();
      await deliver(fixture, dmPost("100.000100"));
      await deliver(fixture, dmPost("100.000300", { thread_ts: "100.000100" }));
      await drain(handle);
      const places = await turnPlacesOf(fixture);
      expect(places).toHaveLength(2);
      expect(places[0]?.topicId).toBe(places[1]?.topicId);
      expect(await sessionsOf(fixture)).toEqual([]);
    });

    test("rollout on: a DM turn's permit and its model call are charged to the person who wrote it", async () => {
      const fixture = await agentInSlack("main", { rollout: "on" });
      // Another person than the agent's owner, so an owner's root would not
      // pass; an admin, as a plain member has no right to ask.
      const memberId = randomUUID();
      await db.insert(users).values({
        id: memberId,
        email: `${memberId}@example.invalid`,
        displayName: "admin",
      });
      await db.insert(memberships).values({
        workspaceId: fixture.workspaceId,
        userId: memberId,
        role: "admin",
      });
      await db.insert(linkedAccounts).values({
        id: randomUUID(),
        workspaceId: fixture.workspaceId,
        userId: memberId,
        provider: "slack",
        externalTenant: TEAM,
        externalUserId: "U0MEMBER",
        verifiedVia: "slack_oidc",
        verifiedAt: new Date(),
      });
      await deliver(
        fixture,
        dmPost("100.000100", { channel: "D0MEMBER", user: "U0MEMBER" }),
      );
      await drain(handler().handle);
      expect(await turnPlacesOf(fixture)).toMatchObject([
        { kind: "dm", personUserId: memberId },
      ]);
      const taken = await leased();
      const [permit] = await db
        .select({
          rootKind: schema.conversationTurnPermits.rootKind,
          requesterUserId: schema.conversationTurnPermits.requesterUserId,
        })
        .from(schema.conversationTurnPermits)
        .where(eq(schema.conversationTurnPermits.turnId, taken.turn_id));
      expect(permit).toEqual({
        rootKind: "user",
        requesterUserId: memberId,
      });
      // The call the turn's model request asks for, as the proxy asks.
      const { auth } = taken.provider;
      if (auth.kind !== "egress_token") throw new Error(auth.kind);
      const granted = await createPostgresConversationCalls(
        db,
      ).authorizeTurnCallAtomic({
        tokenHash: hashConversationCallToken(auth.token),
        exchangeId: randomUUID(),
        callId: conversationCallIdSchema.parse(randomUUID()),
        reserveFor: () => ({
          reserve: conversationCallReserve({
            model: taken.model,
            maxTokens: taken.call.max_tokens,
            maxRequestBytes: 4_096,
          }),
          unmetered: false,
        }),
      });
      expect(granted.outcome).toBe("ok");
      const calls = await db
        .select({
          rootKind: schema.conversationCalls.rootKind,
          requesterUserId: schema.conversationCalls.requesterUserId,
        })
        .from(schema.conversationCalls)
        .where(eq(schema.conversationCalls.agentId, fixture.agentId));
      expect(calls).toEqual([{ rootKind: "user", requesterUserId: memberId }]);
      // The runtime takes it: the DM is the instruction and the current post.
      expect(taken.input.text).toBe("what changed this week");
      const handed = await createTopicSessionChecks({
        contexts: createPostgresTopicTurnContexts(db),
        turns: createPostgresConversationReadToolStore(db),
      }).handOut(taken);
      expect(
        handed.fresh_input.text
          .split("\n")
          .filter((line) => line.startsWith("[now] ")),
      ).toEqual(["[now] what changed this week"]);
    });

    test("rollout on: a post in a DM thread bound to open work goes to its session, with no turn", async () => {
      const fixture = await agentInSlack("main", { rollout: "off" });
      const { handle } = handler();
      await deliver(fixture, dmPost("100.000100"));
      await drain(handle);
      await db
        .update(agents)
        .set({ conversationRollout: "on" })
        .where(eq(agents.id, fixture.agentId));
      await deliver(fixture, dmPost("100.000300", { thread_ts: "100.000100" }));
      await drain(handle);
      const [session, ...more] = await sessionsOf(fixture);
      expect(more).toEqual([]);
      expect((await turnsOf(session?.id)).map((turn) => turn.sequence)).toEqual(
        [1, 2],
      );
      expect(await mentionTurnsOf(fixture)).toEqual([]);
    });

    for (const rollout of ["off", "shadow"] as const) {
      test(`rollout ${rollout}: a DM opens its session as before, and no conversation turn`, async () => {
        const fixture = await agentInSlack("main", { rollout });
        await deliver(fixture, dmPost("100.000100"));
        await drain(handler().handle);
        expect(await sessionsOf(fixture)).toHaveLength(1);
        expect(await mentionTurnsOf(fixture)).toEqual([]);
        expect(slack.statuses).toEqual([]);
      });
    }

    for (const rollout of ["off", "shadow"] as const) {
      test(`rollout ${rollout}: a mention opens its session as before, and no conversation turn`, async () => {
        const fixture = await agentInSlack("main", { rollout });
        await deliver(fixture, mention("100.000100"));
        await drain(handler().handle);
        expect(await sessionsOf(fixture)).toHaveLength(1);
        expect(await mentionTurnsOf(fixture)).toEqual([]);
        expect(slack.statuses).toEqual([]);
      });
    }
  },
);

describe.each(ENGINES)("Slack stop requests on %s", (engine) => {
  useDatabase(engine);
  let tick = 0;
  /** A Slack ts `seconds` from now, each one unique. */
  const at = (seconds: number) => {
    tick += 1;
    const second = Math.floor(Date.now() / 1000) + seconds;
    return `${second}.${String(tick).padStart(6, "0")}`;
  };
  const turnStatesOf = (sessionId: string | undefined) =>
    db
      .select({
        sequence: turns.sequence,
        status: turns.status,
        terminalReason: turns.terminalReason,
      })
      .from(turns)
      .where(eq(turns.sessionId, sessionId ?? ""))
      .orderBy(asc(turns.sequence));
  const interruptsOf = (sessionId: string | undefined) =>
    db
      .select({ kind: schema.controlIntents.kind, turnId: turns.sequence })
      .from(schema.controlIntents)
      .innerJoin(turns, eq(turns.id, schema.controlIntents.targetTurnId))
      .where(eq(schema.controlIntents.sessionId, sessionId ?? ""));
  const setTurn = (
    sessionId: string,
    sequence: number,
    values: Partial<typeof turns.$inferInsert>,
  ) =>
    db
      .update(turns)
      .set(values)
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)));
  const rolloutOn = (fixture: Fixture) =>
    db
      .update(agents)
      .set({ conversationRollout: "on" })
      .where(eq(agents.id, fixture.agentId));
  /** Another workspace member, linked to the Slack user `slackUserId`. */
  async function member(
    fixture: Fixture,
    slackUserId: string,
    role: "admin" | "member" = "admin",
  ) {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      displayName: slackUserId,
    });
    await db.insert(memberships).values({
      workspaceId: fixture.workspaceId,
      userId,
      role,
    });
    await db.insert(linkedAccounts).values({
      id: randomUUID(),
      workspaceId: fixture.workspaceId,
      userId,
      provider: "slack",
      externalTenant: TEAM,
      externalUserId: slackUserId,
      verifiedVia: "slack_oidc",
      verifiedAt: new Date(),
    });
    return userId;
  }
  /**
   * A thread's session, opened with rollout off as work is today: turn 1
   * running on a worker, turn 2 waiting behind it. Rollout goes on after.
   */
  async function workingThread(options: { dm?: boolean } = {}) {
    const fixture = await agentInSlack("main", { rollout: "off" });
    const view = handler();
    const root = at(-100);
    const place = options.dm ? { channel: "D0OWNER", channel_type: "im" } : {};
    await deliver(
      fixture,
      options.dm
        ? message(root, { ...place, text: "summarize the thread" })
        : mention(root),
    );
    await deliver(
      fixture,
      message(at(-90), { ...place, thread_ts: root, text: "and the tests" }),
    );
    await drain(view.handle);
    const [session] = await sessionsOf(fixture);
    if (session === undefined) throw new Error("no session was opened");
    await setTurn(session.id, 1, {
      status: "running",
      attemptId: "attempt-1",
      startedAt: new Date(),
    });
    await rolloutOn(fixture);
    const post = (ts: string, extra: Record<string, unknown> = {}) =>
      message(ts, { ...place, thread_ts: root, ...extra });
    return { fixture, view, root, session, post };
  }

  test("the requester's stop word alone stops the work: the running turn is interrupted, waiting input from before it cancelled, one line, and the word is no input", async () => {
    const { fixture, view, root, session, post } = await workingThread();
    await deliver(fixture, post(at(1), { text: `<@${BOT_USER}> 멈춰!` }));
    expect(await drain(view.handle)).toMatchObject({ processed: 1 });
    // Written after the stop word: it waits as usual.
    await deliver(fixture, post(at(2), { text: "then the docs" }));
    await drain(view.handle);

    expect(await turnStatesOf(session.id)).toEqual([
      { sequence: 1, status: "running", terminalReason: null },
      { sequence: 2, status: "cancelled", terminalReason: "stop_requested" },
      { sequence: 3, status: "queued", terminalReason: null },
    ]);
    expect(await interruptsOf(session.id)).toEqual([
      { kind: "interrupt", turnId: 1 },
    ]);
    expect(view.threadNotices).toMatchObject([
      {
        threadTs: root,
        sessionId: session.id,
        notice: { message: "sessionStoppedQueued", count: 1 },
      },
    ]);
    expect(view.notices).toEqual([]);
    // The session stays open: decision 35.
    const [after] = await sessionsOf(fixture);
    expect(after?.admissionState).toBe("active");
  });

  test("a post written before the stop word but taken after its Slack time is cancelled too", async () => {
    const { fixture, view, session, post } = await workingThread();
    // The inbox took the earlier post late: its turn is newer than the stop
    // word's Slack timestamp, yet it waited when the stop ran.
    await deliver(fixture, post(at(-40), { text: "then the docs" }));
    await drain(view.handle);
    await deliver(fixture, post(at(-30), { text: "stop" }));
    await drain(view.handle);
    expect((await turnStatesOf(session.id)).map((turn) => turn.status)).toEqual(
      ["running", "cancelled", "cancelled"],
    );
  });

  test("in a DM thread the requester's stop works the same", async () => {
    const { session, view, fixture, post } = await workingThread({ dm: true });
    await deliver(fixture, post(at(1), { text: "stop" }));
    await drain(view.handle);
    expect((await turnStatesOf(session.id)).map((turn) => turn.status)).toEqual(
      ["running", "cancelled"],
    );
    expect(await interruptsOf(session.id)).toHaveLength(1);
    expect(view.threadNotices).toMatchObject([
      { notice: { message: "sessionStoppedQueued", count: 1 } },
    ]);
  });

  test("another member who may write to the session stops it too", async () => {
    const { fixture, view, session, post } = await workingThread();
    await member(fixture, "U0MEMBER");
    await deliver(fixture, post(at(1), { user: "U0MEMBER", text: "그만" }));
    await drain(view.handle);
    expect((await turnStatesOf(session.id)).map((turn) => turn.status)).toEqual(
      ["running", "cancelled"],
    );
    expect(await interruptsOf(session.id)).toHaveLength(1);
    expect(view.notices).toEqual([]);
  });

  test("someone the session lets write to it but not stop it is told so alone, and the word goes to the work as input", async () => {
    const { fixture, view, session, post } = await workingThread();
    await member(fixture, "U0MEMBER");
    // A channel whose ceiling takes control away from everyone there.
    await db
      .update(surfaceBindings)
      .set({ ceilingActions: ["session.read", "session.submit"] })
      .where(eq(surfaceBindings.id, fixture.bindingId));
    await deliver(fixture, post(at(1), { user: "U0MEMBER", text: "stop" }));
    await drain(view.handle);
    expect(await turnStatesOf(session.id)).toMatchObject([
      { sequence: 1, status: "running" },
      { sequence: 2, status: "queued" },
      { sequence: 3, status: "queued" },
    ]);
    expect((await turnsOf(session.id))[2]?.message).toBe("stop");
    expect(await interruptsOf(session.id)).toEqual([]);
    expect(view.notices).toMatchObject([
      {
        slackUserId: "U0MEMBER",
        reason: "stop_not_permitted",
        notice: { message: "stopNotPermitted" },
      },
    ]);
    expect(view.threadNotices).toEqual([]);
  });

  test("a stop word the member may not use, refused as input by the storage limit, ends dropped and says nothing more", async () => {
    const { fixture, view, session, post } = await workingThread();
    await member(fixture, "U0MEMBER");
    await db
      .update(surfaceBindings)
      .set({ ceilingActions: ["session.read", "session.submit"] })
      .where(eq(surfaceBindings.id, fixture.bindingId));
    await chargeAfterTheCheck();
    await deliver(fixture, post(at(1), { user: "U0MEMBER", text: "stop" }));
    expect(await drain(view.handle)).toMatchObject({ dropped: 1, retried: 0 });
    expect(await turnStatesOf(session.id)).toHaveLength(2);
    expect(view.notices.map((notice) => notice.reason)).toEqual([
      "stop_not_permitted",
    ]);
    expect(view.threadNotices).toEqual([]);
    expect((await inboxDrops()).at(-1)).toEqual({
      status: "dropped",
      dropReason: "storage_limit_exceeded",
    });
  });

  test("a stop word from a member the session is hidden from is done in one pass, and the requester's stop behind it takes at once", async () => {
    const { fixture, view, session, post } = await workingThread();
    await member(fixture, "U0MEMBER", "member");
    await deliver(fixture, post(at(1), { user: "U0MEMBER", text: "그만" }));
    await deliver(fixture, post(at(2), { text: "그만" }));
    expect(await drain(view.handle)).toMatchObject({
      processed: 2,
      retried: 0,
      failed: 0,
    });

    expect((await turnStatesOf(session.id)).map((turn) => turn.status)).toEqual(
      ["running", "cancelled"],
    );
    expect(await interruptsOf(session.id)).toHaveLength(1);
    // Told once that they may not stop it, though the session also refuses
    // the word as input.
    expect(view.notices).toMatchObject([
      { slackUserId: "U0MEMBER", reason: "stop_not_permitted" },
    ]);
    expect(view.threadNotices).toMatchObject([
      { notice: { message: "sessionStoppedQueued", count: 1 } },
    ]);
    await deliver(fixture, post(at(3), { user: "U0MEMBER", text: "why?" }));
    await drain(view.handle);
    expect(view.notices.map((notice) => notice.reason)).toEqual([
      "stop_not_permitted",
      "NOT_FOUND",
    ]);
  });

  /** A task's thread: its first turn waiting for a worker, rollout on. */
  async function unstartedTask() {
    const fixture = await agentInSlack("main", { rollout: "off" });
    const view = handler();
    const root = at(-100);
    await deliver(fixture, mention(root));
    await drain(view.handle);
    const [session] = await sessionsOf(fixture);
    if (session === undefined) throw new Error("no session was opened");
    await db
      .update(sessions)
      .set({ taskClosing: TASK_CLOSING_DEFAULT })
      .where(eq(sessions.id, session.id));
    await rolloutOn(fixture);
    const post = (ts: string, extra: Record<string, unknown> = {}) =>
      message(ts, { thread_ts: root, ...extra });
    return { fixture, view, session, post };
  }

  test("a task's stop before its first turn closes the task, nothing left to launch, and the thread is told it was closed", async () => {
    const { fixture, view, session, post } = await unstartedTask();
    await deliver(fixture, post(at(1), { text: "그만" }));
    expect(await drain(view.handle)).toMatchObject({ processed: 1, failed: 0 });

    expect(await turnStatesOf(session.id)).toEqual([
      { sequence: 1, status: "cancelled", terminalReason: "stop_requested" },
    ]);
    expect(await interruptsOf(session.id)).toEqual([]);
    const [after] = await sessionsOf(fixture);
    expect(after).toMatchObject({
      admissionState: "closed",
      status: "stopped",
      taskClosedReason: "cancelled",
    });
    expect(
      await db
        .select()
        .from(schema.unassignedSessions)
        .where(eq(schema.unassignedSessions.sessionId, session.id)),
    ).toEqual([]);
    // The task's request is no waiting message: the line has no count.
    expect(view.threadNotices).toMatchObject([
      { notice: { message: "taskStoppedBeforeStart" } },
    ]);
    expect(view.threadNotices[0]?.notice).not.toHaveProperty("count");
  });

  test("messages waiting behind the task's request are counted in the closed line", async () => {
    const { fixture, view, session, post } = await unstartedTask();
    await deliver(fixture, post(at(1), { text: "and the tests" }));
    await drain(view.handle);
    await deliver(fixture, post(at(2), { text: "stop" }));
    await drain(view.handle);
    expect((await turnStatesOf(session.id)).map((turn) => turn.status)).toEqual(
      ["cancelled", "cancelled"],
    );
    expect(view.threadNotices).toMatchObject([
      { notice: { message: "taskStoppedBeforeStartQueued", count: 1 } },
    ]);
  });

  test("a task whose first turn started stays open, and the thread gets the stop line it always had", async () => {
    const { fixture, view, session, post } = await unstartedTask();
    await setTurn(session.id, 1, {
      status: "running",
      attemptId: "attempt-1",
      startedAt: new Date(),
    });
    await deliver(fixture, post(at(1), { text: "and the tests" }));
    await drain(view.handle);
    await deliver(fixture, post(at(2), { text: "그만" }));
    await drain(view.handle);
    expect((await turnStatesOf(session.id)).map((turn) => turn.status)).toEqual(
      ["running", "cancelled"],
    );
    expect(await interruptsOf(session.id)).toHaveLength(1);
    const [after] = await sessionsOf(fixture);
    expect(after?.admissionState).toBe("active");
    expect(view.threadNotices).toMatchObject([
      { notice: { message: "sessionStoppedQueued", count: 1 } },
    ]);
  });

  test("with nothing running or waiting, a stop changes nothing and says so", async () => {
    const { fixture, view, session, post } = await workingThread();
    await setTurn(session.id, 1, { status: "completed", endedAt: new Date() });
    await setTurn(session.id, 2, { status: "completed", endedAt: new Date() });
    await deliver(fixture, post(at(1), { text: "중지" }));
    await drain(view.handle);
    expect((await turnStatesOf(session.id)).map((turn) => turn.status)).toEqual(
      ["completed", "completed"],
    );
    expect(view.threadNotices).toMatchObject([
      { notice: { message: "nothingToStop" } },
    ]);
  });

  test("a stop word with more words, or with rollout off, is input as before", async () => {
    const { fixture, view, session, post } = await workingThread();
    await deliver(
      fixture,
      post(at(1), { text: "멈춰 주세요, 그런데 테스트는 돌려 줘" }),
    );
    await drain(view.handle);
    await db
      .update(agents)
      .set({ conversationRollout: "off" })
      .where(eq(agents.id, fixture.agentId));
    await deliver(fixture, post(at(2), { text: "stop" }));
    await drain(view.handle);
    expect((await turnsOf(session.id)).map((turn) => turn.message)).toEqual([
      "summarize the thread",
      "and the tests",
      "멈춰 주세요, 그런데 테스트는 돌려 줘",
      "stop",
    ]);
    expect(await interruptsOf(session.id)).toEqual([]);
    expect(view.threadNotices).toEqual([]);
  });

  test("a stop retried under its key replays what it did: work that started since is neither cancelled nor interrupted", async () => {
    const { fixture, view, session, post } = await workingThread();
    const stops = createPostgresSessionStops(db);
    const request = {
      principal: { ownerId: session.ownerId },
      sessionId: session.id,
      idempotencyKey: "slack-stop:retried",
    };
    const first = await stops.cancelQueued(request);
    expect(first).toEqual({
      outcome: "cancelled",
      cancelled: 1,
      runningTurnId: "1",
      closed: false,
    });
    // The process died before the stop was done; meanwhile turn 1 ended and
    // new work came in and started.
    await setTurn(session.id, 1, { status: "completed", endedAt: new Date() });
    await deliver(fixture, post(at(5), { text: "new work" }));
    await drain(view.handle);
    await setTurn(session.id, 3, {
      status: "running",
      attemptId: "attempt-3",
      startedAt: new Date(),
    });
    await deliver(fixture, post(at(6), { text: "more new work" }));
    await drain(view.handle);

    expect(await stops.cancelQueued(request)).toEqual(first);
    expect((await turnStatesOf(session.id)).map((turn) => turn.status)).toEqual(
      ["completed", "cancelled", "running", "queued"],
    );
    // Closed since: the retry still says what the stop did; a new stop finds
    // the session closed.
    await db
      .update(sessions)
      .set({ admissionState: "closed" })
      .where(eq(sessions.id, session.id));
    expect(await stops.cancelQueued(request)).toEqual(first);
    expect(
      await stops.cancelQueued({
        ...request,
        idempotencyKey: "slack-stop:new",
      }),
    ).toEqual({ outcome: "closed" });
  });

  test("a stop word whose event comes again stops once and says so once", async () => {
    const { fixture, view, session, post } = await workingThread();
    const stop = post(at(1), { text: "stop" });
    await deliver(fixture, stop);
    await drain(view.handle);
    await deliver(fixture, stop);
    await drain(view.handle);
    expect(await interruptsOf(session.id)).toHaveLength(1);
    expect(view.threadNotices).toHaveLength(1);
  });

  test("once the interrupted turn ends, the thread's status goes back to active", async () => {
    const { fixture, view, root, session, post } = await workingThread();
    await sendOutbox();
    expect(
      slack.statuses.filter((s) => s.threadTs === root).at(-1)?.status,
    ).toBe("processing");
    await deliver(fixture, post(at(1), { text: "stop" }));
    await drain(view.handle);
    // The worker ends the turn it was told to stop, as its finalize does.
    await setTurn(session.id, 1, {
      status: "interrupted",
      endedAt: new Date(),
    });
    await db.execute(
      sql`SELECT slack_thread_status_touch(${session.id}::uuid)`,
    );
    await sendOutbox();
    expect(
      slack.statuses.filter((s) => s.threadTs === root).at(-1)?.status,
    ).toBe("active");
  });

  /** The outbox pass: the thread status writer and the sends. */
  function sendOutbox() {
    const api = createSlackBotApi({ apiUrl: slack.url });
    const tokenOf = (workspaceId: string, slackAppId: string) =>
      slackBotToken(
        createPostgresSecretStore(db, key),
        workspaceId,
        slackAppId,
      );
    return drainSlackOutbox({
      outbox: schema.createPostgresSlackOutboxStore(db),
      slack: api,
      botToken: tokenOf,
      delivery: createRowDelivery({
        slack: api,
        botToken: tokenOf,
        consoleOrigin: null,
      }),
      logger,
      consoleOrigin: null,
      batchSize: 10,
      leaseMs: 30_000,
      deadline: Date.now() + 10_000,
    });
  }
});

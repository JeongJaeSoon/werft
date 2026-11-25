import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  createOutboxSlackNoticeSink,
  createRowDelivery,
  createSlackBotApi,
  createSlackEventsService,
  drainSlackInbox,
  drainSlackOutbox,
  reconcileSlackThreadStatuses,
  SLACK_CARD_SETTLE_TIMING,
  SLACK_OUTBOX_MAX_ATTEMPTS,
  SLACK_OUTBOX_MESSAGES,
  SLACK_RETRY_AFTER_MAX_MS,
  SLACK_THREAD_STATUS_TIMING,
  SlackApiError,
  type SlackBotApi,
  settleSlackCards,
  slackBotToken,
  slackConversationKey,
  writeSlackThreadStatuses,
} from "@werft-ai/chat-slack";
import {
  agentCardRequestSchema,
  BOT_SCOPES,
  type ConversationId,
  type ConversationInputId,
  type ConversationTopicId,
  clientMessageIdSchema,
  DEFAULT_SURFACE_CEILING,
  SESSION_SCOPE_VALUES,
  SLACK_NOTICE_MESSAGES,
  slackMirrorCorrelationIdSchema,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  attempts,
  createDatabaseIdentityReader,
  createPostgresAgentIdentityStore,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresPullRequestDrain,
  createPostgresPushRequests,
  createPostgresSecretStore,
  createPostgresSlackAppStore,
  createPostgresSlackInboundEventStore,
  createPostgresSlackOutboxStore,
  createPostgresSurfaceBindingStore,
  type Database,
  events,
  linkedAccounts,
  memberships,
  moveSummaryLinks,
  pendingRequests,
  pushIntents,
  pushRequests,
  receipts,
  registerSlackInstallation,
  sessionLinks,
  sessions,
  slackApps,
  slackOutbox,
  slackThreadStatus,
  surfaceBindings,
  turns,
  users,
  verifySlackInstallation,
  workerLaunches,
  workspaces,
} from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import { createLogger, type LogRecord } from "@werft-ai/observability";
import {
  type Caller,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  type PushSource,
  SecretKey,
  SURFACE_PROGRESS_EDIT_INTERVAL_MS,
} from "@werft-ai/platform";
import {
  slackEventEnvelope,
  startFakeSlackApi,
} from "@werft-ai/testkit/fake-slack-api";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { Pool } from "pg";
import { eventNeutralizer } from "../api/neutral-fields.ts";
import { TEST_RUNTIMES } from "../testing/catalog.ts";
import {
  seedSettings,
  settingsCatalog,
  settingsDocument,
} from "../testing/settings.ts";
import { slackCatalog, slackSessionHandler } from "./main.ts";

const CONNECTIONS = `connections:
  main:
    kind: anthropic
    endpoint: https://api.anthropic.invalid
    models: [claude-sonnet-5]
    auth:
      kind: api_key
      stored: true
`;
const APP_ID = "A0OUTBOX";
const TEAM = "T0ACME";
const BOT_USER = "U0BOT";
const PERSON = "U0OWNER";
const STRANGER = "U0STRANGER";
const CHANNEL = "C0OPS";
const THREAD = "100.000100";
const CONSOLE = "https://console.example";
// Made here, at runtime: the fake only checks it is the one it handed out.
const BOT_CREDENTIAL = `bot-${randomBytes(12).toString("hex")}`;
const MANAGERS = ["owner", "admin"] as const;
const ENVIRONMENT = {
  EXECUTION_SLOT_LIMIT: "10",
  QUEUED_INPUT_LIMIT_PER_SESSION: "20",
  SESSION_COST_LIMIT_USD: "25",
  STORAGE_LIMIT_BYTES: "1073741824",
  CONSOLE_ORIGIN: CONSOLE,
};

const slack = startFakeSlackApi({ teamId: TEAM });
slack.apps.set(APP_ID, {
  appId: APP_ID,
  clientId: "1.1",
  clientSecret: randomBytes(8).toString("hex"),
  signingSecret: randomBytes(8).toString("hex"),
  manifest: {},
  botTokens: [BOT_CREDENTIAL],
});
const logged: LogRecord[] = [];
const logger = createLogger({
  level: "debug",
  sinks: [{ write: (record) => void logged.push(record) }],
});
const key = SecretKey.fromHex(randomBytes(32).toString("hex"), "TEST_KEY");

let db: Database;

/** The catalog a pass reads before its first event (main). */
async function refreshedSlackCatalog() {
  const catalog = slackCatalog(db, ENVIRONMENT);
  await catalog.refresh();
  return catalog;
}

afterAll(() => {
  slack.stop();
});

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
      const database = await createTempDatabase({ prefix: "slack_outbox" });
      const pool = new Pool({ connectionString: database.url, max: 8 });
      db = drizzlePostgres(pool, { schema });
      close = async () => {
        await pool.end();
        await database.drop();
      };
    }
    await seedSettings(db, settingsDocument(CONNECTIONS));
    slack.statuses.length = 0;
    slack.messages.length = 0;
    slack.failures.clear();
    slack.missingTs.clear();
    slack.refusedBlockTypes.clear();
    slack.users.clear();
    logged.length = 0;
  }, 60_000);
  afterEach(() => close());
}

type Fixture = Awaited<ReturnType<typeof agentInSlack>>;

async function agentInSlack() {
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
    // Saved on purpose: a person with none reads English (see the test below).
    locale: "ko",
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
    catalog: await settingsCatalog(db),
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
    connection_id: "main",
  });
  await agentsService.activateAgent(owner, agentId, {
    release_id: release.id,
    expected_revision: -1,
  });
  const slackAppId = randomUUID();
  await db.insert(slackApps).values({
    id: slackAppId,
    workspaceId,
    kind: "agent",
    agentId,
    state: "created",
    appId: APP_ID,
    clientId: "1.1",
    redirectUrl: `${CONSOLE}/cb`,
  });
  await createPostgresSlackAppStore(db, key).storeBotToken({
    workspaceId,
    slackAppId,
    scopes: [...BOT_SCOPES],
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
    mode: "on",
    home: false,
    ceiling: DEFAULT_SURFACE_CEILING,
    managerRoles: MANAGERS,
  });
  if (bound.outcome !== "set") throw new Error(bound.outcome);
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
    agentId,
    slackAppId,
    owner,
    bindingId: bound.binding.id,
  };
}

let eventCounter = 0;

async function mention(
  fixture: Fixture,
  ts: string,
  user = PERSON,
  extra: Record<string, unknown> = {},
) {
  eventCounter += 1;
  const eventId = `EvOut${eventCounter}`;
  const event = {
    type: "app_mention",
    channel: CHANNEL,
    user,
    ts,
    ...(ts === THREAD ? {} : { thread_ts: THREAD }),
    text: `<@${BOT_USER}> summarize the thread`,
    ...extra,
  };
  await createPostgresSlackInboundEventStore(db).record({
    workspaceId: fixture.workspaceId,
    agentId: fixture.agentId,
    slackAppId: fixture.slackAppId,
    teamId: TEAM,
    appId: APP_ID,
    eventId,
    eventType: "app_mention",
    eventSubtype: null,
    eventTime: new Date(Date.now() + eventCounter),
    status: "received",
    payload: { type: "event_callback", event_id: eventId, event },
    conversationKey: slackConversationKey(fixture.slackAppId, event),
  });
  await drainSlackInbox({
    inbox: createPostgresSlackInboundEventStore(db),
    handler: slackSessionHandler({
      catalog: await refreshedSlackCatalog(),
      db,
      pool: {
        connect: () => {
          throw new Error("no session control is asked of this role");
        },
      },
      environment: ENVIRONMENT,
      logger,
      secretKey: key,
      leaseMs: 30_000,
      notices: createOutboxSlackNoticeSink(createPostgresSlackOutboxStore(db)),
      slackApiUrl: slack.url,
    }),
    logger,
    batchSize: 10,
    leaseMs: 30_000,
    deadline: Date.now() + 10_000,
  });
}

async function sessionOf(fixture: Fixture) {
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.workspaceId, fixture.workspaceId));
  if (!session) throw new Error("no session");
  return session.id;
}

const text = (value: string) => ({ text: value });
const toolUse = { tool_call: { id: "tu1", name: "Read", input: {} } };

/**
 * Ends turn `sequence` as the worker would, with these assistant events: one
 * stored event per block, with its engine-neutral fields.
 */
async function endTurn(
  sessionId: string,
  sequence: number,
  status: "completed" | "failed",
  said: Record<string, unknown>[][] = [],
) {
  const attemptId = `att-${randomUUID()}`;
  const [turn] = await db
    .update(turns)
    .set({ status, attemptId, endedAt: new Date() })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)))
    .returning({ id: turns.id });
  if (!turn) throw new Error("no turn");
  let sourceSequence = 0;
  for (const block of said.flat()) {
    sourceSequence += 1;
    await db.insert(events).values({
      sessionId,
      turnId: turn.id,
      attemptId,
      sourceSequence,
      type: "assistant",
      payload: { type: "assistant", parent_tool_use_id: null, ...block },
    });
  }
}

function outboxPass(
  overrides: Partial<Parameters<typeof drainSlackOutbox>[0]> = {},
) {
  const secrets = createPostgresSecretStore(db, key);
  const slackApi = createSlackBotApi({ apiUrl: slack.url });
  const botToken = (workspaceId: string, slackAppId: string) =>
    slackBotToken(secrets, workspaceId, slackAppId);
  return drainSlackOutbox({
    outbox: createPostgresSlackOutboxStore(db),
    slack: slackApi,
    botToken,
    logger,
    consoleOrigin: CONSOLE,
    batchSize: 10,
    leaseMs: 30_000,
    deadline: Date.now() + 10_000,
    ...overrides,
    // A test that swaps the Slack client or the token swaps it for the send too.
    delivery: createRowDelivery({
      slack: overrides.slack ?? slackApi,
      botToken: overrides.botToken ?? botToken,
      consoleOrigin: CONSOLE,
    }),
  });
}

// A copy of the session's first turn as turn `sequence`, still running.
async function addTurn(sessionId: string, sequence: number) {
  const { rows: columns } = (await db.execute(
    sql`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'turns'
          AND column_name NOT IN ('id', 'sequence', 'attempt_id', 'status', 'ended_at')
        ORDER BY ordinal_position`,
  )) as unknown as { rows: { column_name: string }[] };
  const copied = columns.map(({ column_name }) => `"${column_name}"`);
  await db.execute(
    sql.raw(`INSERT INTO turns (sequence, status, ${copied.join(", ")})
      SELECT ${sequence}, 'running', ${copied.map((column) => `t.${column}`).join(", ")}
      FROM turns t WHERE t.session_id = '${sessionId}' AND t.sequence = 1`),
  );
}

async function answeredThrough() {
  const [link] = await db
    .select({ answeredThrough: sessionLinks.answeredThrough })
    .from(sessionLinks);
  return link?.answeredThrough;
}

// Turn `sequence`, queued as asked from the web or the API: by the person
// who asked turn 1, or by no one.
async function askFrom(
  sessionId: string,
  sequence: number,
  channel: "web" | "api",
  message: string,
  byPerson: boolean,
) {
  await addTurn(sessionId, sequence);
  const [first] = await db
    .select({ actorId: turns.actorId })
    .from(turns)
    .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 1)));
  await db
    .update(turns)
    .set({
      channel,
      message,
      status: "queued",
      actorId: byPerson ? (first?.actorId ?? null) : null,
    })
    .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)));
}

const rows = () => db.select().from(slackOutbox).orderBy(asc(slackOutbox.seq));

const posted = () =>
  slack.messages.filter((message) => message.method === "chat.postMessage");

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  Alias?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Plans?: PlanNode[];
};

const reads = (node: PlanNode, relation: string): boolean =>
  node["Relation Name"] === relation ||
  (node.Plans ?? []).some((child) => reads(child, relation));

// The pass's own turns scan (alias `turns`; subplans use ot/st) either
// fetches by id, or is the inner side of a nested loop whose outer side has
// already read session_links and is bounded to that row's session by its
// index: probed once per live link, never per session or whole.
function turnsReadPerLink(plan: PlanNode, linkedOuter = false): boolean {
  if (plan["Relation Name"] === "turns" && plan.Alias === "turns") {
    // A bitmap scan by the same ids keeps its condition as the recheck.
    const cond = plan["Index Cond"] ?? plan["Recheck Cond"] ?? "";
    return (
      /\bid = ANY \(/.test(cond) ||
      (linkedOuter && /\bsession_id = /.test(cond))
    );
  }
  const children = plan.Plans ?? [];
  if (children.length === 0) return true;
  return children.every((child, index) =>
    turnsReadPerLink(
      child,
      linkedOuter ||
        (plan["Node Type"] === "Nested Loop" &&
          index > 0 &&
          reads(children[0] as PlanNode, "session_links")),
    ),
  );
}

describe("the outbox plan check", () => {
  const turnsBySession: PlanNode = {
    "Node Type": "Index Scan",
    "Relation Name": "turns",
    Alias: "turns",
    "Index Cond": "(session_id = sessions.id)",
  };
  const sessionsScan: PlanNode = {
    "Node Type": "Index Only Scan",
    "Relation Name": "sessions",
    Alias: "sessions",
  };
  const linksScan: PlanNode = {
    "Node Type": "Index Scan",
    "Relation Name": "session_links",
    Alias: "session_links",
  };

  test("accepts turns probed under the live links", () => {
    expect(
      turnsReadPerLink({
        "Node Type": "Nested Loop",
        Plans: [
          { "Node Type": "Nested Loop", Plans: [sessionsScan, linksScan] },
          turnsBySession,
        ],
      }),
    ).toBe(true);
  });

  test("refuses a whole turns index read under the links and filtered after", () => {
    expect(
      turnsReadPerLink({
        "Node Type": "Nested Loop",
        Plans: [
          linksScan,
          {
            "Node Type": "Materialize",
            Plans: [
              {
                "Node Type": "Index Scan",
                "Relation Name": "turns",
                Alias: "turns",
              },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  test("refuses turns read for every session before the links are checked", () => {
    expect(
      turnsReadPerLink({
        "Node Type": "Nested Loop",
        Plans: [
          { "Node Type": "Nested Loop", Plans: [sessionsScan, turnsBySession] },
          linksScan,
        ],
      }),
    ).toBe(false);
  });
});

describe.each(ENGINES)("the Slack outbox on %s", (engine) => {
  useDatabase(engine);

  test("a completed turn answers once in its thread, escaped, with its link, and clears the status", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [
      [text("Let me look."), toolUse],
      [
        text(
          "Done: ping <!here>, <@U0ELSE> and <@U0OWNER>, but `<!here>` stays code.",
        ),
      ],
    ]);

    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 0, claimed: 0 });

    expect(posted()).toEqual([
      {
        method: "chat.postMessage",
        channelId: CHANNEL,
        threadTs: THREAD,
        userId: null,
        // G7: the group mention goes; the one in code stays escaped.
        text: `Done: ping, &lt;@U0ELSE&gt; and <@${PERSON}>, but \`&lt;!here&gt;\` stays code.\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
        ts: expect.any(String),
        options: {
          // N1: a task's answer goes under "agent [task]", the session's
          // title cut from the mention.
          username: "Notes [summarize the thread]",
          link_names: "false",
          unfurl_links: "false",
          unfurl_media: "false",
        },
      },
    ]);
    const [row, ...others] = await rows();
    expect(others).toEqual([]);
    const [link] = await db.select().from(sessionLinks);
    expect(row).toMatchObject({
      kind: "reply",
      sessionLinkId: link?.id,
      status: "sent",
      slackTs: posted()[0]?.ts,
      attempts: 1,
      claimToken: null,
      leaseExpiresAt: null,
    });
    expect(slack.statuses.at(-1)).toEqual({
      channelId: CHANNEL,
      threadTs: THREAD,
      status: "active",
    });
  });

  test("a reply stored before the neutral fields still answers with its text", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [
      [{ message: { content: [{ type: "text", text: "From before." }] } }],
    ]);
    const neutralize = eventNeutralizer(logger);
    expect(
      await outboxPass({
        outbox: createPostgresSlackOutboxStore(db, { neutralize }),
      }),
    ).toMatchObject({ enqueued: 1, sent: 1 });
    expect(posted()[0]?.text).toStartWith("From before.");
  });

  test("a turn that ended while the role was down for days still answers once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("late")]]);
    await db
      .update(turns)
      .set({ endedAt: sql`now() - interval '3 days'` })
      .where(eq(turns.status, "completed"));
    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 0 });
    expect(posted()).toHaveLength(1);
  });

  test("turns that started at the same instant answer in their thread's order", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    // Turn 3 gets the lower id: id order is not the thread's order.
    await addTurn(sessionId, 3);
    await addTurn(sessionId, 2);
    for (const sequence of [1, 2, 3]) {
      await endTurn(sessionId, sequence, "completed", [
        [text(`answer ${sequence}`)],
      ]);
    }

    expect(await outboxPass()).toMatchObject({ enqueued: 3, sent: 3 });
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      "answer 1",
      "answer 2",
      "answer 3",
    ]);
  });

  test("a turn still running holds the thread's mark, and answers once it ends", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("answer 1")]]);
    await addTurn(sessionId, 2);
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 0 });
    expect(await answeredThrough()).toBe(1);

    await addTurn(sessionId, 3);
    await endTurn(sessionId, 3, "completed", [[text("answer 3")]]);
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 0 });
    expect(await answeredThrough()).toBe(1);

    await endTurn(sessionId, 2, "completed", [[text("answer 2")]]);
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    await outboxPass();
    expect(await answeredThrough()).toBe(3);
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      "answer 1",
      "answer 3",
      "answer 2",
    ]);
  });

  test("a turn the platform queued, with no channel or actor, answers in the thread too", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("pushing next turn")]]);
    // A push continuation or an approved push's follow-up turn.
    await addTurn(sessionId, 2);
    await db
      .update(turns)
      .set({ channel: null, actorId: null })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 2)));
    await endTurn(sessionId, 2, "completed", [[text("PR opened")]]);

    await outboxPass();
    await outboxPass();
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      "pushing next turn",
      "PR opened",
    ]);
    expect(await answeredThrough()).toBe(2);
  });

  test("behind a turn holding the mark, answers past one pass's batch still go", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    // Turn 1 runs on; 2 to 14 end, more than a pass's batch of 10.
    for (let sequence = 2; sequence <= 14; sequence += 1) {
      await addTurn(sessionId, sequence);
      await endTurn(sessionId, sequence, "completed", [
        [text(`answer ${sequence}`)],
      ]);
    }
    for (let pass = 0; pass < 3; pass += 1) await outboxPass();
    expect(posted()).toHaveLength(13);
    expect(await answeredThrough()).toBe(0);
  });

  test("an unknown outcome later confirmed completed still answers", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await db
      .update(turns)
      .set({ status: "outcome_unknown", endedAt: new Date() })
      .where(eq(turns.sessionId, sessionId));
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    await outboxPass();
    expect(await answeredThrough()).toBe(0);

    // An operator's confirm_completed.
    await endTurn(sessionId, 1, "completed", [[text("answer 1")]]);
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      SLACK_NOTICE_MESSAGES.ko.failed,
      "answer 1",
    ]);
  });

  test("cancelled, interrupted and pre-link turns move the mark past them", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("answer 1")]]);
    for (const sequence of [2, 3, 4, 5]) await addTurn(sessionId, sequence);
    for (const [sequence, status] of [
      [2, "cancelled"],
      [3, "interrupted"],
    ] as const) {
      await db
        .update(turns)
        .set({ status, endedAt: new Date() })
        .where(
          and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)),
        );
    }
    await endTurn(sessionId, 4, "completed", [[text("before the link")]]);
    await db
      .update(turns)
      .set({ createdAt: sql`now() - interval '1 day'` })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 4)));
    await endTurn(sessionId, 5, "completed", [[text("answer 5")]]);

    expect(await outboxPass()).toMatchObject({ sent: 2 });
    await outboxPass();
    expect(await answeredThrough()).toBe(5);
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      "answer 1",
      "answer 5",
    ]);
  });

  // Known order gap, left for later: a reply waiting out a backoff does not
  // hold back the next reply in its thread.
  test("a reply in backoff lets the thread's next reply go first", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("answer 1")]]);
    slack.failures.set("chat.postMessage", "internal_error");
    expect(await outboxPass()).toMatchObject({ retried: 1 });
    slack.failures.clear();
    await addTurn(sessionId, 2);
    await endTurn(sessionId, 2, "completed", [[text("answer 2")]]);
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    await db.update(slackOutbox).set({ nextAttemptAt: sql`now()` });
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(
      posted()
        .filter((message) => message.ts !== undefined)
        .map((message) => message.text.split("\n")[0]),
    ).toEqual(["answer 2", "answer 1"]);
  });

  test("the pass reads only linked sessions' turns and untold uncertain rows by index", async () => {
    if (engine !== "PostgreSQL") return;
    const plans: string[] = [];
    const traced = drizzlePostgres(
      (db as unknown as { $client: Pool }).$client,
      {
        schema,
        logger: {
          logQuery: (query, params) => {
            plans.push(JSON.stringify({ query, params }));
          },
        },
      },
    ) as unknown as Database;
    const outbox = createPostgresSlackOutboxStore(traced);
    await outbox.unansweredTurns(10);
    await outbox.unpostedInstructions(10);
    await outbox.untoldUncertain(10);
    const explainAs = async (captured: string | undefined, format: string) => {
      const { query, params } = JSON.parse(captured ?? "{}");
      const client = await (
        db as unknown as { $client: Pool }
      ).$client.connect();
      try {
        // Tables this small would be read whole; ask which index it would use.
        await client.query("SET enable_seqscan = off");
        const { rows } = await client.query(
          `EXPLAIN (COSTS OFF, FORMAT ${format}) ${query}`,
          params,
        );
        return rows;
      } finally {
        client.release(true);
      }
    };
    const explain = async (captured: string | undefined) =>
      (await explainAs(captured, "TEXT"))
        .map((row) => row["QUERY PLAN"])
        .join("\n");
    // Answers, then instructions.
    for (const captured of plans.slice(0, 2)) {
      const turnsPlan = await explain(captured);
      // The open turns found per link are fetched by id, or by the link's
      // session with the ids as a filter: the turns row width alone tips the
      // planner between the two. Neither reads turns outside linked sessions.
      const [{ "QUERY PLAN": json }] = await explainAs(captured, "JSON");
      expect(turnsReadPerLink(json[0].Plan)).toBe(true);
      expect(turnsPlan).not.toMatch(
        /Seq Scan on turns|Index Scan using turns_pkey on turns\s+Filter/,
      );
      // Ranged on the link and its mark, not a walk of the whole index.
      expect(turnsPlan).toMatch(
        /turns_session_sequence_uniq[\s\S]*Index Cond: \(\(session_id = [^)]+\) AND \(sequence > /,
      );
    }
    expect(await explain(plans.at(-1))).toContain("slack_outbox_uncertain_idx");
  });

  test("a web instruction goes to the thread once, under its sender's name and image, before its answer", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("First.")]]);
    await outboxPass();
    slack.users.set(PERSON, { image48: "https://avatars.example/owner.png" });

    await askFrom(sessionId, 2, "web", "Add a test, <!here>", true);
    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 0, claimed: 0 });
    await endTurn(sessionId, 2, "completed", [[text("Added.")]]);
    await outboxPass();

    const thread = posted().slice(1);
    expect(
      thread.map(({ threadTs, text, options }) => ({
        threadTs,
        text,
        username: options.username,
        icon_url: options.icon_url,
      })),
    ).toEqual([
      {
        threadTs: THREAD,
        // The name shows once, as the sender, not again in the text.
        // G7: a group mention leaves even a person's instruction.
        text: "Add a test,",
        username: "owner (웹 콘솔)",
        icon_url: "https://avatars.example/owner.png",
      },
      {
        threadTs: THREAD,
        text: expect.stringMatching(/^Added\./),
        username: "Notes [summarize the thread]",
        icon_url: undefined,
      },
    ]);
    // As mock Slack serves it: the sender's name once, in the whole message.
    const served = (
      (await (
        await fetch(`${slack.url.replace(/\/api$/, "")}/fake/messages`)
      ).json()) as { messages: { text: string; options: object }[] }
    ).messages[1];
    expect(JSON.stringify(served).split("owner (웹 콘솔)")).toHaveLength(2);
    // Turn 1 came from Slack: it is already in the thread.
    expect(
      (await rows()).map(({ kind, dedupeKey }) => [kind, dedupeKey]),
    ).toEqual([
      ["reply", expect.stringMatching(/^reply:.*:1$/)],
      ["instruction", expect.stringMatching(/^instruction:.*:2$/)],
      ["reply", expect.stringMatching(/^reply:.*:2$/)],
    ]);
  });

  test("an answer that ended before its instruction went still follows it; a key no person made shows as API", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("First.")]]);
    await outboxPass();

    await askFrom(sessionId, 2, "api", "Run the checks", false);
    await endTurn(sessionId, 2, "completed", [[text("Checks pass.")]]);
    // The answer is enqueued once its instruction has gone.
    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });
    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });

    expect(
      posted()
        .slice(1)
        .map(({ text, options }) => [text.split("\n")[0], options.username]),
    ).toEqual([
      ["Run the checks", "API"],
      [expect.stringMatching(/^Checks pass\./), "Notes [summarize the thread]"],
    ]);
  });

  test("an answer waits for its instruction when a pass's batch did not reach it", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("First.")]]);
    await outboxPass();
    await askFrom(sessionId, 2, "web", "Second", true);
    await askFrom(sessionId, 3, "web", "Third", true);
    await endTurn(sessionId, 3, "completed", [[text("Third done.")]]);

    for (let pass = 0; pass < 3; pass += 1) {
      await outboxPass({ batchSize: 1 });
    }

    const sent = await rows();
    expect(
      sent.map(({ dedupeKey, status }) => [
        dedupeKey.replace(/:.*:/, ":"),
        status,
      ]),
    ).toEqual([
      ["reply:1", "sent"],
      ["instruction:2", "sent"],
      ["instruction:3", "sent"],
      ["reply:3", "sent"],
    ]);
    expect(sent.map((row) => row.slackTs)).toEqual(
      posted().map(({ ts }) => ts),
    );
  });

  test("an answer waits while its instruction backs off", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("First.")]]);
    await outboxPass();
    await askFrom(sessionId, 2, "web", "Second", true);
    await endTurn(sessionId, 2, "completed", [[text("Second done.")]]);

    slack.failures.set("chat.postMessage", "internal_error");
    await outboxPass();
    slack.failures.clear();
    expect((await rows()).map(({ kind, status }) => [kind, status])).toEqual([
      ["reply", "sent"],
      ["instruction", "pending"],
    ]);

    await db
      .update(slackOutbox)
      .set({ nextAttemptAt: new Date() })
      .where(eq(slackOutbox.kind, "instruction"));
    await outboxPass();
    await outboxPass();
    expect(
      posted()
        .slice(1)
        .map(({ text }) => text.split("\n")[0]),
    ).toEqual(["Second", "Second done."]);
  });

  test("a failed turn gets one failure notice with its link", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "failed");
    await outboxPass();
    await outboxPass();
    expect(posted().map((message) => message.text)).toEqual([
      `${SLACK_NOTICE_MESSAGES.ko.failed}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
    ]);
    expect((await rows()).map((row) => row.kind)).toEqual(["failure_notice"]);
  });

  test("a worker waiting for room is told in its thread once, past 30 seconds", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const launch = await launchSession(db, {
      sessionId,
      backend: "kubernetes",
    });
    const waitingFor = (ms: number) =>
      db
        .update(workerLaunches)
        .set({ capacityWaitSince: new Date(Date.now() - ms) })
        .where(eq(workerLaunches.executionId, launch.executionId));

    await waitingFor(5_000);
    await outboxPass();
    expect(posted()).toEqual([]);

    // Claimed before the scheduler cleared the wait: no notice.
    await db.insert(attempts).values({
      id: "attempt-claimed",
      sessionId,
      executionId: launch.executionId,
      leaseEpoch: 0,
      executionGeneration: launch.generation,
      authRevision: 0,
      state: "running",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await db
      .update(workerLaunches)
      .set({ claimedAttemptId: "attempt-claimed" })
      .where(eq(workerLaunches.executionId, launch.executionId));
    await waitingFor(31_000);
    await outboxPass();
    expect(posted()).toEqual([]);
    await db
      .update(workerLaunches)
      .set({ claimedAttemptId: null })
      .where(eq(workerLaunches.executionId, launch.executionId));

    await outboxPass();
    await outboxPass();
    expect(posted().map((message) => message.text)).toEqual([
      `${SLACK_NOTICE_MESSAGES.ko.capacityWait}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
    ]);
    expect((await rows()).map((row) => row.dedupeKey)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^capacity_wait:.+:${launch.executionId}:${launch.generation}$`,
        ),
      ),
    ]);
  });

  test("a turn that found no room ends with the no-room notice", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "failed");
    await db
      .update(turns)
      .set({ terminalReason: "no_capacity" })
      .where(eq(turns.sessionId, sessionId));
    await outboxPass();
    expect(posted().map((message) => message.text)).toEqual([
      `${SLACK_NOTICE_MESSAGES.ko.noCapacity}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
    ]);
  });

  test("a turn its worker's lost lease ended is told once, with the button that goes on from it", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "failed");
    await db
      .update(turns)
      .set({ terminalReason: "worker_ownership_lost" })
      .where(eq(turns.sessionId, sessionId));
    await outboxPass();
    await outboxPass();
    const sent = posted();
    expect(sent.map((message) => message.text)).toEqual([
      `${SLACK_NOTICE_MESSAGES.ko.ownershipLost}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
    ]);
    // The blocks go to Slack as one JSON field.
    expect(
      String((sent[0] as { options?: { blocks?: string } }).options?.blocks),
    ).toContain('"action_id":"turn.continue"');
    expect(JSON.stringify(sent[0])).not.toContain(
      SLACK_NOTICE_MESSAGES.ko.failed,
    );
    expect(
      (await rows()).map((row) => [row.kind, row.status, row.dedupeKey]),
    ).toEqual([
      ["failure_notice", "sent", expect.stringMatching(/^failure:.+:1$/)],
    ]);
  });

  test("a resume that found no room says the session stays paused", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "failed");
    await db
      .update(turns)
      .set({ terminalReason: "no_capacity" })
      .where(eq(turns.sessionId, sessionId));
    await db
      .update(sessions)
      .set({ admissionState: "paused" })
      .where(eq(sessions.id, sessionId));
    await outboxPass();
    expect(posted().map((message) => message.text)).toEqual([
      `${SLACK_NOTICE_MESSAGES.ko.noCapacityPaused}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
    ]);
  });

  test("a person with no saved language reads English", async () => {
    const fixture = await agentInSlack();
    await db.update(users).set({ locale: null });
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "failed");
    await outboxPass();
    expect(posted().map((message) => message.text)).toEqual([
      `${SLACK_NOTICE_MESSAGES.en.failed}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.en.link}>`,
    ]);
  });

  test("a thread reads in the language of whoever started the session", async () => {
    const fixture = await agentInSlack();
    // The fixture's one user, the person who mentions the agent.
    await db.update(users).set({ locale: "en" });
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "failed");
    await outboxPass();
    await askFrom(sessionId, 2, "web", "Try again", true);
    await outboxPass();
    await db.update(users).set({ locale: "ja" });
    await askFrom(sessionId, 3, "web", "Once more", true);
    await outboxPass();
    expect(posted().map((message) => message.text)).toEqual([
      `We couldn't process the request right now. Try again shortly\n\n<${CONSOLE}/sessions/${sessionId}|Open on the web>`,
      "Try again",
      "Once more",
    ]);
    expect(posted()[2]?.options.username).toBe("owner (Webコンソール)");
    expect(posted()[1]?.options.username).toBe("owner (Web console)");

    const [row] = await rows();
    expect(row?.body).toMatchObject({ locale: "en" });
  });

  test("a refusal's reader is the user their Slack account is linked to", async () => {
    const fixture = await agentInSlack();
    const outbox = createPostgresSlackOutboxStore(db);
    const reader = (slackUserId: string) =>
      outbox.readerLocale({
        workspaceId: fixture.workspaceId,
        teamId: TEAM,
        slackUserId,
      });
    await db.update(users).set({ locale: null });
    expect(await reader(PERSON)).toBeNull();
    await db.update(users).set({ locale: "ja" });
    expect(await reader(PERSON)).toBe("ja");
    expect(await reader(STRANGER)).toBeNull();
    await db.update(linkedAccounts).set({ status: "stale" });
    expect(await reader(PERSON)).toBe("ja");
    await db.update(linkedAccounts).set({
      status: "revoked",
      revokedAt: new Date(),
      revokedReason: "unlinked",
    });
    expect(await reader(PERSON)).toBeNull();
    expect(
      await outbox.readerLocale({
        workspaceId: randomUUID(),
        teamId: TEAM,
        slackUserId: PERSON,
      }),
    ).toBeNull();
  });

  test("a failure notice whose send outlived its lease still clears the status", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "failed");
    const outbox = createPostgresSlackOutboxStore(db);
    await outboxPass({ botToken: null });
    const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (!claim) throw new Error("nothing claimed");
    expect(await outbox.beginSend(claim)).toMatchObject({
      agentName: "Notes",
    });
    await db
      .update(slackOutbox)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` });
    slack.statuses.length = 0;

    expect(await outboxPass()).toMatchObject({ uncertain: 1, claimed: 0 });
    expect(posted()).toEqual([]);
    expect(slack.statuses).toEqual([
      { channelId: CHANNEL, threadTs: THREAD, status: "active" },
    ]);
  });

  describe("a deleted source", () => {
    const workspaceOf = async (sessionId: string) => {
      const [session] = await db
        .select({ workspaceId: sessions.workspaceId })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      return session?.workspaceId ?? "";
    };
    const marks = () => schema.createPostgresSlackSourceMarkStore(db);
    const statuses = async () =>
      (await rows())
        .filter((row) => row.kind === "reply")
        .map((row) => [row.status, row.errorCode]);

    test("a reply waiting in the outbox is never sent once the message it answers is deleted", async () => {
      const fixture = await agentInSlack();
      await mention(fixture, THREAD);
      const sessionId = await sessionOf(fixture);
      await endTurn(sessionId, 1, "completed", [[text("hi")]]);
      await outboxPass({ botToken: null });
      expect(await statuses()).toEqual([["pending", null]]);
      await marks().markDeleted({
        workspaceId: await workspaceOf(sessionId),
        teamId: TEAM,
        channelId: CHANNEL,
        ts: THREAD,
        at: new Date(),
      });

      expect(await outboxPass()).toMatchObject({ voided: 1, sent: 0 });
      expect(posted()).toEqual([]);
      expect(await statuses()).toEqual([
        ["voided_by_delete", "source_deleted"],
      ]);
      // Settled: a later pass neither sends it nor tells the thread.
      expect(await outboxPass()).toMatchObject({ claimed: 0, voided: 0 });
      expect(posted()).toEqual([]);
    });

    test("a reply sent before the delete stays as it went; the next turn's reply, inheriting the message, is voided", async () => {
      const fixture = await agentInSlack();
      await mention(fixture, THREAD);
      const sessionId = await sessionOf(fixture);
      await endTurn(sessionId, 1, "completed", [[text("first")]]);
      expect(await outboxPass()).toMatchObject({ sent: 1 });
      await mention(fixture, "100.000200");
      await endTurn(sessionId, 2, "completed", [[text("second")]]);
      await outboxPass({ botToken: null });
      const before = posted().length;
      await marks().markDeleted({
        workspaceId: await workspaceOf(sessionId),
        teamId: TEAM,
        channelId: CHANNEL,
        ts: THREAD,
        at: new Date(),
      });

      expect(await outboxPass()).toMatchObject({ voided: 1, sent: 0 });
      expect(posted()).toHaveLength(before);
      expect(await statuses()).toEqual([
        ["sent", null],
        ["voided_by_delete", "source_deleted"],
      ]);
    });

    test("an overflowed set is judged by its own turn and those before, not by a later turn's message", async () => {
      const fixture = await agentInSlack();
      await mention(fixture, THREAD);
      const sessionId = await sessionOf(fixture);
      await endTurn(sessionId, 1, "completed", [[text("first")]]);
      // Turn 2 is in before turn 1's reply is written.
      await mention(fixture, "100.000200");
      await outboxPass({ botToken: null });
      // As a session past the set's key limit stores them.
      await db.execute(sql`
        UPDATE turns SET sources = sources || '{"overflow": true}'::jsonb
        WHERE session_id = ${sessionId}::uuid`);
      await db.execute(sql`
        UPDATE slack_outbox SET sources = sources || '{"overflow": true}'::jsonb`);
      const [reply] = await rows();
      expect(reply).toMatchObject({ kind: "reply", sourcesTurn: 1 });
      await marks().markDeleted({
        workspaceId: await workspaceOf(sessionId),
        teamId: TEAM,
        channelId: CHANNEL,
        ts: "100.000200",
        at: new Date(),
      });

      expect(await outboxPass()).toMatchObject({ sent: 1, voided: 0 });
      expect(await statuses()).toEqual([["sent", null]]);
    });

    test("an overflowed set is still judged by an earlier turn's message it no longer lists", async () => {
      const fixture = await agentInSlack();
      await mention(fixture, THREAD);
      const sessionId = await sessionOf(fixture);
      await endTurn(sessionId, 1, "completed", [[text("first")]]);
      await mention(fixture, "100.000200");
      await endTurn(sessionId, 2, "completed", [[text("second")]]);
      await outboxPass({ botToken: null });
      // Past the key limit the set keeps its first keys: here, none of turn 1.
      await db.execute(sql`
        UPDATE slack_outbox
        SET sources = jsonb_build_object('direct', sources->'direct',
          'inherited', '[]'::jsonb, 'overflow', true)`);
      await marks().markDeleted({
        workspaceId: await workspaceOf(sessionId),
        teamId: TEAM,
        channelId: CHANNEL,
        ts: THREAD,
        at: new Date(),
      });

      expect(await outboxPass()).toMatchObject({ voided: 2, sent: 0 });
      expect(posted()).toEqual([]);
      expect(await statuses()).toEqual([
        ["voided_by_delete", "source_deleted"],
        ["voided_by_delete", "source_deleted"],
      ]);
    });

    test("an edit of the message holds back no reply", async () => {
      const fixture = await agentInSlack();
      await mention(fixture, THREAD);
      const sessionId = await sessionOf(fixture);
      await endTurn(sessionId, 1, "completed", [[text("hi")]]);
      await outboxPass({ botToken: null });
      await marks().markEdited({
        workspaceId: await workspaceOf(sessionId),
        teamId: TEAM,
        channelId: CHANNEL,
        ts: THREAD,
        at: new Date(),
      });

      expect(await outboxPass()).toMatchObject({ sent: 1, voided: 0 });
      expect(await statuses()).toEqual([["sent", null]]);
    });

    test.skipIf(engine === "PGlite")(
      "a send waits for a delete under way and is voided by it",
      async () => {
        const fixture = await agentInSlack();
        await mention(fixture, THREAD);
        const sessionId = await sessionOf(fixture);
        await endTurn(sessionId, 1, "completed", [[text("hi")]]);
        const outbox = createPostgresSlackOutboxStore(db);
        await outboxPass({ botToken: null });
        const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
        if (!claim) throw new Error("nothing claimed");
        const mark = {
          workspaceId: await workspaceOf(sessionId),
          teamId: TEAM,
          channelId: CHANNEL,
          ts: THREAD,
        };
        let held!: () => void;
        const hold = new Promise<void>((resolve) => {
          held = resolve;
        });
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        // A delete's transaction as markDeleted runs it, kept open.
        const deleting = db.transaction(async (tx) => {
          await tx.execute(schema.lockSlackSourceMark(mark));
          await tx.execute(sql`
            INSERT INTO deleted_sources (workspace_id, team_id, channel_id, ts, deleted_at)
            VALUES (${mark.workspaceId}::uuid, ${TEAM}, ${CHANNEL}, ${THREAD}, now())`);
          held();
          await released;
        });
        await hold;
        const begun = outbox.beginSend(claim);
        expect(
          await Promise.race([
            begun.then(() => "begun"),
            Bun.sleep(300).then(() => "waiting"),
          ]),
        ).toBe("waiting");
        release();
        await deleting;
        expect(await begun).toBe("voided_by_delete");
        expect(await statuses()).toEqual([
          ["voided_by_delete", "source_deleted"],
        ]);
      },
    );
  });

  describe("a web input's Slack mirror", () => {
    const ECHO_SECRET = "echo-signing-secret";
    const outbox = () => createPostgresSlackOutboxStore(db);
    const conversations = () => schema.createPostgresConversationStore(db);
    const query = async <Row>(statement: ReturnType<typeof sql>) =>
      ((await db.execute(statement)) as unknown as { rows: Row[] }).rows;

    const ownerOf = async () => {
      const [row] = await db
        .select({ userId: linkedAccounts.userId })
        .from(linkedAccounts)
        .where(eq(linkedAccounts.externalUserId, PERSON));
      if (!row) throw new Error("no linked owner");
      return row.userId;
    };

    async function channelConversation(fixture: Fixture) {
      return conversations().findOrCreateConversation({
        kind: "channel",
        workspaceId: fixture.workspaceId,
        agentId: fixture.agentId,
        teamId: TEAM,
        channelId: CHANNEL,
      });
    }

    async function webInput(
      fixture: Fixture,
      options: {
        topicId?: ConversationTopicId | null;
        conversationId?: ConversationId;
        requester?: string;
      } = {},
    ) {
      const conversationId =
        options.conversationId ?? (await channelConversation(fixture)).id;
      const taken = await schema
        .createPostgresConversationInputStore(db)
        .takeWebInput({
          workspaceId: fixture.workspaceId,
          agentId: fixture.agentId,
          requesterUserId: options.requester ?? (await ownerOf()),
          conversationId,
          topicId: options.topicId ?? null,
          clientMessageId: clientMessageIdSchema.parse(randomUUID()),
          body: "ship the report",
        });
      if (taken.outcome !== "taken") throw new Error(taken.outcome);
      return taken.receipt;
    }

    type InputRow = {
      id: string;
      topic_id: string;
      seq: number;
      slack_team_id: string | null;
      slack_channel_id: string | null;
      slack_ts: string | null;
      turn_id: string | null;
    };
    const inputsOf = (agentId: string) =>
      query<InputRow>(sql`
        SELECT id::text, topic_id::text, seq, slack_team_id, slack_channel_id,
          slack_ts, turn_id::text
        FROM conversation_inputs WHERE agent_id = ${agentId}::uuid
        ORDER BY topic_id, seq`);
    const topicOf = async (topicId: string) => {
      const [topic] = await query<{
        slack_team_id: string | null;
        slack_channel_id: string | null;
        slack_thread_ts: string | null;
      }>(sql`
        SELECT slack_team_id, slack_channel_id, slack_thread_ts
        FROM conversation_topics WHERE id = ${topicId}::uuid`);
      return topic;
    };
    const mirrors = async () =>
      (await rows()).filter((row) => row.kind === "input_mirror");

    /** An event through the events gate, as Slack would send it. */
    async function viaGate(fixture: Fixture, event: Record<string, unknown>) {
      const gate = createSlackEventsService({
        signingSecrets: {
          forAgent: async () => ({
            workspaceId: fixture.workspaceId,
            slackAppId: fixture.slackAppId,
            appId: APP_ID,
            signingSecret: ECHO_SECRET,
          }),
        },
        inbox: createPostgresSlackInboundEventStore(db),
        apps: createPostgresSlackAppStore(db, key),
        identities: createPostgresAgentIdentityStore(db),
        installs: schema.createPostgresSlackInstallStore(db),
        bindings: createPostgresSurfaceBindingStore(db),
        sourceMarks: schema.createPostgresSlackSourceMarkStore(db),
        mirrorEchoes: createPostgresSlackOutboxStore(db),
      });
      const rawBody = new TextEncoder().encode(
        JSON.stringify(
          slackEventEnvelope({ appId: APP_ID, teamId: TEAM, event }),
        ),
      );
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac("sha256", ECHO_SECRET)
        .update(`v0:${timestamp}:`)
        .update(rawBody)
        .digest("hex")}`;
      return gate.receive({
        agentId: fixture.agentId,
        rawBody,
        timestamp,
        signature,
      });
    }

    // What Slack sends back for a post the outbox made under a sender's name.
    const echoOf = (ts: string, threadTs?: string) => ({
      type: "message",
      subtype: "bot_message",
      channel: CHANNEL,
      ts,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
      bot_id: "B0OWN",
      app_id: APP_ID,
      username: `owner (${SLACK_OUTBOX_MESSAGES.ko.web})`,
      text: "ship the report",
    });

    const dropReasons = async (workspaceId: string) =>
      (
        await db
          .select({ dropReason: schema.slackInboundEvents.dropReason })
          .from(schema.slackInboundEvents)
          .where(eq(schema.slackInboundEvents.workspaceId, workspaceId))
      ).map((row) => row.dropReason);

    test("before: a web console instruction's echo is dropped at the gate as the app's own and makes no turn", async () => {
      const fixture = await agentInSlack();
      const answer = await viaGate(fixture, echoOf("100.000150", THREAD));
      expect(answer).toMatchObject({ result: "recorded", status: "dropped" });
      expect(await dropReasons(fixture.workspaceId)).toEqual(["own_bot_user"]);
      expect(await db.select().from(turns)).toEqual([]);
      expect(await inputsOf(fixture.agentId)).toEqual([]);
    });

    test("a web input opening a topic is posted at the top of the channel; its ts becomes the input's alias and the topic's", async () => {
      const fixture = await agentInSlack();
      const receipt = await webInput(fixture);
      expect(await topicOf(receipt.topicId)).toEqual({
        slack_team_id: null,
        slack_channel_id: null,
        slack_thread_ts: null,
      });

      expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });
      const [mirror] = await mirrors();
      if (!mirror?.slackTs) throw new Error("no mirror sent");
      expect(mirror).toMatchObject({
        status: "sent",
        inputId: receipt.inputId,
        channelId: CHANNEL,
        threadTs: "",
        sessionId: null,
        sources: { direct: [{ input_id: receipt.inputId }], inherited: [] },
      });
      expect(posted()).toEqual([
        expect.objectContaining({
          channelId: CHANNEL,
          threadTs: null,
          ts: mirror.slackTs,
          options: expect.objectContaining({
            username: `owner (${SLACK_OUTBOX_MESSAGES.ko.web})`,
          }),
        }),
      ]);
      expect(await inputsOf(fixture.agentId)).toEqual([
        expect.objectContaining({
          id: receipt.inputId,
          seq: 1,
          slack_team_id: TEAM,
          slack_channel_id: CHANNEL,
          slack_ts: mirror.slackTs,
          turn_id: null,
        }),
      ]);
      expect(await topicOf(receipt.topicId)).toEqual({
        slack_team_id: TEAM,
        slack_channel_id: CHANNEL,
        slack_thread_ts: mirror.slackTs,
      });

      // Slack sends the post back: dropped at the gate, no new input or turn.
      const answer = await viaGate(fixture, echoOf(mirror.slackTs));
      expect(answer).toMatchObject({ status: "dropped" });
      expect(await dropReasons(fixture.workspaceId)).toEqual(["own_bot_user"]);
      expect(await inputsOf(fixture.agentId)).toHaveLength(1);
      expect(await db.select().from(turns)).toEqual([]);
      // Mirrored once: a later pass finds nothing owed.
      expect(await outboxPass()).toMatchObject({ enqueued: 0, sent: 0 });
      expect(posted()).toHaveLength(1);
    });

    test("a person's reply in the mirror's thread is taken as the topic's next input", async () => {
      const fixture = await agentInSlack();
      const receipt = await webInput(fixture);
      await outboxPass();
      const [mirror] = await mirrors();
      if (!mirror?.slackTs) throw new Error("no mirror sent");

      await mention(fixture, "100.000900", PERSON, {
        thread_ts: mirror.slackTs,
      });

      const taken = await inputsOf(fixture.agentId);
      expect(taken).toHaveLength(2);
      expect(taken[1]).toMatchObject({
        topic_id: receipt.topicId,
        seq: 2,
        slack_ts: "100.000900",
      });
      expect(taken[1]?.turn_id).not.toBeNull();
    });

    // Until web inputs open turns, the mirror's thread has no session, and
    // an unmentioned reply there is a stray reply like any other.
    test("an unmentioned reply in the mirror's thread is not taken yet", async () => {
      const fixture = await agentInSlack();
      await webInput(fixture);
      await outboxPass();
      const [mirror] = await mirrors();
      if (!mirror?.slackTs) throw new Error("no mirror sent");

      await mention(fixture, "100.000901", PERSON, {
        type: "message",
        channel_type: "channel",
        thread_ts: mirror.slackTs,
        text: "follow up without a mention",
      });

      expect(await inputsOf(fixture.agentId)).toHaveLength(1);
      expect(await db.select().from(turns)).toEqual([]);
    });

    test("a topic's second web input waits for the first's post, then goes into the thread it opened", async () => {
      const fixture = await agentInSlack();
      const first = await webInput(fixture);
      const second = await webInput(fixture, { topicId: first.topicId });
      expect(second).toMatchObject({ topicId: first.topicId, seq: 2 });

      await outboxPass({ botToken: null });
      expect((await mirrors()).map((row) => row.inputId)).toEqual([
        first.inputId,
      ]);
      await outboxPass();
      await outboxPass();
      const [opened, inThread] = await mirrors();
      expect(opened).toMatchObject({ inputId: first.inputId, threadTs: "" });
      expect(inThread).toMatchObject({
        inputId: second.inputId,
        threadTs: opened?.slackTs,
        status: "sent",
      });
      const [, secondRow] = await inputsOf(fixture.agentId);
      expect(secondRow?.slack_ts).toBe(inThread?.slackTs ?? "");
      // The topic keeps the thread the first post opened.
      expect((await topicOf(first.topicId))?.slack_thread_ts).toBe(
        opened?.slackTs ?? "",
      );
    });

    test("a web input in a topic Slack opened goes into that thread and leaves the topic's alias", async () => {
      const fixture = await agentInSlack();
      await mention(fixture, THREAD);
      const [slackInput] = await inputsOf(fixture.agentId);
      if (!slackInput) throw new Error("no Slack input");
      const receipt = await webInput(fixture, {
        topicId: slackInput.topic_id as ConversationTopicId,
      });
      expect(receipt.seq).toBe(2);

      await outboxPass();
      const [mirror] = await mirrors();
      expect(mirror).toMatchObject({ threadTs: THREAD, status: "sent" });
      expect(await topicOf(slackInput.topic_id)).toEqual({
        slack_team_id: TEAM,
        slack_channel_id: CHANNEL,
        slack_thread_ts: THREAD,
      });
      expect((await inputsOf(fixture.agentId))[1]?.slack_ts).toBe(
        mirror?.slackTs ?? "",
      );
    });

    test("a DM web input goes to the D channel of that person's own placed topic, never another person's", async () => {
      const fixture = await agentInSlack();
      const owner = await ownerOf();
      const other = randomUUID();
      await db.insert(users).values({
        id: other,
        email: `${other}@example.invalid`,
        passwordHash: "argon2id$placeholder",
        displayName: "other",
      });
      await db.insert(memberships).values({
        workspaceId: fixture.workspaceId,
        userId: other,
        role: "member",
      });
      const dmOf = (personUserId: string) =>
        conversations().findOrCreateConversation({
          kind: "dm",
          workspaceId: fixture.workspaceId,
          agentId: fixture.agentId,
          personUserId,
        });
      const otherDm = await dmOf(other);
      await conversations().findOrCreateThreadTopic(otherDm.id, {
        teamId: TEAM,
        channelId: "D0OTHER",
        threadTs: "100.000310",
      });
      const ownerDm = await dmOf(owner);
      const receipt = await webInput(fixture, {
        conversationId: ownerDm.id,
      });
      expect(receipt.slackMirror).toBe("pending");
      // No placed topic of the owner's: the input waits.
      expect(await outbox().unmirroredInputs(10)).toEqual([]);

      await conversations().findOrCreateThreadTopic(ownerDm.id, {
        teamId: TEAM,
        channelId: "D0OWNER",
        threadTs: "100.000320",
      });
      expect(await outbox().unmirroredInputs(10)).toEqual([
        expect.objectContaining({
          inputId: receipt.inputId,
          channelId: "D0OWNER",
          threadTs: "",
          senderSlackUserId: PERSON,
        }),
      ]);
    });

    describe("and the delete check", () => {
      const marks = () => schema.createPostgresSlackSourceMarkStore(db);
      // A row standing for anything whose sources hold the web input.
      const enqueueFromInput = (
        fixture: Fixture,
        inputId: string,
        dedupeKey: string,
      ) =>
        outbox().enqueue({
          workspaceId: fixture.workspaceId,
          agentId: fixture.agentId,
          slackAppId: fixture.slackAppId,
          installationId: mirrorsInstallation,
          kind: "reply",
          channelId: CHANNEL,
          threadTs: "100.000100",
          slackUserId: null,
          sessionId: null,
          sessionLinkId: null,
          body: { text: "done" },
          dedupeKey,
          sources: {
            direct: [{ input_id: inputId as ConversationInputId }],
            inherited: [],
          },
        });
      let mirrorsInstallation = "";
      const installationOf = async () => {
        const [row] = await db
          .select({ id: schema.slackInstallations.id })
          .from(schema.slackInstallations)
          .where(eq(schema.slackInstallations.appId, APP_ID));
        mirrorsInstallation = row?.id ?? "";
      };
      const statusOf = async (dedupeKey: string) =>
        (await rows()).find((row) => row.dedupeKey === dedupeKey)?.status;

      test("a row from a web input is not held back by deletes before the input has its alias", async () => {
        const fixture = await agentInSlack();
        await installationOf();
        const receipt = await webInput(fixture);
        await marks().markDeleted({
          workspaceId: fixture.workspaceId,
          teamId: TEAM,
          channelId: CHANNEL,
          ts: "100.000100",
          at: new Date(),
        });
        await outboxPass({ botToken: null });
        await enqueueFromInput(fixture, receipt.inputId, "from-input:1");
        // Sent alone, ahead of the mirror: the mirror's own alias is not
        // known yet, so nothing deleted in Slack is this input.
        await db.execute(sql`
          UPDATE slack_outbox SET next_attempt_at = now() + interval '1 hour'
          WHERE kind = 'input_mirror'`);
        expect(await outboxPass()).toMatchObject({ sent: 1, voided: 0 });
        expect(await statusOf("from-input:1")).toBe("sent");
      });

      test("once the mirror gave the input its alias, deleting that post voids the rows from the input", async () => {
        const fixture = await agentInSlack();
        await installationOf();
        const receipt = await webInput(fixture);
        await outboxPass();
        const [mirror] = await mirrors();
        if (!mirror?.slackTs) throw new Error("no mirror sent");
        await enqueueFromInput(fixture, receipt.inputId, "from-input:2");
        await marks().markDeleted({
          workspaceId: fixture.workspaceId,
          teamId: TEAM,
          channelId: CHANNEL,
          ts: mirror.slackTs,
          at: new Date(),
        });

        expect(await outboxPass()).toMatchObject({ voided: 1, sent: 0 });
        expect(await statusOf("from-input:2")).toBe("voided_by_delete");
      });

      test("once the mirror gave the input its alias, deleting that post stops a session whose turn names only the input", async () => {
        const fixture = await agentInSlack();
        await installationOf();
        await mention(fixture, THREAD);
        const [turn] = await db.select().from(turns);
        if (!turn) throw new Error("no turn");
        const receipt = await webInput(fixture);
        await db
          .update(turns)
          .set({
            sources: { direct: [{ input_id: receipt.inputId }], inherited: [] },
          })
          .where(eq(turns.id, turn.id));
        await outboxPass();
        const [mirror] = await mirrors();
        if (!mirror?.slackTs) throw new Error("no mirror sent");
        const deletedAt = async () =>
          (
            await db
              .select({ at: sessions.sourceDeletedAt })
              .from(sessions)
              .where(eq(sessions.id, turn.sessionId))
          )[0]?.at ?? null;
        expect(await deletedAt()).toBeNull();

        await marks().markDeleted({
          workspaceId: fixture.workspaceId,
          teamId: TEAM,
          channelId: CHANNEL,
          ts: mirror.slackTs,
          at: new Date(),
        });

        expect(await deletedAt()).not.toBeNull();
      });

      test("a delete Slack sent before the post was recorded is the input's as soon as the alias is written", async () => {
        const fixture = await agentInSlack();
        await installationOf();
        const receipt = await webInput(fixture);
        await outboxPass({ botToken: null });
        const [claim] = await outbox().claim({ limit: 10, leaseMs: 30_000 });
        if (!claim) throw new Error("nothing claimed");
        expect(await outbox().beginSend(claim)).toMatchObject({
          agentName: "Notes",
        });
        const ts = "100.000777";
        await marks().markDeleted({
          workspaceId: fixture.workspaceId,
          teamId: TEAM,
          channelId: CHANNEL,
          ts,
          at: new Date(),
        });
        expect(
          await outbox().settle(claim, { status: "sent", slackTs: ts }),
        ).toBe(true);
        // A mark of a message nothing names is purged; the alias names it.
        expect(
          await schema.purgeUnknownSlackSourceMarks(db, {
            limit: 10,
            dryRun: false,
            retentionMs: 0,
          }),
        ).toEqual({ deleted: 0, edited: 0 });
        await enqueueFromInput(fixture, receipt.inputId, "from-input:3");
        expect(await outboxPass()).toMatchObject({ voided: 1, sent: 0 });
        expect(await statusOf("from-input:3")).toBe("voided_by_delete");
      });
    });

    test("a mirror whose thread a reply already made a topic of links the input and leaves the topics apart", async () => {
      const fixture = await agentInSlack();
      const receipt = await webInput(fixture);
      await outboxPass({ botToken: null });
      const [claim] = await outbox().claim({ limit: 10, leaseMs: 30_000 });
      if (!claim) throw new Error("nothing claimed");
      expect(await outbox().beginSend(claim)).toMatchObject({
        agentName: "Notes",
      });
      const ts = "100.000555";
      const conversation = await channelConversation(fixture);
      const replyTopic = await conversations().findOrCreateThreadTopic(
        conversation.id,
        { teamId: TEAM, channelId: CHANNEL, threadTs: ts },
      );

      expect(
        await outbox().settle(claim, { status: "sent", slackTs: ts }),
      ).toBe("topic_alias_taken");
      expect((await inputsOf(fixture.agentId))[0]).toMatchObject({
        id: receipt.inputId,
        slack_ts: ts,
      });
      expect((await topicOf(receipt.topicId))?.slack_thread_ts).toBeNull();
      expect((await topicOf(replyTopic.id))?.slack_thread_ts).toBe(ts);
      expect((await mirrors())[0]).toMatchObject({
        status: "sent",
        slackTs: ts,
      });
    });

    test.skipIf(engine === "PGlite")(
      "the post's record and its echo arriving at once leave one input and one alias",
      async () => {
        const fixture = await agentInSlack();
        const receipt = await webInput(fixture);
        await outboxPass({ botToken: null });
        const [claim] = await outbox().claim({ limit: 10, leaseMs: 30_000 });
        if (!claim) throw new Error("nothing claimed");
        expect(await outbox().beginSend(claim)).toMatchObject({
          agentName: "Notes",
        });
        const ts = "100.000666";
        let held!: () => void;
        const hold = new Promise<void>((resolve) => {
          held = resolve;
        });
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        // A delete check reading the input, kept open: the record waits
        // with its post known and not yet written.
        const reading = db.transaction(async (tx) => {
          await tx.execute(sql`
            SELECT 1 FROM conversation_inputs
            WHERE id = ${receipt.inputId}::uuid FOR SHARE`);
          held();
          await released;
        });
        await hold;
        const recording = outbox().settle(claim, {
          status: "sent",
          slackTs: ts,
        });
        // The echo before the ts is saved, and Slack's retry of it after.
        const early = await viaGate(fixture, echoOf(ts));
        expect(
          await Promise.race([
            recording.then(() => "recorded"),
            Bun.sleep(300).then(() => "waiting"),
          ]),
        ).toBe("waiting");
        release();
        await reading;
        const [settled, late] = await Promise.all([
          recording,
          viaGate(fixture, echoOf(ts)),
        ]);
        expect(settled).toBe(true);
        expect(early).toMatchObject({ status: "dropped" });
        expect(late).toMatchObject({ status: "dropped" });
        expect(await inputsOf(fixture.agentId)).toEqual([
          expect.objectContaining({ id: receipt.inputId, slack_ts: ts }),
        ]);
        expect(
          await query<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM conversation_inputs
            WHERE slack_team_id = ${TEAM} AND slack_channel_id = ${CHANNEL}
              AND slack_ts = ${ts}`),
        ).toEqual([{ n: 1 }]);
        expect((await topicOf(receipt.topicId))?.slack_thread_ts).toBe(ts);
        expect(await db.select().from(turns)).toEqual([]);
      },
    );

    describe("and the hold before its post (94S-2007)", () => {
      let installationId = "";
      const installed = async () => {
        const [row] = await db
          .select({ id: schema.slackInstallations.id })
          .from(schema.slackInstallations)
          .where(eq(schema.slackInstallations.appId, APP_ID));
        installationId = row?.id ?? "";
      };
      // A row bound for the input's mirror thread: no turn makes one yet.
      const held = (fixture: Fixture, inputId: string, dedupeKey: string) =>
        outbox().enqueue({
          workspaceId: fixture.workspaceId,
          agentId: fixture.agentId,
          slackAppId: fixture.slackAppId,
          installationId,
          kind: "reply",
          channelId: CHANNEL,
          threadTs: "",
          slackUserId: null,
          sessionId: null,
          sessionLinkId: null,
          body: { text: "held answer" },
          dedupeKey,
          heldForInputId: inputId as ConversationInputId,
        });
      const rowOf = async (dedupeKey: string) =>
        (await rows()).find((row) => row.dedupeKey === dedupeKey);
      const mirrorState = async (inputId: string) =>
        (
          await query<{ slack_mirror: string }>(sql`
            SELECT slack_mirror FROM conversation_inputs
            WHERE id = ${inputId}::uuid`)
        )[0]?.slack_mirror;
      // Slack took the send, but its answer could not be read.
      const unreadable = async () => ({
        httpStatus: 200,
        retryAfterHeader: null,
        body: null,
      });
      const garbled = () => ({
        ...createSlackBotApi({ apiUrl: slack.url }),
        postMessage: unreadable,
      });
      const echoNaming = (ts: string, correlationId: string) => ({
        ...echoOf(ts),
        metadata: {
          event_type: "werft_input_mirror",
          event_payload: { correlation_id: correlationId },
        },
      });

      test("a row bound for the mirror's thread waits for the post, then goes into the thread it opened", async () => {
        const fixture = await agentInSlack();
        await installed();
        const receipt = await webInput(fixture);
        await outboxPass({ botToken: null });
        expect(await held(fixture, receipt.inputId, "held:1")).toBe("enqueued");
        expect(await rowOf("held:1")).toMatchObject({
          status: "pending",
          threadTs: "",
          heldForInputId: receipt.inputId,
        });
        await outboxPass({ botToken: null });
        expect(posted()).toEqual([]);

        await outboxPass();
        await outboxPass();
        const [mirror] = await mirrors();
        if (!mirror?.slackTs) throw new Error("no mirror sent");
        expect(await rowOf("held:1")).toMatchObject({
          status: "sent",
          channelId: CHANNEL,
          threadTs: mirror.slackTs,
          heldForInputId: null,
        });
        expect(
          posted().map((message) => [message.text, message.threadTs]),
        ).toEqual([
          ["ship the report", null],
          ["held answer", mirror.slackTs],
        ]);
        // The mirror's post named its request in its metadata; nothing else.
        expect(JSON.parse(posted()[0]?.options.metadata ?? "null")).toEqual({
          event_type: "werft_input_mirror",
          event_payload: { correlation_id: mirror.correlationId },
        });
        expect(posted()[1]?.options).not.toHaveProperty("metadata");
      });

      test("a row enqueued once the thread is known goes there at once", async () => {
        const fixture = await agentInSlack();
        await installed();
        const receipt = await webInput(fixture);
        await outboxPass();
        const [mirror] = await mirrors();
        if (!mirror?.slackTs) throw new Error("no mirror sent");
        await held(fixture, receipt.inputId, "held:2");
        expect(await rowOf("held:2")).toMatchObject({
          threadTs: mirror.slackTs,
          heldForInputId: null,
        });
      });

      test("an uncertain mirror sends nothing held, opens no thread, and the input reads unconfirmed", async () => {
        const fixture = await agentInSlack();
        await installed();
        const clientMessageId = clientMessageIdSchema.parse(randomUUID());
        const take = async () =>
          schema.createPostgresConversationInputStore(db).takeWebInput({
            workspaceId: fixture.workspaceId,
            agentId: fixture.agentId,
            requesterUserId: await ownerOf(),
            conversationId: (await channelConversation(fixture)).id,
            topicId: null,
            clientMessageId,
            body: "ship the report",
          });
        const taken = await take();
        if (taken.outcome !== "taken") throw new Error(taken.outcome);
        const receipt = taken.receipt;
        expect(receipt.slackMirror).toBe("pending");
        await held(fixture, receipt.inputId, "held:3");

        expect(await outboxPass({ slack: garbled() })).toMatchObject({
          uncertain: 1,
        });
        expect(await mirrors()).toEqual([
          expect.objectContaining({
            status: "uncertain",
            errorCode: "unreadable_answer",
          }),
        ]);
        expect(await mirrorState(receipt.inputId)).toBe("unconfirmed");
        // Reading the input again shows it.
        expect(await take()).toMatchObject({
          outcome: "replayed",
          receipt: { inputId: receipt.inputId, slackMirror: "unconfirmed" },
        });

        // The topic's next input waits on it too: no thread of its own.
        await webInput(fixture, { topicId: receipt.topicId });
        await outboxPass();
        await outboxPass();
        expect(posted()).toEqual([]);
        expect(await mirrors()).toHaveLength(1);
        expect(await rowOf("held:3")).toMatchObject({
          status: "pending",
          heldForInputId: receipt.inputId,
        });
        expect((await topicOf(receipt.topicId))?.slack_thread_ts).toBeNull();
      });

      test("an echo names its mirror only by correlation id: of two posts with the same text, the uncertain one is linked", async () => {
        const fixture = await agentInSlack();
        await installed();
        const first = await webInput(fixture);
        const second = await webInput(fixture);
        const live = createSlackBotApi({ apiUrl: slack.url });
        let calls = 0;
        await outboxPass({
          slack: {
            ...live,
            postMessage: (...args: Parameters<typeof live.postMessage>) => {
              calls += 1;
              return calls === 1 ? unreadable() : live.postMessage(...args);
            },
          },
        });
        const lost = (await mirrors()).find(
          (row) => row.inputId === first.inputId,
        );
        const sent = (await mirrors()).find(
          (row) => row.inputId === second.inputId,
        );
        if (!lost?.correlationId || !sent?.correlationId || !sent.slackTs) {
          throw new Error("mirrors missing");
        }
        expect([lost.status, sent.status]).toEqual(["uncertain", "sent"]);
        expect(lost.correlationId).not.toBe(sent.correlationId);
        await held(fixture, first.inputId, "held:4");

        // The other post's own echo, and a post of the same text without
        // metadata, name nothing uncertain.
        await viaGate(fixture, echoNaming(sent.slackTs, sent.correlationId));
        await viaGate(fixture, echoOf("100.000777"));
        expect(await mirrorState(first.inputId)).toBe("unconfirmed");
        expect(
          (await inputsOf(fixture.agentId)).find(
            (row) => row.id === first.inputId,
          )?.slack_ts,
        ).toBeNull();

        const answer = await viaGate(
          fixture,
          echoNaming("100.000700", lost.correlationId),
        );
        expect(answer).toMatchObject({ status: "dropped" });
        expect(
          (await mirrors()).find((row) => row.id === lost.id),
        ).toMatchObject({ status: "sent", slackTs: "100.000700" });
        expect(await mirrorState(first.inputId)).toBe("pending");
        expect(
          (await inputsOf(fixture.agentId)).find(
            (row) => row.id === first.inputId,
          ),
        ).toMatchObject({ slack_ts: "100.000700" });
        expect((await topicOf(first.topicId))?.slack_thread_ts).toBe(
          "100.000700",
        );
        expect(await rowOf("held:4")).toMatchObject({
          threadTs: "100.000700",
          heldForInputId: null,
        });
        // Each echo was dropped as the app's own and kept only its id.
        const kept = await db
          .select({ fields: schema.slackInboundEvents.dropFields })
          .from(schema.slackInboundEvents)
          .where(
            eq(schema.slackInboundEvents.workspaceId, fixture.workspaceId),
          );
        expect(kept).toHaveLength(3);
        expect(kept.map((row) => row.fields?.metadata ?? null)).toEqual(
          expect.arrayContaining([
            {
              event_type: "werft_input_mirror",
              correlation_id: sent.correlationId,
            },
            null,
            {
              event_type: "werft_input_mirror",
              correlation_id: lost.correlationId,
            },
          ]),
        );
        expect(await inputsOf(fixture.agentId)).toHaveLength(2);
        expect(await db.select().from(turns)).toEqual([]);
      });

      test("no candidate, or two, links nothing", async () => {
        const fixture = await agentInSlack();
        await installed();
        const first = await webInput(fixture);
        const second = await webInput(fixture);
        await outboxPass({ slack: garbled() });
        const [a, b] = await mirrors();
        if (!a?.correlationId || !b?.correlationId) throw new Error("no rows");
        expect(
          await outbox().matchMirrorEcho({
            workspaceId: fixture.workspaceId,
            slackAppId: fixture.slackAppId,
            correlationId: slackMirrorCorrelationIdSchema.parse(randomUUID()),
            channelId: CHANNEL,
            ts: "100.000801",
          }),
        ).toBe("no_candidate");
        // Only a fault could give two rows one id; they are not guessed at.
        await db.execute(sql`
          UPDATE slack_outbox SET correlation_id = ${a.correlationId}::uuid
          WHERE id = ${b.id}::uuid`);
        await viaGate(fixture, echoNaming("100.000802", a.correlationId));
        expect(
          await outbox().matchMirrorEcho({
            workspaceId: fixture.workspaceId,
            slackAppId: fixture.slackAppId,
            correlationId: a.correlationId,
            channelId: CHANNEL,
            ts: "100.000802",
          }),
        ).toBe("ambiguous");
        expect((await mirrors()).map((row) => row.status)).toEqual([
          "uncertain",
          "uncertain",
        ]);
        for (const input of [first, second]) {
          expect(await mirrorState(input.inputId)).toBe("unconfirmed");
        }
        expect(
          (await inputsOf(fixture.agentId)).map((row) => row.slack_ts),
        ).toEqual([null, null]);
      });

      test("sending again is a person's call: the same input, a new correlation id, once", async () => {
        const fixture = await agentInSlack();
        await installed();
        const owner = await ownerOf();
        const conversationId = (await channelConversation(fixture)).id;
        const receipt = await webInput(fixture);
        await held(fixture, receipt.inputId, "held:6");
        await outboxPass({ slack: garbled() });
        // Left alone, nothing sends it again.
        await outboxPass();
        await outboxPass();
        expect(await mirrors()).toHaveLength(1);
        expect(posted()).toEqual([]);

        const inputs = schema.createPostgresConversationInputStore(db);
        const resend = (requesterUserId: string) =>
          inputs.resendMirror({
            workspaceId: fixture.workspaceId,
            agentId: fixture.agentId,
            requesterUserId,
            conversationId,
            inputId: receipt.inputId,
          });
        expect(await resend(randomUUID())).toBe("not_found");
        // A suspended account sends nothing again.
        await db.execute(
          sql`UPDATE users SET disabled_at = now() WHERE id = ${owner}::uuid`,
        );
        expect(await resend(owner)).toBe("not_found");
        await db.execute(
          sql`UPDATE users SET disabled_at = NULL WHERE id = ${owner}::uuid`,
        );
        expect(await resend(owner)).toBe("enqueued");
        expect(await resend(owner)).toBe("not_unconfirmed");
        const [lost, again] = await mirrors();
        if (!lost || !again?.correlationId) throw new Error("no new mirror");
        expect(again).toMatchObject({
          status: "pending",
          inputId: receipt.inputId,
          channelId: lost.channelId,
          threadTs: lost.threadTs,
          body: lost.body,
          dedupeKey: `input_mirror:${receipt.inputId}:${again.correlationId}`,
        });
        expect(again.correlationId).not.toBe(lost.correlationId);
        expect(await inputsOf(fixture.agentId)).toHaveLength(1);
        expect(await mirrorState(receipt.inputId)).toBe("pending");

        await outboxPass();
        await outboxPass();
        const sent = (await mirrors())[1];
        if (!sent?.slackTs) throw new Error("not sent again");
        expect(lost).toMatchObject({ status: "uncertain" });
        expect(await inputsOf(fixture.agentId)).toEqual([
          expect.objectContaining({
            id: receipt.inputId,
            slack_ts: sent.slackTs,
          }),
        ]);
        expect(
          posted().map((message) => [message.text, message.threadTs]),
        ).toEqual([
          ["ship the report", null],
          ["held answer", sent.slackTs],
        ]);
      });

      test("rows held past the limit close unsent, and the input reads unconfirmed", async () => {
        const fixture = await agentInSlack();
        await installed();
        const receipt = await webInput(fixture);
        await outboxPass({ botToken: null });
        await held(fixture, receipt.inputId, "held:7");
        await held(fixture, receipt.inputId, "held:7b");
        await db.execute(sql`
          UPDATE slack_outbox SET created_at = now() - interval '2 hours'
          WHERE dedupe_key = 'held:7'`);
        expect(await outboxPass({ botToken: null })).toMatchObject({
          heldClosed: 1,
        });
        expect(await rowOf("held:7")).toMatchObject({
          status: "failed",
          errorCode: "input_unplaced",
        });
        expect(await mirrorState(receipt.inputId)).toBe("unconfirmed");
        // A shorter limit set for the role closes the newer row too.
        expect(
          await outboxPass({ botToken: null, inputHoldMs: 1 }),
        ).toMatchObject({ heldClosed: 1 });

        // The mirror itself still goes; what closed stays closed.
        await outboxPass();
        const [mirror] = await mirrors();
        expect(mirror).toMatchObject({ status: "sent" });
        expect(await mirrorState(receipt.inputId)).toBe("pending");
        expect((await rowOf("held:7"))?.status).toBe("failed");
        expect((await rowOf("held:7b"))?.status).toBe("failed");
        expect(posted().map((message) => message.text)).toEqual([
          "ship the report",
        ]);
      });

      test("a mirror Slack refused for good closes its held rows; none goes to a new thread", async () => {
        const fixture = await agentInSlack();
        await installed();
        const receipt = await webInput(fixture);
        await held(fixture, receipt.inputId, "held:8");
        slack.failures.set("chat.postMessage", "msg_too_long");
        await outboxPass();
        expect(await mirrors()).toEqual([
          expect.objectContaining({ status: "failed" }),
        ]);
        expect(await rowOf("held:8")).toMatchObject({
          status: "failed",
          errorCode: "input_unplaced",
        });
        // A row enqueued after the failure closes at once; it does not
        // wait out the limit.
        expect(await held(fixture, receipt.inputId, "held:8b")).toBe(
          "enqueued",
        );
        expect(await rowOf("held:8b")).toMatchObject({
          status: "failed",
          errorCode: "input_unplaced",
        });
        slack.failures.clear();
        await outboxPass();
        expect(posted()).toEqual([]);
      });

      test("a mirror closed as no longer addressed closes its held rows too", async () => {
        const fixture = await agentInSlack();
        await installed();
        const receipt = await webInput(fixture);
        await outboxPass({ botToken: null });
        await held(fixture, receipt.inputId, "held:10");
        await db.execute(
          sql`UPDATE slack_installations SET status = 'revoked', revoked_at = now()`,
        );
        await outboxPass();
        expect(await mirrors()).toEqual([
          expect.objectContaining({
            status: "failed",
            errorCode: "not_addressed",
          }),
        ]);
        expect(await rowOf("held:10")).toMatchObject({
          status: "failed",
          errorCode: "input_unplaced",
        });
        expect(posted()).toEqual([]);
      });

      test("an echo that comes before Slack's answer to the send still links its mirror", async () => {
        const fixture = await agentInSlack();
        await installed();
        const receipt = await webInput(fixture);
        await held(fixture, receipt.inputId, "held:9");
        const echoes: string[] = [];
        const pass = await outboxPass({
          slack: {
            ...createSlackBotApi({ apiUrl: slack.url }),
            // The mirror is still sending when its echo reaches the gate.
            postMessage: async (token, input) => {
              const correlationId =
                input.metadata?.event_payload.correlation_id;
              if (correlationId === undefined) {
                return createSlackBotApi({ apiUrl: slack.url }).postMessage(
                  token,
                  input,
                );
              }
              echoes.push(correlationId);
              await viaGate(fixture, echoNaming("100.000900", correlationId));
              return unreadable();
            },
          },
        });
        expect(echoes).toHaveLength(1);
        // Its own settle finds the row already taken by the echo; the row
        // it freed may go in the same pass.
        expect(pass).toMatchObject({ lost: 1, uncertain: 0 });
        expect(await mirrors()).toEqual([
          expect.objectContaining({
            status: "sent",
            slackTs: "100.000900",
            correlationId: echoes[0],
          }),
        ]);
        expect(await mirrorState(receipt.inputId)).toBe("pending");
        expect(await rowOf("held:9")).toMatchObject({
          threadTs: "100.000900",
          heldForInputId: null,
        });
        await outboxPass();
        expect(
          posted().map((message) => [message.text, message.threadTs]),
        ).toEqual([["held answer", "100.000900"]]);
      });
    });
  });

  test("a reply whose thread was muted or unlinked while it waited is not sent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    await db.update(sessionLinks).set({ muted: true });

    expect(await outboxPass()).toMatchObject({ failed: 1, claimed: 0 });
    await outboxPass();
    expect(posted()).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "not_addressed",
    });
  });

  test("a closed link's turns are not answered; once enqueued, a reply still goes", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("hi")]]);
    const close = (closedAt: Date | null) =>
      db.update(sessionLinks).set({
        closedAt,
        closedReason: closedAt === null ? null : "completed",
      });
    await close(new Date());
    expect(await outboxPass()).toMatchObject({ enqueued: 0, claimed: 0 });
    expect(posted()).toEqual([]);

    await close(null);
    await outboxPass({ botToken: null });
    await close(new Date());
    expect(await outboxPass()).toMatchObject({ enqueued: 0, sent: 1 });
    expect(posted()).toHaveLength(1);
  });

  test("a reply to a channel that is waiting for approval is not sent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    await db.update(surfaceBindings).set({
      surfaceKind: "private_channel",
      status: "pending_approval",
      home: false,
    });

    expect(await outboxPass()).toMatchObject({ failed: 1, claimed: 0 });
    expect(posted()).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "not_addressed",
    });
  });

  test("a budget account's refusals: the first in the thread, the next to the person alone, none to a channel waiting for approval; never 'try again'", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    // The turn ends failed on the attempt its refused call ran in.
    const refused = async (sequence: number) => {
      await endTurn(sessionId, sequence, "failed");
      const [turn] = await db
        .select({ attemptId: turns.attemptId })
        .from(turns)
        .where(
          and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)),
        );
      expect(
        await schema.recordBudgetAccountRefusal(db, {
          sessionId,
          attemptId: turn?.attemptId ?? "",
          turnId: String(sequence),
          owner: "user",
        }),
      ).toBe("recorded");
    };
    const isBudgetLine = (text: string) =>
      Object.values(SLACK_NOTICE_MESSAGES).some((messages) =>
        text.startsWith(messages.budgetAccountUser),
      );

    await refused(1);
    await outboxPass();
    await outboxPass();
    expect(
      slack.messages.map((message) => [
        message.method,
        message.userId,
        isBudgetLine(message.text),
      ]),
    ).toEqual([["chat.postMessage", null, true]]);

    await mention(fixture, "100.000200");
    await refused(2);
    await outboxPass();
    await outboxPass();
    expect(
      slack.messages.map((message) => [
        message.method,
        message.userId,
        isBudgetLine(message.text),
      ]),
    ).toEqual([
      ["chat.postMessage", null, true],
      ["chat.postEphemeral", PERSON, true],
    ]);

    // A later refusal's ephemeral to a channel now waiting for approval
    // does not go: only the notice of no session that asks for approval may.
    await mention(fixture, "100.000300");
    await refused(3);
    await db.update(surfaceBindings).set({
      surfaceKind: "private_channel",
      status: "pending_approval",
      home: false,
    });
    await outboxPass();
    await outboxPass();
    expect(slack.messages).toHaveLength(2);
    expect(
      (await rows()).map((row) => [row.kind, row.status, row.errorCode]),
    ).toEqual([
      ["failure_notice", "sent", null],
      ["notice", "sent", null],
      ["notice", "failed", "not_addressed"],
    ]);
  });

  test("a reply claimed before its channel began waiting for approval does not start sending", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    const outbox = createPostgresSlackOutboxStore(db);
    const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (!claim) throw new Error("nothing claimed");
    await db.update(surfaceBindings).set({
      surfaceKind: "private_channel",
      status: "pending_approval",
      home: false,
    });
    expect(await outbox.beginSend(claim)).toBe(false);
  });

  // The bot left the private channel: inactive, so nothing goes there.
  const leaveChannel = () =>
    db.update(surfaceBindings).set({
      surfaceKind: "private_channel",
      status: "left",
      home: false,
      approvedAt: null,
      approvedLifecycleUs: null,
    });

  test("a reply to a channel the bot left is not sent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    await leaveChannel();

    expect(await outboxPass()).toMatchObject({ failed: 1, claimed: 0 });
    expect(posted()).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "not_addressed",
    });
  });

  test("a reply claimed before the bot left its channel does not start sending", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    const outbox = createPostgresSlackOutboxStore(db);
    const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (!claim) throw new Error("nothing claimed");
    await leaveChannel();
    expect(await outbox.beginSend(claim)).toBe(false);
  });

  // Slack deleted the channel: inactive like a left one, whatever its kind.
  const deleteChannel = () =>
    db.update(surfaceBindings).set({
      status: "gone",
      home: false,
      approvedAt: null,
      approvedLifecycleUs: null,
    });

  test("a reply to a channel Slack deleted is not sent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    await deleteChannel();

    expect(await outboxPass()).toMatchObject({ failed: 1, claimed: 0 });
    expect(posted()).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "not_addressed",
    });
  });

  test("a reply claimed before its channel was deleted does not start sending", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    const outbox = createPostgresSlackOutboxStore(db);
    const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (!claim) throw new Error("nothing claimed");
    await deleteChannel();
    expect(await outbox.beginSend(claim)).toBe(false);
  });

  test("a thread's status is not set in a channel the bot left", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await outboxPass();
    // The baseline: a status does go out while the bot is in the channel.
    expect(slack.statuses).toEqual([
      { channelId: CHANNEL, threadTs: THREAD, status: "processing" },
    ]);

    // The turn ends, so the status is due to change; the channel is left
    // before that change is sent.
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await leaveChannel();
    await outboxPass();
    expect(slack.statuses).toHaveLength(1);
  });

  test("a notice to a channel the bot left is not sent either, unlike one to a channel waiting for approval", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD, STRANGER);
    await leaveChannel();

    await outboxPass();
    await outboxPass();
    expect(slack.messages).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      kind: "notice",
      status: "failed",
      errorCode: "not_addressed",
    });
  });

  test("rejecting a channel fails the replies still waiting for it, claimed or not", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    const [claimed] = await createPostgresSlackOutboxStore(db).claim({
      limit: 10,
      leaseMs: 30_000,
    });
    if (!claimed) throw new Error("nothing claimed");
    await db.update(surfaceBindings).set({
      surfaceKind: "private_channel",
      status: "pending_approval",
      home: false,
    });
    const [binding] = await db.select().from(surfaceBindings);
    const rejected = await createPostgresSurfaceBindingStore(db).reject({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingId: fixture.bindingId,
      revision: binding?.revision ?? -1,
      approverRoles: ["owner", "admin"],
    });
    expect(rejected.outcome).toBe("resolved");
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "not_addressed",
    });
    expect(posted()).toEqual([]);
  });

  test("a reply made after its channel was rejected is not sent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await db.update(surfaceBindings).set({
      surfaceKind: "private_channel",
      status: "pending_approval",
      home: false,
    });
    const [binding] = await db.select().from(surfaceBindings);
    const rejected = await createPostgresSurfaceBindingStore(db).reject({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingId: fixture.bindingId,
      revision: binding?.revision ?? -1,
      approverRoles: ["owner", "admin"],
    });
    expect(rejected.outcome).toBe("resolved");
    const store = createPostgresSurfaceBindingStore(db);
    expect(
      await store.wasRejected(binding?.installationId ?? "", CHANNEL),
    ).toBe(true);
    expect(
      await store.wasRejected(binding?.installationId ?? "", "C0OTHER"),
    ).toBe(false);

    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    expect(await outboxPass()).toMatchObject({ claimed: 0 });
    expect(posted()).toEqual([]);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "not_addressed",
    });
  });

  test("a channel bound again after a rejection is no longer a rejected one", async () => {
    const fixture = await agentInSlack();
    await db.update(surfaceBindings).set({
      surfaceKind: "private_channel",
      status: "pending_approval",
      home: false,
    });
    const store = createPostgresSurfaceBindingStore(db);
    const [binding] = await db.select().from(surfaceBindings);
    const installationId = binding?.installationId ?? "";
    await store.reject({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingId: fixture.bindingId,
      revision: binding?.revision ?? -1,
      approverRoles: ["owner", "admin"],
    });
    expect(await store.wasRejected(installationId, CHANNEL)).toBe(true);

    const rebound = await store.set({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      channelId: CHANNEL,
      channelKind: "private_channel",
      mode: "on",
      home: false,
      ceiling: DEFAULT_SURFACE_CEILING,
      managerRoles: MANAGERS,
    });
    if (rebound.outcome !== "set") throw new Error(rebound.outcome);
    expect(rebound.binding.status).toBe("pending_approval");
    // Waiting, then approved, then unbound: the old rejection is history.
    expect(await store.wasRejected(installationId, CHANNEL)).toBe(false);
    const approved = await store.approve({
      principal: fixture.owner,
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      bindingId: rebound.binding.id,
      revision: rebound.binding.revision,
      approverRoles: ["owner", "admin"],
    });
    expect(approved.outcome).toBe("resolved");
    await db
      .update(surfaceBindings)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(surfaceBindings.id, rebound.binding.id));
    expect(await store.wasRejected(installationId, CHANNEL)).toBe(false);
  });

  test("each request a turn waits on gets its own card once, with the buttons that settle it", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    const attemptId = `att-${randomUUID()}`;
    await db.insert(attempts).values({
      id: attemptId,
      sessionId,
      executionId: `exec-${attemptId}`,
      leaseEpoch: session.leaseEpoch,
      executionGeneration: session.executionGeneration,
      authRevision: session.authRevision,
      state: "running",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const [turn] = await db
      .update(turns)
      .set({ status: "needs_input", attemptId })
      .where(eq(turns.sessionId, sessionId))
      .returning({ id: turns.id });
    await outboxPass();
    expect(posted()).toEqual([]);

    const ask = (requestId: string, payload: Record<string, unknown>) =>
      db.insert(pendingRequests).values({
        requestId,
        sessionId,
        turnId: turn?.id ?? 0,
        attemptId,
        kind: payload.kind as string,
        payload,
        inputHash: "h",
        expiresAt: new Date(Date.now() + 60_000),
      });
    await ask("toolu:1", {
      kind: "permission",
      tool: "Bash",
      input: { command: "echo <@U0ALL> <!here>" },
    });
    await outboxPass();
    await outboxPass();
    const actionsOf = (message: { options: Record<string, string> }) =>
      (
        JSON.parse(message.options.blocks ?? "[]") as {
          type: string;
          elements?: { action_id?: string; value?: string }[];
        }[]
      )
        .filter((block) => block.type === "actions")
        .flatMap((block) => block.elements ?? []);
    expect(posted()).toHaveLength(1);
    const [card] = posted();
    if (!card) throw new Error("no card");
    expect(actionsOf(card).map((button) => button.action_id)).toEqual([
      "permission.allow",
      "permission.allow_note",
      "permission.deny",
    ]);
    expect(JSON.parse(actionsOf(card)[0]?.value ?? "{}")).toEqual({
      s: sessionId,
      r: "toolu:1",
    });
    expect(card.options.blocks).toContain("rich_text_preformatted");
    expect(card.text).not.toContain("<!here>");
    const cardOf = () =>
      createPostgresSlackOutboxStore(db).promptCard({
        sessionId,
        requestId: "toolu:1",
        channelId: card.channelId,
        slackTs: card.ts,
      });
    const open = await cardOf();
    expect(open).toMatchObject({
      locale: "ko",
      deciderSlackUserId: null,
      display: { kind: "permission", tool: "Bash", state: "open" },
    });
    expect(open?.linkUrl).toStartWith(CONSOLE);
    expect(card.text).toContain(open?.linkUrl ?? "missing");
    expect(
      await createPostgresSlackOutboxStore(db).promptCard({
        sessionId,
        requestId: "toolu:1",
        channelId: card.channelId,
        slackTs: "1.000000",
      }),
    ).toBeNull();
    expect((await rows()).map((row) => [row.kind, row.dedupeKey])).toEqual([
      [
        "input_notice",
        `prompt:${(await db.select().from(sessionLinks))[0]?.id}:toolu:1`,
      ],
    ]);
    // The turn is still going: its status line stays.
    expect(slack.statuses.map((status) => status.status)).not.toContain(
      "active",
    );

    await ask("toolu:2", {
      kind: "question",
      questions: [
        {
          question_id: "q1",
          prompt: "Which branch?",
          options: [
            { option_id: "main", label: "main" },
            { option_id: "dev", label: "dev" },
          ],
          multi_select: false,
          allow_free_text: false,
        },
      ],
    });
    await outboxPass();
    expect(posted()).toHaveLength(2);
    expect(
      actionsOf(posted()[1] ?? card).map((button) => button.action_id),
    ).toEqual(["question.option:0", "question.option:1"]);

    await ask("toolu:3", { kind: "permission", tool: "Read", input: null });
    await outboxPass({ botToken: null });
    await db
      .update(pendingRequests)
      .set({ resolvedAt: new Date() })
      .where(eq(pendingRequests.requestId, "toolu:3"));
    expect(await outboxPass()).toMatchObject({ failed: 1, claimed: 0 });
    expect(posted()).toHaveLength(2);
    expect(
      (await rows()).map((row) => [
        row.dedupeKey.split(":").at(-1),
        row.errorCode,
      ]),
    ).toEqual([
      ["1", null],
      ["2", null],
      ["3", "not_addressed"],
    ]);
  });

  test("a push card carries the sources the session had when the push was asked, not a later turn's", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    const [asked] = await db
      .select({ sources: turns.sources })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    const receiptId = randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: session.ownerId,
      operation: "request_push",
      targetRef: { kind: "session", id: sessionId },
    });
    await db.insert(pushRequests).values({
      id: randomUUID(),
      ownerId: session.ownerId,
      sessionId,
      repositoryId: "sandbox",
      checkpointRevision: 1,
      gitCommit: "a".repeat(40),
      targetBranch: `agent/${sessionId}`,
      state: "requested",
      requestedBy: {
        principal: { kind: "installation", id: "i" },
        actor_user_id: null,
        agent_id: null,
      },
      requestReceiptId: receiptId,
      createdAt: new Date(Date.now() - 60_000),
    });
    // A later post of the thread, after the push was asked.
    await db.insert(turns).values({
      sessionId,
      sequence: 2,
      message: "later",
      status: "queued",
      sources: {
        direct: [{ team_id: TEAM, channel_id: CHANNEL, ts: "100.000900" }],
        inherited: asked?.sources?.direct ?? [],
      },
    });
    await db
      .update(turns)
      .set({ createdAt: new Date(Date.now() - 120_000) })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 1)));
    // A request an intent made takes its turn's sources, none included,
    // though a later turn with sources was there when it was asked.
    const [noSources] = await db
      .insert(turns)
      .values({ sessionId, sequence: 3, message: "quiet", status: "completed" })
      .returning({ id: turns.id });
    const intentReceipt = randomUUID();
    await db.insert(receipts).values({
      id: intentReceipt,
      ownerId: session.ownerId,
      operation: "request_push",
      targetRef: { kind: "session", id: sessionId },
    });
    const byIntent = randomUUID();
    await db.insert(pushRequests).values({
      id: byIntent,
      ownerId: session.ownerId,
      sessionId,
      repositoryId: "sandbox",
      checkpointRevision: 1,
      gitCommit: "b".repeat(40),
      targetBranch: `agent/${sessionId}-intent`,
      state: "requested",
      requestedBy: {
        principal: { kind: "installation", id: "i" },
        actor_user_id: null,
        agent_id: null,
      },
      requestReceiptId: intentReceipt,
    });
    await db.insert(pushIntents).values({
      id: randomUUID(),
      ownerId: session.ownerId,
      sessionId,
      turnId: noSources?.id ?? 0,
      attemptId: "attempt",
      repositoryId: "sandbox",
      targetBranch: `agent/${sessionId}-intent`,
      status: "requested",
      pinnedRevision: 1,
      pushRequestId: byIntent,
      actor: {},
    });
    await outboxPass();
    const cards = (await rows()).filter((row) => row.kind === "input_notice");
    expect(cards.map((row) => row.sources)).toEqual([
      asked?.sources ?? null,
      null,
    ]);
  });

  test("a push request waiting for its decision gets one card, and none once decided", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    const push = async (state: string, branch = "") => {
      const receiptId = randomUUID();
      await db.insert(receipts).values({
        id: receiptId,
        ownerId: session.ownerId,
        operation: "request_push",
        targetRef: { kind: "session", id: sessionId },
      });
      const id = randomUUID();
      await db.insert(pushRequests).values({
        id,
        ownerId: session.ownerId,
        sessionId,
        repositoryId: "sandbox",
        checkpointRevision: 1,
        gitCommit: "a".repeat(40),
        targetBranch: `agent/${sessionId}${branch}`,
        state,
        requestedBy: {
          principal: { kind: "installation", id: "i" },
          actor_user_id: null,
          agent_id: null,
        },
        requestReceiptId: receiptId,
        ...(state === "requested"
          ? {}
          : {
              decidedAt: new Date(),
              decidedBy: { kind: "policy" },
              decisionReceiptId: receiptId,
            }),
      });
      return { id, receiptId };
    };
    const decide = (pushed: { id: string; receiptId: string }) =>
      db
        .update(pushRequests)
        .set({
          state: "rejected",
          decidedAt: new Date(),
          decidedBy: { kind: "policy" },
          decisionReceiptId: pushed.receiptId,
        })
        .where(eq(pushRequests.id, pushed.id));
    const waiting = await push("requested");
    await push("pushed");
    await outboxPass();
    await outboxPass();
    expect(posted()).toHaveLength(1);
    const blocks = JSON.parse(posted()[0]?.options.blocks ?? "[]") as {
      type: string;
      elements?: { action_id?: string; value?: string }[];
      text?: { text?: string };
    }[];
    const buttons = blocks.flatMap((block) =>
      block.type === "actions" ? (block.elements ?? []) : [],
    );
    expect(buttons.map((button) => button.action_id)).toEqual([
      "push.approve",
      "push.reject",
    ]);
    expect(JSON.parse(buttons[0]?.value ?? "{}")).toEqual({
      s: sessionId,
      r: waiting.id,
    });
    expect(JSON.stringify(blocks)).toContain(`agent/${sessionId}`);

    const later = await push("requested", "-later");
    await outboxPass({ botToken: null });
    await decide(later);
    expect(await outboxPass()).toMatchObject({ failed: 1 });
    expect(posted()).toHaveLength(1);
  });

  test("a send Slack took but whose answer cannot be read is never resent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    const live = createSlackBotApi({ apiUrl: slack.url });
    const garbled = {
      ...live,
      postMessage: async () => ({
        httpStatus: 200,
        retryAfterHeader: null,
        body: null,
      }),
    };
    expect(await outboxPass({ slack: garbled })).toMatchObject({
      uncertain: 2,
    });
    expect(
      (await rows()).map((row) => [row.kind, row.status, row.errorCode]),
    ).toEqual([
      ["reply", "uncertain", "unreadable_answer"],
      ["failure_notice", "uncertain", "unreadable_answer"],
    ]);
  });

  test("a reply, and the notice that its send went uncertain, carry the sources of the turn they answer", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("hi")]]);
    const [turn] = await db
      .select({ sources: turns.sources })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    expect(turn?.sources).toMatchObject({
      direct: [{ team_id: TEAM, channel_id: CHANNEL, ts: THREAD }],
      inherited: [],
    });
    const live = createSlackBotApi({ apiUrl: slack.url });
    await outboxPass({
      slack: {
        ...live,
        postMessage: async () => ({
          httpStatus: 200,
          retryAfterHeader: null,
          body: null,
        }),
      },
    });
    expect((await rows()).map((row) => [row.kind, row.sources])).toEqual([
      ["reply", turn?.sources ?? null],
      ["failure_notice", turn?.sources ?? null],
    ]);
  });

  test("a refusal reaches only the person who typed, once per thread", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD, STRANGER);
    await mention(fixture, "100.000200", STRANGER);
    await outboxPass();
    await outboxPass();
    expect(slack.messages).toEqual([
      {
        method: "chat.postEphemeral",
        channelId: CHANNEL,
        threadTs: THREAD,
        userId: STRANGER,
        // A stranger has no language of their own: English.
        text: `${SLACK_NOTICE_MESSAGES.en.connect}\n\n<${CONSOLE}/settings/linked-accounts|${SLACK_OUTBOX_MESSAGES.en.link}>`,
        ts: expect.any(String),
        options: { link_names: "false" },
      },
    ]);
    const [row] = await rows();
    expect(row).toMatchObject({ kind: "notice", status: "sent" });
    // A refusal is no answer: the thread's status is the handler's to set.
    expect(slack.statuses).toEqual([]);
  });

  test("a 429 waits out a clamped Retry-After, then sends once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    slack.rateLimit("chat.postMessage", 86_400);
    expect(await outboxPass()).toMatchObject({ retried: 1, sent: 0 });
    const [waiting] = await db
      .select({
        status: slackOutbox.status,
        errorCode: slackOutbox.errorCode,
        waitMs: sql<number>`extract(epoch from ${slackOutbox.nextAttemptAt} - now()) * 1000`,
      })
      .from(slackOutbox);
    expect(waiting).toMatchObject({
      status: "pending",
      errorCode: "ratelimited",
    });
    expect(Number(waiting?.waitMs)).toBeLessThanOrEqual(
      SLACK_RETRY_AFTER_MAX_MS,
    );
    expect(Number(waiting?.waitMs)).toBeGreaterThan(
      SLACK_RETRY_AFTER_MAX_MS - 60_000,
    );
    expect(await outboxPass()).toMatchObject({ claimed: 0 });

    await db.update(slackOutbox).set({ nextAttemptAt: sql`now()` });
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(posted()).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ status: "sent", attempts: 2 });
  });

  test("a 5xx whose body breaks off mid-read is uncertain, never resent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    const live = createSlackBotApi({ apiUrl: slack.url });
    const broken = createSlackBotApi({
      apiUrl: slack.url,
      fetch: (async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("connection reset"));
            },
          }),
          { status: 503 },
        )) as unknown as typeof fetch,
    });
    const slackApi = { ...live, postMessage: broken.postMessage };
    expect(await outboxPass({ slack: slackApi })).toMatchObject({
      uncertain: 2,
      retried: 0,
    });
    expect(
      (await rows()).map((row) => [row.kind, row.status, row.errorCode]),
    ).toEqual([
      ["reply", "uncertain", "unreadable_answer"],
      ["failure_notice", "uncertain", "unreadable_answer"],
    ]);
  });

  const TABLE_REPLY = [
    "저장소는 2개입니다.",
    "",
    "| 저장소 | 상태 |",
    "| --- | --- |",
    "| acme/web | 기본 저장소 |",
    "| acme/api | 붙일 수 있음 |",
  ].join("\n");

  test("a table block Slack refuses is sent again as the row list", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [
      [text(TABLE_REPLY)],
    ]);
    slack.refusedBlockTypes.add("table");
    expect(await outboxPass()).toMatchObject({ sent: 1, failed: 0 });
    const messages = posted();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.options.blocks).toBeUndefined();
    expect(messages[0]?.text).toContain("*acme/api* — 상태: 붙일 수 있음");
  });

  test("a transient error backs off and fails on the fifth attempt", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    slack.failures.set("chat.postMessage", "internal_error");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await outboxPass();
      const [row] = await db
        .select({
          status: slackOutbox.status,
          attempts: slackOutbox.attempts,
        })
        .from(slackOutbox);
      expect(row?.attempts).toBe(attempt);
      expect(row?.status).toBe(attempt < 5 ? "pending" : "failed");
      await db.update(slackOutbox).set({ nextAttemptAt: sql`now()` });
    }
    expect((await rows())[0]).toMatchObject({ errorCode: "internal_error" });
    expect(slack.statuses.at(-1)).toMatchObject({ status: "active" });
  });

  test("an error no retry clears fails the row at once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    slack.failures.set("chat.postMessage", "not_in_channel");
    expect(await outboxPass()).toMatchObject({ failed: 1 });
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      errorCode: "not_in_channel",
      attempts: 1,
    });
    // A failed row is not sent again, even once Slack would take it.
    slack.failures.clear();
    expect(await outboxPass()).toMatchObject({ sent: 0, failed: 0 });
    expect(posted()).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({
      status: "failed",
      attempts: 1,
    });
  });

  test("a send that outlived its lease is uncertain, never resent, and the thread hears so", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("hi")]]);
    const outbox = createPostgresSlackOutboxStore(db);
    await outboxPass({ botToken: null });
    const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (!claim) throw new Error("nothing claimed");
    expect(await outbox.beginSend(claim)).toMatchObject({
      agentName: "Notes",
    });
    // The pass died mid-send.
    await db
      .update(slackOutbox)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` });

    expect(await outboxPass()).toMatchObject({ uncertain: 1, sent: 1 });
    expect(posted().map((message) => message.text)).toEqual([
      `${SLACK_OUTBOX_MESSAGES.ko.uncertain}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
    ]);
    expect((await rows()).map((row) => [row.kind, row.status])).toEqual([
      ["reply", "uncertain"],
      ["failure_notice", "sent"],
    ]);
    expect(await outbox.settle(claim, { status: "sent", slackTs: "1.2" })).toBe(
      false,
    );
  });

  test("an uncertain reply a pass died before telling about is told once later", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    // As expireSending leaves it, with no notice enqueued after.
    await db
      .update(slackOutbox)
      .set({ status: "uncertain", errorCode: "lease_expired" });

    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(await outboxPass()).toMatchObject({ claimed: 0 });
    expect(posted().map((message) => message.text)).toEqual([
      expect.stringContaining(SLACK_OUTBOX_MESSAGES.ko.uncertain),
    ]);
    expect((await rows()).map((row) => [row.kind, row.status])).toEqual([
      ["reply", "uncertain"],
      ["failure_notice", "sent"],
    ]);
  });

  test("a pass that died after claiming but before sending leaves the row to be sent once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    const outbox = createPostgresSlackOutboxStore(db);
    await outboxPass({ botToken: null });
    const [claim] = await outbox.claim({ limit: 10, leaseMs: 30_000 });
    if (!claim) throw new Error("nothing claimed");
    await db
      .update(slackOutbox)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` });

    expect(await outboxPass()).toMatchObject({ uncertain: 0, sent: 1 });
    expect(posted()).toHaveLength(1);
    expect(await outbox.beginSend(claim)).toBe(false);
  });

  test("claims that never reached Slack spend no attempts", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    const outbox = createPostgresSlackOutboxStore(db);
    await outboxPass({ botToken: null });
    for (let lapse = 0; lapse < 5; lapse += 1) {
      expect(await outbox.claim({ limit: 10, leaseMs: 30_000 })).toHaveLength(
        1,
      );
      await db
        .update(slackOutbox)
        .set({ leaseExpiresAt: sql`now() - interval '1 second'` });
    }
    slack.failures.set("chat.postMessage", "internal_error");
    expect(await outboxPass()).toMatchObject({ retried: 1, failed: 0 });
    expect((await rows())[0]).toMatchObject({
      status: "pending",
      attempts: 1,
    });
  });

  test("two passes at once send each row once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    await outboxPass({ botToken: null });
    const results = await Promise.all([outboxPass(), outboxPass()]);
    expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(1);
    expect(posted()).toHaveLength(1);
  });

  test("a status Slack will not set leaves the answer sent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    slack.failures.set("agents.sessions.setStatus", "not_authorized");
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect((await rows())[0]).toMatchObject({ status: "sent" });
    expect(
      logged.some(
        (record) =>
          record.message === "Slack status not shown" &&
          record.level === "info",
      ),
    ).toBe(true);
  });

  test("without a master key rows wait unsent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    expect(await outboxPass({ botToken: null })).toMatchObject({
      enqueued: 1,
      claimed: 0,
    });
    expect(posted()).toEqual([]);
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("a bot token that will not load fails the row on the fifth attempt", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await outboxPass({ botToken: async () => null });
      expect((await rows())[0]).toMatchObject({
        status: attempt < 5 ? "pending" : "failed",
        errorCode: "no_bot_token",
        attempts: attempt,
      });
      await db.update(slackOutbox).set({ nextAttemptAt: sql`now()` });
    }
    expect(posted()).toEqual([]);
  });

  test("a send with no answer is uncertain; the bot token is in no log line or row", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await endTurn(await sessionOf(fixture), 1, "completed", [[text("hi")]]);
    const down = createSlackBotApi({ apiUrl: "http://127.0.0.1:1/api" });
    expect(await outboxPass({ slack: down })).toMatchObject({ uncertain: 2 });
    expect(
      (await rows()).map((row) => [row.kind, row.status, row.errorCode]),
    ).toEqual([
      ["reply", "uncertain", "unreachable"],
      ["failure_notice", "uncertain", "unreachable"],
    ]);
    await outboxPass();
    expect(posted()).toEqual([]);
    expect(JSON.stringify(logged)).not.toContain(BOT_CREDENTIAL);
    expect(JSON.stringify(await rows())).not.toContain(BOT_CREDENTIAL);
  });

  test("a reply whose send got no answer is never resent, and the thread hears so once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("hi")]]);
    const live = createSlackBotApi({ apiUrl: slack.url });
    let dropped = false;
    const flaky = {
      ...live,
      postMessage: (...args: Parameters<typeof live.postMessage>) => {
        if (dropped) return live.postMessage(...args);
        dropped = true;
        return Promise.reject(
          new SlackApiError("chat.postMessage", "timeout", false),
        );
      },
    };
    expect(await outboxPass({ slack: flaky })).toMatchObject({
      uncertain: 1,
      sent: 1,
    });
    await outboxPass();
    expect(posted().map((message) => message.text)).toEqual([
      `${SLACK_OUTBOX_MESSAGES.ko.uncertain}\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.ko.link}>`,
    ]);
    expect(
      (await rows()).map((row) => [row.kind, row.status, row.errorCode]),
    ).toEqual([
      ["reply", "uncertain", "timeout"],
      ["failure_notice", "sent", null],
    ]);
    expect(JSON.stringify(logged)).not.toContain(BOT_CREDENTIAL);
    expect(JSON.stringify(await rows())).not.toContain(BOT_CREDENTIAL);
  });
});

describe.each(ENGINES)("the Slack thread status on %s", (engine) => {
  useDatabase(engine);
  const W = SLACK_THREAD_STATUS_TIMING.windowMs;
  const LEASE = SLACK_THREAD_STATUS_TIMING.leaseMs;
  const GRACE = SLACK_THREAD_STATUS_TIMING.graceMs;

  const store = () => {
    const found = createPostgresSlackOutboxStore(db).threadStatus;
    if (!found) throw new Error("no thread status store");
    return found;
  };
  const statusRows = () =>
    db
      .select()
      .from(slackThreadStatus)
      .orderBy(asc(slackThreadStatus.sessionLinkId));
  const shown = () => slack.statuses.map((status) => status.status);
  const api = createSlackBotApi({ apiUrl: slack.url });
  const secrets = () => createPostgresSecretStore(db, key);

  // A first setStatus that waits until released, then calls the fake Slack;
  // the order the fake records is the order Slack applied them. Later calls
  // go straight through.
  function heldSlack() {
    const held: { status: string; release: () => Promise<void> }[] = [];
    let calls = 0;
    const slackApi: Pick<SlackBotApi, "setStatus"> = {
      setStatus: (token, input) => {
        calls += 1;
        if (held.length > 0) return api.setStatus(token, input);
        return new Promise<void>((resolve, reject) => {
          held.push({
            status: input.status,
            release: async () => {
              await api.setStatus(token, input).then(resolve, reject);
            },
          });
        });
      },
    };
    return { held, slackApi, calls: () => calls };
  }
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i += 1) await Bun.sleep(10);
    if (!check()) throw new Error("condition never held");
  };
  const writer = (
    overrides: Partial<Parameters<typeof writeSlackThreadStatuses>[0]> = {},
  ) =>
    writeSlackThreadStatuses({
      store: store(),
      slack: api,
      botToken: (workspaceId, slackAppId) =>
        slackBotToken(secrets(), workspaceId, slackAppId),
      logger,
      batchSize: 10,
      deadline: Date.now() + 10_000,
      ...overrides,
    });
  // Moves every clock the rows hold back by `ms`, as if that long passed.
  const elapse = (ms: number) =>
    db.execute(sql`
      UPDATE slack_thread_status SET
        lease_expires_at = lease_expires_at - make_interval(secs => ${ms / 1000}),
        inflight_at = inflight_at - make_interval(secs => ${ms / 1000}),
        uncertain_latest_at = uncertain_latest_at - make_interval(secs => ${ms / 1000}),
        next_at = next_at - make_interval(secs => ${ms / 1000}),
        sent_at = sent_at - make_interval(secs => ${ms / 1000}),
        disabled_at = disabled_at - make_interval(secs => ${ms / 1000})`);

  async function sessionRow(sessionId: string) {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    return session;
  }

  /** A request the session waits on: parked, so no live attempt is needed. */
  async function waitOnPerson(sessionId: string, requestId = "toolu:1") {
    const session = await sessionRow(sessionId);
    const attemptId = `att-${randomUUID()}`;
    await db.insert(attempts).values({
      id: attemptId,
      sessionId,
      executionId: `exec-${attemptId}`,
      leaseEpoch: session.leaseEpoch,
      executionGeneration: session.executionGeneration,
      authRevision: session.authRevision,
      state: "running",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const [turn] = await db
      .update(turns)
      .set({ status: "needs_input", attemptId })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 1)))
      .returning({ id: turns.id });
    await db.insert(pendingRequests).values({
      requestId,
      sessionId,
      turnId: turn?.id ?? 0,
      attemptId,
      kind: "permission",
      payload: { kind: "permission", tool: "Bash", input: {} },
      inputHash: "h",
      expiresAt: new Date(Date.now() + 60_000),
      parkedAt: new Date(),
    });
  }

  async function idleThread() {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("hi")]]);
    return { fixture, sessionId };
  }

  test("the thread shows processing, then suspended on a request, then active; each once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    expect(shown()).toEqual([]);
    expect(await outboxPass()).toMatchObject({ statuses: 1 });
    expect(shown()).toEqual(["processing"]);

    await waitOnPerson(sessionId);
    await outboxPass();
    expect(shown()).toEqual(["processing", "suspended"]);

    await db
      .update(pendingRequests)
      .set({ resolvedAt: new Date(), answeredAt: new Date() });
    await endTurn(sessionId, 1, "completed", [[text("done")]]);
    await outboxPass();
    await outboxPass();
    expect(shown()).toEqual(["processing", "suspended", "active"]);
    expect(slack.statuses.at(-1)).toEqual({
      channelId: CHANNEL,
      threadTs: THREAD,
      status: "active",
    });
  });

  test("an approvable push waits on a person; a decided one does not", async () => {
    const { sessionId } = await idleThread();
    const session = await sessionRow(sessionId);
    await db.update(sessions).set({ checkpointRevision: 1 });
    const receiptId = randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: session.ownerId,
      operation: "request_push",
      targetRef: { kind: "session", id: sessionId },
    });
    const pushId = randomUUID();
    await db.insert(pushRequests).values({
      id: pushId,
      ownerId: session.ownerId,
      sessionId,
      repositoryId: "sandbox",
      checkpointRevision: 1,
      gitCommit: "a".repeat(40),
      targetBranch: `agent/${sessionId}`,
      requestedBy: {
        principal: { kind: "installation", id: "i" },
        actor_user_id: null,
        agent_id: null,
      },
      requestReceiptId: receiptId,
    });
    await outboxPass();
    expect(shown().at(-1)).toBe("suspended");
    // Recovery refuses answers but not push decisions.
    await db.update(sessions).set({ admissionState: "recovery_required" });
    await outboxPass();
    expect(shown().at(-1)).toBe("suspended");
    await db
      .update(pushRequests)
      .set({
        state: "rejected",
        decidedAt: new Date(),
        decidedBy: { kind: "policy" },
        decisionReceiptId: receiptId,
      })
      .where(eq(pushRequests.id, pushId));
    await outboxPass();
    expect(shown().at(-1)).toBe("active");
  });

  test("a late active never lands after the suspended computed later, with two writers", async () => {
    const { sessionId } = await idleThread();
    const first = heldSlack();
    const writing = writer({ slack: first.slackApi });
    await until(() => first.held.length === 1);
    expect(first.held[0]?.status).toBe("active");

    await waitOnPerson(sessionId);
    // The other replica finds the row leased and sends nothing.
    const second = heldSlack();
    expect(await writer({ slack: second.slackApi })).toMatchObject({
      claimed: 0,
    });
    expect(second.calls()).toBe(0);

    await first.held[0]?.release();
    // Its own next turn finds the row dirty again and sends what is now.
    expect(await writing).toMatchObject({ sent: 2 });
    expect(shown()).toEqual(["active", "suspended"]);
    const [row] = await statusRows();
    expect(row).toMatchObject({ sentStatus: "suspended" });
    expect(row?.sentRev).toBe(row?.dirtyRev);

    // Two replicas at once: one sends.
    await db
      .update(pendingRequests)
      .set({ resolvedAt: new Date(), answeredAt: new Date() });
    await endTurn(sessionId, 1, "completed");
    const [replicaA, replicaB] = await Promise.all([writer(), writer()]);
    expect((replicaA?.sent ?? 0) + (replicaB?.sent ?? 0)).toBe(1);
    expect(shown()).toEqual(["active", "suspended", "active"]);
  });

  test("a held send is not taken over before its lease and grace end; after, the latest goes again", async () => {
    const { sessionId } = await idleThread();
    const first = heldSlack();
    const writing = writer({ slack: first.slackApi });
    await until(() => first.held.length === 1);
    await waitOnPerson(sessionId);

    // The lease ran out, the grace has not.
    await elapse(LEASE + GRACE / 2);
    expect(await writer()).toMatchObject({ claimed: 0, expired: 0 });
    expect(shown()).toEqual([]);

    // Past the grace the send's outcome is unknown: recorded, not resent
    // until the window has passed.
    await elapse(GRACE);
    expect(await writer()).toMatchObject({ expired: 1, claimed: 0 });
    expect((await statusRows())[0]).toMatchObject({
      uncertainRev: 1,
      inflightAt: null,
      claimToken: null,
    });
    await elapse(W);
    expect(await writer()).toMatchObject({ sent: 1 });
    expect(shown()).toEqual(["suspended"]);

    // The old call lands late, over the newer one; its fence fails, so the
    // row is uncertain again and the latest goes once more a window later.
    await first.held[0]?.release();
    expect(await writing).toMatchObject({ uncertain: 1 });
    expect(shown()).toEqual(["suspended", "active"]);
    const [row] = await statusRows();
    expect(row?.sentRev).toBe(row?.dirtyRev);
    expect(row?.uncertainLatestAt).not.toBeNull();
    expect(await writer()).toMatchObject({ claimed: 0 });
    await elapse(W);
    expect(await writer()).toMatchObject({ sent: 1 });
    expect(shown()).toEqual(["suspended", "active", "suspended"]);
    expect((await statusRows())[0]).toMatchObject({
      uncertainLatestAt: null,
      nextAt: null,
    });
  });

  test("a writer that died mid-send leaves its row resent a window later, the same value included", async () => {
    await idleThread();
    // The second pass settles the mark the first pass's post left.
    await outboxPass();
    await outboxPass();
    expect(shown()).toEqual(["active"]);
    const [claim] = await store().claim({
      limit: 1,
      leaseMs: LEASE,
      graceMs: GRACE,
    });
    // Nothing is due; force a claim as a writer would on a later change.
    expect(claim).toBeUndefined();
    await db.execute(
      sql`UPDATE slack_thread_status SET dirty_rev = dirty_rev + 1`,
    );
    const [dying] = await store().claim({
      limit: 1,
      leaseMs: LEASE,
      graceMs: GRACE,
    });
    if (!dying) throw new Error("nothing claimed");
    expect(await store().beginSend(dying, 15_000)).not.toBeNull();
    // It dies here; Slack may or may not have taken its call.
    await db.execute(sql`UPDATE slack_thread_status SET sent_rev = dirty_rev`);
    await elapse(LEASE + GRACE + 1_000);
    expect(await writer()).toMatchObject({ expired: 1, sent: 0 });
    await elapse(W);
    expect(await writer()).toMatchObject({ sent: 1 });
    expect(shown()).toEqual(["active", "active"]);
    expect((await statusRows())[0]).toMatchObject({ uncertainLatestAt: null });
  });

  test("timeouts in a row push the resend past the latest; a new one during the resend is kept", async () => {
    await idleThread();
    const timeout: Pick<SlackBotApi, "setStatus"> = {
      setStatus: async () => {
        throw new SlackApiError("agents.sessions.setStatus", "timeout", false);
      },
    };
    expect(await writer({ slack: timeout })).toMatchObject({ uncertain: 1 });
    // Four minutes on a send times out again (the row let go early here):
    // the bound moves to that send + W.
    await elapse(4 * 60_000);
    await db.update(slackThreadStatus).set({ nextAt: sql`now()` });
    expect(await writer({ slack: timeout })).toMatchObject({ uncertain: 1 });
    const { rows: bound } = (await db.execute(
      sql`SELECT uncertain_rev,
            next_at > now() + make_interval(secs => ${W / 1000 - 10}) AS later
          FROM slack_thread_status`,
    )) as unknown as { rows: { uncertain_rev: number; later: boolean }[] };
    expect(bound).toEqual([{ uncertain_rev: 2, later: true }]);
    expect(await writer()).toMatchObject({ claimed: 0 });

    // The resend succeeds while another writer records a new uncertainty:
    // the number moved, so the mark stays.
    await elapse(W);
    const late: Pick<SlackBotApi, "setStatus"> = {
      setStatus: async (token, input) => {
        const [current] = await statusRows();
        await store().uncertain(
          {
            sessionLinkId: current?.sessionLinkId ?? "",
            claimToken: randomUUID(),
          },
          new Date(),
          W,
        );
        await api.setStatus(token, input);
      },
    };
    expect(await writer({ slack: late })).toMatchObject({ sent: 1 });
    expect((await statusRows())[0]?.uncertainLatestAt).not.toBeNull();
  });

  test("a request that expires without a press turns the thread active on the next drain", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await waitOnPerson(sessionId);
    await outboxPass();
    expect(shown()).toEqual(["suspended"]);
    await endTurn(sessionId, 1, "completed");
    await outboxPass();
    expect(shown()).toEqual(["suspended"]);
    // Expiry is a clock, not a write: hide the trigger's mark.
    await db
      .update(pendingRequests)
      .set({ expiresAt: new Date(Date.now() - 1) });
    await db.execute(sql`UPDATE slack_thread_status SET sent_rev = dirty_rev`);
    await outboxPass();
    expect(shown()).toEqual(["suspended", "active"]);
  });

  test("a request parked in recovery shows active; a parked one otherwise suspended", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await waitOnPerson(sessionId);
    await db
      .update(sessions)
      .set({ admissionState: "paused", pauseReason: "awaiting_input" });
    await outboxPass();
    expect(shown()).toEqual(["suspended"]);
    await db.update(sessions).set({ admissionState: "recovery_required" });
    await outboxPass();
    expect(shown()).toEqual(["suspended", "active"]);
  });

  test("120 links are each reconciled once in three drains", async () => {
    const { fixture, sessionId } = await idleThread();
    const columns = async (table: string) =>
      (
        (await db.execute(
          sql`SELECT column_name FROM information_schema.columns
              WHERE table_name = ${table} AND column_name <> 'id'
              ORDER BY ordinal_position`,
        )) as unknown as { rows: { column_name: string }[] }
      ).rows.map(({ column_name }) => `"${column_name}"`);
    const sessionColumns = await columns("sessions");
    const linkColumns = (await columns("session_links")).filter(
      (column) =>
        !['"session_id"', '"surface_ref"', '"thread_id"'].includes(column),
    );
    for (let i = 0; i < 119; i += 1) {
      const id = randomUUID();
      await db.execute(
        sql.raw(`INSERT INTO sessions (id, ${sessionColumns.join(", ")})
          SELECT '${id}', ${sessionColumns.join(", ")} FROM sessions WHERE id = '${sessionId}'`),
      );
      await db.execute(
        sql.raw(`INSERT INTO session_links (id, session_id, surface_ref, thread_id, ${linkColumns.join(", ")})
          SELECT gen_random_uuid(), '${id}', '${CHANNEL}:${200 + i}.0', '${200 + i}.0', ${linkColumns.join(", ")}
          FROM session_links WHERE session_id = '${sessionId}'`),
      );
    }
    void fixture;
    await db.delete(slackThreadStatus);
    const passes = [];
    for (let i = 0; i < 3; i += 1) {
      passes.push(await reconcileSlackThreadStatuses({ store: store() }));
    }
    // Unreconciled first: the third pass takes the last 20, then the oldest.
    expect(passes.map((pass) => pass.checked)).toEqual([50, 50, 50]);
    const stamped = await statusRows();
    expect(stamped).toHaveLength(120);
    expect(stamped.every((row) => row.reconciledAt !== null)).toBe(true);
  });

  test("a push intent or a pull request stage change marks the thread status due", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    const [turn] = await db
      .select({ id: turns.id })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    if (!session || !turn) throw new Error("no session or turn");
    const dirty = async () => (await statusRows())[0]?.dirtyRev ?? 0;
    const intentId = randomUUID();
    let before = await dirty();
    await db.insert(pushIntents).values({
      id: intentId,
      ownerId: session.ownerId,
      sessionId,
      turnId: turn.id,
      attemptId: "attempt-1",
      repositoryId: "sandbox",
      targetBranch: `agent/${sessionId}`,
      status: "deferred",
      actor: {
        principal: { kind: "api_key", id: "k" },
        actor_user_id: null,
        agent_id: null,
      },
      approvalBasis: "push.primary",
      policySource: "agent",
    });
    expect(await dirty()).toBeGreaterThan(before);
    before = await dirty();
    await db
      .update(pushIntents)
      .set({ status: "cancelled", refusalCode: "session_closed" })
      .where(eq(pushIntents.id, intentId));
    expect(await dirty()).toBeGreaterThan(before);
  });

  test("processing is sent again after 50 minutes, before Slack drops it", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await outboxPass();
    await outboxPass();
    expect(shown()).toEqual(["processing"]);
    await elapse(51 * 60_000);
    await db.update(slackThreadStatus).set({ reconciledAt: null });
    await outboxPass();
    expect(shown()).toEqual(["processing", "processing"]);
  });

  test("a status Slack will not show stops nothing and is not asked again until a day passes or the app is verified again", async () => {
    const { sessionId } = await idleThread();
    slack.failures.set("agents.sessions.setStatus", "not_authorized");
    let calls = 0;
    const counting = {
      ...api,
      setStatus: (...args: Parameters<SlackBotApi["setStatus"]>) => {
        calls += 1;
        return api.setStatus(...args);
      },
    };
    expect(await outboxPass({ slack: counting })).toMatchObject({ sent: 1 });
    expect(calls).toBe(1);
    expect((await statusRows())[0]).toMatchObject({
      disabledReason: "not_authorized",
    });
    await askFrom(sessionId, 2, "web", "more", true);
    await outboxPass({ slack: counting });
    await outboxPass({ slack: counting });
    expect(calls).toBe(1);

    await elapse(24 * 60 * 60_000 + 1_000);
    await outboxPass({ slack: counting });
    expect(calls).toBe(2);
    await db.execute(
      sql`UPDATE slack_installations SET verified_at = now() + interval '1 second'`,
    );
    await outboxPass({ slack: counting });
    expect(calls).toBe(3);

    // Any other failure only delays the status; the answers still go.
    slack.failures.set("agents.sessions.setStatus", "internal_error");
    await endTurn(sessionId, 2, "completed", [[text("ok")]]);
    await db.update(slackThreadStatus).set({ nextAt: null });
    expect(await outboxPass({ slack: counting })).toMatchObject({
      statuses: 0,
    });
    expect(calls).toBe(4);
    expect(posted().map((message) => message.text.split("\n")[0])).toContain(
      "ok",
    );
    expect((await statusRows())[0]?.disabledReason).toBeNull();
  });

  test("a rate-limited status waits out Slack's Retry-After, not the shorter retry", async () => {
    await idleThread();
    slack.rateLimit("agents.sessions.setStatus", 120);
    expect(await outboxPass()).toMatchObject({ statuses: 0 });
    expect(shown()).toEqual([]);
    await elapse(31_000);
    await outboxPass();
    expect(shown()).toEqual([]);
    await elapse(90_000);
    await outboxPass();
    expect(shown()).toEqual(["active"]);
  });

  test("on a statuses-first pass a backlog of posts neither holds back the statuses nor runs more than one post past the deadline", async () => {
    const { sessionId } = await idleThread();
    for (const sequence of [2, 3]) {
      await askFrom(sessionId, sequence, "web", "more", true);
      await endTurn(sessionId, sequence, "completed", [[text("ok")]]);
    }
    const start = Date.now();
    let clock = start;
    const slow = {
      ...api,
      // Each post takes ten seconds of the pass.
      postMessage: (...args: Parameters<typeof api.postMessage>) => {
        clock += 10_000;
        return api.postMessage(...args);
      },
    };
    await outboxPass({
      slack: slow,
      deadline: start + 12_000,
      statusesFirst: true,
      now: () => clock,
    });
    expect(shown()).toEqual(["active"]);
    expect(posted()).toHaveLength(2);
    expect(clock - start).toBe(20_000);
    // The third is still pending, for a pass once its lease runs out.
    const { rows } = (await db.execute(
      sql`SELECT count(*)::int AS n FROM slack_outbox WHERE status = 'pending'`,
    )) as unknown as { rows: { n: number }[] };
    expect(rows[0]?.n).toBe(1);
  });

  test("a slow status that eats a short window leaves the posts to the next, posts-first pass", async () => {
    await idleThread();
    const start = Date.now();
    let clock = start;
    const slowStatus = {
      ...api,
      setStatus: (...args: Parameters<typeof api.setStatus>) => {
        clock += 10_000;
        return api.setStatus(...args);
      },
    };
    const pass = (statusesFirst: boolean) =>
      outboxPass({
        slack: slowStatus,
        deadline: clock + 3_000,
        statusesFirst,
        now: () => clock,
      });
    await pass(true);
    expect(shown()).toEqual(["active"]);
    expect(posted()).toHaveLength(0);
    // Due again, so a statuses-first pass would spend the window once more.
    await db.execute(
      sql`UPDATE slack_thread_status SET dirty_rev = dirty_rev + 1, sent_status = NULL`,
    );
    await pass(false);
    expect(posted()).toHaveLength(1);
  });

  test("a status row reached after the deadline is handed back, not sent late", async () => {
    const { sessionId } = await idleThread();
    // A copy of the session in a second thread.
    const columns = async (table: string, skip: string[]) =>
      (
        (await db.execute(
          sql`SELECT column_name FROM information_schema.columns
              WHERE table_name = ${table}`,
        )) as unknown as { rows: { column_name: string }[] }
      ).rows
        .map(({ column_name }) => column_name)
        .filter((column) => !skip.includes(column))
        .map((column) => `"${column}"`)
        .join(", ");
    const copy = randomUUID();
    const sessionRest = await columns("sessions", ["id"]);
    const linkRest = await columns("session_links", [
      "id",
      "session_id",
      "surface_ref",
      "thread_id",
    ]);
    await db.execute(
      sql.raw(`INSERT INTO sessions (id, ${sessionRest})
        SELECT '${copy}', ${sessionRest} FROM sessions WHERE id = '${sessionId}'`),
    );
    await db.execute(
      sql.raw(`INSERT INTO session_links (id, session_id, surface_ref, thread_id, ${linkRest})
        SELECT gen_random_uuid(), '${copy}', '${CHANNEL}:300.0', '300.0', ${linkRest}
        FROM session_links WHERE session_id = '${sessionId}'`),
    );
    expect(await statusRows()).toHaveLength(2);
    let late = false;
    const deadline = Date.now() + 10_000;
    const lateSlack = {
      ...api,
      setStatus: (...args: Parameters<SlackBotApi["setStatus"]>) => {
        late = true;
        return api.setStatus(...args);
      },
    };
    const pass = await writer({
      slack: lateSlack,
      deadline,
      now: () => (late ? deadline : Date.now()),
    });
    expect(pass).toMatchObject({ sent: 1, deferred: 1 });
    expect(shown()).toHaveLength(1);
    expect((await statusRows()).every((row) => row.claimToken === null)).toBe(
      true,
    );
    await writer();
    expect(shown()).toHaveLength(2);
  });

  test("each write that changes the session's state marks its thread due when it commits", async () => {
    const { sessionId } = await idleThread();
    await outboxPass();
    const rev = async () => Number((await statusRows())[0]?.dirtyRev);
    let last = await rev();
    const raised = async () => {
      const now = await rev();
      const moved = now > last;
      last = now;
      return moved;
    };
    await addTurn(sessionId, 2);
    expect(await raised()).toBe(true);
    await waitOnPerson(sessionId);
    expect(await raised()).toBe(true);
    await db.update(pendingRequests).set({ resolvedAt: new Date() });
    expect(await raised()).toBe(true);
    await endTurn(sessionId, 2, "completed");
    expect(await raised()).toBe(true);
    await db.update(sessions).set({ admissionState: "paused" });
    expect(await raised()).toBe(true);
    await db.update(sessions).set({ checkpointRevision: 7 });
    expect(await raised()).toBe(true);
    await db
      .update(sessions)
      .set({ executionRevokedAt: new Date(), executionRevokedReason: "test" });
    expect(await raised()).toBe(true);
    await db.update(sessionLinks).set({ muted: true });
    expect(await raised()).toBe(true);
    // No send in between: the writer reads the state once, at the end.
    expect(shown()).toEqual(["active"]);
  });

  test("a rolled-back write marks nothing; an unrelated session update marks nothing", async () => {
    const { sessionId } = await idleThread();
    await outboxPass();
    const before = (await statusRows())[0]?.dirtyRev;
    await db
      .transaction(async (tx) => {
        await tx
          .update(sessions)
          .set({ admissionState: "paused" })
          .where(eq(sessions.id, sessionId));
        throw new Error("rollback");
      })
      .catch(() => {});
    await db
      .update(sessions)
      .set({ revision: sql`${sessions.revision} + 1` })
      .where(eq(sessions.id, sessionId));
    expect((await statusRows())[0]?.dirtyRev).toBe(before);
  });
});

describe.each(ENGINES)("the Slack card settle on %s", (engine) => {
  useDatabase(engine);
  beforeEach(() => {
    slack.updates.length = 0;
  });
  const W = SLACK_CARD_SETTLE_TIMING.windowMs;
  const LEASE = SLACK_CARD_SETTLE_TIMING.leaseMs;
  const GRACE = SLACK_CARD_SETTLE_TIMING.graceMs;
  const api = createSlackBotApi({ apiUrl: slack.url });
  const secrets = () => createPostgresSecretStore(db, key);

  const cards = () => {
    const found = createPostgresSlackOutboxStore(db).cards;
    if (!found) throw new Error("no card store");
    return found;
  };
  const settler = (
    overrides: Partial<Parameters<typeof settleSlackCards>[0]> = {},
  ) =>
    settleSlackCards({
      store: cards(),
      slack: api,
      botToken: (workspaceId, slackAppId) =>
        slackBotToken(secrets(), workspaceId, slackAppId),
      logger,
      batchSize: 20,
      deadline: Date.now() + 10_000,
      ...overrides,
    });
  const cardRow = async () => {
    const [row] = await db
      .select()
      .from(slackOutbox)
      .where(eq(slackOutbox.kind, "input_notice"))
      .orderBy(asc(slackOutbox.seq));
    if (!row) throw new Error("no card row");
    return row;
  };
  // Moves every clock the card rows hold back by `ms`, as if that long passed.
  const elapse = (ms: number) =>
    db.execute(sql`
      UPDATE slack_outbox SET
        settle_lease_expires_at = settle_lease_expires_at - make_interval(secs => ${ms / 1000}),
        settle_inflight_at = settle_inflight_at - make_interval(secs => ${ms / 1000}),
        settle_uncertain_latest_at = settle_uncertain_latest_at - make_interval(secs => ${ms / 1000}),
        settle_next_at = settle_next_at - make_interval(secs => ${ms / 1000})`);
  type Block = {
    type: string;
    text?: { text: string };
    elements?: { type: string; text?: string; action_id?: string }[];
  };
  const updated = () =>
    slack.updates.map((update) => ({
      ts: update.ts,
      text: update.text,
      blocks: update.blocks as Block[],
    }));
  const lines = (blocks: Block[]) =>
    blocks.map(
      (block) =>
        block.text?.text ??
        block.elements
          ?.map((element) =>
            typeof element.text === "string" ? element.text : element.action_id,
          )
          .join(" | "),
    );

  /** A session waiting on `requestId`, its card posted. */
  async function cardThread(
    payload: Record<string, unknown> = {
      kind: "permission",
      tool: "Bash",
      input: { command: "npm test" },
    },
  ) {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    const attemptId = `att-${randomUUID()}`;
    await db.insert(attempts).values({
      id: attemptId,
      sessionId,
      executionId: `exec-${attemptId}`,
      leaseEpoch: session.leaseEpoch,
      executionGeneration: session.executionGeneration,
      authRevision: session.authRevision,
      state: "running",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const [turn] = await db
      .update(turns)
      .set({ status: "needs_input", attemptId })
      .where(eq(turns.sessionId, sessionId))
      .returning({ id: turns.id, actorId: turns.actorId });
    await db.insert(pendingRequests).values({
      requestId: "toolu:1",
      sessionId,
      turnId: turn?.id ?? 0,
      attemptId,
      kind: payload.kind as string,
      payload,
      inputHash: "h",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await outboxPass();
    await outboxPass();
    const [card] = posted();
    if (!card) throw new Error("no card posted");
    return { fixture, sessionId, session, card, actorId: turn?.actorId ?? "" };
  }

  /** What the web answer path writes: the person, from the web surface. */
  const answerOn = (
    surface: "web" | "slack",
    userId: string,
    answer: Record<string, unknown>,
  ) =>
    db
      .update(pendingRequests)
      .set({
        answer,
        answeredAt: new Date(),
        resolvedAt: new Date(),
        answerSurface: surface,
        answerDecisionId: randomUUID(),
        answeredBy: {
          principal:
            surface === "web"
              ? { kind: "user", id: userId }
              : { kind: "installation", id: randomUUID() },
          actor_user_id: userId,
          agent_id: null,
        },
      })
      .where(eq(pendingRequests.requestId, "toolu:1"));

  test("a permission allowed on the web: the next pass turns its Slack card into one line, once", async () => {
    const { card, actorId } = await cardThread();
    // An open card is no target, however many passes run.
    await outboxPass();
    await outboxPass();
    expect(updated()).toEqual([]);
    expect(await cardRow()).toMatchObject({
      settleRendered: "open",
      settleState: null,
    });

    await answerOn("web", actorId, { decision: "allow" });
    expect(await outboxPass()).toMatchObject({ cards: 1 });
    await outboxPass();
    expect(updated()).toHaveLength(1);
    const [update] = updated();
    expect(update?.ts).toBe(card.ts);
    expect(lines(update?.blocks ?? [])).toEqual([
      `:white_check_mark: *웹에서 허용됨* · <@${PERSON}> | 명령 실행: npm test | <${CONSOLE}/sessions/${(await cardRow()).sessionId}|웹에서 열기>`,
    ]);
    expect(JSON.stringify(update?.blocks)).not.toContain("permission.allow");
    expect(update?.text).toStartWith(`*웹에서 허용됨* · <@${PERSON}>`);
    expect(await cardRow()).toMatchObject({
      settleRendered: "allowed",
      settleState: "settled",
    });
  });

  test("a question answered on the web keeps its text with `웹에서 <label> 선택됨 · who`; a typed answer shows only as 직접 입력", async () => {
    const { actorId } = await cardThread({
      kind: "question",
      questions: [
        {
          question_id: "q1",
          prompt: "README 한국어 PR을 어떤 방식으로 진행할까요?",
          options: [
            { option_id: "main", label: "main에서 새 브랜치 (Recommended)" },
            { option_id: "here", label: "현재 브랜치에서 작업" },
          ],
          multi_select: false,
          allow_free_text: true,
        },
      ],
    });
    await answerOn("web", actorId, {
      answers: [
        {
          question_id: "q1",
          selected_option_ids: ["main"],
          free_text: "secret plan",
        },
      ],
    });
    await outboxPass();
    const [update] = updated();
    expect(lines(update?.blocks ?? [])).toEqual([
      "README 한국어 PR을 어떤 방식으로 진행할까요?",
      `:speech_balloon: | 웹에서 main에서 새 브랜치 (Recommended), 직접 입력 선택됨 | · <@${PERSON}> | <${CONSOLE}/sessions/${(await cardRow()).sessionId}|웹에서 열기>`,
    ]);
    expect(JSON.stringify(update)).not.toContain("secret plan");
    expect(await cardRow()).toMatchObject({ settleRendered: "answered" });
  });

  test("an answer pressed in Slack draws the same card without 웹에서, and the drain leaves it", async () => {
    const { card, actorId } = await cardThread();
    await answerOn("slack", actorId, { decision: "deny" });
    // The press path: mark its own card, draw it now.
    expect(
      await cards().markDueAt({ channelId: CHANNEL, slackTs: card.ts }),
    ).toBe(true);
    expect(
      await settler({ only: { channelId: CHANNEL, slackTs: card.ts } }),
    ).toMatchObject({ sent: 1 });
    expect(lines(updated()[0]?.blocks ?? [])[0]).toStartWith(
      `:no_entry_sign: *거부됨* · <@${PERSON}>`,
    );
    await outboxPass();
    // Pressed again after it settled: drawn the same, so nothing is sent.
    await cards().markDueAt({ channelId: CHANNEL, slackTs: card.ts });
    expect(
      await settler({ only: { channelId: CHANNEL, slackTs: card.ts } }),
    ).toMatchObject({ sent: 0, skipped: 1 });
    expect(updated()).toHaveLength(1);
  });

  test("a backlog of thread statuses leaves the cards half the window", async () => {
    const { sessionId } = await cardThread();
    // Three copies of the session in threads of their own, each status due.
    const columns = async (table: string, skip: string[]) =>
      (
        (await db.execute(
          sql`SELECT column_name FROM information_schema.columns
              WHERE table_name = ${table}`,
        )) as unknown as { rows: { column_name: string }[] }
      ).rows
        .map(({ column_name }) => column_name)
        .filter((column) => !skip.includes(column))
        .map((column) => `"${column}"`)
        .join(", ");
    const sessionRest = await columns("sessions", ["id"]);
    const linkRest = await columns("session_links", [
      "id",
      "session_id",
      "surface_ref",
      "thread_id",
    ]);
    for (const n of [1, 2, 3]) {
      const copy = randomUUID();
      await db.execute(
        sql.raw(`INSERT INTO sessions (id, ${sessionRest})
          SELECT '${copy}', ${sessionRest} FROM sessions WHERE id = '${sessionId}'`),
      );
      await db.execute(
        sql.raw(`INSERT INTO session_links (id, session_id, surface_ref, thread_id, ${linkRest})
          SELECT gen_random_uuid(), '${copy}', '${CHANNEL}:30${n}.0', '30${n}.0', ${linkRest}
          FROM session_links WHERE session_id = '${sessionId}'`),
      );
    }
    await answerOn("web", randomUUID(), { decision: "allow" });
    const start = Date.now();
    let clock = start;
    let statuses = 0;
    const slowStatus = {
      ...api,
      // Each status takes a second of the pass.
      setStatus: (...args: Parameters<typeof api.setStatus>) => {
        clock += 1_000;
        statuses += 1;
        return api.setStatus(...args);
      },
    };
    // The statuses-first step gets the first 4s of a 12s pass; the statuses
    // stop at 2s, and the card goes in the 2s left.
    await outboxPass({
      slack: slowStatus,
      deadline: start + 12_000,
      statusesFirst: true,
      now: () => clock,
    });
    expect(statuses).toBe(2);
    expect(updated()).toHaveLength(1);
  });

  test("expiry settles a card no one pressed", async () => {
    const first = await cardThread();
    await db
      .update(pendingRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    await outboxPass();
    expect(lines(updated()[0]?.blocks ?? [])[0]).toStartWith(
      ":hourglass: *만료됨* |",
    );
    expect(first.card.ts).toBe(updated()[0]?.ts ?? "");
  });

  test("a closed session settles a card no one pressed", async () => {
    const first = await cardThread();
    // What close-control writes: the session closed, its requests resolved.
    await db.update(sessions).set({ admissionState: "closed" });
    await db.update(pendingRequests).set({ resolvedAt: new Date() });
    await outboxPass();
    expect(updated()).toHaveLength(1);
    expect(first.card.ts).toBe(updated()[0]?.ts ?? "");
    expect(lines(updated()[0]?.blocks ?? [])[0]).toContain(
      "*더 이상 답할 수 없어요*",
    );
    expect(await cardRow()).toMatchObject({
      settleRendered: "closed",
      settleState: "settled",
    });
  });

  test("a card posted before the settle columns, whose request since expired, settles on the first pass", async () => {
    await cardThread();
    await db.update(slackOutbox).set({ settleRendered: null });
    await db
      .update(pendingRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) });
    await outboxPass();
    expect(updated()).toHaveLength(1);
    expect(await cardRow()).toMatchObject({
      settleRendered: "expired",
      settleState: "settled",
    });
  });

  test("a request parked in recovery keeps its card's buttons", async () => {
    await cardThread();
    await db.update(pendingRequests).set({ parkedAt: new Date() });
    await db.update(sessions).set({ admissionState: "recovery_required" });
    await outboxPass();
    await outboxPass();
    expect(updated()).toEqual([]);
  });

  test("a push decided on the web, and one decided in Slack, each name their path", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    const [actor] = await db
      .select({ id: turns.actorId })
      .from(turns)
      .where(eq(turns.sessionId, sessionId));
    const push = async (branch: string) => {
      const receiptId = randomUUID();
      await db.insert(receipts).values({
        id: receiptId,
        ownerId: session.ownerId,
        operation: "request_push",
        targetRef: { kind: "session", id: sessionId },
      });
      const id = randomUUID();
      await db.insert(pushRequests).values({
        id,
        ownerId: session.ownerId,
        sessionId,
        repositoryId: "sandbox",
        checkpointRevision: 1,
        gitCommit: "a".repeat(40),
        targetBranch: `agent/${sessionId}-${branch}`,
        requestedBy: {
          principal: { kind: "installation", id: "i" },
          actor_user_id: null,
          agent_id: null,
        },
        requestReceiptId: receiptId,
      });
      return { id, receiptId };
    };
    const web = await push("web");
    const pressed = await push("slack");
    await outboxPass();
    await outboxPass();
    expect(posted()).toHaveLength(2);
    for (const [pushed, principal] of [
      [web, { kind: "user", id: actor?.id }],
      [pressed, { kind: "installation", id: randomUUID() }],
    ] as const) {
      await db
        .update(pushRequests)
        .set({
          state: "approved",
          decidedAt: new Date(),
          decidedBy: {
            principal,
            actor_user_id: actor?.id ?? null,
            agent_id: null,
          },
          decisionReceiptId: pushed.receiptId,
        })
        .where(eq(pushRequests.id, pushed.id));
    }
    await outboxPass();
    expect(
      updated()
        .map((update) => lines(update.blocks)[0]?.split(" | ")[0])
        .sort(),
    ).toEqual([
      `:white_check_mark: *push 승인됨* · <@${PERSON}>`,
      `:white_check_mark: *웹에서 push 승인됨* · <@${PERSON}>`,
    ]);
  });

  test("a push the checkpoint moved past keeps only Reject; back on its commit, the buttons return; rejected, one line", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    await db.update(sessions).set({ checkpointRevision: 1 });
    const receiptId = randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: session.ownerId,
      operation: "request_push",
      targetRef: { kind: "session", id: sessionId },
    });
    const pushId = randomUUID();
    await db.insert(pushRequests).values({
      id: pushId,
      ownerId: session.ownerId,
      sessionId,
      repositoryId: "sandbox",
      checkpointRevision: 1,
      gitCommit: "a".repeat(40),
      targetBranch: `agent/${sessionId}`,
      requestedBy: {
        principal: { kind: "installation", id: "i" },
        actor_user_id: null,
        agent_id: null,
      },
      requestReceiptId: receiptId,
    });
    await outboxPass();
    await outboxPass();
    const [card] = posted();
    if (!card) throw new Error("no card");
    let latest = "b".repeat(40);
    const pushSource = {
      readPushSource: async () => ({
        status: "ready",
        revision: 2,
        gitCommit: latest,
      }),
    } as unknown as PushSource;
    await db.update(sessions).set({ checkpointRevision: 2 });
    // A source of the same commit at another revision is still approvable.
    latest = "a".repeat(40);
    await settler({ pushSource });
    expect(updated()).toEqual([]);

    latest = "b".repeat(40);
    await settler({ pushSource });
    expect(lines(updated()[0]?.blocks ?? [])).toEqual([
      ":warning: *새 커밋이 생겨 이 push는 승인할 수 없어요* | sandbox ← aaaaaaa",
      "push.reject",
    ]);
    expect(await cardRow()).toMatchObject({
      settleRendered: "reject_only",
      settleState: null,
    });

    latest = "a".repeat(40);
    await settler({ pushSource });
    expect(updated()[1]?.blocks).toEqual(
      JSON.parse(card.options.blocks ?? "[]"),
    );
    expect(await cardRow()).toMatchObject({ settleRendered: "open" });

    await db
      .update(pushRequests)
      .set({
        state: "rejected",
        decidedAt: new Date(),
        decidedBy: { kind: "policy" },
        decisionReceiptId: receiptId,
      })
      .where(eq(pushRequests.id, pushId));
    await settler({ pushSource });
    expect(lines(updated()[2]?.blocks ?? [])[0]).toStartWith(
      ":no_entry_sign: *push 거절됨*",
    );
    expect(await cardRow()).toMatchObject({ settleState: "settled" });
  });

  test("a push whose requester left the private channel says so and keeps its buttons; back in, the line goes (94S-2000)", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    const receiptId = randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: session.ownerId,
      operation: "request_push",
      targetRef: { kind: "session", id: sessionId },
    });
    await db.insert(pushRequests).values({
      id: randomUUID(),
      ownerId: session.ownerId,
      sessionId,
      repositoryId: "sandbox",
      checkpointRevision: 1,
      gitCommit: "a".repeat(40),
      targetBranch: `agent/${sessionId}`,
      requestedBy: {
        principal: { kind: "installation", id: "i" },
        actor_user_id: null,
        agent_id: null,
      },
      requestReceiptId: receiptId,
    });
    let left = true;
    const requesterLeft = async () => left;
    // The requester left before the card went out: the same pass draws it
    // again at once.
    await outboxPass({ requesterLeft });
    await outboxPass({ requesterLeft });
    const [card] = posted();
    if (!card) throw new Error("no card");
    const row = await cardRow();
    const here = {
      installationId: row.installationId,
      channelId: row.channelId,
      windowMs: W,
    };
    const drawn = lines(updated()[0]?.blocks ?? []);
    const buttons = drawn.findIndex((line) => line?.includes("push.reject"));
    expect(drawn[buttons - 1]).toBe(
      ":information_source: 요청자가 채널을 나갔어요",
    );
    // Still a choice: not settled, and the next member change finds it.
    expect(await cardRow()).toMatchObject({
      settleRendered: "open_requester_left",
      settleState: null,
    });

    // Back in: a member change elsewhere leaves the card; one in its channel
    // redraws it without the line.
    left = false;
    expect(
      await cards().markChoiceCardsDueIn({ ...here, channelId: "C0OTHER" }),
    ).toBe(0);
    expect(await cards().markChoiceCardsDueIn(here)).toBe(1);
    await settler({ requesterLeft });
    expect(updated()[1]?.blocks).toEqual(
      JSON.parse(card.options.blocks ?? "[]"),
    );
    expect(await cardRow()).toMatchObject({
      settleRendered: "open",
      settleState: null,
    });

    // A change while the card is being drawn: that edit may have read the
    // old membership, so finishing it leaves the card owed a window later.
    expect(await cards().markChoiceCardsDueIn(here)).toBe(1);
    const [claim] = await cards().claim({
      limit: 1,
      leaseMs: LEASE,
      graceMs: GRACE,
      only: { channelId: row.channelId, slackTs: row.slackTs ?? "" },
    });
    if (!claim) throw new Error("no claim");
    expect(await cards().markChoiceCardsDueIn(here)).toBe(1);
    expect(await cards().beginSend(claim, 0)).not.toBeNull();
    expect(
      await cards().finish(claim, {
        rendered: "open",
        uncertainRev: claim.uncertainRev,
        windowMs: W,
      }),
    ).toBe(true);
    const after = await cardRow();
    expect(after.settleUncertainLatestAt).not.toBeNull();
    expect(after.settleNextAt).not.toBeNull();

    // The other order: a redraw that finished just before the change leaves
    // the card idle, and the change marks it due.
    await db
      .update(slackOutbox)
      .set({
        settleState: "due",
        settleUncertainLatestAt: null,
        settleNextAt: null,
      })
      .where(eq(slackOutbox.id, row.id));
    const [again] = await cards().claim({
      limit: 1,
      leaseMs: LEASE,
      graceMs: GRACE,
      only: { channelId: row.channelId, slackTs: row.slackTs ?? "" },
    });
    if (!again) throw new Error("no claim");
    expect(await cards().beginSend(again, 0)).not.toBeNull();
    await cards().finish(again, {
      rendered: "open",
      uncertainRev: again.uncertainRev,
      windowMs: W,
    });
    expect(await cardRow()).toMatchObject({ settleState: null });
    expect(await cards().markChoiceCardsDueIn(here)).toBe(1);
    expect(await cardRow()).toMatchObject({ settleState: "due" });
  });

  test("a tool permission card whose requester left says so and keeps its session button; a member change in its channel redraws it (94S-2175)", async () => {
    const { sessionId, card } = await cardThread({
      kind: "permission",
      tool: "Bash",
      input: { command: "npm test" },
      remember_offer: [{ tool_name: "Bash", rule_content: "npm test" }],
    });
    // The requester's own card offers the session-wide allow.
    expect(card.options.blocks ?? "").toContain("이 세션 동안 허용");
    const row = await cardRow();
    const here = {
      installationId: row.installationId,
      channelId: row.channelId,
      windowMs: W,
    };
    const asked: unknown[] = [];
    let left = true;
    const requesterLeft = async (request: unknown) => {
      asked.push(request);
      return left;
    };
    expect(await cards().markChoiceCardsDueIn(here)).toBe(1);
    await settler({ requesterLeft });
    expect(asked).toEqual([
      expect.objectContaining({ sessionId, pendingRequestId: "toolu:1" }),
    ]);
    const drawn = JSON.stringify(updated().at(-1)?.blocks ?? []);
    expect(drawn).toContain(":information_source: 요청자가 채널을 나갔어요");
    // A member's session allow is bound to that member, as anyone's.
    expect(drawn).toContain("이 세션 동안 허용");
    expect(await cardRow()).toMatchObject({
      settleRendered: "open_requester_left",
      settleState: null,
    });

    // Back in: the card as posted.
    left = false;
    expect(await cards().markChoiceCardsDueIn(here)).toBe(1);
    await settler({ requesterLeft });
    expect(updated().at(-1)?.blocks).toEqual(
      JSON.parse(card.options.blocks ?? "[]"),
    );
    expect(await cardRow()).toMatchObject({ settleRendered: "open" });
  });

  test("a turn's notice from before the cards ends as one handled line once its turn waits no more", async () => {
    const { sessionId, actorId } = await cardThread();
    const row = await cardRow();
    const { id: _, seq: __, ...copy } = row;
    await db.insert(slackOutbox).values({
      ...copy,
      id: randomUUID(),
      dedupeKey: `input:${row.dedupeKey.split(":")[1]}:1`,
      slackTs: "200.000200",
      body: { text: "old notice", locale: "en", link_url: `${CONSOLE}/x` },
    });
    await answerOn("web", actorId, { decision: "allow" });
    await db
      .update(turns)
      .set({ status: "completed" })
      .where(eq(turns.sessionId, sessionId));
    await outboxPass();
    const old = updated().find((update) => update.ts === "200.000200");
    expect(lines(old?.blocks ?? [])).toEqual([
      `:white_circle: *Handled* | <${CONSOLE}/x|Open on the web>`,
    ]);
  });

  test("Slack errors: gone → abandoned, rate limit defers uncounted, refused blocks retried as text, five failures → abandoned", async () => {
    const { actorId } = await cardThread();
    await answerOn("web", actorId, { decision: "allow" });

    slack.rateLimit("chat.update", 120);
    expect(await settler()).toMatchObject({ deferred: 1, sent: 0 });
    const limited = await cardRow();
    expect(limited).toMatchObject({
      settleState: "due",
      settleAttempts: 0,
      settleError: "ratelimited",
    });
    expect(limited.settleNextAt?.getTime() ?? 0).toBeGreaterThan(
      Date.now() + 100_000,
    );
    // A new process reads the same wait.
    expect(await settler()).toMatchObject({ claimed: 0 });
    await elapse(130_000);

    let calls = 0;
    const refusing = (codes: string[]) => ({
      updateMessage: async (
        token: string,
        input: Parameters<NonNullable<SlackBotApi["updateMessage"]>>[1],
      ) => {
        const code = codes[calls];
        calls += 1;
        if (code !== undefined) {
          throw new SlackApiError("chat.update", code, true);
        }
        await api.updateMessage(token, input);
      },
    });
    expect(
      await settler({ slack: refusing(["invalid_blocks"]) }),
    ).toMatchObject({ sent: 1 });
    const fallback = updated().at(-1);
    if (!fallback) throw new Error("no text fallback");
    expect(fallback.blocks as unknown).toEqual([
      { type: "section", text: { type: "mrkdwn", text: fallback.text } },
    ]);
    expect(await cardRow()).toMatchObject({ settleState: "settled" });

    // Five failures in a row, then it is given up. (The card is put back to
    // open, as if Slack still showed the buttons.)
    const reopen = () =>
      db
        .update(slackOutbox)
        .set({ settleState: "due", settleRendered: "open", settleAttempts: 0 });
    await reopen();
    calls = 0;
    const failing = refusing(Array(10).fill("internal_error"));
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(await settler({ slack: failing })).toMatchObject({ deferred: 1 });
      expect(await cardRow()).toMatchObject({ settleAttempts: attempt });
      await elapse(31 * 60_000);
    }
    expect(await settler({ slack: failing })).toMatchObject({ abandoned: 1 });
    expect(calls).toBe(5);

    // Gone for good: abandoned at once, never claimed again.
    await reopen();
    calls = 0;
    expect(
      await settler({ slack: refusing(["message_not_found"]) }),
    ).toMatchObject({ abandoned: 1 });
    expect(await cardRow()).toMatchObject({
      settleState: "abandoned",
      settleError: "message_not_found",
    });
    expect(await settler()).toMatchObject({ claimed: 0 });
  });

  test("a press and a pass at once write the card once", async () => {
    const { card, actorId } = await cardThread();
    await answerOn("web", actorId, { decision: "allow" });
    await cards().markDueAt({ channelId: CHANNEL, slackTs: card.ts });
    const passes = await Promise.all([
      settler(),
      settler({ only: { channelId: CHANNEL, slackTs: card.ts } }),
      settler(),
    ]);
    expect(passes.reduce((sum, pass) => sum + pass.sent, 0)).toBe(1);
    expect(updated()).toHaveLength(1);
  });

  test("a held edit is not taken over before its lease and grace end; after, the current card goes again", async () => {
    const { actorId } = await cardThread();
    await answerOn("web", actorId, { decision: "allow" });
    await cards().markDue();
    const [claim] = await cards().claim({
      limit: 1,
      leaseMs: LEASE,
      graceMs: GRACE,
    });
    if (!claim) throw new Error("no claim");
    expect(
      await cards().claim({ limit: 1, leaseMs: LEASE, graceMs: GRACE }),
    ).toEqual([]);
    await elapse(LEASE + 1000);
    expect(
      await cards().claim({ limit: 1, leaseMs: LEASE, graceMs: GRACE }),
    ).toEqual([]);
    await elapse(GRACE);
    // The first writer, late, finds its fence gone.
    expect(await settler()).toMatchObject({ sent: 1 });
    expect(await cards().beginSend(claim, 0)).toBeNull();
    expect(updated()).toHaveLength(1);
  });

  test("a writer that died mid-edit leaves its card resent a window later, settled or not; a new uncertainty during the resend is kept", async () => {
    const { actorId } = await cardThread();
    await answerOn("web", actorId, { decision: "allow" });
    expect(await settler()).toMatchObject({ sent: 1 });
    // A writer that began an edit and died: its inflight mark outlives the lease.
    await db.update(slackOutbox).set({ settleState: "due" });
    const [claim] = await cards().claim({
      limit: 1,
      leaseMs: LEASE,
      graceMs: GRACE,
    });
    if (!claim) throw new Error("no claim");
    expect(await cards().beginSend(claim, 0)).not.toBeNull();
    await elapse(LEASE + GRACE + 1000);
    await settler();
    expect(await cardRow()).toMatchObject({ settleUncertainRev: 1 });
    expect((await cardRow()).settleUncertainLatestAt).not.toBeNull();
    // Not before the window.
    expect(updated()).toHaveLength(1);
    await db.update(slackOutbox).set({ settleState: "settled" });
    await elapse(W);

    // The resend runs while another edit's outcome turns unknown.
    const raced = {
      updateMessage: async (
        token: string,
        input: Parameters<NonNullable<SlackBotApi["updateMessage"]>>[1],
      ) => {
        await api.updateMessage(token, input);
        await cards().uncertain(
          { id: claim.id, claimToken: randomUUID() },
          new Date(),
          W,
        );
      },
    };
    expect(await settler({ slack: raced })).toMatchObject({ sent: 1 });
    expect(updated()).toHaveLength(2);
    const after = await cardRow();
    expect(after.settleUncertainRev).toBe(2);
    expect(after.settleUncertainLatestAt).not.toBeNull();

    // A clean resend a window after the latest clears it.
    await elapse(W);
    expect(await settler()).toMatchObject({ sent: 1 });
    expect(await cardRow()).toMatchObject({
      settleUncertainLatestAt: null,
      settleState: "settled",
    });
    expect(await settler()).toMatchObject({ claimed: 0 });
  });

  test("timeouts in a row push the resend past the latest one", async () => {
    const { actorId } = await cardThread();
    await answerOn("web", actorId, { decision: "allow" });
    const timeout = {
      updateMessage: async () => {
        throw new SlackApiError("chat.update", "timeout", false, {
          failure: "timeout",
        });
      },
    };
    expect(await settler({ slack: timeout })).toMatchObject({ uncertain: 1 });
    await elapse(240_000);
    await db.update(slackOutbox).set({ settleNextAt: null });
    expect(await settler({ slack: timeout })).toMatchObject({ uncertain: 1 });
    const row = await cardRow();
    expect(row.settleUncertainRev).toBe(2);
    const waitMs =
      (row.settleNextAt?.getTime() ?? 0) -
      (row.settleUncertainLatestAt?.getTime() ?? 0);
    expect(waitMs).toBeGreaterThanOrEqual(W - 1000);
    expect(await settler()).toMatchObject({ claimed: 0 });
  });
});

describe.each(ENGINES)("a link's posting columns on %s", (engine) => {
  useDatabase(engine);

  /** Turn `sequence` waits on one permission request, its card unsent. */
  async function waitOnPermission(sessionId: string, sequence: number) {
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    const attemptId = `att-${randomUUID()}`;
    await db.insert(attempts).values({
      id: attemptId,
      sessionId,
      executionId: `exec-${attemptId}`,
      leaseEpoch: session.leaseEpoch,
      executionGeneration: session.executionGeneration,
      authRevision: session.authRevision,
      state: "running",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const [turn] = await db
      .update(turns)
      .set({ status: "needs_input", attemptId })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, sequence)))
      .returning({ id: turns.id });
    await db.insert(pendingRequests).values({
      requestId: `toolu:${sequence}`,
      sessionId,
      turnId: turn?.id ?? 0,
      attemptId,
      kind: "permission",
      payload: { kind: "permission", tool: "Bash", input: { command: "ls" } },
      inputHash: "h",
      expiresAt: new Date(Date.now() + 60_000),
    });
  }

  const kinds = async () =>
    [...new Set((await rows()).map((row) => row.kind))].sort();
  // Each row as its kind and the turn or request it is of.
  const sent = async () =>
    (await rows())
      .map((row) => `${row.kind}:${row.dedupeKey.split(":").at(-1)}`)
      .sort();

  // What `visibility` sent before the columns: `full` every kind, `summary`
  // none. A moved link must send the same; each column gates its own kinds.
  test.each([
    [
      "full, as an old host's link leaves it",
      async () => {},
      ["input_notice:2", "instruction:2", "reply:1", "reply:2"],
    ],
    [
      "summary, moved by the start pass",
      async () => {
        await db.update(sessionLinks).set({ visibility: "summary" });
        expect(await moveSummaryLinks(db)).toBe(1);
      },
      [],
    ],
    [
      // The start pass may run late or fail: a link it has not moved yet
      // still posts nothing.
      "summary, not moved yet",
      () => db.update(sessionLinks).set({ visibility: "summary" }),
      [],
    ],
    [
      "mirror_instructions off",
      () => db.update(sessionLinks).set({ mirrorInstructions: false }),
      ["input_notice:2", "reply:1", "reply:2"],
    ],
    [
      "post_prompts off",
      () => db.update(sessionLinks).set({ postPrompts: false }),
      ["instruction:2", "reply:1", "reply:2"],
    ],
    // Until v1-b every mode but none posts once per turn, as full did.
    [
      "report_mode progress on the link",
      () => db.update(sessionLinks).set({ reportMode: "progress" }),
      ["input_notice:2", "instruction:2", "reply:1", "reply:2"],
    ],
    [
      "report_mode notify_only on the channel, unset on the link",
      () => db.update(surfaceBindings).set({ reportMode: "notify_only" }),
      ["input_notice:2", "instruction:2", "reply:1", "reply:2"],
    ],
    [
      "report_mode none",
      () => db.update(sessionLinks).set({ reportMode: "none" }),
      ["input_notice:2", "instruction:2"],
    ],
  ] as const)(
    "%s: the thread gets what its columns allow",
    async (_, set, expected) => {
      const fixture = await agentInSlack();
      await mention(fixture, THREAD);
      const sessionId = await sessionOf(fixture);
      await set();
      await endTurn(sessionId, 1, "completed", [[text("First.")]]);
      await outboxPass();
      await askFrom(sessionId, 2, "web", "Add a test", true);
      await outboxPass();
      await waitOnPermission(sessionId, 2);
      await outboxPass();
      await endTurn(sessionId, 2, "completed", [[text("Added.")]]);
      await outboxPass();

      expect(await sent()).toEqual([...expected]);
      expect(posted()).toHaveLength(expected.length);
    },
  );

  test("a reply, an instruction or a card whose column was turned off while it waited is not sent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("First.")]]);
    await askFrom(sessionId, 2, "web", "Add a test", true);
    await waitOnPermission(sessionId, 2);
    await outboxPass({ botToken: null });
    await outboxPass({ botToken: null });
    expect(await kinds()).toEqual(["input_notice", "instruction", "reply"]);

    await db.update(sessionLinks).set({
      reportMode: "none",
      mirrorInstructions: false,
      postPrompts: false,
    });
    await outboxPass();
    expect(posted()).toEqual([]);
    expect(
      (await rows())
        .map(({ kind, status, errorCode }) => [kind, status, errorCode])
        .sort(),
    ).toEqual([
      ["input_notice", "failed", "not_addressed"],
      ["instruction", "failed", "not_addressed"],
      ["reply", "failed", "not_addressed"],
    ]);
  });
});

describe.each(ENGINES)("action notices on %s", (engine) => {
  useDatabase(engine);

  const COMMIT = "a".repeat(40);

  /** A session in a Slack thread, and a push request taken up by the pusher. */
  async function pushing(
    flow: "legacy" | "actions",
    options: {
      intent?: unknown;
      slack?: boolean;
      /** Another request of the session an earlier call made. */
      sessionId?: string;
    } = {},
  ) {
    let sessionId = options.sessionId;
    if (sessionId === undefined) {
      const fixture = await agentInSlack();
      await mention(fixture, THREAD);
      sessionId = await sessionOf(fixture);
    }
    const [session] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!session) throw new Error("no session");
    if (options.slack === false) await db.delete(schema.sessionLinks);
    const receiptId = randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: session.ownerId,
      operation: "request_push",
      targetRef: { kind: "session", id: sessionId },
    });
    const id = randomUUID();
    await db.insert(pushRequests).values({
      id,
      ownerId: session.ownerId,
      sessionId,
      repositoryId: "sandbox",
      repositoryBinding: "sha256:binding",
      checkpointRevision: 1,
      gitCommit: COMMIT,
      targetBranch: `agent/${sessionId}`,
      state: "pushing",
      pushAttempts: 1,
      flow,
      pullRequestIntent: options.intent ?? null,
      requestedBy: {
        principal: { kind: "installation", id: "i" },
        actor_user_id: null,
        agent_id: null,
      },
      requestReceiptId: receiptId,
      decidedAt: new Date(),
      decidedBy: { kind: "policy" },
      decisionReceiptId: receiptId,
    });
    return { id, sessionId, ownerId: session.ownerId };
  }

  const pushed = {
    state: "pushed" as const,
    remoteUrl: "https://github.com/acme/app.git",
    remoteRef: "refs/heads/x",
    previousCommit: null,
  };
  const notices = async () =>
    (await db.select().from(slackOutbox))
      .filter((row) => row.kind === "action_notice")
      .sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));
  const row = async (id: string) =>
    (await db.select().from(pushRequests).where(eq(pushRequests.id, id)))[0];

  test("a finished push of the action flow leaves one notice in the same commit as its state, and a PR intent makes the stage due", async () => {
    const { id } = await pushing("actions", { intent: { title: "T" } });
    const store = createPostgresPushRequests(db);
    const job = { id, attempt: 1 } as never;
    expect(await store.finish(job, pushed)).toBe(true);
    expect(await row(id)).toMatchObject({ state: "pushed", prState: "due" });
    const [notice, ...rest] = await notices();
    expect(rest).toEqual([]);
    expect(notice).toMatchObject({
      kind: "action_notice",
      dedupeKey: `action:${id}:pushed`,
      status: "pending",
    });
    expect(notice?.body.text).toContain("sandbox");
    expect(notice?.body.text).toContain("aaaaaaa");
    // A repeat of the same result is no second row.
    expect(await store.finish(job, pushed)).toBe(false);
    expect(await notices()).toHaveLength(1);
  });

  test("a push without a PR intent stays at push; a failed one cancels the stage and says so", async () => {
    const bare = await pushing("actions");
    const store = createPostgresPushRequests(db);
    await store.finish({ id: bare.id, attempt: 1 } as never, pushed);
    expect((await row(bare.id))?.prState).toBeNull();

    const failed = await pushing("actions", {
      intent: { title: "T" },
      sessionId: bare.sessionId,
    });
    await store.finish({ id: failed.id, attempt: 1 } as never, {
      state: "failed",
      refusal: "push_failed",
    });
    expect(await row(failed.id)).toMatchObject({
      state: "failed",
      prState: "cancelled",
      prError: "push_failed",
    });
    const keys = (await notices()).map((entry) => entry.dedupeKey);
    expect(keys).toContain(`action:${failed.id}:push_failed`);
    expect(keys).toContain(`action:${bare.id}:pushed`);
  });

  test("a thread that hears of no turns gets no notice, and its push still finishes", async () => {
    const { id } = await pushing("actions");
    await db.update(sessionLinks).set({ reportMode: "none" });
    await createPostgresPushRequests(db).finish(
      { id, attempt: 1 } as never,
      pushed,
    );
    expect(await notices()).toEqual([]);
    expect((await row(id))?.state).toBe("pushed");
  });

  test("a request of the legacy flow gets no notice", async () => {
    const legacy = await pushing("legacy");
    await createPostgresPushRequests(db).finish(
      { id: legacy.id, attempt: 1 } as never,
      pushed,
    );
    expect(await notices()).toEqual([]);
    expect((await row(legacy.id))?.state).toBe("pushed");
  });

  test("a session with no Slack thread gets no notice, and its push still finishes", async () => {
    const web = await pushing("actions", { slack: false });
    await createPostgresPushRequests(db).finish(
      { id: web.id, attempt: 1 } as never,
      pushed,
    );
    expect(await notices()).toEqual([]);
    expect((await row(web.id))?.state).toBe("pushed");
  });

  test("the drain's settle writes the state and the notice together: opened tells once with the PR link, in the starter's language", async () => {
    const { id, sessionId } = await pushing("actions", {
      intent: { title: "T" },
    });
    await createPostgresPushRequests(db).finish(
      { id, attempt: 1 } as never,
      pushed,
    );
    const drain = createPostgresPullRequestDrain(db);
    const job = await drain.claimNextDue(60_000);
    if (job === null) throw new Error("no job");
    await drain.settle(job, {
      kind: "opened",
      pullRequest: {
        number: 12,
        url: "https://github.com/acme/app/pull/12",
        head: `agent/${sessionId}`,
        base: "main",
        headSha: COMMIT,
        title: "T",
        created: true,
      },
    });
    expect(await row(id)).toMatchObject({
      prState: "opened",
      prVerifiedNumber: 12,
    });
    const opened = (await notices()).find(
      (entry) => entry.dedupeKey === `action:${id}:opened`,
    );
    expect(opened?.body).toMatchObject({
      link_url: "https://github.com/acme/app/pull/12",
    });
    expect(opened?.body.text).toContain("12");
    // A fenced settle writes neither state nor notice.
    expect(
      await drain.settle(job, {
        kind: "stop",
        stage: "failed",
        error: "head_moved",
      }),
    ).toEqual({ result: "fenced" });
    expect((await notices()).map((entry) => entry.dedupeKey)).toEqual([
      `action:${id}:opened`,
      `action:${id}:pushed`,
    ]);
  });

  test("an unclear end tells once as uncertain, and a stop with a code names the code", async () => {
    const drain = createPostgresPullRequestDrain(db);
    const store = createPostgresPushRequests(db);
    const one = await pushing("actions", { intent: { title: "T" } });
    await store.finish({ id: one.id, attempt: 1 } as never, pushed);
    const job = await drain.claimNextDue(60_000);
    if (job === null) throw new Error("no job");
    await drain.settle(job, {
      kind: "stop",
      stage: "uncertain",
      error: "lookup_failed",
    });
    const uncertain = (await notices()).find(
      (entry) => entry.dedupeKey === `action:${one.id}:pr_uncertain`,
    );
    expect(uncertain?.body.text).toContain("lookup_failed");
    expect(await drain.claimNextDue(60_000)).toBeNull();

    const two = await pushing("actions", {
      intent: { title: "T" },
      sessionId: one.sessionId,
    });
    await store.finish({ id: two.id, attempt: 1 } as never, pushed);
    const second = await drain.claimNextDue(60_000);
    if (second === null) throw new Error("no job");
    await drain.settle(second, {
      kind: "stop",
      stage: "failed",
      error: "head_moved",
    });
    const failed = (await notices()).find(
      (entry) => entry.dedupeKey === `action:${two.id}:pr_failed`,
    );
    expect(failed?.body.text).toContain("head_moved");
  });

  test("the migration lets an action_notice row in (the kind CHECK was widened)", async () => {
    const { id } = await pushing("actions");
    await createPostgresPushRequests(db).finish(
      { id, attempt: 1 } as never,
      pushed,
    );
    expect((await notices())[0]?.kind).toBe("action_notice");
  });
});

describe.each(ENGINES)("model notices on %s", (engine) => {
  useDatabase(engine);

  const modelNotice = async (
    fixture: Awaited<ReturnType<typeof agentInSlack>>,
    sessionId: string,
    to: { channelId: string; threadTs: string; sessionLinkId: string | null },
  ) => {
    await db.insert(slackOutbox).values({
      id: randomUUID(),
      workspaceId: fixture.workspaceId,
      agentId: fixture.agentId,
      slackAppId: fixture.slackAppId,
      installationId: (await db.select().from(sessionLinks))[0]
        ?.installationId as string,
      kind: "model_notice",
      ...to,
      slackUserId: null,
      sessionId,
      body: { text: "The session stopped.", locale: "en" },
      dedupeKey: `model-not-allowed:${fixture.workspaceId}:${sessionId}:${to.sessionLinkId}`,
    });
  };

  test("a model_notice goes to the session's thread with the session's link", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    const [link] = await db.select().from(sessionLinks);
    if (!link) throw new Error("no link");
    await modelNotice(fixture, sessionId, {
      channelId: link.channelId,
      threadTs: link.threadId,
      sessionLinkId: link.id,
    });

    expect(await outboxPass()).toMatchObject({ sent: 1, failed: 0 });
    expect(posted()).toContainEqual(
      expect.objectContaining({
        channelId: link.channelId,
        threadTs: link.threadId,
        text: `The session stopped.\n\n<${CONSOLE}/sessions/${sessionId}|${SLACK_OUTBOX_MESSAGES.en.link}>`,
      }),
    );
    expect(
      (await rows()).find((row) => row.kind === "model_notice"),
    ).toMatchObject({ status: "sent" });
  });

  // Before 94S-2040 a muted thread did not stop it: it went to a person.
  test("a muted thread stops it, as it does any notice", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    expect(await outboxPass()).toMatchObject({ failed: 0 });
    const [link] = await db.select().from(sessionLinks);
    if (!link) throw new Error("no link");
    await modelNotice(fixture, sessionId, {
      channelId: link.channelId,
      threadTs: link.threadId,
      sessionLinkId: link.id,
    });
    await db.update(sessionLinks).set({ muted: true });
    const before = posted().length;

    expect(await outboxPass()).toMatchObject({ claimed: 0, failed: 1 });
    expect(posted()).toHaveLength(before);
  });

  // What a release before 94S-2040, or the image before this one beside it,
  // wrote: a direct message to a person, outside any thread.
  test("a model_notice to a person is never sent", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    expect(await outboxPass()).toMatchObject({ failed: 0 });
    await modelNotice(fixture, sessionId, {
      channelId: PERSON,
      threadTs: "",
      sessionLinkId: null,
    });
    const before = posted().length;

    // It waits for the API's start pass, unclaimed and not closed.
    expect(await outboxPass()).toMatchObject({ claimed: 0, failed: 0 });
    expect(posted()).toHaveLength(before);
    expect(
      (await db.select().from(schema.slackOutbox)).filter(
        (row) => row.kind === "model_notice",
      ),
    ).toEqual([
      expect.objectContaining({ channelId: PERSON, status: "pending" }),
    ]);
    // The pass moves it to the session's thread, where it goes once.
    expect(await schema.moveModelNoticesOffPeople(db)).toMatchObject({
      moved: 1,
    });
    expect(await outboxPass()).toMatchObject({ failed: 0 });
    expect(posted().slice(before)).toEqual([
      expect.objectContaining({ channelId: CHANNEL, threadTs: THREAD }),
    ]);
    expect(posted().map((post) => post.channelId)).not.toContain(PERSON);
  });

  test("a revoked installation still stops it", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    expect(await outboxPass()).toMatchObject({ failed: 0 });
    const [link] = await db.select().from(sessionLinks);
    if (!link) throw new Error("no link");
    await modelNotice(fixture, sessionId, {
      channelId: link.channelId,
      threadTs: link.threadId,
      sessionLinkId: link.id,
    });
    await db.execute(
      sql`UPDATE slack_installations SET status = 'revoked', revoked_at = now()`,
    );
    const before = posted().length;
    expect(await outboxPass()).toMatchObject({ claimed: 0, failed: 1 });
    expect(posted()).toHaveLength(before);
  });
});

describe.each(ENGINES)("closing a closed session's link on %s", (engine) => {
  useDatabase(engine);

  const links = () =>
    db
      .select({
        id: sessionLinks.id,
        sessionId: sessionLinks.sessionId,
        closedAt: sessionLinks.closedAt,
        closedReason: sessionLinks.closedReason,
      })
      .from(sessionLinks)
      .orderBy(asc(sessionLinks.createdAt));

  // The state closeAtomic leaves; `byOwner` also writes its close receipt.
  async function closeSession(sessionId: string, byOwner: boolean) {
    const [session] = await db
      .update(sessions)
      .set({ admissionState: "closed", status: "stopped" })
      .where(eq(sessions.id, sessionId))
      .returning({ ownerId: sessions.ownerId });
    if (!session) throw new Error("no session");
    if (!byOwner) return;
    const receiptId = randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: session.ownerId,
      actor: null,
      requestId: null,
      operation: "close",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      status: "succeeded",
      result: null,
    });
    await db.insert(schema.idempotencyKeys).values({
      principal: session.ownerId,
      operation: "close",
      resource: sessionId,
      key: randomUUID(),
      payloadHash: "h",
      receiptId,
    });
  }

  test("off by default: a closed session's link stays open and its thread's next mention goes as before", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("done")]]);
    await closeSession(sessionId, true);
    expect(await outboxPass()).toMatchObject({ sent: 1, linksClosed: 0 });
    expect(await outboxPass()).toMatchObject({ linksClosed: 0 });
    const before = await rows();

    await mention(fixture, "100.000300");
    await outboxPass();
    expect(await links()).toEqual([
      expect.objectContaining({
        sessionId,
        closedAt: null,
        closedReason: null,
      }),
    ]);
    expect(
      await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.workspaceId, fixture.workspaceId)),
    ).toEqual([{ id: sessionId }]);
    // As before: the person who asked hears the session takes no more.
    const added = (await rows()).slice(before.length);
    expect(
      added.map((row) => [row.kind, row.threadTs, row.slackUserId]),
    ).toEqual([["notice", THREAD, PERSON]]);
    expect(added[0]?.body.text).toBe(SLACK_NOTICE_MESSAGES.ko.failed);
  });

  test("on: the link closes only once the last reply is enqueued, and that reply goes to its thread", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("the last report")]]);
    await closeSession(sessionId, true);
    const outbox = createPostgresSlackOutboxStore(db);
    // Its reply is not in yet: nothing closes.
    expect(await outbox.closeFinishedLinks(10)).toBe(0);
    expect(
      await outboxPass({ botToken: null, closeLinks: true }),
    ).toMatchObject({ enqueued: 1, linksClosed: 1 });
    const [link] = await links();
    expect(link?.closedAt).toBeInstanceOf(Date);
    expect(link?.closedReason).toBe("completed");
    // The pending reply still goes: the send check does not read closed_at.
    expect(await outboxPass({ closeLinks: true })).toMatchObject({
      sent: 1,
      linksClosed: 0,
    });
    expect(posted().map((message) => [message.text, message.threadTs])).toEqual(
      [[expect.stringContaining("the last report"), THREAD]],
    );
  });

  test("on: a session closed with no owner's close receipt closes its link abandoned", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("hi")]]);
    await closeSession(sessionId, false);
    await outboxPass({ closeLinks: true });
    expect((await links())[0]?.closedReason).toBe("abandoned");
  });

  test("on: the same thread's next mention opens a new session on a new link", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const first = await sessionOf(fixture);
    await endTurn(first, 1, "completed", [[text("hi")]]);
    await closeSession(first, true);
    await outboxPass({ closeLinks: true });

    await mention(fixture, "100.000300");
    const all = await links();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({
      sessionId: first,
      closedReason: "completed",
    });
    expect(all[1]).toMatchObject({ closedAt: null, closedReason: null });
    expect(all[1]?.sessionId).not.toBeNull();
    expect(all[1]?.sessionId).not.toBe(first);
  });

  test.each(["stopped", "paused", "recovery_required"] as const)(
    "on: a %s session keeps its link open",
    async (admissionState) => {
      const fixture = await agentInSlack();
      await mention(fixture, THREAD);
      const sessionId = await sessionOf(fixture);
      await endTurn(sessionId, 1, "completed", [[text("hi")]]);
      await db
        .update(sessions)
        .set({ admissionState })
        .where(eq(sessions.id, sessionId));
      expect(await outboxPass({ closeLinks: true })).toMatchObject({
        linksClosed: 0,
      });
      expect(await outboxPass({ closeLinks: true })).toMatchObject({
        linksClosed: 0,
      });
      expect(await links()).toEqual([
        expect.objectContaining({ closedAt: null, closedReason: null }),
      ]);
    },
  );

  test("on: a revoked link stays open, so its thread stays blocked", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("hi")]]);
    await outboxPass({ closeLinks: true });
    await db.update(sessionLinks).set({ revokedAt: new Date() });
    await closeSession(sessionId, true);
    expect(await outboxPass({ closeLinks: true })).toMatchObject({
      linksClosed: 0,
    });
    await mention(fixture, "100.000300");
    expect(await links()).toEqual([
      expect.objectContaining({ sessionId, closedAt: null }),
    ]);
  });

  test("a closed link takes no new row but the notice of its own reply gone uncertain, once", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("hi")]]);
    await closeSession(sessionId, true);
    await outboxPass({ botToken: null, closeLinks: true });
    const [link] = await links();
    const [reply] = await rows();
    if (!link?.closedAt || !reply) throw new Error("no closed link or reply");
    const outbox = createPostgresSlackOutboxStore(db);
    const entry = {
      workspaceId: reply.workspaceId,
      agentId: reply.agentId,
      slackAppId: reply.slackAppId,
      installationId: reply.installationId,
      kind: "failure_notice" as const,
      channelId: reply.channelId,
      threadTs: reply.threadTs,
      slackUserId: null,
      sessionId,
      sessionLinkId: link.id,
      body: { text: "late" },
    };
    expect(await outbox.enqueue({ ...entry, dedupeKey: "late:1" })).toBe(
      "link_closed",
    );
    // Nor a key that names no row of this link, nor a malformed one.
    expect(
      await outbox.enqueue({
        ...entry,
        dedupeKey: `uncertain:${randomUUID()}`,
      }),
    ).toBe("link_closed");
    expect(
      await outbox.enqueue({ ...entry, dedupeKey: "uncertain:not-a-uuid" }),
    ).toBe("link_closed");

    await db
      .update(slackOutbox)
      .set({ status: "uncertain" })
      .where(eq(slackOutbox.id, reply.id));
    await outboxPass({ closeLinks: true });
    await outboxPass({ closeLinks: true });
    const notices = (await rows()).filter(
      (row) => row.dedupeKey === `uncertain:${reply.id}`,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      sessionLinkId: link.id,
      threadTs: THREAD,
      status: "sent",
    });
  });

  test("on: a session closed by recovery with its turn still outcome_unknown closes its link once the failure row is in", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    const sessionId = await sessionOf(fixture);
    await db
      .update(turns)
      .set({ status: "outcome_unknown", endedAt: new Date() })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 1)));
    await closeSession(sessionId, false);
    expect(
      await outboxPass({ botToken: null, closeLinks: true }),
    ).toMatchObject({ enqueued: 1, linksClosed: 1 });
    const [link] = await links();
    expect(link?.closedReason).toBe("abandoned");
    expect((await rows()).map((row) => row.dedupeKey)).toEqual([
      `failure:${link?.id}:1`,
    ]);
  });

  test("on: a link that reports no turns closes with its session, and turning reports on afterwards sends nothing", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await db.update(sessionLinks).set({ reportMode: "none" });
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("unheard")]]);
    await closeSession(sessionId, true);
    expect(await outboxPass({ closeLinks: true })).toMatchObject({
      linksClosed: 1,
    });
    const before = await rows();

    await db.update(sessionLinks).set({ reportMode: "per_step" });
    expect(await outboxPass({ closeLinks: true })).toMatchObject({
      enqueued: 0,
      linksClosed: 0,
    });
    await outboxPass({ closeLinks: true });
    expect(await rows()).toEqual(before);
    expect(posted()).toEqual([]);
  });
});

describe.each(ENGINES)("a progress message on %s", (engine) => {
  useDatabase(engine);

  const KEY = "progress-1";

  // Update `n` of the progress message in the mention's thread.
  async function progress(n: number, value: string) {
    const [link] = await db.select().from(sessionLinks);
    const [app] = await db.select({ id: slackApps.id }).from(slackApps);
    if (!link?.sessionId || !app) throw new Error("no link");
    return createPostgresSlackOutboxStore(db).enqueue({
      workspaceId: link.workspaceId,
      agentId: link.agentId,
      slackAppId: app.id,
      installationId: link.installationId,
      kind: "progress",
      channelId: link.channelId,
      threadTs: link.threadId,
      slackUserId: null,
      sessionId: link.sessionId,
      sessionLinkId: link.id,
      body: { text: value },
      dedupeKey: `progress:${KEY}:${n}`,
      progressKey: KEY,
    });
  }

  // As if the interval since the last send, or a Retry-After, ran out.
  const intervalOver = () =>
    db
      .update(slackOutbox)
      .set({ nextAttemptAt: sql`now()` })
      .where(eq(slackOutbox.kind, "progress"));

  const progressRows = () =>
    db
      .select({
        status: slackOutbox.status,
        errorCode: slackOutbox.errorCode,
        slackTs: slackOutbox.slackTs,
        progressTs: slackOutbox.progressTs,
        text: sql<string>`${slackOutbox.body}->>'text'`,
      })
      .from(slackOutbox)
      .where(eq(slackOutbox.kind, "progress"))
      .orderBy(asc(slackOutbox.seq));

  const waitMsOf = async (n: number) => {
    const [row] = await db
      .select({
        waitMs: sql<number>`extract(epoch from ${slackOutbox.nextAttemptAt} - now()) * 1000`,
      })
      .from(slackOutbox)
      .where(eq(slackOutbox.dedupeKey, `progress:${KEY}:${n}`));
    return Number(row?.waitMs);
  };

  beforeEach(() => {
    slack.updates.length = 0;
  });

  test("five updates inside the interval: one post, then one edit with the last", async () => {
    await mention(await agentInSlack(), THREAD);
    expect(await progress(1, "step 1")).toBe("enqueued");
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    for (const n of [2, 3, 4, 5]) {
      expect(await progress(n, `step ${n}`)).toBe("enqueued");
      expect(await outboxPass()).toMatchObject({ claimed: 0 });
    }
    expect(await waitMsOf(1)).toBeGreaterThan(
      SURFACE_PROGRESS_EDIT_INTERVAL_MS - 5_000,
    );
    expect(await waitMsOf(1)).toBeLessThanOrEqual(
      SURFACE_PROGRESS_EDIT_INTERVAL_MS,
    );

    await intervalOver();
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    await intervalOver();
    expect(await outboxPass()).toMatchObject({ claimed: 0 });
    const [post, ...more] = posted();
    if (!post) throw new Error("no post");
    expect(more).toEqual([]);
    expect(post).toMatchObject({ threadTs: THREAD, text: "step 1" });
    expect(slack.updates).toEqual([
      { channelId: CHANNEL, ts: post.ts, text: "step 5", blocks: undefined },
    ]);
    const superseded = (n: number) => ({
      status: "failed" as const,
      errorCode: "superseded",
      slackTs: null,
      progressTs: null,
      text: `step ${n}`,
    });
    expect(await progressRows()).toEqual([
      {
        status: "sent",
        errorCode: null,
        slackTs: post.ts,
        progressTs: null,
        text: "step 1",
      },
      superseded(2),
      superseded(3),
      superseded(4),
      {
        status: "sent",
        errorCode: null,
        slackTs: post.ts,
        progressTs: post.ts,
        text: "step 5",
      },
    ]);
  });

  test("a rate-limited edit waits out its Retry-After, and the update that overtakes it waits too", async () => {
    await mention(await agentInSlack(), THREAD);
    await progress(1, "step 1");
    await outboxPass();
    await progress(2, "step 2");
    await intervalOver();
    slack.rateLimit("chat.update", 30);
    expect(await outboxPass()).toMatchObject({ retried: 1, sent: 0 });
    expect(await waitMsOf(2)).toBeGreaterThan(25_000);
    expect(await waitMsOf(2)).toBeLessThanOrEqual(30_000);

    await progress(3, "step 3");
    expect(await outboxPass()).toMatchObject({ claimed: 0 });
    expect(slack.updates).toEqual([]);
    expect((await progressRows())[1]).toMatchObject({
      status: "failed",
      errorCode: "superseded",
    });

    await intervalOver();
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    const [post] = posted();
    if (!post) throw new Error("no post");
    expect(slack.updates).toEqual([
      {
        channelId: CHANNEL,
        ts: post.ts,
        text: "step 3",
        blocks: undefined,
      },
    ]);
  });

  test("a Retry-After shorter than the interval still waits the interval", async () => {
    await mention(await agentInSlack(), THREAD);
    await progress(1, "step 1");
    await outboxPass();
    await progress(2, "step 2");
    await intervalOver();
    slack.rateLimit("chat.update", 1);
    expect(await outboxPass()).toMatchObject({ retried: 1 });
    expect(await waitMsOf(2)).toBeGreaterThan(
      SURFACE_PROGRESS_EDIT_INTERVAL_MS - 5_000,
    );
  });

  test("a post Slack never confirmed stops the message: no second post", async () => {
    await mention(await agentInSlack(), THREAD);
    await progress(1, "step 1");
    // As if its send outlived its lease.
    await db
      .update(slackOutbox)
      .set({ status: "uncertain", errorCode: "lease_expired" })
      .where(eq(slackOutbox.kind, "progress"));
    await progress(2, "step 2");
    expect(await outboxPass()).toMatchObject({ claimed: 0 });
    expect(posted()).toEqual([]);
    expect((await progressRows())[1]).toMatchObject({
      status: "failed",
      errorCode: "progress_stopped",
    });
  });

  test("a claim made beside another pass's is checked again when its send begins", async () => {
    await mention(await agentInSlack(), THREAD);
    await progress(1, "step 1");
    await progress(2, "step 2");
    // Both claimed, as two passes may when one's snapshot predates step 2.
    const claimed = await db
      .update(slackOutbox)
      .set({
        claimToken: sql`gen_random_uuid()`,
        leaseExpiresAt: sql`now() + interval '1 minute'`,
      })
      .where(eq(slackOutbox.kind, "progress"))
      .returning({ id: slackOutbox.id, claimToken: slackOutbox.claimToken })
      .then((rows) =>
        rows.map(({ id, claimToken }) => ({
          id,
          claimToken: claimToken ?? "",
        })),
      );
    const store = createPostgresSlackOutboxStore(db);
    const fenceOf = async (n: number) => {
      const [row] = await db
        .select({ id: slackOutbox.id })
        .from(slackOutbox)
        .where(eq(slackOutbox.dedupeKey, `progress:${KEY}:${n}`));
      const fence = claimed.find((claim) => claim.id === row?.id);
      if (!fence) throw new Error("no claim");
      return fence;
    };
    const fences = [await fenceOf(1), await fenceOf(2)];
    // At once: on PostgreSQL two connections, the second waiting on the first.
    const [one, two] = await Promise.all(
      fences.map((fence) => store.beginSend(fence)),
    );
    expect(one).toBe(false);
    expect(two).toMatchObject({ progress: { ts: null, reposted: false } });
    expect(
      (await progressRows()).map(({ status, errorCode }) => [
        status,
        errorCode,
      ]),
    ).toEqual([
      ["failed", "superseded"],
      ["sending", null],
    ]);
  });

  test("a progress message waits out the whole of a long Retry-After", async () => {
    await mention(await agentInSlack(), THREAD);
    await progress(1, "step 1");
    await outboxPass();
    await progress(2, "step 2");
    await intervalOver();
    slack.rateLimit("chat.update", 600);
    expect(await outboxPass()).toMatchObject({ retried: 1 });
    expect(await waitMsOf(2)).toBeGreaterThan(590_000);
  });

  test("a 429 on the last attempt still holds the next update for its Retry-After", async () => {
    await mention(await agentInSlack(), THREAD);
    await progress(1, "step 1");
    await outboxPass();
    await progress(2, "step 2");
    await intervalOver();
    // Nine claims spent: this one is the last.
    await db
      .update(slackOutbox)
      .set({ attempts: SLACK_OUTBOX_MAX_ATTEMPTS - 1 })
      .where(eq(slackOutbox.dedupeKey, `progress:${KEY}:2`));
    slack.rateLimit("chat.update", 600);
    expect(await outboxPass()).toMatchObject({ failed: 1 });
    expect((await progressRows())[1]).toMatchObject({
      status: "failed",
      errorCode: "ratelimited",
    });
    expect(await waitMsOf(2)).toBeGreaterThan(590_000);
    await progress(3, "step 3");
    expect(await outboxPass()).toMatchObject({ claimed: 0 });
  });

  test("an edit that fails for good still spaces the next one", async () => {
    await mention(await agentInSlack(), THREAD);
    await progress(1, "step 1");
    await outboxPass();
    await progress(2, "step 2");
    await intervalOver();
    slack.failures.set("chat.update", "msg_too_long");
    expect(await outboxPass()).toMatchObject({ failed: 1 });
    expect(await waitMsOf(2)).toBeGreaterThan(
      SURFACE_PROGRESS_EDIT_INTERVAL_MS - 5_000,
    );
    slack.failures.delete("chat.update");
    await progress(3, "step 3");
    expect(await outboxPass()).toMatchObject({ claimed: 0 });
  });

  test("a post Slack keeps but takes no edit of stops the message, posted once", async () => {
    await mention(await agentInSlack(), THREAD);
    await progress(1, "step 1");
    await outboxPass();
    slack.failures.set("chat.update", "edit_window_closed");
    await progress(2, "step 2");
    await intervalOver();
    expect(await outboxPass()).toMatchObject({ failed: 1, sent: 0 });
    expect(posted()).toHaveLength(1);
    expect((await progressRows())[1]).toMatchObject({
      status: "failed",
      errorCode: "progress_stopped",
    });
  });

  test("another installation's message of the same key is another message", async () => {
    await mention(await agentInSlack(), THREAD);
    await progress(1, "step 1");
    const [row] = await db
      .select()
      .from(slackOutbox)
      .where(eq(slackOutbox.kind, "progress"));
    if (!row) throw new Error("no row");
    // Newer, of an installation the pass closes unsent.
    await createPostgresSlackOutboxStore(db).enqueue({
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      slackAppId: row.slackAppId,
      installationId: randomUUID(),
      kind: "progress",
      channelId: row.channelId,
      threadTs: row.threadTs,
      slackUserId: null,
      sessionId: null,
      sessionLinkId: null,
      body: { text: "elsewhere" },
      dedupeKey: `progress:${KEY}:elsewhere`,
      progressKey: KEY,
    });
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(posted().map((message) => message.text)).toEqual(["step 1"]);
  });

  test("an edit of a deleted post puts the message up again once; later updates edit the new post", async () => {
    await mention(await agentInSlack(), THREAD);
    await progress(1, "step 1");
    await outboxPass();
    slack.failures.set("chat.update", "message_not_found");
    await progress(2, "step 2");
    await intervalOver();
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    const [first, again, ...more] = posted();
    if (!first || !again) throw new Error("no posts");
    expect(more).toEqual([]);
    expect(again).toMatchObject({ threadTs: THREAD, text: "step 2" });
    expect(again.ts).not.toBe(first.ts);

    slack.failures.delete("chat.update");
    await progress(3, "step 3");
    await intervalOver();
    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(posted()).toHaveLength(2);
    expect(slack.updates).toEqual([
      { channelId: CHANNEL, ts: again.ts, text: "step 3", blocks: undefined },
    ]);
    expect(
      (await progressRows()).map(({ slackTs, progressTs }) => ({
        slackTs,
        progressTs,
      })),
    ).toEqual([
      { slackTs: first.ts, progressTs: null },
      { slackTs: again.ts, progressTs: first.ts },
      { slackTs: again.ts, progressTs: again.ts },
    ]);
  });

  test("a post lost again stops the message; the thread's reports still go", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await progress(1, "step 1");
    await outboxPass();
    slack.failures.set("chat.update", "message_not_found");
    await progress(2, "step 2");
    await intervalOver();
    await outboxPass();
    await progress(3, "step 3");
    await intervalOver();
    expect(await outboxPass()).toMatchObject({ failed: 1, sent: 0 });
    await progress(4, "step 4");
    await intervalOver();
    expect(await outboxPass()).toMatchObject({ claimed: 0 });
    expect(posted()).toHaveLength(2);
    expect(
      (await progressRows()).map(({ status, errorCode }) => [
        status,
        errorCode,
      ]),
    ).toEqual([
      ["sent", null],
      ["sent", null],
      ["failed", "progress_stopped"],
      ["failed", "progress_stopped"],
    ]);

    await endTurn(await sessionOf(fixture), 1, "completed", [[text("done")]]);
    expect(await outboxPass()).toMatchObject({ enqueued: 1, sent: 1 });
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      "step 1",
      "step 2",
      "done",
    ]);
  });

  test("a closed link takes no new update; the last one in before the close still goes", async () => {
    const fixture = await agentInSlack();
    await mention(fixture, THREAD);
    await progress(1, "step 1");
    await progress(2, "step 2");
    // The pass that closes the link sends what came in before it.
    const sessionId = await sessionOf(fixture);
    await endTurn(sessionId, 1, "completed", [[text("done")]]);
    await db
      .update(sessions)
      .set({ admissionState: "closed", status: "stopped" })
      .where(eq(sessions.id, sessionId));
    expect(await outboxPass({ closeLinks: true })).toMatchObject({
      linksClosed: 1,
      sent: 2,
    });
    expect(await progress(3, "step 3")).toBe("link_closed");
    await intervalOver();
    expect(await outboxPass({ closeLinks: true })).toMatchObject({
      claimed: 0,
    });
    expect(posted().map((message) => message.text.split("\n")[0])).toEqual([
      "step 2",
      "done",
    ]);
    expect(slack.updates).toEqual([]);
    expect(
      (await progressRows()).map(({ status, errorCode }) => [
        status,
        errorCode,
      ]),
    ).toEqual([
      ["failed", "superseded"],
      ["sent", null],
    ]);
  });
});

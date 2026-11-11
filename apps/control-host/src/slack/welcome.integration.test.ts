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
  agentSlackBotToken,
  createRowDelivery,
  createSlackBotApi,
  createSlackChannelJoiner,
  createSlackChannelKinds,
  createSlackWelcome,
  deploymentWelcomeKey,
  drainSlackInbox,
  drainSlackOutbox,
  type SlackInstalled,
  slackBotToken,
  slackConversationKey,
  slackWelcomeText,
} from "@werft-ai/chat-slack";
import {
  agentCardRequestSchema,
  SESSION_SCOPE_VALUES,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseIdentityReader,
  createPostgresAgentIdentityStore,
  createPostgresAgentStore,
  createPostgresCredentialBindingStore,
  createPostgresSecretStore,
  createPostgresSlackAppStore,
  createPostgresSlackInboundEventStore,
  createPostgresSlackOutboxStore,
  createPostgresSurfaceBindingStore,
  type Database,
  memberships,
  registerSlackInstallation,
  slackApps,
  slackOutbox,
  surfaceBindings,
  users,
  verifySlackInstallation,
  workspaces,
} from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import {
  type Caller,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  createSurfaceBindingService,
  SecretKey,
} from "@werft-ai/platform";
import { startFakeSlackApi } from "@werft-ai/testkit/fake-slack-api";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import {
  createTempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { asc, eq } from "drizzle-orm";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { Pool } from "pg";
import { TEST_RUNTIMES } from "../testing/catalog.ts";
import {
  seedSettings,
  settingsCatalog,
  settingsDocument,
} from "../testing/settings.ts";
import { slackCatalog, slackSessionHandler } from "./main.ts";

// The API side (activation, binding writes, install Finalize) and the
// `slack` role (the invite event, the outbox) over one database and the
// fake Slack, wired as server.ts and main.ts wire them.

const APP_ID = "A0WELCOME";
const TEAM = "T0ACME";
const BOT_USER = "U0BOT";
const MANAGERS = ["owner", "admin"] as const;
const ENVIRONMENT = {
  EXECUTION_SLOT_LIMIT: "10",
  MAX_TURN_SECONDS: "3600",
  PROVIDER_MAX_RETRIES: "2",
  QUEUED_INPUT_LIMIT_PER_SESSION: "20",
  SESSION_COST_LIMIT_USD: "25",
  STORAGE_LIMIT_BYTES: "1073741824",
};
// Made here, at runtime: the fake only checks it is one it was given.
const BOT_CREDENTIAL = `bot-${randomBytes(12).toString("hex")}`;

const slack = startFakeSlackApi({ teamId: TEAM });
slack.apps.set(APP_ID, {
  appId: APP_ID,
  clientId: "1.1",
  clientSecret: randomBytes(8).toString("hex"),
  signingSecret: randomBytes(8).toString("hex"),
  manifest: {},
  botTokens: [BOT_CREDENTIAL],
});
const logger = createLogger({ level: "error", sinks: [] });
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
      const database = await createTempDatabase({ prefix: "slack_welcome" });
      const pool = new Pool({ connectionString: database.url, max: 8 });
      db = drizzlePostgres(pool, { schema });
      close = async () => {
        await pool.end();
        await database.drop();
      };
    }
    await seedSettings(
      db,
      settingsDocument(
        `connections:
  main:
    kind: anthropic
    endpoint: https://api.anthropic.invalid
    models: [claude-sonnet-5]
    auth:
      kind: api_key
      value_env: PROVIDER_KEY
`,
      ),
    );
    slack.calls.length = 0;
    slack.messages.length = 0;
    slack.statuses.length = 0;
    slack.failures.clear();
  }, 60_000);
  afterEach(() => close());
}

const card = (instructions: string) =>
  agentCardRequestSchema.parse({
    role: "r",
    instructions,
    model: "claude-sonnet-5",
    capabilities: { tools: ["Read"], mcp: null, forbidden: [] },
  });

async function installedAgent() {
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

  const authorization = createAuthorizationPolicy({
    identity: createDatabaseIdentityReader(db),
  });
  const agentStore = createPostgresAgentStore(db);
  const bindingStore = createPostgresSurfaceBindingStore(db);
  const appStore = createPostgresSlackAppStore(db, key);
  const slackBotApi = createSlackBotApi({ apiUrl: slack.url });
  const join = createSlackChannelJoiner({
    bindings: bindingStore,
    slack: slackBotApi,
    botToken: (workspace, agent) =>
      agentSlackBotToken(
        { apps: appStore, secrets: createPostgresSecretStore(db, key) },
        workspace,
        agent,
      ),
  });
  const welcome = createSlackWelcome({
    agents: agentStore,
    bindings: bindingStore,
    apps: appStore,
    outbox: createPostgresSlackOutboxStore(db),
    join,
    logger,
  });
  const agents = createAgentService({
    authorization,
    store: agentStore,
    catalog: await settingsCatalog(db),
    credentials: createPostgresCredentialBindingStore(db),
    runtimes: TEST_RUNTIMES,
    welcome,
  });
  const bindings = createSurfaceBindingService({
    authorization,
    store: bindingStore,
    channels: createSlackChannelKinds({
      apps: appStore,
      secrets: createPostgresSecretStore(db, key),
      slack: slackBotApi,
    }),
    join,
    welcome,
  });

  const managingTeamId = randomUUID();
  await db
    .insert(schema.memberTeams)
    .values({ id: managingTeamId, workspaceId, name: "notes" });
  const created = await agents.createAgent(owner, {
    slug: "notes",
    name: "Notes",
    managing_team_id: managingTeamId,
    card: card("i"),
  });
  const agentId = created.agent.id;
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
  await appStore.storeBotToken({
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

  let revision = -1;
  const release = async (instructions?: string) => {
    let versionId = created.versions[0]?.id ?? "";
    if (instructions !== undefined) {
      const updated = await agents.updateAgent(owner, agentId, {
        card: card(instructions),
      });
      versionId = updated.versions.at(-1)?.id ?? "";
    }
    return agents.createRelease(owner, agentId, {
      version_id: versionId,
      connection_id: "main",
    });
  };
  const activate = async (releaseId: string) => {
    const activated = await agents.activateAgent(owner, agentId, {
      release_id: releaseId,
      expected_revision: revision,
    });
    revision = activated.activation_revision;
    return activated;
  };
  const bind = (channelId: string, home: boolean) =>
    bindings.putSlackBinding(owner, agentId, {
      channel_id: channelId,
      mode: "on",
      home,
    });
  const approve = (binding: { id: string; revision: number }) =>
    bindings.approveSlackBinding(owner, agentId, binding.id, {
      revision: binding.revision,
    });
  const finalize = () =>
    welcome.finalize({ workspaceId, agentId } as SlackInstalled);
  const list = async () =>
    (await bindings.listSlackBindings(owner, agentId)).items;
  return {
    workspaceId,
    agentId,
    slackAppId,
    release,
    activate,
    bind,
    approve,
    finalize,
    list,
    bindingStore,
  };
}

const outboxRows = () =>
  db.select().from(slackOutbox).orderBy(asc(slackOutbox.seq));
const callsOf = (method: string) =>
  slack.calls.filter((call) => call.method === method).length;

function outboxPass() {
  const secrets = createPostgresSecretStore(db, key);
  const slackApi = createSlackBotApi({ apiUrl: slack.url });
  const botToken = (workspaceId: string, slackAppId: string) =>
    slackBotToken(secrets, workspaceId, slackAppId);
  return drainSlackOutbox({
    outbox: createPostgresSlackOutboxStore(db),
    slack: slackApi,
    botToken,
    delivery: createRowDelivery({
      slack: slackApi,
      botToken,
      consoleOrigin: null,
    }),
    logger,
    consoleOrigin: null,
    batchSize: 10,
    leaseMs: 30_000,
    deadline: Date.now() + 10_000,
  });
}

let eventCounter = 0;

async function invited(
  fixture: { workspaceId: string; agentId: string; slackAppId: string },
  channel: string,
) {
  const app = slack.conversations.find((candidate) => candidate.id === channel);
  app?.members.push(APP_ID);
  eventCounter += 1;
  const eventId = `EvJoin${eventCounter}`;
  const event = { type: "member_joined_channel", user: BOT_USER, channel };
  await createPostgresSlackInboundEventStore(db).record({
    workspaceId: fixture.workspaceId,
    agentId: fixture.agentId,
    slackAppId: fixture.slackAppId,
    teamId: TEAM,
    appId: APP_ID,
    eventId,
    eventType: "member_joined_channel",
    eventSubtype: null,
    eventTime: new Date(),
    status: "received",
    payload: { type: "event_callback", event_id: eventId, event },
    conversationKey: slackConversationKey(fixture.slackAppId, event),
  });
  return drainSlackInbox({
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
      slackApiUrl: slack.url,
    }),
    logger,
    batchSize: 10,
    leaseMs: 30_000,
    deadline: Date.now() + 10_000,
  });
}

async function settled(until: () => boolean) {
  for (let tick = 0; tick < 200 && !until(); tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe.each(ENGINES)("the deployment welcome on %s", (engine) => {
  useDatabase(engine);

  test("a public home is joined once and welcomed once, whatever release goes live", async () => {
    const [home] = slack.seedChannels([{ name: "home" }]);
    const channel = home?.id ?? "";
    const fixture = await installedAgent();

    const bound = await fixture.bind(channel, true);
    expect(bound.slack_binding.membership).toEqual({
      state: "joined",
      error: null,
    });
    expect(callsOf("conversations.join")).toBe(1);
    // Saving it again finds the bot there.
    await fixture.bind(channel, true);
    expect(callsOf("conversations.join")).toBe(1);
    // No release is live yet: nothing to announce.
    expect(await outboxRows()).toEqual([]);

    const { release: first } = await fixture.release();
    await fixture.activate(first.id);
    expect(await outboxRows()).toHaveLength(1);

    // The same definition again is the same release, and it is live.
    const again = await fixture.release();
    expect(again.created).toBe(false);
    expect((await fixture.activate(first.id)).receipt_id).toBeNull();
    expect(await outboxRows()).toHaveLength(1);

    // A new release in the same channel: it heard its welcome already.
    const { release: second } = await fixture.release("changed");
    await fixture.activate(second.id);
    await fixture.activate(first.id);

    const rows = await outboxRows();
    expect(rows.map((row) => row.dedupeKey)).toEqual([
      deploymentWelcomeKey(fixture.agentId, bound.slack_binding.id),
    ]);
    expect(rows[0]).toMatchObject({
      kind: "welcome",
      channelId: channel,
      threadTs: "",
      status: "pending",
    });

    expect(await outboxPass()).toMatchObject({ sent: 1 });
    expect(slack.messages).toEqual([
      expect.objectContaining({
        method: "chat.postMessage",
        channelId: channel,
        threadTs: null,
        text: slackWelcomeText("Notes"),
      }),
    ]);
    // No thread, so no thread status to clear.
    expect(slack.statuses).toEqual([]);
  });

  test("each home channel hears once: a moved home is welcomed, moving back is not", async () => {
    const [home, other] = slack.seedChannels([
      { name: "home" },
      { name: "other" },
    ]);
    const fixture = await installedAgent();
    const first = await fixture.bind(home?.id ?? "", true);
    const { release } = await fixture.release();
    await fixture.activate(release.id);
    const moved = await fixture.bind(other?.id ?? "", true);
    await fixture.finalize();
    const { release: second } = await fixture.release("changed");
    await fixture.activate(second.id);
    await fixture.bind(home?.id ?? "", true);
    await fixture.finalize();

    expect((await outboxRows()).map((row) => row.dedupeKey)).toEqual([
      deploymentWelcomeKey(fixture.agentId, first.slack_binding.id),
      deploymentWelcomeKey(fixture.agentId, moved.slack_binding.id),
    ]);
  });

  test("a home welcomed under the old per-release key is not welcomed again", async () => {
    const [home] = slack.seedChannels([{ name: "home" }]);
    const fixture = await installedAgent();
    const bound = await fixture.bind(home?.id ?? "", true);
    const { release } = await fixture.release();
    await fixture.activate(release.id);
    // What a welcome sent before 94S-1298 left behind.
    const legacy = `deployment-welcome:${fixture.agentId}:${release.id}:${bound.slack_binding.id}`;
    await db
      .update(slackOutbox)
      .set({ dedupeKey: legacy, status: "sent" })
      .where(eq(slackOutbox.kind, "welcome"));

    const { release: second } = await fixture.release("changed");
    await fixture.activate(second.id);
    await fixture.finalize();

    expect((await outboxRows()).map((row) => row.dedupeKey)).toEqual([legacy]);
  });

  test("a channel bound again after a disconnect is not welcomed again", async () => {
    const [home] = slack.seedChannels([{ name: "home" }]);
    const channel = home?.id ?? "";
    const fixture = await installedAgent();
    const before = await fixture.bind(channel, true);
    const { release } = await fixture.release();
    await fixture.activate(release.id);
    // What revoking the install's identity does to its bindings.
    await db
      .update(surfaceBindings)
      .set({ status: "revoked", home: false, revokedAt: new Date() })
      .where(eq(surfaceBindings.id, before.slack_binding.id));

    const after = await fixture.bind(channel, true);
    expect(after.slack_binding.id).not.toBe(before.slack_binding.id);
    await fixture.finalize();
    const { release: second } = await fixture.release("changed");
    await fixture.activate(second.id);

    expect((await outboxRows()).map((row) => row.dedupeKey)).toEqual([
      deploymentWelcomeKey(fixture.agentId, before.slack_binding.id),
    ]);
  });

  test("a private home waits for the invite and the approval: no row before them, one after, then duplicate", async () => {
    const [home] = slack.seedChannels([{ name: "secret", isPrivate: true }]);
    const channel = home?.id ?? "";
    const fixture = await installedAgent();
    const { release } = await fixture.release();
    await fixture.activate(release.id);

    const bound = await fixture.bind(channel, false);
    expect(bound.slack_binding.status).toBe("pending_approval");
    expect(bound.slack_binding.membership).toEqual({
      // Slack hides it from the bot until the invite.
      state: "awaiting_invite",
      error: "channel_not_found",
    });
    expect(callsOf("conversations.join")).toBe(0);
    await expect(fixture.bind(channel, true)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(await outboxRows()).toEqual([]);

    expect(await invited(fixture, channel)).toMatchObject({ processed: 1 });
    expect(await outboxRows()).toEqual([]);

    const [waiting] = await fixture.list();
    if (!waiting) throw new Error("no binding");
    await fixture.approve(waiting);
    await fixture.bind(channel, true);
    expect(await fixture.finalize()).toEqual({
      finalized: true,
      warnings: [],
    });
    expect(await outboxRows()).toHaveLength(1);
    // Finalize again, and the same event again, find it sent already.
    expect(await fixture.finalize()).toEqual({
      finalized: true,
      warnings: [],
    });
    await invited(fixture, channel);
    expect(await outboxRows()).toHaveLength(1);
    expect(callsOf("conversations.join")).toBe(0);
  });

  test("a rollback before the invite stays silent after it", async () => {
    const [home] = slack.seedChannels([{ name: "secret", isPrivate: true }]);
    const channel = home?.id ?? "";
    const fixture = await installedAgent();
    const bound = await fixture.bind(channel, false);
    const { release: first } = await fixture.release();
    const { release: second } = await fixture.release("changed");
    await fixture.activate(first.id);
    await fixture.activate(second.id);
    await fixture.activate(first.id);

    // The asks the activations left running may answer after the invite.
    expect(await invited(fixture, channel)).toMatchObject({ processed: 1 });
    const [waiting] = await fixture.list();
    if (!waiting) throw new Error("no binding");
    await fixture.approve(waiting);
    await fixture.bind(channel, true);
    await fixture.finalize();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await outboxRows()).toEqual([]);
    // Forward again to the newest: that one is announced.
    await fixture.activate(second.id);
    expect((await outboxRows()).map((row) => row.dedupeKey)).toEqual([
      deploymentWelcomeKey(fixture.agentId, bound.slack_binding.id),
    ]);
  });

  test("an activation never waits on Slack: an unchecked home is joined and welcomed after it returns", async () => {
    const [home] = slack.seedChannels([{ name: "later" }]);
    const channel = home?.id ?? "";
    const fixture = await installedAgent();
    // The kind lookup goes through; the membership one is rate limited,
    // so membership stays unknown.
    slack.rateLimit("conversations.info", 1, 1, 1);
    const bound = await fixture.bind(channel, true);
    expect(bound.slack_binding.membership).toBeUndefined();
    expect(callsOf("conversations.join")).toBe(0);

    const { release } = await fixture.release();
    await fixture.activate(release.id);
    await settled(() => callsOf("conversations.join") > 0);
    // The enqueue follows the join.
    for (let tick = 0; tick < 200; tick += 1) {
      if ((await outboxRows()).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(await outboxRows()).toHaveLength(1);
  });

  test("the insert itself checks the home and the active release", async () => {
    const [home, other] = slack.seedChannels([
      { name: "home" },
      { name: "other" },
    ]);
    const fixture = await installedAgent();
    const bound = await fixture.bind(home?.id ?? "", true);
    const elsewhere = await fixture.bind(other?.id ?? "", false);
    const { release } = await fixture.release();
    await fixture.activate(release.id);
    const [row] = await outboxRows();
    if (!row) throw new Error("no welcome");
    const outbox = createPostgresSlackOutboxStore(db);
    // Another channel: this one heard its welcome already.
    const entry = {
      ...row,
      channelId: "C0PROBE",
      dedupeKey: "deployment-welcome:probe",
    };
    const homeId = bound.slack_binding.id;

    expect(
      await outbox.enqueue(entry, {
        bindingId: elsewhere.slack_binding.id,
        releaseId: release.id,
      }),
    ).toBe("not_home");
    expect(
      await outbox.enqueue(entry, { bindingId: homeId, releaseId: "sha256:x" }),
    ).toBe("not_home");
    expect(await outboxRows()).toHaveLength(1);
    expect(
      await outbox.enqueue(entry, { bindingId: homeId, releaseId: release.id }),
    ).toBe("enqueued");

    // The welcomed channel's id again is a duplicate in its own team, and
    // another channel in another team.
    const live = { bindingId: homeId, releaseId: release.id };
    expect(
      await outbox.enqueue(
        { ...row, dedupeKey: "deployment-welcome:same" },
        live,
      ),
    ).toBe("duplicate");
    const elsewhereTeam = await registerSlackInstallation(db, {
      appId: "A0OTHERTEAM",
      teamId: "T0OTHER",
      workspaceId: row.workspaceId,
    });
    if (elsewhereTeam.outcome !== "registered") throw new Error("no install");
    expect(
      await outbox.enqueue(
        {
          ...row,
          installationId: elsewhereTeam.installation.id,
          dedupeKey: "deployment-welcome:other-team",
        },
        live,
      ),
    ).toBe("enqueued");

    // R1 → R2 → R1 while a welcome for R1 was on its way: R1 is active
    // again, and still a rollback.
    const { release: second } = await fixture.release("changed");
    await fixture.activate(second.id);
    await fixture.activate(release.id);
    expect(
      await outbox.enqueue(
        { ...entry, dedupeKey: "deployment-welcome:probe-2" },
        { bindingId: homeId, releaseId: release.id },
      ),
    ).toBe("not_home");
  });

  test("a membership answer from before an invite does not overwrite it", async () => {
    const [home] = slack.seedChannels([{ name: "secret", isPrivate: true }]);
    const fixture = await installedAgent();
    const bound = await fixture.bind(home?.id ?? "", false);
    const id = bound.slack_binding.id;
    const seen = bound.slack_binding.membership ?? null;
    await fixture.bindingStore.setMembership(id, {
      state: "joined",
      error: null,
    });
    await fixture.bindingStore.setMembership(
      id,
      { state: "awaiting_invite", error: null },
      seen,
    );
    expect((await fixture.list())[0]?.membership).toEqual({
      state: "joined",
      error: null,
    });
    // Against what it holds now, the write goes through.
    await fixture.bindingStore.setMembership(
      id,
      { state: "join_failed", error: "is_archived" },
      { state: "joined", error: null },
    );
    expect((await fixture.list())[0]?.membership).toEqual({
      state: "join_failed",
      error: "is_archived",
    });
  });

  test("a join Slack refuses leaves its cause on the binding and fails nothing", async () => {
    const [archived] = slack.seedChannels([{ name: "old", isArchived: true }]);
    const [locked] = slack.seedChannels([{ name: "locked" }]);
    const fixture = await installedAgent();
    const { release } = await fixture.release();
    await fixture.activate(release.id);

    expect(
      (await fixture.bind(archived?.id ?? "", false)).slack_binding.membership,
    ).toEqual({ state: "join_failed", error: "is_archived" });
    slack.failures.set("conversations.join", "restricted_action");
    expect(
      (await fixture.bind(locked?.id ?? "", true)).slack_binding.membership,
    ).toEqual({ state: "join_failed", error: "restricted_action" });
    // Retrying once the policy allows it joins and welcomes, once.
    slack.failures.clear();
    expect(
      (await fixture.bind(locked?.id ?? "", true)).slack_binding.membership,
    ).toEqual({ state: "joined", error: null });
    await fixture.bind(locked?.id ?? "", true);
    expect(await outboxRows()).toHaveLength(1);
    // What the console lists is what was stored.
    expect(
      (await fixture.list()).map((binding) => [
        binding.external_surface_id,
        binding.membership,
      ]),
    ).toEqual([
      [locked?.id, { state: "joined", error: null }],
      [archived?.id, { state: "join_failed", error: "is_archived" }],
    ]);
  });
});

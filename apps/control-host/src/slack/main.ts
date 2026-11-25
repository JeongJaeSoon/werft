import { integerSetting } from "@werft-ai/contracts/settings";
import * as schema from "@werft-ai/db";
import {
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentIdentityStore,
  createPostgresAgentStore,
  createPostgresCallerLimitGate,
  createPostgresCatalogRepositoryStore,
  createPostgresChannelMemberStore,
  createPostgresConversationStore,
  createPostgresCredentialBindingStore,
  createPostgresDecisionLog,
  createPostgresInstallationSettingsStore,
  createPostgresJudgmentBufferStore,
  createPostgresLinkedAccountStore,
  createPostgresSecretStore,
  createPostgresSessionControl,
  createPostgresSessionLinkStore,
  createPostgresSessionReader,
  createPostgresSessionShareStore,
  createPostgresSessionUnitOfWork,
  createPostgresSlackAppStore,
  createPostgresSlackGuestSetting,
  createPostgresSlackInboundEventStore,
  createPostgresSlackOutboxStore,
  createPostgresSlackThreadBotTurnStore,
  createPostgresSurfaceBindingStore,
  type Database,
  getSlackAppSettings,
  newSessionGitHubReaders,
} from "@werft-ai/db";
import {
  createEnforcedPool,
  JOB_POOL_TIMEOUTS,
  SEQUENTIAL_ROLE_POOL_MAX,
} from "@werft-ai/db/pool";
import {
  createLogger,
  logLevelFromEnv,
  type StructuredLogger,
} from "@werft-ai/observability";
import {
  agentReleaseReaders,
  createAuthorizationPolicy,
  createCatalogRegistry,
  createSessionService,
  pushRequesterLeft,
  readerOutsideChannels,
  registryCatalog,
  repositoryView,
  type SecretKey,
  type SurfaceInboundEventStore,
  type SurfaceOutboxClaim,
  settingsView,
  withConsoleRepositories,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import {
  loadSecretKey,
  runtimeVersionsFromEnv,
} from "../api/catalog-config.ts";
import { extensionDepsFor } from "../api/extension-deps.ts";
import { eventNeutralizer } from "../api/neutral-fields.ts";
import { consoleOriginFrom, slackApiUrlFrom } from "../api/slack-config.ts";
import { booleanFlag } from "../boolean-flag.ts";
import { queueDatabaseUrl } from "../database-url.ts";
import { PASS_LOOP_ROLES, passLoopConfigFromEnv } from "../pass-loop/loop.ts";
import {
  createOutboxSlackNoticeSink,
  createSlackAudienceCache,
  drainSlackInbox,
  drainSlackOutbox,
  SLACK_INPUT_HOLD_MS,
  type SlackAudienceCache,
  type SlackInboundHandler,
  type SlackInboxDrain,
  type SlackNoticeSink,
} from "../wiring/chat-slack.ts";
import { installationConfigOf } from "../wiring/installation-config.ts";
import { releaseStartableIn } from "../wiring/release-startable.ts";
import { wireSlackChannelMembers } from "../wiring/slack-api.ts";
import { wireSlackInbound, wireSlackOutbound } from "../wiring/slack-worker.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export function slackRoleSettings(environment: Environment): {
  batchSize: number;
  leaseMs: number;
  passBudgetMs: number;
  inputHoldMs: number;
  closeLinks: boolean;
} {
  const { passTimeoutMs } = passLoopConfigFromEnv(
    environment,
    PASS_LOOP_ROLES.slack,
  );
  return {
    batchSize: integerSetting(environment, "SLACK_ROLE_BATCH_SIZE", {
      min: 1,
      default: 10,
    }),
    leaseMs:
      integerSetting(environment, "SLACK_ROLE_LEASE_SEC", {
        min: 1,
        default: 60,
      }) * 1000,
    passBudgetMs: passTimeoutMs / 2,
    inputHoldMs:
      integerSetting(environment, "SLACK_ROLE_INPUT_HOLD_SEC", {
        min: 1,
        default: SLACK_INPUT_HOLD_MS / 1000,
      }) * 1000,
    closeLinks: booleanFlag(
      environment.SLACK_ROLE_CLOSE_LINKS ?? "true",
      "SLACK_ROLE_CLOSE_LINKS",
    ),
  };
}

/** The inbox a pass drains, holding to the installation's buffer limit. */
export function slackInbox(
  db: Database,
  logger: Pick<StructuredLogger, "info" | "warn">,
) {
  const config = installationConfigOf(db, logger);
  return createPostgresSlackInboundEventStore(db, {
    bufferLimit: () => config.get("judgment_buffer_limit_per_channel"),
    logger,
  });
}

export function slackRoleStartup(environment: Environment): {
  secretKey: SecretKey;
} {
  slackRoleSettings(environment);
  queueDatabaseUrl(environment);
  return { secretKey: loadSecretKey(environment) };
}

export function slackCatalog(db: Database, environment: Environment) {
  const runtimeVersions = runtimeVersionsFromEnv(environment);
  return registryCatalog(
    {
      repositories: {},
      ...(runtimeVersions === undefined
        ? {}
        : { runtime_versions: runtimeVersions }),
    },
    createCatalogRegistry({
      repositories: createPostgresCatalogRepositoryStore(db),
      settings: {
        read: async () =>
          settingsView(
            await createPostgresInstallationSettingsStore(db, null).read(),
            () => SLACK_ROLE_CREDENTIAL,
          ),
      },
    }),
    // The api's catalog, so a release the console's repositories allow runs
    // here too.
    (rows, settings) => slackRepositoryViews(rows, settings?.repositories),
  );
}

export function slackRepositoryViews(
  ...args: Parameters<typeof withConsoleRepositories>
) {
  return Object.fromEntries(
    Object.entries(withConsoleRepositories(...args)).map(([id, repository]) => [
      id,
      repositoryView(repository),
    ]),
  );
}

// Stands in for every credential in the slack role's settings: never sent.
const SLACK_ROLE_CREDENTIAL = "slack-role-holds-no-credential";

export function slackSessionHandler(deps: {
  db: Database;
  pool: Pick<Pool, "connect">;
  environment: Environment;
  logger: StructuredLogger;
  secretKey: SecretKey;
  leaseMs: number;
  notices: SlackNoticeSink;
  slackApiUrl?: string;
  inbox?: Pick<SurfaceInboundEventStore, "renew">;
  /** The pass's catalog, already read. No timer reads it again. */
  catalog?: ReturnType<typeof slackCatalog>;
  /** Slack's answers about channels and people, kept across passes. */
  audienceCache?: SlackAudienceCache;
}): SlackInboundHandler {
  const { db, environment, logger } = deps;
  const catalog = deps.catalog ?? slackCatalog(db, environment);
  const credentials = createPostgresCredentialBindingStore(db);
  const authorization = createAuthorizationPolicy({
    identity: createDatabaseIdentityReader(db),
    agents: createDatabaseAgentAuthority(db),
    credentials,
    slackGuests: createPostgresSlackGuestSetting(db),
    sessions: createPostgresSessionShareStore(db),
    // A press on a card outside the session's channel asks Slack.
    channelMembers: wireSlackChannelMembers({
      apiUrl: deps.slackApiUrl ?? slackApiUrlFrom(environment),
      appStore: createPostgresSlackAppStore(db, deps.secretKey),
      secrets: () => createPostgresSecretStore(db, deps.secretKey),
      store: createPostgresChannelMemberStore(db),
      logger,
    }),
    decisions: createPostgresDecisionLog(db),
    logger,
  });
  const agentStore = createPostgresAgentStore(db);
  const sessions = createSessionService({
    authorization,
    inputs: createPostgresSessionUnitOfWork(db),
    controls: createPostgresSessionControl(db, {
      connect: () => deps.pool.connect(),
      logger,
    }),
    reader: createPostgresSessionReader(db, {
      logger,
      neutralize: eventNeutralizer(logger),
    }),
    catalog,
    releases: {
      ...agentReleaseReaders(agentStore, catalog),
      ...newSessionGitHubReaders(db),
    },
    extensions: extensionDepsFor(db),
    credentials,
    callerLimits: createPostgresCallerLimitGate(db, logger),
    limits: installationConfigOf(db, logger).sessionLimits,
  });
  const { secretKey } = deps;
  const secrets = createPostgresSecretStore(db, secretKey);
  const consoleOrigin = consoleOriginFrom(environment);
  const identities = createPostgresAgentIdentityStore(db);
  const bindings = createPostgresSurfaceBindingStore(db);
  return wireSlackInbound({
    ...(deps.audienceCache === undefined
      ? {}
      : { audienceCache: deps.audienceCache }),
    apiUrl: deps.slackApiUrl ?? slackApiUrlFrom(environment),
    secrets,
    consoleOrigin,
    inbox: deps.inbox ?? createPostgresSlackInboundEventStore(db),
    leaseMs: deps.leaseMs,
    authorization,
    identities,
    links: createPostgresLinkedAccountStore(db),
    bindings,
    members: createPostgresChannelMemberStore(db),
    settings: {
      getSettings: (workspaceId, agentId) =>
        getSlackAppSettings(db, workspaceId, agentId),
    },
    botTurns: createPostgresSlackThreadBotTurnStore(db),
    sessionLinks: createPostgresSessionLinkStore(db),
    conversations: createPostgresConversationStore(db),
    buffer: createPostgresJudgmentBufferStore(db),
    sessions,
    agentDetails: agentStore,
    releaseRepositoryUnusable: async (workspaceId, releaseId) => {
      const release = await agentStore.findRelease(workspaceId, releaseId);
      return (
        release !== null &&
        !(await releaseStartableIn(db, catalog, workspaceId, release))
      );
    },
    notices: deps.notices,
    welcomeAgents: agentStore,
    welcomeApps: createPostgresSlackAppStore(db, secretKey),
    welcomeOutbox: createPostgresSlackOutboxStore(db),
    cards: createPostgresSlackOutboxStore(db).cards,
    logger,
  });
}

/** The card's label and the policy ask the same question (answer 15). */
function slackPushRequesterLeft(
  db: Database,
  secretKey: SecretKey,
  environment: Environment,
  logger: StructuredLogger,
) {
  const deps = {
    sessions: createPostgresSessionShareStore(db),
    channelMembers: wireSlackChannelMembers({
      apiUrl: slackApiUrlFrom(environment),
      appStore: createPostgresSlackAppStore(db, secretKey),
      secrets: () => createPostgresSecretStore(db, secretKey),
      store: createPostgresChannelMemberStore(db),
      logger,
    }),
    logger,
  };
  return (push: Parameters<typeof pushRequesterLeft>[1]) =>
    pushRequesterLeft(deps, push);
}

/** A session's direct message goes only to someone who can see it. */
function slackReaderOutside(
  db: Database,
  secretKey: SecretKey,
  environment: Environment,
  logger: StructuredLogger,
) {
  const sessions = createPostgresSessionShareStore(db);
  const members = wireSlackChannelMembers({
    apiUrl: slackApiUrlFrom(environment),
    appStore: createPostgresSlackAppStore(db, secretKey),
    secrets: () => createPostgresSecretStore(db, secretKey),
    store: createPostgresChannelMemberStore(db),
    logger,
  });
  // The account the row is addressed to, in the row's install: a person
  // who relinked since is not asked about in its place.
  return async (claim: SurfaceOutboxClaim) =>
    claim.sessionId !== null &&
    (await readerOutsideChannels(
      { sessions },
      {
        workspaceId: claim.workspaceId,
        sessionId: claim.sessionId,
        membership: (place) =>
          members.slackMembership({
            workspaceId: claim.workspaceId,
            agentId: place.agentId.toLowerCase(),
            channelId: place.channelId,
            installationId: claim.installationId,
            slackUserId: claim.channelId,
          }),
      },
    ));
}

// The pass child serves pass after pass, so this flips each pass: statuses
// and posts take turns at the start of the outbox window.
let statusesFirst = false;
const audienceCache = createSlackAudienceCache();
function nextStatusesFirst(): boolean {
  statusesFirst = !statusesFirst;
  return statusesFirst;
}

export async function main(
  environment: Environment = process.env,
): Promise<SlackInboxDrain> {
  const settings = slackRoleSettings(environment);
  const logger = createLogger({
    level: logLevelFromEnv(environment.LOG_LEVEL),
  });
  const pool = createEnforcedPool(
    queueDatabaseUrl(environment),
    logger,
    "slack",
    JOB_POOL_TIMEOUTS,
    { max: SEQUENTIAL_ROLE_POOL_MAX },
  );
  try {
    const db = drizzle(pool, { schema });
    // Inbox and outbox share one pass budget. The inbox stops at half of it,
    // so a steady stream of mentions cannot starve the answers.
    const started = Date.now();
    const deadline = started + settings.passBudgetMs;
    const { secretKey } = slackRoleStartup(environment);
    const catalog = slackCatalog(db, environment);
    await catalog.refresh();
    const outbox = createPostgresSlackOutboxStore(db, {
      neutralize: eventNeutralizer(logger),
    });
    const drain = await drainSlackInbox({
      inbox: slackInbox(db, logger),
      handler: slackSessionHandler({
        db,
        pool,
        environment,
        logger,
        secretKey,
        leaseMs: settings.leaseMs,
        notices: createOutboxSlackNoticeSink(outbox),
        catalog,
        audienceCache,
      }),
      logger,
      batchSize: settings.batchSize,
      leaseMs: settings.leaseMs,
      deadline: started + settings.passBudgetMs / 2,
    });
    if (drain.claimed > 0) logger.info("Slack inbox pass", drain);
    const secrets = createPostgresSecretStore(db, secretKey);
    const consoleOrigin = consoleOriginFrom(environment);
    const {
      api: slackApi,
      botToken,
      delivery,
    } = wireSlackOutbound({
      apiUrl: slackApiUrlFrom(environment),
      secrets,
      consoleOrigin,
      readerOutside: slackReaderOutside(db, secretKey, environment, logger),
    });
    const sent = await drainSlackOutbox({
      outbox,
      slack: slackApi,
      botToken,
      delivery,
      bindings: createPostgresSurfaceBindingStore(db),
      logger,
      consoleOrigin,
      batchSize: settings.batchSize,
      leaseMs: settings.leaseMs,
      deadline,
      statusesFirst: nextStatusesFirst(),
      requesterLeft: slackPushRequesterLeft(db, secretKey, environment, logger),
      inputHoldMs: settings.inputHoldMs,
      closeLinks: settings.closeLinks,
    });
    if (sent.enqueued + sent.claimed + sent.uncertain + sent.linksClosed > 0) {
      logger.info("Slack outbox pass", sent);
    }
    return drain;
  } finally {
    await pool.end();
  }
}

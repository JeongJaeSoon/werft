import { integerSetting } from "@werft-ai/contracts/settings";
import * as schema from "@werft-ai/db";
import {
  agentGitHubSettingsOf,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAgentAccessSetting,
  createPostgresAgentIdentityStore,
  createPostgresAgentStore,
  createPostgresCatalogRepositoryStore,
  createPostgresCredentialBindingStore,
  createPostgresDecisionLog,
  createPostgresInstallationProfileStore,
  createPostgresInstallationSettingsStore,
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
  createPostgresSurfaceBindingStore,
  createPostgresWorkspaceProfileStore,
  type Database,
  getSlackAppSettings,
  newSessionGitHubReaders,
  workspaceRepositoryCeiling,
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
  agentEnvNames,
  createAuthorizationPolicy,
  createLoggingSlackNoticeSink,
  createOutboxSlackNoticeSink,
  createProfileRegistry,
  createSessionService,
  createSlackBotApi,
  createSlackMemberJoinedHandler,
  createSlackMemberLeftHandler,
  createSlackSessionHandler,
  createSlackWelcome,
  drainSlackInbox,
  drainSlackOutbox,
  installationLimitsFromEnv,
  profileCatalog,
  releaseStartable,
  repositoryView,
  resolveAgentRelease,
  type SecretKey,
  type SlackInboundEventStore,
  type SlackInboundHandler,
  type SlackInboxDrain,
  type SlackNoticeSink,
  settingsView,
  slackBotToken,
  withConsoleRepositories,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import {
  loadSecretKey,
  profileViewSources,
  refuseFileCatalog,
  runtimeVersionsFromEnv,
} from "../api/catalog-config.ts";
import { extensionDepsFor } from "../api/extension-deps.ts";
import { eventNeutralizer } from "../api/neutral-fields.ts";
import { consoleOriginFrom, slackApiUrlFrom } from "../api/slack-config.ts";
import { PASS_LOOP_ROLES, passLoopConfigFromEnv } from "../pass-loop/loop.ts";

type Environment = Readonly<Record<string, string | undefined>>;

function slackDatabaseUrl(environment: Environment): string {
  const databaseUrl =
    environment.DATABASE_URL || environment.QUEUE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or QUEUE_DATABASE_URL is required");
  }
  return databaseUrl;
}

export function slackRoleSettings(environment: Environment): {
  batchSize: number;
  leaseMs: number;
  passBudgetMs: number;
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
  };
}

export function slackRoleStartup(environment: Environment): {
  secretKey: SecretKey;
} {
  slackRoleSettings(environment);
  slackDatabaseUrl(environment);
  refuseFileCatalog(environment);
  return { secretKey: loadSecretKey(environment) };
}

export function slackProfileCatalog(db: Database, environment: Environment) {
  const runtimeVersions = runtimeVersionsFromEnv(environment);
  return profileCatalog(
    {
      repositories: {},
      ...(runtimeVersions === undefined
        ? {}
        : { runtime_versions: runtimeVersions }),
    },
    createProfileRegistry({
      workspaces: createPostgresWorkspaceProfileStore(db),
      installations: createPostgresInstallationProfileStore(db),
      repositories: createPostgresCatalogRepositoryStore(db),
      settings: {
        read: async () =>
          settingsView(
            await createPostgresInstallationSettingsStore(db, null).read(),
            () => SLACK_ROLE_CREDENTIAL,
          ),
      },
      sources: profileViewSources(environment),
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
  notices?: SlackNoticeSink;
  slackApiUrl?: string;
  inbox?: Pick<SlackInboundEventStore, "renew">;
  /**
   * The pass's catalog, already read. No timer reads it again: the pass
   * child outlives the pass, and lookups of an unread id read it themselves.
   */
  profiles?: ReturnType<typeof slackProfileCatalog>;
}): SlackInboundHandler {
  const { db, environment, logger } = deps;
  const catalog = deps.profiles ?? slackProfileCatalog(db, environment);
  const credentials = createPostgresCredentialBindingStore(db);
  const authorization = createAuthorizationPolicy({
    identity: createDatabaseIdentityReader(db),
    agents: createDatabaseAgentAuthority(db),
    credentials,
    slackGuests: createPostgresSlackGuestSetting(db),
    outsideAgents: createPostgresAgentAccessSetting(db),
    sessions: createPostgresSessionShareStore(db),
    decisions: createPostgresDecisionLog(db),
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
      neutralize: eventNeutralizer(catalog, logger),
    }),
    catalog,
    releases: {
      resolveRelease: (workspaceId, releaseId) =>
        resolveAgentRelease(
          { store: agentStore, catalog },
          workspaceId,
          releaseId,
        ),
      envNames: (workspaceId, releaseId) =>
        agentEnvNames(agentStore, workspaceId, releaseId),
      ...newSessionGitHubReaders(db),
    },
    extensions: extensionDepsFor(db),
    credentials,
    limits: installationLimitsFromEnv(environment),
  });
  const { secretKey } = deps;
  const secrets = createPostgresSecretStore(db, secretKey);
  const consoleOrigin = consoleOriginFrom(environment);
  const identities = createPostgresAgentIdentityStore(db);
  const bindings = createPostgresSurfaceBindingStore(db);
  const slackApi = createSlackBotApi({
    apiUrl: deps.slackApiUrl ?? slackApiUrlFrom(environment),
  });
  const sessionHandler = createSlackSessionHandler({
    inbox: deps.inbox ?? createPostgresSlackInboundEventStore(db),
    leaseMs: deps.leaseMs,
    authorization,
    agents: identities,
    links: createPostgresLinkedAccountStore(db),
    bindings,
    settings: {
      getSettings: (workspaceId, agentId) =>
        getSlackAppSettings(db, workspaceId, agentId),
    },
    sessionLinks: createPostgresSessionLinkStore(db),
    sessions,
    agentDetails: agentStore,
    releaseRepositoryUnusable: async (workspaceId, releaseId) => {
      const release = await agentStore.findRelease(workspaceId, releaseId);
      return (
        release !== null &&
        !releaseStartable(
          catalog,
          release,
          await agentGitHubSettingsOf(db, release.agent_id),
          await workspaceRepositoryCeiling(db, workspaceId),
        )
      );
    },
    slack: slackApi,
    botToken: (workspaceId, slackAppId) =>
      slackBotToken(secrets, workspaceId, slackAppId),
    notices: deps.notices ?? createLoggingSlackNoticeSink(logger),
    logger,
    connectUrl:
      consoleOrigin === null
        ? ""
        : new URL("/settings/linked-accounts", consoleOrigin).toString(),
  });
  const memberJoined = createSlackMemberJoinedHandler({
    agents: identities,
    bindings,
    welcome: createSlackWelcome({
      agents: agentStore,
      bindings,
      apps: createPostgresSlackAppStore(db, secretKey),
      outbox: createPostgresSlackOutboxStore(db),
      join: null,
      logger,
    }),
    slack: slackApi,
    botToken: (workspaceId, slackAppId) =>
      slackBotToken(secrets, workspaceId, slackAppId),
    next: sessionHandler,
  });
  return createSlackMemberLeftHandler({
    agents: identities,
    bindings,
    next: memberJoined,
  });
}

// The pass child serves pass after pass, so this flips each pass: statuses
// and posts take turns at the start of the outbox window.
let statusesFirst = false;
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
    slackDatabaseUrl(environment),
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
    const profiles = slackProfileCatalog(db, environment);
    await profiles.workspace_profiles.refresh();
    const outbox = createPostgresSlackOutboxStore(db, {
      neutralize: eventNeutralizer(profiles, logger),
    });
    const drain = await drainSlackInbox({
      inbox: createPostgresSlackInboundEventStore(db),
      handler: slackSessionHandler({
        db,
        pool,
        environment,
        logger,
        secretKey,
        leaseMs: settings.leaseMs,
        notices: createOutboxSlackNoticeSink(outbox),
        profiles,
      }),
      logger,
      batchSize: settings.batchSize,
      leaseMs: settings.leaseMs,
      deadline: started + settings.passBudgetMs / 2,
    });
    if (drain.claimed > 0) logger.info("Slack inbox pass", drain);
    const secrets = createPostgresSecretStore(db, secretKey);
    const sent = await drainSlackOutbox({
      outbox,
      slack: createSlackBotApi({ apiUrl: slackApiUrlFrom(environment) }),
      botToken: (workspaceId, slackAppId) =>
        slackBotToken(secrets, workspaceId, slackAppId),
      logger,
      consoleOrigin: consoleOriginFrom(environment),
      batchSize: settings.batchSize,
      leaseMs: settings.leaseMs,
      deadline,
      statusesFirst: nextStatusesFirst(),
    });
    if (sent.enqueued + sent.claimed + sent.uncertain > 0) {
      logger.info("Slack outbox pass", sent);
    }
    return drain;
  } finally {
    await pool.end();
  }
}

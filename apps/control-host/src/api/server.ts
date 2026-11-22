import { REQUEST_BODY_MAX_BYTES } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentDeleted,
  closeAgentlessSessions,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAchievementJudgments,
  createPostgresAchievementRuleStore,
  createPostgresAgentAdminStore,
  createPostgresAgentCallerLimitsStore,
  createPostgresAgentGitHubStore,
  createPostgresAgentIdentityStore,
  createPostgresAgentStore,
  createPostgresAgentUsageStore,
  createPostgresAgentWorkspaceMcpStore,
  createPostgresAuditLogReader,
  createPostgresAuditRetention,
  createPostgresCallerLimitGate,
  createPostgresCatalogRepositoryStore,
  createPostgresCommitAttributionLedger,
  createPostgresCredentialBindingStore,
  createPostgresDecisionLog,
  createPostgresEnvVariableStore,
  createPostgresExtensionBundleStore,
  createPostgresGitHubAppManifestStore,
  createPostgresGitHubAppStore,
  createPostgresGitHubGateStore,
  createPostgresGitHubInstallationStore,
  createPostgresGitHubMcpStore,
  createPostgresGitHubOAuthStore,
  createPostgresGitHubPackagesStore,
  createPostgresGitHubPinStore,
  createPostgresGitHubSettingsStore,
  createPostgresInstallationConfigStore,
  createPostgresInstallationSettingsStore,
  createPostgresInviteStore,
  createPostgresJudgmentEgress,
  createPostgresLinkedAccountStore,
  createPostgresLoginMethodStore,
  createPostgresLoginProviderAdminStore,
  createPostgresLoginProviderStore,
  createPostgresLoginSettingsStore,
  createPostgresMcpEgressStore,
  createPostgresMemberStore,
  createPostgresPendingRequests,
  createPostgresPullRequestDrain,
  createPostgresPullRequestSettingsStore,
  createPostgresPullRequests,
  createPostgresPushFollowUpStore,
  createPostgresPushIntents,
  createPostgresPushRequests,
  createPostgresRepositoryAttachments,
  createPostgresRepositoryPins,
  createPostgresSecretStore,
  createPostgresSessionAttributionStore,
  createPostgresSessionControl,
  createPostgresSessionOutcomes,
  createPostgresSessionReader,
  createPostgresSessionShareStore,
  createPostgresSessionTitleStore,
  createPostgresSessionUnitOfWork,
  createPostgresSettingsDocumentStore,
  createPostgresSkillGitSourceStore,
  createPostgresSlackAppStore,
  createPostgresSlackConfigTokenStore,
  createPostgresSlackGuestSetting,
  createPostgresSlackInboundEventStore,
  createPostgresSlackInstallStore,
  createPostgresSlackOutboxStore,
  createPostgresSlackSettingsStore,
  createPostgresSurfaceBindingStore,
  createPostgresTeamStore,
  createPostgresTurnInterrupts,
  createPostgresUsageReader,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
  createPostgresWorkspaceKeyStore,
  createPostgresWorkspaceMcpEgressStore,
  createPostgresWorkspaceMcpStore,
  createProviderExchangeLedger,
  hasUncollectedCheckpoint,
  newSessionGitHubReaders,
  reconcileRetiredCatalogDrafts,
  slackAppKind,
  workspaceRepositoryCeiling,
} from "@werft-ai/db";
import {
  createLogger,
  createTelemetryPolicy,
  noopTracer,
  parseTracingSettings,
  sanitizeText,
  type Tracer,
} from "@werft-ai/observability";
import {
  type AuthorizationPolicy,
  admitsReservations,
  CATALOG_REFRESH_MS,
  createAchievementJudge,
  createAchievementRuleService,
  createAgentAdminService,
  createAgentCallerLimitsService,
  createAgentGitHubService,
  createAgentIdentityService,
  createAgentPullRequestService,
  createAgentService,
  createAgentUsageService,
  createAgentWorkspaceMcpService,
  createApiKeyService,
  createAuditLogService,
  createAuthorizationPolicy,
  createCatalogRegistry,
  createCredentialBindingService,
  createDecisionsClient,
  createEnvVariableService,
  createExtensionBundleService,
  createGitHubAppService,
  createGitHubConnectionResolver,
  createGitHubGate,
  createGitHubMcpServer,
  createGitHubPackagesService,
  createGitHubPackagesTokenVerifier,
  createGitHubRepositoryService,
  createGitHubSettingsService,
  createGitHubWorkService,
  createInterruptService,
  createInviteService,
  createLinkedAccountService,
  createMemberService,
  createModelMoveRunner,
  createOutcomeRefresher,
  createPendingRequestService,
  createPullRequestDrain,
  createPullRequestService,
  createPushExecutor,
  createPushIntentRunner,
  createPushRequestService,
  createRepositoryAttachmentService,
  createSessionAchievementService,
  createSessionAttributionService,
  createSessionOutcomeService,
  createSessionOutputService,
  createSessionService,
  createSessionShareService,
  createSessionTitler,
  createSettingsConsoleService,
  createSettingsDocumentService,
  createSkillGitSync,
  createSkillService,
  createSurfaceBindingService,
  createTeamService,
  createUsageService,
  createWorkerGateway,
  createWorkspaceMcpService,
  derivedSecretKey,
  GITHUB_API_BASE,
  InstallationConfigError,
  installationLimitsFromEnv,
  messageOf,
  registryCatalog,
  resolveAgentRelease,
  SessionServiceError,
  SKILL_DAILY_CHECK_PASS_MS,
  settingsJudgeConnections,
  withConsoleRepositories,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import { forgettingChannelsOnBindingPut } from "../wiring/chat-slack.ts";
import {
  wireAppBotUsers,
  wireGitHubAppDirectory,
  wireGitHubConnections,
  wireGitHubManifestConverter,
  wireGitHubRegistry,
  wireGitHubSkillReader,
  wireGitPusher,
} from "../wiring/github-api.ts";
import { createInstallationConfigSource } from "../wiring/installation-config.ts";
import { releaseStartableIn } from "../wiring/release-startable.ts";
import {
  type SlackServicesStageDeps,
  wireSlackBot,
  wireSlackChannels,
  wireSlackConfig,
  wireSlackInteractions,
  wireSlackServices,
} from "../wiring/slack-api.ts";
import { createAccountLinkCookies } from "./account-link-cookie.ts";
import {
  API_READINESS_REQUIRED_ENV,
  ApiSettingsError,
  apiReadinessConfigProblems,
  apiSettingsFromEnv,
} from "./api-settings.ts";
import { createApiApp } from "./app.ts";
import { DatabaseIdentityStore } from "./auth.ts";
import {
  installedRuntimeVersions,
  launchableKindsFromEnv,
  loadSecretKey,
  runtimeVersionsFromEnv,
} from "./catalog-config.ts";
import {
  archivedEventSource,
  assertCheckpointBucketEncryption,
  assertCheckpointBucketProtection,
  assertCheckpointObjectsPresent,
  checkpointGitMemoryBytesFromEnv,
  checkpointObjectRouteSigner,
  checkpointStorageConfigFromEnv,
  createApiCheckpoints,
  extensionBundleObjects,
  extensionBundleSource,
} from "./checkpoints.ts";
import {
  createEgressAuthorizer,
  egressAuthorizerConfigFromEnv,
  githubMcpGrantKeyOf,
  sessionTitleEgressUrlFromEnv,
} from "./egress-authorizer.ts";
import { extensionDepsFor } from "./extension-deps.ts";
import { githubCallbackUrl } from "./github-link.ts";
import {
  githubPackagesConfigFromEnv,
  githubPackagesOutbound,
} from "./github-packages-config.ts";
import {
  createInstallationConfigAdmin,
  sessionArchiveStatusOf,
} from "./installation-config.ts";
import { leftOutReporter, settingsSource } from "./installation-settings.ts";
import { DatabaseApiKeyStore, generateApiKey, hashApiKey } from "./keys.ts";
import { createLoginSettingsAdmin } from "./login-settings.ts";
import { eventNeutralizer, startNeutralFill } from "./neutral-fields.ts";
import { endpointProblem } from "./oidc/provider-http.ts";
import { oneHostOutbound } from "./outbound-http.ts";
import { PasswordChecks } from "./password-checks.ts";
import { createApiPool, createProbePool } from "./pool.ts";
import { createProviderAdmin } from "./provider-admin.ts";
import { createProviderLogin } from "./provider-login.ts";
import { createSlackEventsLimiter } from "./rate-limit.ts";
import { createReadinessProbe } from "./readiness.ts";
import { RequestTracing } from "./request-tracing.ts";
import { registerAgentPullRequestRoutes } from "./routes/action/agent-pull-request.ts";
import { registerPullRequestRoutes } from "./routes/action/pull-requests.ts";
import { registerPushRequestRoutes } from "./routes/action/push-requests.ts";
import { registerAgentWorkspaceMcpRoutes } from "./routes/agents/agent-mcp.ts";
import {
  refuseDeletedAgents,
  registerAgentRoutes,
} from "./routes/agents/agents.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerAgentGitHubRoutes } from "./routes/github/agent-github.ts";
import { registerGitHubAppRoutes } from "./routes/github/github-app.ts";
import { registerGitHubPackagesRoutes } from "./routes/github/github-packages.ts";
import { registerGitHubRepositoryRoutes } from "./routes/github/github-repositories.ts";
import { registerGitHubSettingsRoutes } from "./routes/github/github-settings.ts";
import {
  githubWebhookUrlFrom,
  registerGitHubWebhookRoutes,
} from "./routes/github/github-webhook.ts";
import {
  registerGitHubWorkRoutes,
  registerSessionAttributionRoutes,
  registerSessionOutcomeRoutes,
} from "./routes/github/github-work.ts";
import { registerInstallationConfigRoutes } from "./routes/installation-config.ts";
import {
  registerInstallationSettingsRoutes,
  registerSettingsConsoleRoutes,
} from "./routes/installation-settings.ts";
import { registerLoginProviderRoutes } from "./routes/login-providers.ts";
import { registerLoginSettingsRoutes } from "./routes/login-settings.ts";
import { registerAgentCallerLimitsRoutes } from "./routes/musterrolle/agent-caller-limits.ts";
import { registerAgentIdentityRoutes } from "./routes/musterrolle/agent-identities.ts";
import { registerAgentUsageRoutes } from "./routes/musterrolle/agent-usage.ts";
import { registerApiKeyRoutes } from "./routes/musterrolle/api-keys.ts";
import { registerAuditLogRoutes } from "./routes/musterrolle/audit-log.ts";
import { registerCredentialBindingRoutes } from "./routes/musterrolle/credential-bindings.ts";
import { registerEnvVariableRoutes } from "./routes/musterrolle/env-variables.ts";
import {
  registerInviteRoutes,
  registerPublicInviteRoutes,
} from "./routes/musterrolle/invites.ts";
import { registerLinkedAccountRoutes } from "./routes/musterrolle/linked-accounts.ts";
import { registerMemberRoutes } from "./routes/musterrolle/members.ts";
import { registerSessionShareRoutes } from "./routes/musterrolle/session-shares.ts";
import { registerSkillRoutes } from "./routes/musterrolle/skills.ts";
import { registerTeamRoutes } from "./routes/musterrolle/teams.ts";
import { registerWorkspaceMcpServerRoutes } from "./routes/musterrolle/workspace-mcp-servers.ts";
import { registerWorkspaceRoutes } from "./routes/musterrolle/workspaces.ts";
import {
  registerAchievementRoutes,
  registerSessionAchievementRoutes,
} from "./routes/sessions/achievements.ts";
import { registerCloseRoutes } from "./routes/sessions/close.ts";
import { registerEventRoutes } from "./routes/sessions/events.ts";
import { registerInterruptRoutes } from "./routes/sessions/interrupt.ts";
import { registerSessionOutputRoutes } from "./routes/sessions/outputs.ts";
import { registerPauseRoutes } from "./routes/sessions/pause.ts";
import { registerPendingRoutes } from "./routes/sessions/pending.ts";
import { registerReceiptRoutes } from "./routes/sessions/receipts.ts";
import { registerSessionRoutes } from "./routes/sessions/sessions.ts";
import { registerSlackAppRoutes } from "./routes/surface/slack-apps.ts";
import { registerSlackBindingRoutes } from "./routes/surface/slack-bindings.ts";
import { registerSlackChannelRoutes } from "./routes/surface/slack-channels.ts";
import { registerSlackEventRoutes } from "./routes/surface/slack-events.ts";
import { registerSlackInstallRoutes } from "./routes/surface/slack-install.ts";
import { registerSlackInteractionRoutes } from "./routes/surface/slack-interactions.ts";
import { registerSlackSecretRoutes } from "./routes/surface/slack-secrets.ts";
import { registerSlackSettingsRoutes } from "./routes/surface/slack-settings.ts";
import { registerUsageRoutes } from "./routes/usage/usage.ts";
import { registerWorkerRoutes } from "./routes/workers/worker.ts";
import { PostgresSessionNotifier } from "./session-notifier.ts";
import { createShutdown } from "./shutdown.ts";
import {
  consoleOriginFrom,
  slackApiUrlFrom,
  slackEnvWarnings,
  slackIssuerFrom,
} from "./slack-config.ts";
import { createSlackOidcTransport, signInWithSlackOff } from "./slack-link.ts";
import {
  carryOverSlackSettings,
  createSlackSettingsAdmin,
  slackEventsBaseOf,
} from "./slack-settings.ts";
import { installedToolCatalogView } from "./tool-catalogs.ts";
import {
  startTelemetryIngest,
  warnCollectorOnEgressAllowlist,
} from "./tracing-startup.ts";
import {
  workspaceMcpHostsFromEnv,
  workspaceMcpOutbound,
  workspaceMcpRedirectUri,
  workspaceMcpUrlProblem,
} from "./workspace-mcp.ts";

const authMode = process.env.AUTH_MODE;
const databaseUrl = process.env.DATABASE_URL;

// The sessions API is storage-backed, so a process without a database would
// advertise routes it cannot serve; refuse to start instead.
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const logger = createLogger();
// A bad OTEL_* value throws here and stops the process at startup. The SDK
// adapter is only loaded when tracing is on.
const tracingSettings = parseTracingSettings(process.env);
warnCollectorOnEgressAllowlist(tracingSettings, process.env, logger);
const telemetry = createTelemetryPolicy(tracingSettings);
const otelTracer =
  tracingSettings === undefined
    ? undefined
    : (await import("@werft-ai/observability/otel")).createOtelTracer(
        tracingSettings,
      );
const tracer: Tracer = otelTracer ?? noopTracer;
const limits = (() => {
  try {
    return installationLimitsFromEnv(process.env);
  } catch (error) {
    // Every problem in one line before the process dies, so the operator
    // fixes the env file once instead of once per variable.
    if (error instanceof InstallationConfigError) {
      logger.error("Refusing to start: installation limits are invalid", {
        problems: error.problems,
      });
    }
    throw error;
  }
})();
const settings = (() => {
  try {
    return apiSettingsFromEnv(process.env);
  } catch (error) {
    if (error instanceof ApiSettingsError) {
      logger.error("Refusing to start: API settings are invalid", {
        problems: error.problems,
      });
    }
    throw error;
  }
})();
const secretKey = loadSecretKey(process.env);

// Checked before the pool exists: a bucket that is missing is a startup
// error, not a warning, unless the operator said there is none.
const checkpointStorage = checkpointStorageConfigFromEnv(process.env);
const checkpointGitMemoryBytes = checkpointGitMemoryBytesFromEnv(process.env);
if (checkpointStorage === "disabled") {
  logger.warn(
    "Checkpoint object store is disabled; every checkpoint will be refused and no session can be restored",
    {},
  );
} else if (checkpointStorage.protection === "unversioned") {
  logger.warn(
    "Checkpoint objects are not pinned by version or held; an object deleted or overwritten after its checkpoint committed is found at restore, not prevented",
    { bucket: checkpointStorage.bucket },
  );
} else {
  await assertCheckpointBucketProtection(checkpointStorage);
}
if (checkpointStorage !== "disabled") {
  await assertCheckpointBucketEncryption(checkpointStorage, {
    warn: (message, fields) => logger.warn(message, fields),
  });
}

const pool = createApiPool(databaseUrl, logger);
const db = drizzle(pool, { schema });
const installationConfigStore = createPostgresInstallationConfigStore(db);
const installationConfig = createInstallationConfigSource({
  store: installationConfigStore,
  warn: (message, fields) => logger.warn(message, fields ?? {}),
});
const catalogRepositoryStore = createPostgresCatalogRepositoryStore(db);
const installationSettings = settingsSource({
  store: createPostgresInstallationSettingsStore(db, secretKey),
});
const reportLeftOut = leftOutReporter((message, fields) =>
  logger.warn(message, fields),
);
const catalogRegistry = createCatalogRegistry({
  repositories: catalogRepositoryStore,
  settings: {
    async read() {
      const snapshot = await installationSettings.read();
      reportLeftOut(snapshot);
      return snapshot;
    },
  },
});
const runtimeVersions = runtimeVersionsFromEnv(process.env);
const launchableKind = launchableKindsFromEnv(process.env);
const catalog = registryCatalog(
  {
    repositories: {},
    ...(runtimeVersions === undefined
      ? {}
      : { runtime_versions: runtimeVersions }),
    tool_catalogs: installedToolCatalogView,
  },
  catalogRegistry,
  (rows, settings) => withConsoleRepositories(rows, settings?.repositories),
);
const logCatalog = (message: string): void => {
  logger.info(message, {
    connections: Object.keys(catalog.connections).length,
    repositories: Object.keys(catalog.repositories).length,
  });
};
const refreshCatalog = (): void => {
  catalogRegistry.refresh(CATALOG_REFRESH_MS).catch((error: unknown) => {
    logger.warn("Installation settings could not be read; retrying", {
      error_name: error instanceof Error ? error.name : typeof error,
    });
  });
};
const CATALOG_READ_RETRY_MS = 30_000;
const readCatalog = (): void => {
  catalogRegistry.refresh().then(
    () => {
      logCatalog("Session catalog loaded");
      setInterval(refreshCatalog, CATALOG_REFRESH_MS).unref();
    },
    (error: unknown) => {
      logger.warn("Installation settings could not be read; retrying", {
        error_name: error instanceof Error ? error.name : typeof error,
      });
      setTimeout(readCatalog, CATALOG_READ_RETRY_MS).unref();
    },
  );
};
readCatalog();
const neutralize = eventNeutralizer(logger);
startNeutralFill(db, neutralize, logger, () => catalogRegistry.refresh());
// Drafts saved while the catalog MCP lived; each start finds what is left.
reconcileRetiredCatalogDrafts(db).then(
  (drafts) => {
    if (drafts.moved + drafts.unreadable > 0) {
      logger.info("Drafts naming a retired catalog MCP server reconciled", {
        moved: drafts.moved,
        unreadable: drafts.unreadable,
      });
    }
  },
  (error: unknown) => {
    logger.warn(
      "Drafts naming a retired catalog MCP server could not be reconciled; the next start tries again",
      { error_name: error instanceof Error ? error.name : typeof error },
    );
  },
);
// Sessions accepted before a release was required; each start closes what
// is left, so a session that failed here is tried again on the next.
closeAgentlessSessions(db).then(
  (sessions) => {
    if (sessions.closed.length > 0) {
      logger.info("Sessions without an agent release closed", {
        sessions: sessions.closed.length,
      });
    }
    for (const { sessionId, error } of sessions.failed) {
      logger.warn(
        "A session without an agent release could not be closed; the next start tries again",
        {
          session_id: sessionId,
          error_name: error instanceof Error ? error.name : typeof error,
        },
      );
    }
  },
  (error: unknown) => {
    logger.warn(
      "Sessions without an agent release could not be read; the next start tries again",
      { error_name: error instanceof Error ? error.name : typeof error },
    );
  },
);
if (checkpointStorage !== "disabled") {
  await assertCheckpointObjectsPresent(checkpointStorage, {
    hasUncollectedCheckpoint: () => hasUncollectedCheckpoint(db),
  });
}
const checkpoints = createApiCheckpoints(
  db,
  checkpointStorage,
  checkpointGitMemoryBytes,
);
const credentialBindings = createPostgresCredentialBindingStore(db);
const slackGuests = createPostgresSlackGuestSetting(db);
const sessionShares = createPostgresSessionShareStore(db);
const authorization = createAuthorizationPolicy({
  ...(authMode === "none"
    ? {}
    : { identity: createDatabaseIdentityReader(db) }),
  agents: createDatabaseAgentAuthority(db),
  credentials: credentialBindings,
  slackGuests,
  sessions: sessionShares,
  decisions: createPostgresDecisionLog(db),
  logger,
});
const agentStore = createPostgresAgentStore(db);
const surfaceBindingStore = createPostgresSurfaceBindingStore(db);
const slackSecretStore = () => createPostgresSecretStore(db, secretKey);
const slackAppStore = createPostgresSlackAppStore(db, secretKey);
const {
  api: slackBotApi,
  join: slackJoin,
  welcome: slackWelcome,
} = wireSlackBot({
  apiUrl: slackApiUrlFrom(process.env),
  appStore: slackAppStore,
  secrets: slackSecretStore,
  bindings: surfaceBindingStore,
  agents: agentStore,
  outbox: createPostgresSlackOutboxStore(db),
  logger,
});
const githubSettingsStore = createPostgresGitHubSettingsStore(db);
const extensionDeps = extensionDepsFor(db);
const agents = createAgentService({
  authorization,
  store: agentStore,
  catalog,
  credentials: credentialBindings,
  githubSettings: githubSettingsStore,
  repositoryCeiling: (workspaceId) =>
    workspaceRepositoryCeiling(db, workspaceId),
  welcome: slackWelcome,
  keys: createPostgresWorkspaceKeyStore(db),
  runtimes: installedRuntimeVersions,
  extensions: extensionDeps,
});
const archivedEvents = archivedEventSource(checkpointStorage);
const sessions = createSessionService({
  authorization,
  inputs: createPostgresSessionUnitOfWork(db),
  controls: createPostgresSessionControl(db, {
    connect: () => pool.connect(),
    logger,
  }),
  reader: createPostgresSessionReader(db, {
    logger,
    neutralize,
    ...(archivedEvents === undefined ? {} : { archivedEvents }),
  }),
  catalog,
  releases: { ...agents, ...newSessionGitHubReaders(db) },
  extensions: extensionDeps,
  credentials: credentialBindings,
  callerLimits: createPostgresCallerLimitGate(db, logger),
  launchable: (spec) => launchableKind(spec.runtime.kind),
  limits: installationConfig.sessionLimits,
});
const sessionOutputs = createSessionOutputService({
  sessions,
  source: checkpoints.outputs,
});
// The same limits admission and dispatch run under, so what this reports is
// what the gates enforce; the worker limits are what the next launch takes.
const usage = createUsageService({
  authorization,
  reader: createPostgresUsageReader(db),
  limits: async () => ({
    ...limits,
    ...(await installationConfig.sessionLimits()),
    ...(await installationConfig.workerLimits()),
  }),
});
const pendingRequests = createPendingRequestService({
  authorization,
  store: createPostgresPendingRequests(db),
});
const members = createMemberService({
  authorization,
  store: createPostgresMemberStore(db),
});
const slackInstallStore = createPostgresSlackInstallStore(db);
const slackIdentityStore = createPostgresAgentIdentityStore(db);
const agentIdentities = createAgentIdentityService({
  authorization,
  store: slackIdentityStore,
});
const { tokenRevoked: slackTokenRevoked, channelKinds: slackChannelKinds } =
  wireSlackChannels({
    api: slackBotApi,
    appStore: slackAppStore,
    secrets: slackSecretStore,
    identities: slackIdentityStore,
    installs: slackInstallStore,
    onTokenRevokedError: (error) =>
      logger.warn("Slack token_revoked could not revoke the install", {
        error: messageOf(error),
      }),
  });
const slackBindings = createSurfaceBindingService({
  authorization,
  store: surfaceBindingStore,
  channels: slackChannelKinds,
  join: slackJoin,
  welcome: slackWelcome,
});
const linkedAccounts = createLinkedAccountService({
  authorization,
  store: createPostgresLinkedAccountStore(db),
});
const slackIssuer = slackIssuerFrom(process.env);
for (const warning of slackEnvWarnings(process.env)) logger.warn(warning, {});
const { api: slackConfigApi, tokens: slackConfigTokens } = wireSlackConfig({
  apiUrl: slackApiUrlFrom(process.env),
  tokenStore: createPostgresSlackConfigTokenStore(db, secretKey),
});
const consoleOrigin = consoleOriginFrom(process.env);
if (consoleOrigin === null) {
  logger.warn(
    "Slack apps cannot be created (CONSOLE_ORIGIN unset): their OAuth redirect is on the console's origin",
    {},
  );
}
const slackLinkOff = signInWithSlackOff(consoleOrigin, true);
if (slackLinkOff !== null) logger.warn(slackLinkOff, {});
const { store: slackSettingsStore } = carryOverSlackSettings({
  env: process.env,
  store: createPostgresSlackSettingsStore(db),
  consoleOrigin,
  warn: (message, fields) => logger.warn(message, fields ?? {}),
  retryMs: CATALOG_READ_RETRY_MS,
});
const slackEventsBase = slackEventsBaseOf(slackSettingsStore, consoleOrigin);
const installationConfigAdmin = createInstallationConfigAdmin({
  authorization,
  source: installationConfig,
  store: installationConfigStore,
  sessionArchive: sessionArchiveStatusOf(checkpointStorage),
});
const slackActiveReleaseWarning: SlackServicesStageDeps["activeReleaseWarning"] =
  async (workspaceId, agentId) => {
    const release = (await agentStore.get(workspaceId, agentId))
      ?.active_release;
    if (!release) return { code: "no_active_release" };
    try {
      await resolveAgentRelease(
        { store: agentStore, catalog },
        workspaceId,
        release.id,
      );
    } catch (error) {
      if (
        error instanceof SessionServiceError &&
        error.code === "RELEASE_SPEC_UNAVAILABLE"
      ) {
        return { code: "release_unavailable", release_id: release.id };
      }
      throw error;
    }
    // Missing and dropped from the catalog take the same fix: a new release.
    return (await releaseStartableIn(db, catalog, workspaceId, release))
      ? null
      : { code: "repository_required", release_id: release.id };
  };
const {
  secrets: slackSecrets,
  signingSecrets: slackSigningSecrets,
  channels: slackChannels,
  apps: slackApps,
  events: slackEvents,
  install: slackInstall,
  linkApps: slackLinkApps,
} = wireSlackServices({
  authorization,
  appStore: slackAppStore,
  secrets: slackSecretStore,
  config: { api: slackConfigApi, tokens: slackConfigTokens },
  botApi: slackBotApi,
  welcome: slackWelcome,
  tokenRevoked: slackTokenRevoked,
  agentAuthority: createDatabaseAgentAuthority(db),
  inbox: createPostgresSlackInboundEventStore(db),
  identities: slackIdentityStore,
  installs: slackInstallStore,
  bindings: surfaceBindingStore,
  installStates: slackInstallStore,
  consoleOrigin,
  eventsPublicUrl: slackEventsBase,
  appKind: (workspaceId, slackAppId) =>
    slackAppKind(db, workspaceId, slackAppId),
  activeReleaseWarning: slackActiveReleaseWarning,
  logger,
});
const slackSettingsAdmin = createSlackSettingsAdmin({
  authorization,
  store: slackSettingsStore,
  consoleOrigin,
});
const credentialBindingService = createCredentialBindingService({
  authorization,
  store: credentialBindings,
});
const envVariableService = createEnvVariableService({
  authorization,
  store: createPostgresEnvVariableStore(db),
});
const workspaceMcpHosts = workspaceMcpHostsFromEnv(process.env);
const workspaceMcpPolicy = {
  plainHttp: "refuse" as const,
  privateHosts: workspaceMcpHosts?.private ?? [],
};
const workspaceMcp = createWorkspaceMcpService({
  authorization,
  store: createPostgresWorkspaceMcpStore(db, secretKey),
  secretStoreOn: secretKey !== null,
  remote: {
    http: workspaceMcpOutbound(workspaceMcpHosts),
    allowsUrl: (url) => endpointProblem(url, workspaceMcpPolicy) === null,
  },
  serverUrlProblem: (url) => workspaceMcpUrlProblem(workspaceMcpHosts, url),
  redirectUriFor: (serverId) =>
    workspaceMcpRedirectUri(consoleOrigin, serverId),
});
const apiKeys = createApiKeyService({
  authorization,
  store: createPostgresWorkspaceKeyStore(db),
  mint: () => {
    const secret = generateApiKey();
    return { secret, hash: hashApiKey(secret) };
  },
});
const shares = createSessionShareService({
  authorization,
  store: sessionShares,
});
const teams = createTeamService({
  authorization,
  store: createPostgresTeamStore(db),
});
const judgeConnections = settingsJudgeConnections(catalogRegistry);
const achievementRules = createAchievementRuleService({
  authorization,
  store: createPostgresAchievementRuleStore(db),
  judgeConnections,
});
const settingsDocumentStore = createPostgresSettingsDocumentStore(
  db,
  secretKey,
);
// The write already committed; the periodic refresh picks it up if this fails.
const rereadSettings = () =>
  catalogRegistry.refresh().catch((error: unknown) => {
    logger.warn("Installation settings could not be reread after a write", {
      error_name: error instanceof Error ? error.name : typeof error,
    });
  });
const settingsDocument = createSettingsDocumentService({
  authorization,
  store: settingsDocumentStore,
  reread: rereadSettings,
});
const settingsConsole = createSettingsConsoleService({
  authorization,
  store: settingsDocumentStore,
  leftOut: () => catalogRegistry.settings?.left_out ?? [],
  secretStoreOn: true,
  credentialHosts: workspaceMcpHosts?.credential ?? null,
  reread: rereadSettings,
  discovery: {
    connection: (id) => catalogRegistry.settings?.connections[id],
    urlProblem: (url) => workspaceMcpUrlProblem(workspaceMcpHosts, url),
    http: workspaceMcpOutbound(workspaceMcpHosts),
    log: (fields) => logger.info("Connection model list read", fields),
  },
});
const agentAdmins = createAgentAdminService({
  authorization,
  store: createPostgresAgentAdminStore(db),
});
const agentUsage = createAgentUsageService({
  authorization,
  store: createPostgresAgentUsageStore(db),
});
const agentCallerLimits = createAgentCallerLimitsService({
  authorization,
  store: createPostgresAgentCallerLimitsStore(db),
});
const inviteStore = createPostgresInviteStore(db);
const invites = createInviteService({ authorization, store: inviteStore });
const githubAppStore = createPostgresGitHubAppStore(db, secretKey);
const registeredGitHub = wireGitHubRegistry({
  appStore: githubAppStore,
  logger,
});
const reloadRegisteredGitHub = (): Promise<void> => registeredGitHub.refresh();
const githubPins = createPostgresGitHubPinStore(db);
// Another replica's change arrives with the next read.
const refreshRegisteredGitHub = (): Promise<void> =>
  reloadRegisteredGitHub().catch((error: unknown) => {
    logger.warn("The GitHub App could not be read; retrying", {
      error_name: error instanceof Error ? error.name : typeof error,
    });
  });
void refreshRegisteredGitHub();
setInterval(refreshRegisteredGitHub, CATALOG_REFRESH_MS).unref();
const githubAppDirectory = wireGitHubAppDirectory({ logger });
const githubRepositories = createGitHubRepositoryService({
  authorization,
  store: catalogRepositoryStore,
  apps: githubAppStore,
  pins: githubPins,
  directory: githubAppDirectory,
  agents: agentStore,
  repositoryCeiling: (workspaceId) =>
    workspaceRepositoryCeiling(db, workspaceId),
  changed: () => catalogRegistry.refresh(),
});
const githubInstallations = createPostgresGitHubInstallationStore(db);
const githubWebhookUrl = githubWebhookUrlFrom(process.env);
if (githubWebhookUrl === null) {
  logger.info(
    "GitHub skills sync without push webhooks (GITHUB_WEBHOOK_BASE_URL unset)",
    {},
  );
}
const githubApps = createGitHubAppService({
  authorization,
  store: githubAppStore,
  directory: githubAppDirectory,
  apiBase: GITHUB_API_BASE,
  webhookUrl: githubWebhookUrl,
  repositories: () =>
    Object.entries(catalog.repositories)
      .filter(
        ([, repository]) =>
          repository.auth?.kind === "github_app" &&
          "registered" in repository.auth,
      )
      .map(([id, repository]) => ({ id, url: repository.url })),
  changed: reloadRegisteredGitHub,
  manifests: {
    states: createPostgresGitHubAppManifestStore(db),
    convert: wireGitHubManifestConverter({ logger }),
    consoleOrigin,
    callbackUrl: githubCallbackUrl(consoleOrigin),
    webBase: "https://github.com",
    refused: (check) =>
      logger.warn("GitHub App manifest state refused", { check }),
  },
  installations: {
    store: githubInstallations,
    refused: (check) =>
      logger.warn("GitHub installation state refused", { check }),
  },
});
// Every GitHub token (clone, push, pull requests, Actions) is issued here,
// from one connection per repository and so one token cache.
const githubGateStore = createPostgresGitHubGateStore(db);
const githubConnections = wireGitHubConnections({
  catalog,
  registry: registeredGitHub,
  logger,
});
const githubResolver = createGitHubConnectionResolver({
  connections: githubConnections,
  pins: githubPins,
});
const github = createGitHubGate({
  store: githubGateStore,
  catalog,
  connections: githubConnections,
  resolver: githubResolver,
});
const githubWorkFor = (authorization: AuthorizationPolicy) =>
  createGitHubWorkService({
    authorization,
    gate: github,
    store: githubGateStore,
    redact: sanitizeText,
  });
const githubWork = githubWorkFor(authorization);
const githubOAuth = createPostgresGitHubOAuthStore(db, secretKey);
const githubCallback = githubCallbackUrl(consoleOrigin);
const pullRequestSettings = createPostgresPullRequestSettingsStore(db);
const githubSettings = createGitHubSettingsService({
  authorization,
  store: githubSettingsStore,
  pullRequestSettings,
  oauth: githubOAuth,
  callbackUrl: githubCallback,
  secretsOn: true,
  apps: githubAppStore,
  directory: githubAppDirectory,
  installations: githubInstallations,
});
const githubPackagesConfig = githubPackagesConfigFromEnv(process.env);
const githubPackagesStore = createPostgresGitHubPackagesStore(db, secretKey);
const githubPackages = createGitHubPackagesService({
  authorization,
  store: githubPackagesStore,
  verifier: createGitHubPackagesTokenVerifier({
    apiBase: githubPackagesConfig.apiBase,
    http: githubPackagesOutbound(githubPackagesConfig.apiBase),
  }),
  secretsOn: true,
});
const sessionAttribution = createPostgresSessionAttributionStore(db);
const commitAttributions = createPostgresCommitAttributionLedger(db);
const agentGitHub = createAgentGitHubService({
  authorization,
  agents: agentStore,
  store: createPostgresAgentGitHubStore(db),
  catalog,
  githubSettings: githubSettingsStore,
  connections: githubConnections,
  resolver: githubResolver,
  selection: githubRepositories.selection,
  pinned: { apps: githubAppStore, pins: githubPins },
});
const agentWorkspaceMcp = createAgentWorkspaceMcpService({
  authorization,
  store: createPostgresAgentWorkspaceMcpStore(db),
});
const agentPullRequest = createAgentPullRequestService({
  authorization,
  agents: agentStore,
  settings: pullRequestSettings,
});
const pushStore = createPostgresPushRequests(db);
const pushIntentStore = createPostgresPushIntents(db);
const pushRequestsFor = (authorization: AuthorizationPolicy) =>
  createPushRequestService({
    authorization,
    store: pushStore,
    intents: pushIntentStore,
    source: checkpoints.pushSource,
    catalog,
  });
const pushRequests = pushRequestsFor(authorization);
const pullRequestStore = createPostgresPullRequests(db);
const pullRequestsFor = (authorization: AuthorizationPolicy) =>
  createPullRequestService({
    authorization,
    store: pullRequestStore,
    catalog,
    gate: github,
    redact: sanitizeText,
    attribution: sessionAttribution,
    settings: pullRequestSettings,
    consoleOrigin,
    logger,
  });
const pullRequests = pullRequestsFor(authorization);
// The built-in `github` MCP server: the same services as the session API,
// each made with the authorization of the one session a grant names.
const githubMcpStore = createPostgresGitHubMcpStore(db);
const repositoryAttachmentStore = createPostgresRepositoryAttachments(db);
const repositoryPinStore = createPostgresRepositoryPins(db);
const repositoryAttachments = createRepositoryAttachmentService({
  store: repositoryAttachmentStore,
  pins: repositoryPinStore,
  context: githubGateStore,
  catalog,
});
const githubMcp = createGitHubMcpServer({
  store: githubMcpStore,
  // The same fields the egress authorizer logs for a failed call: no message,
  // which can carry a connection string or GitHub's text.
  onInternalError: (error, { tool, sessionId, requestId }) =>
    logger.error("GitHub MCP call failed", {
      session_id: sessionId,
      tool,
      request_id: requestId,
      error: error instanceof Error ? error.name : "error",
    }),
  services: (bound) => ({
    pushRequests: pushRequestsFor(bound),
    pullRequests: pullRequestsFor(bound),
    githubWork: githubWorkFor(bound),
    attachments: repositoryAttachments,
  }),
});
const pushExecutor = createPushExecutor({
  store: pushStore,
  catalog,
  gate: github,
  bundles: checkpoints.pushSource,
  pusher: wireGitPusher({ maxGitMemoryBytes: checkpointGitMemoryBytes }),
  attributions: commitAttributions,
  logger,
}).start();
// The control-host action-broker's intent runner. It makes push requests as
// the stored actor and approves nothing.
const pushIntentRunner = createPushIntentRunner({
  store: pushIntentStore,
  createFromIntent: (job) => pushRequests.createFromIntent(job),
  logger,
}).start();
const modelMoveRunner = createModelMoveRunner({
  store: agentStore,
  catalog,
  agents,
  logger,
}).start();
// The pull request drain of the control-host's action-broker: a stage left
// from before a restart is still finished.
const pullRequestDrain = createPullRequestDrain({
  store: createPostgresPullRequestDrain(db),
  opener: pullRequests,
  logger,
}).start();
// Each replica reads the state of the pull requests sessions opened; the
// rate-limit budget is shared through the database (§10).
const sessionOutcomes = createPostgresSessionOutcomes(db);
const outcomeRefresher = createOutcomeRefresher({
  store: sessionOutcomes,
  gate: github,
  catalog,
  connections: githubConnections,
  resolver: githubResolver,
  logger,
}).start();
// Each replica judges the sessions whose evidence changed; only it writes
// achievements.
const achievementJudgments = createPostgresAchievementJudgments(db);
const judgmentEgress = createPostgresJudgmentEgress(db);
// The judge calls Luna through the egress proxy's credential listener, the
// one generated titles use, on an `openai_decisions` connection of the
// installation settings.
const judgeEgressUrl = sessionTitleEgressUrlFromEnv(process.env);
const achievementJudge = createAchievementJudge({
  store: achievementJudgments,
  outputs: checkpoints.outputs,
  logger,
  models: judgeConnections,
  ...(judgeEgressUrl === null
    ? {}
    : {
        luna: {
          connections: judgeConnections,
          tokens: judgmentEgress,
          decisions: createDecisionsClient({
            egressUrl: judgeEgressUrl,
            http: oneHostOutbound(judgeEgressUrl, { private: true }),
          }),
        },
      }),
}).start();
const interrupts = createInterruptService({
  authorization,
  store: createPostgresTurnInterrupts(db, { logger }),
});
const shutdown = createShutdown({ logger });
const titleEgressUrl = sessionTitleEgressUrlFromEnv(process.env);
const titleStore = createPostgresSessionTitleStore(db);
if (titleEgressUrl === null) {
  logger.info(
    "Generated session titles are off (SESSION_TITLE_EGRESS_URL unset)",
    {},
  );
}
// The egress proxy's authorizer, on a port of its own that no
// worker allowlist names. Read before anything listens, so a half-set pair
// stops the process instead of starting an API whose workers cannot reach
// their provider.
const egressAuthorizer = egressAuthorizerConfigFromEnv(process.env);
const githubMcpGrantKey =
  egressAuthorizer === null ? null : githubMcpGrantKeyOf(egressAuthorizer);
const extensionBundles = extensionBundleSource(checkpointStorage, db);
// Skill trees live in the checkpoint bucket; without one the routes are absent.
const skillObjects = extensionBundleObjects(checkpointStorage);
const skillGitSync =
  skillObjects === undefined
    ? undefined
    : createSkillGitSync({
        authorization,
        sources: createPostgresSkillGitSourceStore(db),
        bundles: createExtensionBundleService({
          store: createPostgresExtensionBundleStore(db),
          objects: skillObjects,
        }),
        reader: wireGitHubSkillReader({ logger }),
        apps: (workspaceId) =>
          githubAppStore.credentials("author", workspaceId),
        installationFor: (app, repo) =>
          githubAppDirectory.installationFor(app, repo),
        webhookSecrets: (appId) => githubAppStore.webhookSecrets(appId),
        webhookUrl: githubWebhookUrl,
        failed: (error, fields) =>
          logger.warn("A Git skill check failed", {
            ...fields,
            error_name: error instanceof Error ? error.name : typeof error,
          }),
      });
if (skillGitSync !== undefined) {
  const daily = () => {
    void skillGitSync.daily().catch((error: unknown) =>
      logger.warn("The daily Git skill check failed", {
        error_name: error instanceof Error ? error.name : typeof error,
      }),
    );
  };
  setInterval(daily, SKILL_DAILY_CHECK_PASS_MS).unref();
}
const skills =
  skillObjects === undefined
    ? undefined
    : createSkillService({
        authorization,
        store: createPostgresExtensionBundleStore(db),
        objects: skillObjects,
        ...(skillGitSync === undefined
          ? {}
          : { gitSources: (workspaceId) => skillGitSync.views(workspaceId) }),
      });
const workers = createWorkerGateway({
  work: createPostgresWorkerUnitOfWork(db, { logger }),
  telemetry,
  catalog,
  neutralize,
  ...(extensionBundles === undefined ? {} : { extensions: extensionBundles }),
  // The storage-backed verifier: a checkpoint is promoted only after its
  // manifest, objects and workspace bundle were read back from S3 (checked by
  // git), and the pointer itself advances inside the turn's own transaction.
  checkpoints: checkpoints.verifier,
  ...(checkpoints.protocol === undefined
    ? {}
    : { checkpointProtocol: checkpoints.protocol }),
  pending: createPostgresWorkerPendingStore(db),
  github,
  attachments: repositoryAttachmentStore,
  repositoryPins: repositoryPinStore,
  attribution: {
    store: sessionAttribution,
    ledger: commitAttributions,
    consoleOrigin,
    sessionLink: async (workspaceId) =>
      (await pullRequestSettings.get(workspaceId)).settings.session_link,
    appBotUserId: wireAppBotUsers({ logger }),
    commitPin: {
      resolver: githubResolver,
      onFailed: (failure) =>
        logger.warn("Commit author pin not made at claim", failure),
    },
  },
  mcp: createPostgresMcpEgressStore(db),
  workspaceMcp: {
    store: createPostgresWorkspaceMcpEgressStore(db),
    credentialFor: workspaceMcp.credentialFor,
  },
  onMcpReceiptError: (error) =>
    logger.error("MCP refusal receipt not recorded", {
      error: error instanceof Error ? error.name : "error",
    }),
  onRestoreConfigsDropped: ({ sessionId, dropped }) => {
    logger.warn("claim.retired_catalog_restore_dropped", {
      session_id: sessionId,
      dropped,
    });
  },
  onToolAudit: ({ dropped, conflicts, unverified, sessionId, attemptId }) => {
    // Counts only: what the worker sent is never put in a log.
    const fields = { session_id: sessionId, attempt_id: attemptId };
    if (dropped > 0) logger.warn("tool_audit.dropped", { ...fields, dropped });
    if (conflicts > 0) {
      logger.warn("tool_audit.conflict", { ...fields, conflicts });
    }
    if (unverified > 0) {
      logger.warn("tool_audit.unverified", { ...fields, unverified });
    }
  },
  onModelCutError: (error, cut) =>
    logger.error("Model cut note not recorded", {
      session_id: cut.sessionId,
      attempt_id: cut.attemptId,
      error: error instanceof Error ? error.name : "error",
    }),
  ...(githubMcpGrantKey === null
    ? {}
    : { githubMcp: { store: githubMcpStore, grantKey: githubMcpGrantKey } }),
  githubPackages: {
    store: githubPackagesStore,
    upstreams: githubPackagesConfig.upstreams,
  },
  judgments: {
    store: judgmentEgress,
    upstream: judgeConnections.upstream,
  },
  ...(titleEgressUrl === null
    ? {}
    : {
        titles: {
          store: titleStore,
          titler: createSessionTitler({
            store: titleStore,
            catalog,
            egressUrl: titleEgressUrl,
            http: oneHostOutbound(titleEgressUrl, { private: true }),
            onError: (error, context) =>
              logger.warn(
                "Session title not generated; the derived one stays",
                {
                  session_id: context.sessionId,
                  error: error instanceof Error ? error.message : "error",
                },
              ),
          }),
        },
      }),
  options: {
    sessionBudget: installationConfig.sessionBudget,
    workspaceEnforce: () => installationConfig.get("workspace_enforce"),
    leaseTtlMs: settings.leaseTtlMs,
    // How long a permission or question takes answers. The worker waits
    // exactly this long once the request is registered.
    pendingTtlMs: async () =>
      (await installationConfig.get("pending_request_ttl_sec")) * 1000,
    stopWaiting: shutdown.stopWaiting,
  },
});
const authorizerListener =
  egressAuthorizer === null
    ? undefined
    : Bun.serve({
        hostname: egressAuthorizer.hostname,
        port: egressAuthorizer.port,
        fetch: createEgressAuthorizer({
          gateway: workers,
          logger,
          exchanges: createProviderExchangeLedger(db, {
            admits: async () =>
              admitsReservations(await installationConfig.sessionBudget()),
          }),
          ...(githubMcpGrantKey === null
            ? {}
            : {
                githubMcp: { handle: githubMcp, grantKey: githubMcpGrantKey },
              }),
          ...(checkpointStorage === "disabled"
            ? {}
            : { objectStore: checkpointObjectRouteSigner(checkpointStorage) }),
          token: egressAuthorizer.token,
        }),
      });
if (authorizerListener === undefined) {
  logger.warn(
    "Egress authorizer is off (EGRESS_AUTHORIZER_PORT unset); workers cannot reach their provider, repository or object store",
    {},
  );
} else {
  logger.info("Egress authorizer listening", {
    port: authorizerListener.port,
  });
}

// Wakes SSE streams on NOTIFY; streams still re-read on their keepalive
// clock, so a listener that is down only adds latency, never loses events.
const notifier = new PostgresSessionNotifier(databaseUrl, logger);
void notifier.start();
const identity = new DatabaseIdentityStore(db);
const passwords = new PasswordChecks();
// Providers are settings rows; nothing about them is read from the
// environment. The redirect URIs are built on CONSOLE_ORIGIN itself.
const loginProviderAdminStore = createPostgresLoginProviderAdminStore(
  db,
  secretKey,
);
const providerLogin = createProviderLogin({
  providers: createPostgresLoginProviderStore(db, secretKey),
  admin: loginProviderAdminStore,
  consoleOrigin,
  flowKey: derivedSecretKey(secretKey, "login-flow-cookie"),
});
const providerAdmin = createProviderAdmin({
  authorization,
  store: loginProviderAdminStore,
  login: providerLogin,
  consoleOrigin,
});
const loginSettingsStore = createPostgresLoginSettingsStore(db);
const loginSettingsAdmin = createLoginSettingsAdmin({
  authorization,
  store: loginSettingsStore,
});
const auth = {
  identity,
  providers: providerLogin,
  loginMethods: createPostgresLoginMethodStore(db),
  loginSettings: loginSettingsStore,
  passwords,
  logger,
};
const slackInteractions = wireSlackInteractions({
  secrets: slackSecretStore,
  signingSecrets: slackSigningSecrets,
  botApi: slackBotApi,
  authorization,
  agents: slackIdentityStore,
  links: createPostgresLinkedAccountStore(db),
  bindings: surfaceBindingStore,
  pending: pendingRequests,
  pushes: pushRequests,
  sessions,
  followUps: createPostgresPushFollowUpStore(db),
  outbox: createPostgresSlackOutboxStore(db),
  consoleOrigin,
  logger,
});
const probePool = createProbePool(databaseUrl, logger);
const app = createApiApp({
  ...(authMode === undefined ? {} : { authMode }),
  logger,
  tracer,
  keyStore: new DatabaseApiKeyStore(db),
  identity,
  authorization,
  skillUploads: skills !== undefined,
  registerPublicRoutes: (router) => {
    registerPublicAuthRoutes(router, auth);
    registerSlackEventRoutes(router, {
      events: slackEvents,
      limiter: createSlackEventsLimiter(),
      logger,
    });
    registerSlackInteractionRoutes(router, {
      interactions: slackInteractions,
      limiter: createSlackEventsLimiter(),
      logger,
    });
    if (skillGitSync !== undefined) {
      registerGitHubWebhookRoutes(router, {
        sync: skillGitSync,
        limiter: createSlackEventsLimiter(),
        logger,
      });
    }
    registerPublicInviteRoutes(router, {
      invites: inviteStore,
      identity,
      loginSettings: loginSettingsStore,
      passwords,
      logger,
    });
  },
  registerRoutes: (router) => {
    refuseDeletedAgents(router, (workspaceId, agentId) =>
      agentDeleted(db, workspaceId, agentId),
    );
    registerAuthRoutes(router, auth);
    registerInviteRoutes(router, invites);
    registerWorkspaceRoutes(router, {
      authorization,
      retention: createPostgresAuditRetention(db),
      slackGuests,
    });
    registerAuditLogRoutes(
      router,
      createAuditLogService({
        authorization,
        reader: createPostgresAuditLogReader(db),
      }),
    );
    registerSlackSecretRoutes(router, slackSecrets);
    registerGitHubAppRoutes(router, githubApps, logger);
    registerGitHubRepositoryRoutes(router, githubRepositories);
    registerGitHubSettingsRoutes(router, githubSettings);
    registerGitHubPackagesRoutes(router, githubPackages);
    registerAgentGitHubRoutes(router, agentGitHub);
    registerAgentWorkspaceMcpRoutes(router, agentWorkspaceMcp);
    registerAgentPullRequestRoutes(router, agentPullRequest);
    registerSessionRoutes(router, sessions);
    registerSessionOutputRoutes(router, sessionOutputs);
    registerSessionShareRoutes(router, shares, sessions);
    registerPauseRoutes(router, sessions);
    registerCloseRoutes(router, sessions);
    registerReceiptRoutes(router, sessions);
    registerUsageRoutes(router, usage);
    registerInstallationSettingsRoutes(router, settingsDocument);
    registerSettingsConsoleRoutes(router, settingsConsole);
    registerLoginProviderRoutes(router, providerAdmin);
    registerLoginSettingsRoutes(router, loginSettingsAdmin);
    registerSlackSettingsRoutes(router, slackSettingsAdmin);
    registerInstallationConfigRoutes(router, installationConfigAdmin);
    registerAchievementRoutes(router, achievementRules);
    registerSessionAchievementRoutes(
      router,
      createSessionAchievementService({
        authorization,
        store: achievementJudgments,
        judgeConnections,
      }),
    );
    registerPendingRoutes(router, pendingRequests);
    registerPushRequestRoutes(router, pushRequests);
    registerPullRequestRoutes(router, pullRequests);
    registerGitHubWorkRoutes(router, githubWork);
    registerSessionAttributionRoutes(
      router,
      createSessionAttributionService({
        authorization,
        store: sessionAttribution,
      }),
    );
    registerSessionOutcomeRoutes(
      router,
      createSessionOutcomeService({ authorization, store: sessionOutcomes }),
    );
    registerInterruptRoutes(router, interrupts);
    registerLinkedAccountRoutes(router, {
      service: linkedAccounts,
      linkCookies: createAccountLinkCookies(
        derivedSecretKey(secretKey, "account-link-cookie"),
      ),
      github: { oauth: githubOAuth, redirectUri: githubCallback },
      slack:
        consoleOrigin === null
          ? null
          : {
              issuer: slackIssuer,
              clients: slackLinkApps,
              oidc: createSlackOidcTransport(slackIssuer),
            },
      logger,
    });
    registerMemberRoutes(router, members, invites);
    registerAgentRoutes(router, agents);
    registerAgentIdentityRoutes(router, {
      service: agentIdentities,
      logger,
    });
    registerSlackBindingRoutes(router, {
      service: forgettingChannelsOnBindingPut(slackBindings, slackChannels),
      logger,
    });
    registerSlackChannelRoutes(router, { service: slackChannels, logger });
    registerSlackAppRoutes(router, {
      apps: slackApps,
      secrets: slackSecrets,
      logger,
    });
    registerSlackInstallRoutes(router, { service: slackInstall, logger });
    registerApiKeyRoutes(router, apiKeys);
    registerTeamRoutes(router, teams, agentAdmins);
    registerAgentUsageRoutes(router, agentUsage);
    registerAgentCallerLimitsRoutes(router, agentCallerLimits);
    registerCredentialBindingRoutes(router, credentialBindingService);
    registerEnvVariableRoutes(router, envVariableService);
    registerWorkspaceMcpServerRoutes(router, workspaceMcp);
    if (skills !== undefined) registerSkillRoutes(router, skills, skillGitSync);
    registerEventRoutes(router, sessions, {
      wakeup: notifier,
      logger,
      stopWaiting: shutdown.stopWaiting,
      ...settings.sse,
    });
  },
  registerInternalRoutes: (router) =>
    registerWorkerRoutes(router, workers, new RequestTracing(tracer)),
  ...(settings.webDistDir === undefined
    ? {}
    : { webDistDir: settings.webDistDir }),
  readiness: shutdown.readiness(
    createReadinessProbe({
      db: probePool,
      requiredEnv: API_READINESS_REQUIRED_ENV,
      // A blocked key stays out: the owner fixes it in the console, which
      // a not-ready API would keep them from reaching.
      configProblems: (environment) => [
        ...apiReadinessConfigProblems(environment),
        ...(installationConfig.loaded()
          ? []
          : ["installation config not read yet"]),
      ],
    }),
  ),
});

// Bun resets a connection that has been idle for 10 seconds (default), and a
// reset carries no status, no request id and no retry hint. A /v1 request runs
// several database stages in sequence (key lookup, pool wait, BEGIN,
// statements, ROLLBACK), each bounded by its own pool timeout but together
// longer than 10 seconds. The app drives the clock through setIdleTimeout:
// above REQUEST_DEADLINE_MS around database work (deadline.ts answers 503
// first), on while it ingests a body (under BODY_DEADLINE_MS), and back to
// the default once the response is decided.
const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  // Bun's own cap (default 128 MiB) applies before any handler runs and
  // answers without the API's error envelope, so it sits above the contract
  // limit: the app produces the documented 413 up to twice the limit, and
  // only a grossly oversized upload is cut at the transport.
  maxRequestBodySize: REQUEST_BODY_MAX_BYTES * 2,
  fetch(
    request: Request,
    server: { timeout(r: Request, seconds: number): void },
  ): Response | Promise<Response> {
    return app.fetch(request, {
      setIdleTimeout: (seconds: number) => server.timeout(request, seconds),
    });
  },
});
// With PORT=0 the OS picks the port; this line is the only place it shows.
logger.info("API listening", { port: server.port });

// Workers send spans here and never to the collector. Off with tracing, so a
// default installation opens no extra port.
const ingestListener =
  tracingSettings === undefined || otelTracer === undefined
    ? undefined
    : await startTelemetryIngest(tracingSettings, db, logger);
if (ingestListener !== undefined) {
  logger.info("Telemetry ingest listening", { port: ingestListener.port });
}

// Pools close last: requests still draining hold their clients until then.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown.run(
      signal,
      // The authorizer drains with the API: a proxy exchange mid-regrant
      // gets its answer, and one refused after the stop rides its grace.
      [
        server,
        ...(authorizerListener === undefined ? [] : [authorizerListener]),
        ...(ingestListener === undefined ? [] : [ingestListener]),
      ],
      [
        { name: "push-executor", close: () => pushExecutor.stop() },
        { name: "push-intent-runner", close: () => pushIntentRunner.stop() },
        { name: "model-move-runner", close: () => modelMoveRunner.stop() },
        { name: "pull-request-drain", close: () => pullRequestDrain.stop() },
        { name: "outcome-refresher", close: () => outcomeRefresher.stop() },
        { name: "achievement-judge", close: () => achievementJudge.stop() },
        { name: "event-listener", close: () => notifier.close() },
        // Spans already accepted get a bounded time to reach the collector.
        ...(ingestListener === undefined
          ? []
          : [
              { name: "telemetry-ingest", close: () => ingestListener.close() },
            ]),
        // Flushes the spans of the requests that just drained.
        ...(otelTracer === undefined
          ? []
          : [{ name: "tracer", close: () => otelTracer.shutdown() }]),
        { name: "pool", close: () => pool.end() },
        { name: "probe-pool", close: () => probePool.end() },
      ],
    );
  });
}

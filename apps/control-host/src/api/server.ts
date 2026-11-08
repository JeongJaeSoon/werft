import { REQUEST_BODY_MAX_BYTES } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  agentGitHubSettingsOf,
  backfillSessionModels,
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresAchievementJudgments,
  createPostgresAchievementRuleStore,
  createPostgresAgentAccessSetting,
  createPostgresAgentAdminStore,
  createPostgresAgentGitHubStore,
  createPostgresAgentIdentityStore,
  createPostgresAgentMcpStore,
  createPostgresAgentStore,
  createPostgresAuditRetention,
  createPostgresCatalogRepositoryStore,
  createPostgresCommitAttributionLedger,
  createPostgresCredentialBindingStore,
  createPostgresDecisionLog,
  createPostgresGitHubAppManifestStore,
  createPostgresGitHubAppStore,
  createPostgresGitHubGateStore,
  createPostgresGitHubInstallationStore,
  createPostgresGitHubMcpStore,
  createPostgresGitHubOAuthStore,
  createPostgresGitHubPackagesStore,
  createPostgresGitHubPinStore,
  createPostgresGitHubSettingsStore,
  createPostgresInstallationProfileStore,
  createPostgresInstallationSettingsStore,
  createPostgresInviteStore,
  createPostgresJudgmentEgress,
  createPostgresLinkedAccountStore,
  createPostgresMcpEgressStore,
  createPostgresMemberStore,
  createPostgresPendingRequests,
  createPostgresProfileRolloutStore,
  createPostgresPullRequestDrain,
  createPostgresPullRequestSettingsStore,
  createPostgresPullRequests,
  createPostgresPushFollowUpStore,
  createPostgresPushIntents,
  createPostgresPushRequests,
  createPostgresRepositoryAttachments,
  createPostgresSecretStore,
  createPostgresSessionAttributionStore,
  createPostgresSessionControl,
  createPostgresSessionOutcomes,
  createPostgresSessionReader,
  createPostgresSessionShareStore,
  createPostgresSessionTitleStore,
  createPostgresSessionUnitOfWork,
  createPostgresSettingsDocumentStore,
  createPostgresSlackAppStore,
  createPostgresSlackConfigTokenStore,
  createPostgresSlackGuestSetting,
  createPostgresSlackInboundEventStore,
  createPostgresSlackInstallStore,
  createPostgresSlackOutboxStore,
  createPostgresSurfaceBindingStore,
  createPostgresTeamStore,
  createPostgresTurnInterrupts,
  createPostgresUsageReader,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
  createPostgresWorkspaceKeyStore,
  createPostgresWorkspaceProfileStore,
  hasUncollectedCheckpoint,
  newSessionGitHubReaders,
  slackAppKind,
  workspaceRepositoryCeiling,
} from "@werft-ai/db";
import { createLogger, sanitizeText } from "@werft-ai/observability";
import {
  agentSlackBotToken,
  composeSlackFinalize,
  createAchievementJudge,
  createAchievementRuleService,
  createAgentAdminService,
  createAgentGitHubService,
  createAgentIdentityService,
  createAgentMcpService,
  createAgentPullRequestService,
  createAgentService,
  createApiKeyService,
  createAuthorizationPolicy,
  createCredentialBindingService,
  createDecisionsClient,
  createGitHubAppService,
  createGitHubConnectionResolver,
  createGitHubGate,
  createGitHubMcpServer,
  createGitHubPackagesService,
  createGitHubPackagesTokenVerifier,
  createGitHubRepositoryService,
  createGitHubSettingsService,
  createGitHubWorkService,
  createInstallationProfileService,
  createInterruptService,
  createInviteService,
  createLinkedAccountService,
  createMemberService,
  createOutcomeRefresher,
  createPendingRequestService,
  createProfileRegistry,
  createProfileRolloutRunner,
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
  createSlackAppService,
  createSlackBotApi,
  createSlackChannelJoiner,
  createSlackChannelKinds,
  createSlackChannelSearchService,
  createSlackConfigApi,
  createSlackConfigTokens,
  createSlackEventsFinalize,
  createSlackEventsService,
  createSlackInstallService,
  createSlackInteractionService,
  createSlackLinkAppService,
  createSlackSecretService,
  createSlackSigningSecrets,
  createSlackTokenRevoked,
  createSlackWelcome,
  createSurfaceBindingService,
  createTeamService,
  createUsageService,
  createWorkerGateway,
  createWorkspaceProfileService,
  fingerprintModel,
  forgettingChannelsOnBindingPut,
  GITHUB_API_BASE,
  InstallationConfigError,
  installationLimitsFromEnv,
  NO_JUDGE_CONNECTIONS,
  platformPromptRevisionFromEnv,
  profileCatalog,
  releaseStartable,
  resolveAgentRelease,
  SessionServiceError,
  slackBotToken,
  unrunnableProfiles,
  WORKSPACE_PROFILE_REFRESH_MS,
  withConsoleRepositories,
} from "@werft-ai/platform";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  API_READINESS_REQUIRED_ENV,
  ApiSettingsError,
  apiReadinessConfigProblems,
  apiSettingsFromEnv,
} from "./api-settings.ts";
import { createApiApp } from "./app.ts";
import {
  bootstrapGateFromEnv,
  DatabaseIdentityStore,
  LoginLockout,
  WorkGate,
} from "./auth.ts";
import {
  installedRuntimes,
  loadSecretKey,
  profileSources,
  refuseFileCatalog,
  runtimeVersionsFromEnv,
  secretsManagerReader,
  unattendedAllowed,
  unattendedProfiles,
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
} from "./checkpoints.ts";
import {
  createEgressAuthorizer,
  egressAuthorizerConfigFromEnv,
  githubMcpGrantKeyOf,
  sessionTitleEgressUrlFromEnv,
} from "./egress-authorizer.ts";
import {
  connectionsOf,
  createAppBotUsers,
  createGitHubAppDirectory,
  createGitHubManifestConverter,
  createRegisteredGitHubConnections,
} from "./forge-github.ts";
import { createGitPusher } from "./git-push.ts";
import { githubCallbackUrl } from "./github-link.ts";
import { githubPackagesConfigFromEnv } from "./github-packages-config.ts";
import { createGoogleLogin, googleLoginConfigFromEnv } from "./google-login.ts";
import {
  credentialHostsFromEnv,
  leftOutReporter,
  settingsSource,
} from "./installation-settings.ts";
import { DatabaseApiKeyStore, generateApiKey, hashApiKey } from "./keys.ts";
import { eventNeutralizer, startNeutralFill } from "./neutral-fields.ts";
import { createApiPool, createProbePool } from "./pool.ts";
import { createSlackEventsLimiter } from "./rate-limit.ts";
import { createReadinessProbe } from "./readiness.ts";
import {
  registerAchievementRoutes,
  registerSessionAchievementRoutes,
} from "./routes/achievements.ts";
import { registerAgentGitHubRoutes } from "./routes/agent-github.ts";
import { registerAgentIdentityRoutes } from "./routes/agent-identities.ts";
import { registerAgentMcpRoutes } from "./routes/agent-mcp.ts";
import { registerAgentPullRequestRoutes } from "./routes/agent-pull-request.ts";
import { registerAgentRoutes } from "./routes/agents.ts";
import { registerApiKeyRoutes } from "./routes/api-keys.ts";
import { registerAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerCloseRoutes } from "./routes/close.ts";
import { registerCredentialBindingRoutes } from "./routes/credential-bindings.ts";
import { registerEventRoutes } from "./routes/events.ts";
import { registerGitHubAppRoutes } from "./routes/github-app.ts";
import { registerGitHubPackagesRoutes } from "./routes/github-packages.ts";
import { registerGitHubRepositoryRoutes } from "./routes/github-repositories.ts";
import { registerGitHubSettingsRoutes } from "./routes/github-settings.ts";
import {
  registerGitHubWorkRoutes,
  registerSessionAttributionRoutes,
  registerSessionOutcomeRoutes,
} from "./routes/github-work.ts";
import {
  registerInstallationSettingsRoutes,
  registerSettingsConsoleRoutes,
} from "./routes/installation-settings.ts";
import { registerInterruptRoutes } from "./routes/interrupt.ts";
import {
  registerInviteRoutes,
  registerPublicInviteRoutes,
} from "./routes/invites.ts";
import { registerLinkedAccountRoutes } from "./routes/linked-accounts.ts";
import { registerMemberRoutes } from "./routes/members.ts";
import { registerSessionOutputRoutes } from "./routes/outputs.ts";
import { registerPauseRoutes } from "./routes/pause.ts";
import { registerPendingRoutes } from "./routes/pending.ts";
import { registerProfileRoutes } from "./routes/profiles.ts";
import { registerPullRequestRoutes } from "./routes/pull-requests.ts";
import { registerPushRequestRoutes } from "./routes/push-requests.ts";
import { registerReceiptRoutes } from "./routes/receipts.ts";
import { registerSessionShareRoutes } from "./routes/session-shares.ts";
import { registerSessionRoutes } from "./routes/sessions.ts";
import { registerSlackAppRoutes } from "./routes/slack-apps.ts";
import { registerSlackBindingRoutes } from "./routes/slack-bindings.ts";
import { registerSlackChannelRoutes } from "./routes/slack-channels.ts";
import { registerSlackEventRoutes } from "./routes/slack-events.ts";
import { registerSlackInstallRoutes } from "./routes/slack-install.ts";
import { registerSlackInteractionRoutes } from "./routes/slack-interactions.ts";
import { registerSlackSecretRoutes } from "./routes/slack-secrets.ts";
import { registerTeamRoutes } from "./routes/teams.ts";
import { registerUsageRoutes } from "./routes/usage.ts";
import { registerWorkerRoutes } from "./routes/worker.ts";
import { registerWorkspaceRoutes } from "./routes/workspaces.ts";
import { PostgresSessionNotifier } from "./session-notifier.ts";
import { createShutdown } from "./shutdown.ts";
import {
  consoleOriginFrom,
  slackApiUrlFrom,
  slackEventsPublicUrlFrom,
} from "./slack-config.ts";
import { signInWithSlackOff, slackOidcSettingsFromEnv } from "./slack-link.ts";
import { installedToolCatalogView } from "./tool-catalogs.ts";

const authMode = process.env.AUTH_MODE;
const databaseUrl = process.env.DATABASE_URL;

// The sessions API is storage-backed, so a process without a database would
// advertise routes it cannot serve; refuse to start instead.
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const logger = createLogger();
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
refuseFileCatalog(process.env);
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
const workspaceProfileStore = createPostgresWorkspaceProfileStore(db);
const installationProfileStore = createPostgresInstallationProfileStore(db);
const catalogRepositoryStore = createPostgresCatalogRepositoryStore(db);
const installationSettings = settingsSource({
  store: createPostgresInstallationSettingsStore(db, secretKey),
  env: process.env,
  readSecret: secretsManagerReader(process.env),
});
const reportLeftOut = leftOutReporter((message, fields) =>
  logger.warn(message, fields),
);
const workspaceProfileVersions = createProfileRegistry({
  workspaces: workspaceProfileStore,
  installations: installationProfileStore,
  repositories: catalogRepositoryStore,
  settings: {
    async read() {
      const snapshot = await installationSettings.read();
      reportLeftOut(snapshot);
      return snapshot;
    },
  },
  sources: profileSources(process.env),
});
const runtimeVersions = runtimeVersionsFromEnv(process.env);
const catalog = profileCatalog(
  {
    repositories: {},
    ...(runtimeVersions === undefined
      ? {}
      : { runtime_versions: runtimeVersions }),
    tool_catalogs: installedToolCatalogView,
  },
  workspaceProfileVersions,
  (rows, settings) => withConsoleRepositories(rows, settings?.repositories),
);
const logCatalog = (message: string): void => {
  logger.info(message, {
    profiles: Object.keys(catalog.profiles).length,
    repositories: Object.keys(catalog.repositories).length,
  });
  const skipped = unrunnableProfiles(catalog);
  if (skipped.length > 0) {
    logger.warn("Profiles left out of this replica's catalog", {
      profiles: skipped,
    });
  }
};
const refreshWorkspaceProfiles = (): void => {
  workspaceProfileVersions
    .refresh(WORKSPACE_PROFILE_REFRESH_MS)
    .catch((error: unknown) => {
      logger.warn("Workspace profiles could not be read; retrying", {
        error_name: error instanceof Error ? error.name : typeof error,
      });
    });
};
// The registry runs only what the database holds. Until the first read a
// profile id it does not know reads the database itself, so a request
// waits on that read rather than this one.
const PROFILE_READ_RETRY_MS = 30_000;
const readProfiles = (): void => {
  workspaceProfileVersions.refresh().then(
    () => {
      logCatalog("Session catalog loaded");
      const unattended = unattendedProfiles(catalog);
      if (unattended.length > 0) {
        logger.warn("Profiles run tools without asking for approval", {
          profiles: unattended,
        });
      }
      setInterval(
        refreshWorkspaceProfiles,
        WORKSPACE_PROFILE_REFRESH_MS,
      ).unref();
    },
    (error: unknown) => {
      logger.warn("Profiles could not be read; retrying", {
        error_name: error instanceof Error ? error.name : typeof error,
      });
      setTimeout(readProfiles, PROFILE_READ_RETRY_MS).unref();
    },
  );
};
readProfiles();
// Not awaited: the API starts without its database, and a version 1
// fingerprint names its model, so nothing waits on the column being filled.
const MODEL_BACKFILL_RETRY_MS = 30_000;
const backfillModels = (): void => {
  backfillSessionModels(db, ({ profileId, fingerprint }) =>
    fingerprintModel(catalog, profileId, fingerprint),
  ).then(
    (sessions) => logger.info("Session models backfilled", { sessions }),
    (error: unknown) => {
      logger.warn("Session models could not be backfilled; retrying", {
        error_name: error instanceof Error ? error.name : typeof error,
      });
      setTimeout(backfillModels, MODEL_BACKFILL_RETRY_MS).unref();
    },
  );
};
backfillModels();
const neutralize = eventNeutralizer(catalog, logger);
startNeutralFill(db, neutralize, logger, () =>
  workspaceProfileVersions.refresh(),
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
const agentAccess = createPostgresAgentAccessSetting(db);
const sessionShares = createPostgresSessionShareStore(db);
const authorization = createAuthorizationPolicy({
  ...(authMode === "none"
    ? {}
    : { identity: createDatabaseIdentityReader(db) }),
  agents: createDatabaseAgentAuthority(db),
  credentials: credentialBindings,
  slackGuests,
  outsideAgents: agentAccess,
  sessions: sessionShares,
  decisions: createPostgresDecisionLog(db),
});
const agentStore = createPostgresAgentStore(db);
const surfaceBindingStore = createPostgresSurfaceBindingStore(db);
const slackBotApi = createSlackBotApi({ apiUrl: slackApiUrlFrom(process.env) });
const slackAppStore =
  secretKey === null ? null : createPostgresSlackAppStore(db, secretKey);
const slackJoin =
  secretKey === null || slackAppStore === null // narrows both
    ? null
    : createSlackChannelJoiner({
        bindings: surfaceBindingStore,
        slack: slackBotApi,
        botToken: (workspaceId, agentId) =>
          agentSlackBotToken(
            {
              apps: slackAppStore,
              secrets: createPostgresSecretStore(db, secretKey),
            },
            workspaceId,
            agentId,
          ),
      });
const slackWelcome =
  slackAppStore === null
    ? null
    : createSlackWelcome({
        agents: agentStore,
        bindings: surfaceBindingStore,
        apps: slackAppStore,
        outbox: createPostgresSlackOutboxStore(db),
        join: slackJoin,
        logger,
      });
const githubSettingsStore = createPostgresGitHubSettingsStore(db);
const profileRollouts = createPostgresProfileRolloutStore(db);
const agents = createAgentService({
  authorization,
  store: agentStore,
  catalog,
  credentials: credentialBindings,
  githubSettings: githubSettingsStore,
  ...(slackWelcome === null ? {} : { welcome: slackWelcome }),
  keys: createPostgresWorkspaceKeyStore(db),
  outsideAgents: agentAccess,
  profileLineage: profileRollouts,
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
  promptRevision: platformPromptRevisionFromEnv(process.env),
  actionFlows: () => settings.actionFlows,
  credentials: credentialBindings,
  limits,
});
const sessionOutputs = createSessionOutputService({
  sessions,
  source: checkpoints.outputs,
});
// The same parsed limits admission and dispatch run under, so what this
// reports is what the gates enforce.
const usage = createUsageService({
  authorization,
  reader: createPostgresUsageReader(db),
  limits,
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
// A Slack call answered `token_revoked` with no uninstall event sent.
const slackTokenRevoked =
  secretKey === null
    ? undefined
    : createSlackTokenRevoked({
        identities: slackIdentityStore,
        installs: slackInstallStore,
        secrets: createPostgresSecretStore(db, secretKey),
        onError: (error) =>
          logger.warn("Slack token_revoked could not revoke the install", {
            error: error instanceof Error ? error.message : String(error),
          }),
      });
const slackBindings = createSurfaceBindingService({
  authorization,
  store: surfaceBindingStore,
  channels: createSlackChannelKinds({
    apps: slackAppStore,
    secrets:
      secretKey === null ? null : createPostgresSecretStore(db, secretKey),
    slack: slackBotApi,
    ...(slackTokenRevoked ? { tokenRevoked: slackTokenRevoked } : {}),
  }),
  ...(slackJoin === null ? {} : { join: slackJoin }),
  ...(slackWelcome === null ? {} : { welcome: slackWelcome }),
});
const linkedAccounts = createLinkedAccountService({
  authorization,
  store: createPostgresLinkedAccountStore(db),
});
const slackOidc = slackOidcSettingsFromEnv(process.env);
const slackConfigApi = createSlackConfigApi({
  apiUrl: slackApiUrlFrom(process.env),
});
const slackConfigTokens =
  secretKey === null
    ? null
    : createSlackConfigTokens({
        store: createPostgresSlackConfigTokenStore(db, secretKey),
        api: slackConfigApi,
      });
const consoleOrigin = consoleOriginFrom(process.env);
if (consoleOrigin === null) {
  logger.warn(
    "Slack apps cannot be created (SLACK_OIDC_REDIRECT_URI unset): their OAuth redirect is on the console's origin",
    {},
  );
}
const slackLinkOff = signInWithSlackOff(slackOidc, secretKey !== null);
if (slackLinkOff !== null) logger.warn(slackLinkOff, {});
const slackSecrets = createSlackSecretService({
  authorization,
  store: secretKey === null ? null : createPostgresSecretStore(db, secretKey),
  tokens: slackConfigTokens,
  appKind: (workspaceId, slackAppId) =>
    slackAppKind(db, workspaceId, slackAppId),
});
const slackSigningSecrets =
  secretKey === null || slackAppStore === null // narrows both
    ? null
    : createSlackSigningSecrets({
        apps: slackAppStore,
        secrets: createPostgresSecretStore(db, secretKey),
      });
const slackChannels = createSlackChannelSearchService({
  authorization,
  agents: createDatabaseAgentAuthority(db),
  apps: slackAppStore,
  secrets: secretKey === null ? null : createPostgresSecretStore(db, secretKey),
  api: slackBotApi,
  ...(slackTokenRevoked ? { tokenRevoked: slackTokenRevoked } : {}),
});
const slackApps = createSlackAppService({
  authorization,
  apps: slackAppStore,
  tokens: slackConfigTokens,
  api: slackConfigApi,
  consoleOrigin,
  eventsPublicUrl: slackEventsPublicUrlFrom(process.env),
  onAgentAppChanged: (agentId) => slackSigningSecrets?.invalidate(agentId),
  activeReleaseWarning: async (workspaceId, agentId) => {
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
        (error.code === "PROFILE_DIGEST_MISMATCH" ||
          error.code === "PROFILE_BLOCKED")
      ) {
        return {
          code: "profile_unavailable",
          profile_id: release.runtime_profile_id,
        };
      }
      throw error;
    }
    // Missing and dropped from the catalog take the same fix: a new release.
    return releaseStartable(
      catalog,
      release,
      await agentGitHubSettingsOf(db, agentId),
      await workspaceRepositoryCeiling(db, workspaceId),
    )
      ? null
      : { code: "repository_required", profile_id: release.runtime_profile_id };
  },
});
const slackEventsPublicUrl = slackEventsPublicUrlFrom(process.env);
if (slackEventsPublicUrl === null) {
  logger.warn(
    "Slack apps get no event subscription (SLACK_EVENTS_PUBLIC_URL unset): installs finish with events_url_unset",
    {},
  );
}
const slackEvents = createSlackEventsService({
  signingSecrets: slackSigningSecrets ?? { forAgent: async () => null },
  inbox: createPostgresSlackInboundEventStore(db),
  apps: slackAppStore ?? { setEventsUnlessVerified: async () => {} },
  identities: slackIdentityStore,
  installs: slackInstallStore,
});
const slackInstall = createSlackInstallService({
  authorization,
  apps: slackAppStore,
  states: secretKey === null ? null : slackInstallStore,
  secrets: secretKey === null ? null : createPostgresSecretStore(db, secretKey),
  tokens: slackConfigTokens,
  identities: slackIdentityStore,
  api: slackConfigApi,
  ...(slackAppStore === null || slackWelcome === null
    ? {}
    : {
        finalize: composeSlackFinalize(
          createSlackEventsFinalize({
            apps: slackApps,
            agents: slackAppStore,
            publicUrl: slackEventsPublicUrl,
          }),
          slackWelcome.finalize,
        ),
      }),
});
const slackLinkApps = createSlackLinkAppService({
  authorization,
  apps: slackAppStore,
  tokens: slackConfigTokens,
  api: slackConfigApi,
  consoleOrigin,
  fallback:
    slackOidc?.client == null
      ? null
      : { ...slackOidc.client, redirectUri: slackOidc.redirectUri },
});
const credentialBindingService = createCredentialBindingService({
  authorization,
  store: credentialBindings,
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
const workspaceProfiles = createWorkspaceProfileService({
  authorization,
  store: workspaceProfileStore,
  catalog,
  rollouts: profileRollouts,
});
const achievementRules = createAchievementRuleService({
  authorization,
  store: createPostgresAchievementRuleStore(db),
});
const installationProfiles = createInstallationProfileService({
  authorization,
  store: installationProfileStore,
  rollouts: profileRollouts,
  catalog,
  connections: () => workspaceProfileVersions.connections,
  allowUnattended: unattendedAllowed(process.env),
  runtimes: installedRuntimes,
});
const settingsDocumentStore = createPostgresSettingsDocumentStore(
  db,
  secretKey,
);
const rereadSettings = () =>
  workspaceProfileVersions.refresh().catch(() => undefined);
const settingsDocument = createSettingsDocumentService({
  authorization,
  store: settingsDocumentStore,
  reread: rereadSettings,
});
const settingsConsole = createSettingsConsoleService({
  authorization,
  store: settingsDocumentStore,
  leftOut: () => workspaceProfileVersions.settings?.left_out ?? [],
  secretStoreOn: secretKey !== null,
  credentialHosts: credentialHostsFromEnv(process.env),
  reread: rereadSettings,
  profiles: {
    refresh: () => workspaceProfileVersions.refresh(),
    catalog,
    settings: () => ({
      connections: workspaceProfileVersions.connections,
      connection_aliases:
        workspaceProfileVersions.settings?.connection_aliases ?? {},
    }),
  },
});
const agentAdmins = createAgentAdminService({
  authorization,
  store: createPostgresAgentAdminStore(db),
});
const inviteStore = createPostgresInviteStore(db);
const invites = createInviteService({ authorization, store: inviteStore });
const githubAppStore =
  secretKey === null ? null : createPostgresGitHubAppStore(db, secretKey);
const registeredGitHub = createRegisteredGitHubConnections({
  store: githubAppStore,
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
setInterval(refreshRegisteredGitHub, WORKSPACE_PROFILE_REFRESH_MS).unref();
const githubAppDirectory = createGitHubAppDirectory({ logger });
const githubRepositories = createGitHubRepositoryService({
  authorization,
  store: catalogRepositoryStore,
  apps: githubAppStore,
  pins: githubAppStore === null ? null : githubPins,
  directory: githubAppDirectory,
  agents: agentStore,
  repositoryCeiling: (workspaceId) =>
    workspaceRepositoryCeiling(db, workspaceId),
  changed: () => workspaceProfileVersions.refresh(),
});
const githubInstallations = createPostgresGitHubInstallationStore(db);
const githubApps = createGitHubAppService({
  authorization,
  store: githubAppStore,
  directory: githubAppDirectory,
  apiBase: GITHUB_API_BASE,
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
    convert: createGitHubManifestConverter({ logger }),
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
const githubConnections = connectionsOf(catalog, {
  logger,
  registered: (role) => registeredGitHub.connections(role),
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
const githubWork = createGitHubWorkService({
  authorization,
  gate: github,
  store: githubGateStore,
  redact: sanitizeText,
});
const githubOAuth = createPostgresGitHubOAuthStore(db, secretKey);
const githubCallback = githubCallbackUrl(consoleOrigin);
const pullRequestSettings = createPostgresPullRequestSettingsStore(db);
const githubSettings = createGitHubSettingsService({
  authorization,
  store: githubSettingsStore,
  pullRequestSettings,
  oauth: githubOAuth,
  callbackUrl: githubCallback,
  secretsOn: secretKey !== null,
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
  }),
  secretsOn: secretKey !== null,
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
  ...(githubAppStore === null
    ? {}
    : { pinned: { apps: githubAppStore, pins: githubPins } }),
});
const agentMcp = createAgentMcpService({
  authorization,
  store: createPostgresAgentMcpStore(db),
  catalog,
});
const agentPullRequest = createAgentPullRequestService({
  authorization,
  agents: agentStore,
  settings: pullRequestSettings,
});
const pushStore = createPostgresPushRequests(db);
const pushIntentStore = createPostgresPushIntents(db);
const pushRequests = createPushRequestService({
  authorization,
  store: pushStore,
  intents: pushIntentStore,
  source: checkpoints.pushSource,
  catalog,
});
const pullRequestStore = createPostgresPullRequests(db);
const pullRequests = createPullRequestService({
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
// The built-in `github` MCP server: the same services as the session API,
// each made with the authorization of the one session a grant names.
const githubMcpStore = createPostgresGitHubMcpStore(db);
const repositoryAttachmentStore = createPostgresRepositoryAttachments(db);
const repositoryAttachments = createRepositoryAttachmentService({
  store: repositoryAttachmentStore,
  context: githubGateStore,
  catalog,
});
const githubMcp = createGitHubMcpServer({
  store: githubMcpStore,
  actionFlows: () => settings.actionFlows,
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
    pushRequests: createPushRequestService({
      authorization: bound,
      store: pushStore,
      intents: pushIntentStore,
      source: checkpoints.pushSource,
      catalog,
    }),
    pullRequests: createPullRequestService({
      authorization: bound,
      store: pullRequestStore,
      catalog,
      gate: github,
      redact: sanitizeText,
      attribution: sessionAttribution,
      settings: pullRequestSettings,
      consoleOrigin,
      logger,
    }),
    githubWork: createGitHubWorkService({
      authorization: bound,
      gate: github,
      store: githubGateStore,
      redact: sanitizeText,
    }),
    attachments: repositoryAttachments,
  }),
});
const pushExecutor = createPushExecutor({
  store: pushStore,
  catalog,
  gate: github,
  bundles: checkpoints.pushSource,
  pusher: createGitPusher({ maxGitMemoryBytes: checkpointGitMemoryBytes }),
  attributions: commitAttributions,
  logger,
}).start();
// The control-host action-broker's intent runner starts whatever
// AGENT_ACTION_FLOWS says: intents made while it was on are finished after it
// is turned off. It makes push requests as the stored actor and approves
// nothing.
const pushIntentRunner = createPushIntentRunner({
  store: pushIntentStore,
  createFromIntent: (job) => pushRequests.createFromIntent(job),
  logger,
}).start();
// Moves agents that follow a profile onto its newest version (design 2.3).
// Every replica runs it; an item's lease and the activation's compare-and-swap
// make a second one harmless.
const profileRolloutRunner = createProfileRolloutRunner({
  rollouts: profileRollouts,
  agentStore,
  agents,
  logger,
  sweep: true,
}).start();
// The pull request drain of the control-host's action-broker starts whether
// or not AGENT_ACTION_FLOWS is on: a stage left from before a restart with
// the setting off is still finished.
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
// achievements (achievement-rules.md §4).
const achievementJudgments = createPostgresAchievementJudgments(db);
const judgmentEgress = createPostgresJudgmentEgress(db);
// The judge calls Luna through the egress proxy's credential listener, the
// one generated titles use. No connection resolves until connections are
// stored, so `luna` rules stay `judge_unavailable` meanwhile.
const judgeEgressUrl = sessionTitleEgressUrlFromEnv(process.env);
const achievementJudge = createAchievementJudge({
  store: achievementJudgments,
  outputs: checkpoints.outputs,
  logger,
  ...(judgeEgressUrl === null
    ? {}
    : {
        luna: {
          connections: NO_JUDGE_CONNECTIONS,
          tokens: judgmentEgress,
          decisions: createDecisionsClient({ egressUrl: judgeEgressUrl }),
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
const workers = createWorkerGateway({
  work: createPostgresWorkerUnitOfWork(db, { logger }),
  catalog,
  neutralize,
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
  attribution: {
    store: sessionAttribution,
    ledger: commitAttributions,
    consoleOrigin,
    sessionLink: async (workspaceId) =>
      (await pullRequestSettings.get(workspaceId)).settings.session_link,
    appBotUserId: createAppBotUsers({ logger }),
    commitPin: {
      resolver: githubResolver,
      onFailed: (failure) =>
        logger.warn("Commit author pin not made at claim", failure),
    },
  },
  mcp: createPostgresMcpEgressStore(db),
  onMcpReceiptError: (error) =>
    logger.error("MCP refusal receipt not recorded", {
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
    upstream: NO_JUDGE_CONNECTIONS.upstream,
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
    sessionCostLimitUsd: limits.sessionCostLimitUsd,
    workspaceEnforce: settings.workspaceEnforce,
    sessionTokenLimit: limits.sessionTokenLimit,
    leaseTtlMs: settings.leaseTtlMs,
    // How long a permission or question takes answers. The worker waits
    // exactly this long once the request is registered.
    pendingTtlMs: settings.pendingTtlMs,
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
const google = googleLoginConfigFromEnv(process.env);
if (google.problems.length > 0) {
  throw new Error(
    `Invalid Google sign-in settings: ${google.problems.join("; ")}`,
  );
}
// One window and one hashing gate for every account password check (login,
// the reset issuer's re-check, invite accept), so no route resets another's
// count.
const lockout = new LoginLockout();
const passwordWork = new WorkGate();
const auth = {
  identity,
  ...(google.config ? { google: createGoogleLogin(google.config) } : {}),
  lockout,
  passwordWork,
  bootstrap: await bootstrapGateFromEnv(
    process.env.BOOTSTRAP_TOKEN,
    identity,
    logger,
    undefined,
    undefined,
    process.env.BOOTSTRAP_TOKEN_FILE || undefined,
  ),
  logger,
};
const slackInteractions = createSlackInteractionService({
  signingSecrets: slackSigningSecrets ?? { forAgent: async () => null },
  authorization,
  agents: slackIdentityStore,
  links: createPostgresLinkedAccountStore(db),
  bindings: surfaceBindingStore,
  pending: pendingRequests,
  pushes: pushRequests,
  sessions,
  followUps: createPostgresPushFollowUpStore(db),
  slack: slackBotApi,
  botToken: async (workspaceId, slackAppId) =>
    secretKey === null
      ? null
      : slackBotToken(
          createPostgresSecretStore(db, secretKey),
          workspaceId,
          slackAppId,
        ),
  outbox: createPostgresSlackOutboxStore(db),
  connectUrl:
    consoleOrigin === null
      ? ""
      : new URL("/settings/linked-accounts", consoleOrigin).toString(),
  logger,
});
const probePool = createProbePool(databaseUrl, logger);
const app = createApiApp({
  ...(authMode === undefined ? {} : { authMode }),
  logger,
  keyStore: new DatabaseApiKeyStore(db),
  identity,
  authorization,
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
    registerPublicInviteRoutes(router, {
      invites: inviteStore,
      identity,
      lockout,
      passwordWork,
      logger,
    });
  },
  registerRoutes: (router) => {
    registerAuthRoutes(router, auth);
    registerInviteRoutes(router, invites);
    registerWorkspaceRoutes(router, {
      authorization,
      retention: createPostgresAuditRetention(db),
      slackGuests,
      agentAccess,
    });
    registerSlackSecretRoutes(router, slackSecrets);
    registerGitHubAppRoutes(router, githubApps, logger);
    registerGitHubRepositoryRoutes(router, githubRepositories);
    registerGitHubSettingsRoutes(router, githubSettings);
    registerGitHubPackagesRoutes(router, githubPackages);
    registerAgentGitHubRoutes(router, agentGitHub);
    registerAgentMcpRoutes(router, agentMcp);
    registerAgentPullRequestRoutes(router, agentPullRequest);
    registerSessionRoutes(router, sessions);
    registerSessionOutputRoutes(router, sessionOutputs);
    registerSessionShareRoutes(router, shares, sessions);
    registerPauseRoutes(router, sessions);
    registerCloseRoutes(router, sessions);
    registerReceiptRoutes(router, sessions);
    registerUsageRoutes(router, usage);
    registerProfileRoutes(router, workspaceProfiles, installationProfiles);
    registerInstallationSettingsRoutes(router, settingsDocument);
    registerSettingsConsoleRoutes(router, settingsConsole);
    registerAchievementRoutes(router, achievementRules);
    registerSessionAchievementRoutes(
      router,
      createSessionAchievementService({
        authorization,
        store: achievementJudgments,
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
      github: { oauth: githubOAuth, redirectUri: githubCallback },
      slack:
        slackOidc === null
          ? null
          : { issuer: slackOidc.issuer, clients: slackLinkApps },
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
    registerCredentialBindingRoutes(router, credentialBindingService);
    registerEventRoutes(router, sessions, {
      wakeup: notifier,
      logger,
      ...settings.sse,
    });
  },
  registerInternalRoutes: (router) => registerWorkerRoutes(router, workers),
  ...(settings.webDistDir === undefined
    ? {}
    : { webDistDir: settings.webDistDir }),
  readiness: shutdown.readiness(
    createReadinessProbe({
      db: probePool,
      requiredEnv: API_READINESS_REQUIRED_ENV,
      configProblems: apiReadinessConfigProblems,
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

// Pools close last: requests still draining hold their clients until then.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown.run(
      signal,
      // The authorizer drains with the API: a proxy exchange mid-regrant
      // gets its answer, and one refused after the stop rides its grace.
      authorizerListener === undefined
        ? [server]
        : [server, authorizerListener],
      [
        { name: "push-executor", close: () => pushExecutor.stop() },
        { name: "push-intent-runner", close: () => pushIntentRunner.stop() },
        {
          name: "profile-rollout-runner",
          close: () => profileRolloutRunner.stop(),
        },
        { name: "pull-request-drain", close: () => pullRequestDrain.stop() },
        { name: "outcome-refresher", close: () => outcomeRefresher.stop() },
        { name: "achievement-judge", close: () => achievementJudge.stop() },
        { name: "event-listener", close: () => notifier.close() },
        { name: "pool", close: () => pool.end() },
        { name: "probe-pool", close: () => probePool.end() },
      ],
    );
  });
}

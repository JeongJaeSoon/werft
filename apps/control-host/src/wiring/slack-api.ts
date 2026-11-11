// The API role's Slack chat adapters, built in the stages the role needs them:
// the platform services between the stages take the earlier stage's output.
// Every adapter is created exactly once, in the order the role used before.
import type { StructuredLogger } from "@werft-ai/observability";
import type {
  AgentIdentityStore,
  SecretStore,
  SlackAppStore,
  SlackInstallStore,
  SurfaceBindingStore,
} from "@werft-ai/platform";
import {
  agentSlackBotToken,
  composeSlackFinalize,
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
  slackBotToken,
  slackPublicUrlsOf,
} from "./chat-slack.ts";

type Param<F extends (...args: never[]) => unknown> = Parameters<F>[0];

export interface SlackBotStageDeps {
  apiUrl: string;
  /** Null (with `secrets`) when no master key is set. */
  appStore: SlackAppStore | null;
  secrets: SecretStore | null;
  bindings: SurfaceBindingStore;
  agents: Param<typeof createSlackWelcome>["agents"];
  outbox: Param<typeof createSlackWelcome>["outbox"];
  logger: StructuredLogger;
}

export interface SlackBotStage {
  api: ReturnType<typeof createSlackBotApi>;
  /** Null when no master key is set: there is no token to join with. */
  join: ReturnType<typeof createSlackChannelJoiner> | null;
  welcome: ReturnType<typeof createSlackWelcome> | null;
}

export function wireSlackBot(deps: SlackBotStageDeps): SlackBotStage {
  const { appStore, secrets } = deps;
  const api = createSlackBotApi({ apiUrl: deps.apiUrl });
  const join =
    secrets === null || appStore === null // narrows both
      ? null
      : createSlackChannelJoiner({
          bindings: deps.bindings,
          slack: api,
          botToken: (workspaceId, agentId) =>
            agentSlackBotToken(
              { apps: appStore, secrets },
              workspaceId,
              agentId,
            ),
        });
  const welcome =
    appStore === null
      ? null
      : createSlackWelcome({
          agents: deps.agents,
          bindings: deps.bindings,
          apps: appStore,
          outbox: deps.outbox,
          join,
          logger: deps.logger,
        });
  return { api, join, welcome };
}

export interface SlackChannelsStageDeps {
  api: SlackBotStage["api"];
  appStore: SlackBotStageDeps["appStore"];
  secrets: SlackBotStageDeps["secrets"];
  identities: AgentIdentityStore;
  installs: SlackInstallStore;
  onTokenRevokedError: (error: unknown) => void;
}

export interface SlackChannelsStage {
  /** A Slack call answered `token_revoked` with no uninstall event sent. */
  tokenRevoked: ReturnType<typeof createSlackTokenRevoked> | undefined;
  channelKinds: ReturnType<typeof createSlackChannelKinds>;
}

export function wireSlackChannels(
  deps: SlackChannelsStageDeps,
): SlackChannelsStage {
  const tokenRevoked =
    deps.secrets === null
      ? undefined
      : createSlackTokenRevoked({
          identities: deps.identities,
          installs: deps.installs,
          secrets: deps.secrets,
          onError: deps.onTokenRevokedError,
        });
  return {
    tokenRevoked,
    channelKinds: createSlackChannelKinds({
      apps: deps.appStore,
      secrets: deps.secrets,
      slack: deps.api,
      ...(tokenRevoked ? { tokenRevoked } : {}),
    }),
  };
}

export interface SlackConfigStageDeps {
  apiUrl: string;
  /** Null when no master key is set. */
  tokenStore: Param<typeof createSlackConfigTokens>["store"] | null;
}

export interface SlackConfigStage {
  api: ReturnType<typeof createSlackConfigApi>;
  tokens: ReturnType<typeof createSlackConfigTokens> | null;
}

export function wireSlackConfig(deps: SlackConfigStageDeps): SlackConfigStage {
  const api = createSlackConfigApi({ apiUrl: deps.apiUrl });
  return {
    api,
    tokens:
      deps.tokenStore === null
        ? null
        : createSlackConfigTokens({ store: deps.tokenStore, api }),
  };
}

export interface SlackServicesStageDeps {
  authorization: Param<typeof createSlackSecretService>["authorization"];
  appStore: SlackBotStageDeps["appStore"];
  secrets: SlackBotStageDeps["secrets"];
  config: SlackConfigStage;
  botApi: SlackBotStage["api"];
  welcome: SlackBotStage["welcome"];
  tokenRevoked: SlackChannelsStage["tokenRevoked"];
  agentAuthority: Param<typeof createSlackChannelSearchService>["agents"];
  inbox: Param<typeof createSlackEventsService>["inbox"];
  identities: AgentIdentityStore;
  installs: SlackInstallStore;
  bindings: SurfaceBindingStore;
  /** Null when the install flow has no key to seal the state with. */
  installStates: Param<typeof createSlackInstallService>["states"];
  consoleOrigin: string | null;
  eventsPublicUrl: string | null;
  appKind: Param<typeof createSlackSecretService>["appKind"];
  activeReleaseWarning: NonNullable<
    Param<typeof createSlackAppService>["activeReleaseWarning"]
  >;
  logger: StructuredLogger;
}

export interface SlackServicesStage {
  secrets: ReturnType<typeof createSlackSecretService>;
  /** Null when no master key or app store is set. */
  signingSecrets: ReturnType<typeof createSlackSigningSecrets> | null;
  channels: ReturnType<typeof createSlackChannelSearchService>;
  apps: ReturnType<typeof createSlackAppService>;
  events: ReturnType<typeof createSlackEventsService>;
  install: ReturnType<typeof createSlackInstallService>;
  linkApps: ReturnType<typeof createSlackLinkAppService>;
}

export function wireSlackServices(
  deps: SlackServicesStageDeps,
): SlackServicesStage {
  const { appStore, secrets, config, authorization } = deps;
  const secretService = createSlackSecretService({
    authorization,
    store: secrets,
    tokens: config.tokens,
    urls: slackPublicUrlsOf(deps.consoleOrigin, deps.eventsPublicUrl),
    appKind: deps.appKind,
  });
  const signingSecrets =
    secrets === null || appStore === null // narrows both
      ? null
      : createSlackSigningSecrets({ apps: appStore, secrets });
  const channels = createSlackChannelSearchService({
    authorization,
    agents: deps.agentAuthority,
    apps: appStore,
    secrets,
    api: deps.botApi,
    ...(deps.tokenRevoked ? { tokenRevoked: deps.tokenRevoked } : {}),
  });
  const apps = createSlackAppService({
    authorization,
    apps: appStore,
    tokens: config.tokens,
    api: config.api,
    consoleOrigin: deps.consoleOrigin,
    eventsPublicUrl: deps.eventsPublicUrl,
    logger: deps.logger,
    onAgentAppChanged: (agentId) => signingSecrets?.invalidate(agentId),
    activeReleaseWarning: deps.activeReleaseWarning,
  });
  const events = createSlackEventsService({
    signingSecrets: signingSecrets ?? { forAgent: async () => null },
    inbox: deps.inbox,
    apps: appStore ?? { setEventsUnlessVerified: async () => {} },
    identities: deps.identities,
    installs: deps.installs,
    bindings: deps.bindings,
  });
  const install = createSlackInstallService({
    authorization,
    apps: appStore,
    states: deps.installStates,
    secrets,
    tokens: config.tokens,
    identities: deps.identities,
    api: config.api,
    ...(appStore === null || deps.welcome === null
      ? {}
      : {
          finalize: composeSlackFinalize(
            createSlackEventsFinalize({
              apps,
              agents: appStore,
              publicUrl: deps.eventsPublicUrl,
            }),
            deps.welcome.finalize,
          ),
        }),
  });
  const linkApps = createSlackLinkAppService({
    authorization,
    apps: appStore,
    tokens: config.tokens,
    api: config.api,
    consoleOrigin: deps.consoleOrigin,
  });
  return {
    secrets: secretService,
    signingSecrets,
    channels,
    apps,
    events,
    install,
    linkApps,
  };
}

export interface SlackInteractionsStageDeps {
  secrets: SlackBotStageDeps["secrets"];
  signingSecrets: SlackServicesStage["signingSecrets"];
  botApi: SlackBotStage["api"];
  authorization: Param<typeof createSlackInteractionService>["authorization"];
  agents: AgentIdentityStore;
  links: Param<typeof createSlackInteractionService>["links"];
  bindings: SurfaceBindingStore;
  pending: Param<typeof createSlackInteractionService>["pending"];
  pushes: Param<typeof createSlackInteractionService>["pushes"];
  sessions: Param<typeof createSlackInteractionService>["sessions"];
  followUps: Param<typeof createSlackInteractionService>["followUps"];
  outbox: Param<typeof createSlackInteractionService>["outbox"];
  consoleOrigin: string | null;
  logger: StructuredLogger;
}

export function wireSlackInteractions(deps: SlackInteractionsStageDeps) {
  const { secrets } = deps;
  return createSlackInteractionService({
    signingSecrets: deps.signingSecrets ?? { forAgent: async () => null },
    authorization: deps.authorization,
    agents: deps.agents,
    links: deps.links,
    bindings: deps.bindings,
    pending: deps.pending,
    pushes: deps.pushes,
    sessions: deps.sessions,
    followUps: deps.followUps,
    slack: deps.botApi,
    botToken: async (workspaceId, slackAppId) =>
      secrets === null ? null : slackBotToken(secrets, workspaceId, slackAppId),
    outbox: deps.outbox,
    connectUrl:
      deps.consoleOrigin === null
        ? ""
        : new URL("/settings/linked-accounts", deps.consoleOrigin).toString(),
    logger: deps.logger,
  });
}

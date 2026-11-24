// The API role's Slack chat adapters, built in the stages the role needs them:
// the platform services between the stages take the earlier stage's output.
// Every adapter is created exactly once, and a stage runs after the stages
// whose output it takes. The stores a stage takes are already built when it
// runs, the outbox store included: constructing that store only closes over
// the database handle, so where it is built changes nothing observable.
import type { StructuredLogger } from "@werft-ai/observability";
import type {
  AgentIdentityStore,
  ChannelMemberStore,
  SecretStore,
  SurfaceAppStore,
  SurfaceBindingStore,
  SurfaceInstallStore,
} from "@werft-ai/platform";
import {
  agentSlackBotToken,
  composeSlackFinalize,
  createSlackAppService,
  createSlackBotApi,
  createSlackChannelJoiner,
  createSlackChannelKinds,
  createSlackChannelMembers,
  createSlackChannelSearchService,
  createSlackChannelSharingReader,
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
  type SlackChannelMembers,
  slackBotToken,
  slackPublicUrlsOf,
} from "./chat-slack.ts";
import { type Param, slackConnectUrl } from "./slack-shared.ts";

/**
 * Makes a secret store on each call, as the role did at every use: the stores
 * hold no state, but how many are made stays what it was.
 */
export type SecretStoreSource = () => SecretStore;

export interface SlackBotStageDeps {
  apiUrl: string;
  appStore: SurfaceAppStore;
  secrets: SecretStoreSource;
  bindings: SurfaceBindingStore;
  agents: Param<typeof createSlackWelcome>["agents"];
  outbox: Param<typeof createSlackWelcome>["outbox"];
  logger: StructuredLogger;
}

export interface SlackBotStage {
  api: ReturnType<typeof createSlackBotApi>;
  join: ReturnType<typeof createSlackChannelJoiner>;
  welcome: ReturnType<typeof createSlackWelcome>;
}

export function wireSlackBot(deps: SlackBotStageDeps): SlackBotStage {
  const { appStore, secrets } = deps;
  const api = createSlackBotApi({ apiUrl: deps.apiUrl });
  const join = createSlackChannelJoiner({
    bindings: deps.bindings,
    slack: api,
    botToken: (workspaceId, agentId) =>
      agentSlackBotToken(
        { apps: appStore, secrets: secrets() },
        workspaceId,
        agentId,
      ),
  });
  const welcome = createSlackWelcome({
    agents: deps.agents,
    bindings: deps.bindings,
    apps: appStore,
    outbox: deps.outbox,
    join,
    logger: deps.logger,
  });
  return { api, join, welcome };
}

/**
 * Whether a person is a member of a channel now, for the policy's private
 * channel decisions; its own bot API, as no stage needs to come first.
 */
export function wireSlackChannelMembers(deps: {
  apiUrl: string;
  appStore: SurfaceAppStore;
  secrets: SecretStoreSource;
  store: ChannelMemberStore;
  logger: StructuredLogger;
}): SlackChannelMembers {
  return createSlackChannelMembers({
    store: deps.store,
    slack: createSlackBotApi({ apiUrl: deps.apiUrl }),
    botToken: (workspaceId, agentId) =>
      agentSlackBotToken(
        { apps: deps.appStore, secrets: deps.secrets() },
        workspaceId,
        agentId,
      ),
    logger: deps.logger,
  });
}

export interface SlackChannelsStageDeps {
  api: SlackBotStage["api"];
  appStore: SlackBotStageDeps["appStore"];
  secrets: SlackBotStageDeps["secrets"];
  identities: AgentIdentityStore;
  installs: SurfaceInstallStore;
  bindings: Pick<SurfaceBindingStore, "recordExternalShared">;
  onTokenRevokedError: (error: unknown) => void;
}

export interface SlackChannelsStage {
  /** A Slack call answered `token_revoked` with no uninstall event sent. */
  tokenRevoked: ReturnType<typeof createSlackTokenRevoked>;
  channelKinds: ReturnType<typeof createSlackChannelKinds> &
    ReturnType<typeof createSlackChannelSharingReader>;
}

export function wireSlackChannels(
  deps: SlackChannelsStageDeps,
): SlackChannelsStage {
  const tokenRevoked = createSlackTokenRevoked({
    identities: deps.identities,
    installs: deps.installs,
    secrets: deps.secrets(),
    onError: deps.onTokenRevokedError,
  });
  return {
    tokenRevoked,
    channelKinds: {
      ...createSlackChannelKinds({
        apps: deps.appStore,
        secrets: deps.secrets(),
        slack: deps.api,
        tokenRevoked,
      }),
      ...createSlackChannelSharingReader({
        apps: deps.appStore,
        secrets: deps.secrets(),
        slack: deps.api,
        bindings: deps.bindings,
      }),
    },
  };
}

export interface SlackConfigStageDeps {
  apiUrl: string;
  tokenStore: Param<typeof createSlackConfigTokens>["store"];
}

export interface SlackConfigStage {
  api: ReturnType<typeof createSlackConfigApi>;
  tokens: ReturnType<typeof createSlackConfigTokens>;
}

export function wireSlackConfig(deps: SlackConfigStageDeps): SlackConfigStage {
  const api = createSlackConfigApi({ apiUrl: deps.apiUrl });
  return {
    api,
    tokens: createSlackConfigTokens({ store: deps.tokenStore, api }),
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
  sourceMarks: Param<typeof createSlackEventsService>["sourceMarks"];
  mirrorEchoes: Param<typeof createSlackEventsService>["mirrorEchoes"];
  identities: AgentIdentityStore;
  installs: SurfaceInstallStore;
  bindings: SurfaceBindingStore;
  installStates: NonNullable<Param<typeof createSlackInstallService>["states"]>;
  consoleOrigin: string | null;
  /** The events base, read on each use. */
  eventsPublicUrl: () => Promise<string | null>;
  appKind: Param<typeof createSlackSecretService>["appKind"];
  activeReleaseWarning: NonNullable<
    Param<typeof createSlackAppService>["activeReleaseWarning"]
  >;
  logger: StructuredLogger;
}

export interface SlackServicesStage {
  secrets: ReturnType<typeof createSlackSecretService>;
  signingSecrets: ReturnType<typeof createSlackSigningSecrets>;
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
    store: secrets(),
    tokens: config.tokens,
    urls: async () =>
      slackPublicUrlsOf(deps.consoleOrigin, await deps.eventsPublicUrl()),
    appKind: deps.appKind,
  });
  const signingSecrets = createSlackSigningSecrets({
    apps: appStore,
    secrets: secrets(),
  });
  const channels = createSlackChannelSearchService({
    authorization,
    agents: deps.agentAuthority,
    apps: appStore,
    secrets: secrets(),
    api: deps.botApi,
    tokenRevoked: deps.tokenRevoked,
  });
  const apps = createSlackAppService({
    authorization,
    apps: appStore,
    tokens: config.tokens,
    api: config.api,
    consoleOrigin: deps.consoleOrigin,
    eventsPublicUrl: deps.eventsPublicUrl,
    logger: deps.logger,
    onAgentAppChanged: (agentId) => signingSecrets.invalidate(agentId),
    activeReleaseWarning: deps.activeReleaseWarning,
    bots: { secrets: secrets(), api: deps.botApi },
  });
  const events = createSlackEventsService({
    signingSecrets,
    inbox: deps.inbox,
    sourceMarks: deps.sourceMarks,
    mirrorEchoes: deps.mirrorEchoes,
    apps: appStore,
    identities: deps.identities,
    installs: deps.installs,
    bindings: deps.bindings,
  });
  const install = createSlackInstallService({
    authorization,
    apps: appStore,
    states: deps.installStates,
    secrets: secrets(),
    tokens: config.tokens,
    identities: deps.identities,
    api: config.api,
    finalize: composeSlackFinalize(
      createSlackEventsFinalize({
        apps,
        agents: appStore,
        publicUrl: deps.eventsPublicUrl,
      }),
      deps.welcome.finalize,
    ),
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
  requesterLeft: NonNullable<
    Param<typeof createSlackInteractionService>["requesterLeft"]
  >;
  consoleOrigin: string | null;
  logger: StructuredLogger;
}

export function wireSlackInteractions(deps: SlackInteractionsStageDeps) {
  const { secrets } = deps;
  return createSlackInteractionService({
    signingSecrets: deps.signingSecrets,
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
      slackBotToken(secrets(), workspaceId, slackAppId),
    outbox: deps.outbox,
    requesterLeft: deps.requesterLeft,
    connectUrl: slackConnectUrl(deps.consoleOrigin),
    logger: deps.logger,
  });
}

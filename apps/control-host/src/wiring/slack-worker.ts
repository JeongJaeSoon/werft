// The Slack role's chat adapters: the inbound handler chain and the outbound
// delivery. The role's drain loop and its stores stay in slack/main.ts.
import type { StructuredLogger } from "@werft-ai/observability";
import type {
  AgentIdentityStore,
  ChannelMemberStore,
  JudgmentBufferStore,
  SurfaceBindingStore,
  SurfaceCardSettleStore,
} from "@werft-ai/platform";
import {
  createRowDelivery,
  createSlackAudience,
  createSlackBotApi,
  createSlackChannelConversionHandler,
  createSlackChannelLifecycleHandler,
  createSlackChannelSharingHandler,
  createSlackMemberCacheInvalidator,
  createSlackMemberJoinedHandler,
  createSlackMemberLeftHandler,
  createSlackSessionHandler,
  createSlackWelcome,
  type SlackAudienceCache,
  type SlackChannelRef,
  type SlackInboundHandler,
  type SlackNoticeSink,
  slackBotToken,
} from "./chat-slack.ts";
import { type Param, slackAgentsUrl, slackConnectUrl } from "./slack-shared.ts";

export interface SlackInboundDeps {
  apiUrl: string;
  secrets: Parameters<typeof slackBotToken>[0];
  consoleOrigin: string | null;
  leaseMs: number;
  notices: SlackNoticeSink;
  inbox: Param<typeof createSlackSessionHandler>["inbox"];
  authorization: Param<typeof createSlackSessionHandler>["authorization"];
  identities: AgentIdentityStore;
  links: Param<typeof createSlackSessionHandler>["links"];
  bindings: SurfaceBindingStore;
  members: Pick<ChannelMemberStore, "forget">;
  refill?: (ref: SlackChannelRef) => void;
  cards: Pick<SurfaceCardSettleStore, "markChoiceCardsDueIn"> | undefined;
  settings: Param<typeof createSlackSessionHandler>["settings"];
  botTurns: Param<typeof createSlackSessionHandler>["botTurns"];
  sessionLinks: Param<typeof createSlackSessionHandler>["sessionLinks"];
  conversations: Param<typeof createSlackSessionHandler>["conversations"];
  sessions: Param<typeof createSlackSessionHandler>["sessions"];
  stops: Param<typeof createSlackSessionHandler>["stops"];
  agentDetails: Param<typeof createSlackSessionHandler>["agentDetails"];
  releaseRepositoryUnusable: Param<
    typeof createSlackSessionHandler
  >["releaseRepositoryUnusable"];
  welcomeAgents: Param<typeof createSlackWelcome>["agents"];
  welcomeApps: Param<typeof createSlackWelcome>["apps"];
  welcomeOutbox: Param<typeof createSlackWelcome>["outbox"];
  buffer: JudgmentBufferStore;
  mentionTurns: Param<typeof createSlackSessionHandler>["mentionTurns"];
  /** Slack's answers about channels and people, kept across passes. */
  audienceCache?: SlackAudienceCache;
  logger: StructuredLogger;
}

/**
 * The channel sharing handler wraps the member-cache void, which wraps the
 * channel conversion handler, which wraps
 * the channel lifecycle handler, which wraps the
 * left-handler, which wraps the joined-handler, which wraps the session
 * handler.
 */
export function wireSlackInbound(deps: SlackInboundDeps): SlackInboundHandler {
  const { secrets } = deps;
  const botToken = (workspaceId: string, slackAppId: string) =>
    slackBotToken(secrets, workspaceId, slackAppId);
  const slackApi = createSlackBotApi({ apiUrl: deps.apiUrl });
  const audience = createSlackAudience({
    slack: slackApi,
    bindings: deps.bindings,
    logger: deps.logger,
    ...(deps.audienceCache === undefined ? {} : { cache: deps.audienceCache }),
  });
  const sessionHandler = createSlackSessionHandler({
    inbox: deps.inbox,
    leaseMs: deps.leaseMs,
    authorization: deps.authorization,
    agents: deps.identities,
    links: deps.links,
    bindings: deps.bindings,
    settings: deps.settings,
    botTurns: deps.botTurns,
    sessionLinks: deps.sessionLinks,
    conversations: deps.conversations,
    buffer: deps.buffer,
    mentionTurns: deps.mentionTurns,
    audience,
    sessions: deps.sessions,
    stops: deps.stops,
    agentDetails: deps.agentDetails,
    releaseRepositoryUnusable: deps.releaseRepositoryUnusable,
    slack: slackApi,
    botToken,
    notices: deps.notices,
    logger: deps.logger,
    connectUrl: slackConnectUrl(deps.consoleOrigin),
    agentsUrl: slackAgentsUrl(deps.consoleOrigin),
  });
  const memberJoined = createSlackMemberJoinedHandler({
    agents: deps.identities,
    bindings: deps.bindings,
    welcome: createSlackWelcome({
      agents: deps.welcomeAgents,
      bindings: deps.bindings,
      apps: deps.welcomeApps,
      outbox: deps.welcomeOutbox,
      join: null,
      logger: deps.logger,
    }),
    slack: slackApi,
    botToken,
    next: sessionHandler,
  });
  const chain = createSlackMemberCacheInvalidator({
    agents: deps.identities,
    members: deps.members,
    ...(deps.refill === undefined ? {} : { refill: deps.refill }),
    ...(deps.cards === undefined ? {} : { cards: deps.cards }),
    next: createSlackChannelConversionHandler({
      agents: deps.identities,
      bindings: deps.bindings,
      logger: deps.logger,
      slack: slackApi,
      botToken,
      next: createSlackChannelLifecycleHandler({
        agents: deps.identities,
        bindings: deps.bindings,
        conversations: deps.conversations,
        next: createSlackMemberLeftHandler({
          agents: deps.identities,
          bindings: deps.bindings,
          next: memberJoined,
        }),
      }),
    }),
  });
  return createSlackChannelSharingHandler({
    agents: deps.identities,
    audience,
    bindings: deps.bindings,
    botToken,
    next: chain,
  });
}

export interface SlackOutboundDeps {
  apiUrl: string;
  secrets: Parameters<typeof slackBotToken>[0];
  consoleOrigin: string | null;
  logger: NonNullable<Param<typeof createRowDelivery>["logger"]>;
}

export interface SlackOutbound {
  api: ReturnType<typeof createSlackBotApi>;
  botToken: (workspaceId: string, slackAppId: string) => Promise<string | null>;
  delivery: ReturnType<typeof createRowDelivery>;
}

export function wireSlackOutbound(deps: SlackOutboundDeps): SlackOutbound {
  const api = createSlackBotApi({ apiUrl: deps.apiUrl });
  const botToken = (workspaceId: string, slackAppId: string) =>
    slackBotToken(deps.secrets, workspaceId, slackAppId);
  return {
    api,
    botToken,
    delivery: createRowDelivery({
      slack: api,
      logger: deps.logger,
      botToken,
      consoleOrigin: deps.consoleOrigin,
    }),
  };
}

// The Slack role's chat adapters: the inbound handler chain and the outbound
// delivery. The role's drain loop and its stores stay in slack/main.ts.
import type { StructuredLogger } from "@werft-ai/observability";
import type {
  AgentIdentityStore,
  SurfaceBindingStore,
} from "@werft-ai/platform";
import {
  createOutboxSlackNoticeSink,
  createRowDelivery,
  createSlackBotApi,
  createSlackMemberJoinedHandler,
  createSlackMemberLeftHandler,
  createSlackSessionHandler,
  createSlackWelcome,
  type SlackInboundHandler,
  type SlackNoticeSink,
  slackBotToken,
} from "./chat-slack.ts";
import { type Param, slackConnectUrl } from "./slack-shared.ts";

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
  settings: Param<typeof createSlackSessionHandler>["settings"];
  sessionLinks: Param<typeof createSlackSessionHandler>["sessionLinks"];
  sessions: Param<typeof createSlackSessionHandler>["sessions"];
  agentDetails: Param<typeof createSlackSessionHandler>["agentDetails"];
  releaseRepositoryUnusable: Param<
    typeof createSlackSessionHandler
  >["releaseRepositoryUnusable"];
  welcomeAgents: Param<typeof createSlackWelcome>["agents"];
  welcomeApps: Param<typeof createSlackWelcome>["apps"];
  welcomeOutbox: Param<typeof createSlackWelcome>["outbox"];
  logger: StructuredLogger;
}

/** Left-handler wraps joined-handler wraps the session handler. */
export function wireSlackInbound(deps: SlackInboundDeps): SlackInboundHandler {
  const { secrets } = deps;
  const botToken = (workspaceId: string, slackAppId: string) =>
    slackBotToken(secrets, workspaceId, slackAppId);
  const slackApi = createSlackBotApi({ apiUrl: deps.apiUrl });
  const sessionHandler = createSlackSessionHandler({
    inbox: deps.inbox,
    leaseMs: deps.leaseMs,
    authorization: deps.authorization,
    agents: deps.identities,
    links: deps.links,
    bindings: deps.bindings,
    settings: deps.settings,
    sessionLinks: deps.sessionLinks,
    sessions: deps.sessions,
    agentDetails: deps.agentDetails,
    releaseRepositoryUnusable: deps.releaseRepositoryUnusable,
    slack: slackApi,
    botToken,
    notices: deps.notices,
    logger: deps.logger,
    connectUrl: slackConnectUrl(deps.consoleOrigin),
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
  return createSlackMemberLeftHandler({
    agents: deps.identities,
    bindings: deps.bindings,
    next: memberJoined,
  });
}

/** The notice sink for the pass child: a notice becomes an outbox row. */
export function wireSlackOutboxNotices(
  outbox: Param<typeof createOutboxSlackNoticeSink>,
): SlackNoticeSink {
  return createOutboxSlackNoticeSink(outbox);
}

export interface SlackOutboundDeps {
  apiUrl: string;
  secrets: Parameters<typeof slackBotToken>[0];
  consoleOrigin: string | null;
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
      botToken,
      consoleOrigin: deps.consoleOrigin,
    }),
  };
}

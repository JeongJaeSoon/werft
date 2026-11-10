// The only place product code reaches the Slack chat adapter (R3). Roles
// import the factories and their types from here and receive the built
// services as arguments.
export {
  createLoggingSlackNoticeSink,
  createOutboxSlackNoticeSink,
  createRowDelivery,
  createSlackChannelJoiner,
  createSlackEventsService,
  createSlackInteractionService,
  createSlackMemberJoinedHandler,
  createSlackMemberLeftHandler,
  createSlackSessionHandler,
  createSlackSigningSecrets,
  createSlackWelcome,
  drainSlackOutbox,
  type SlackEventsService,
  type SlackInteractionService,
  type SlackNoticeSink,
} from "@werft-ai/chat-slack";

import {
  type ConversationTopicId,
  type EngagementKind,
  formatSurfaceRef,
  messageTextSchema,
  SLACK_BOT_TURN_LIMIT,
  type SlackMessageRef,
  type SlackNotice,
  type SlackNoticeMessage,
  type SurfaceChannelKind,
  slackNoticeFor,
  slackUserKindOf,
  type ThreadReplyRule,
} from "@werft-ai/contracts";
import type {
  AgentIdentityStore,
  AgentStore,
  BotTurnStore,
  BoundReplyStore,
  BufferedInputReceipt,
  Conversation,
  ConversationStore,
  InboundInputReceipt,
  JudgmentBufferStore,
  LinkedAccountStore,
  MentionTurnRequest,
  MentionTurnStart,
  SessionLinkRecord,
  SessionLinkStore,
  SurfaceAppStore,
  SurfaceBindingStore,
  SurfaceInboundEventStore,
  TurnInputTopic,
} from "@werft-ai/platform";
import {
  type AuthorizationPolicy,
  agentForSlackEvent,
  type Caller,
  inboundHandling,
  isStopRequest,
  type LifecycleStop,
  type SessionService,
  SessionServiceError,
  type SessionStop,
  type TableHandling,
} from "@werft-ai/platform";
import { z } from "zod";
import type { SlackAudience } from "./slack-audience.ts";
import { SlackApiError, type SlackBotApi } from "./slack-config-api.ts";
import {
  authorizeSlackInput,
  type SlackInput,
  slackCallerOf,
} from "./slack-decision.ts";
import { unescapeSlackText } from "./slack-entities.ts";
import {
  SLACK_PERSON_RESET_SUBTYPES,
  SlackInboundDeferred,
  SlackInboundDropped,
  type SlackInboundHandler,
  type SlackInboxLogger,
} from "./slack-inbox.ts";
import type { SlackNoticeSink } from "./slack-notice-sink.ts";
import { judgeThreadReply } from "./slack-thread-shadow.ts";

const slackMessageSchema = z.object({
  type: z.enum(["app_mention", "message"]),
  channel: z.string().min(1),
  ts: z.string().min(1),
  thread_ts: z.string().min(1).optional(),
  user: z.string().min(1),
  text: z.string().default(""),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
  channel_type: z.string().optional(),
});

const CHANNEL_KIND_OF: Partial<Record<string, SurfaceChannelKind>> = {
  channel: "public_channel",
  group: "private_channel",
  mpim: "private_channel",
  im: "dm",
};

/** The refusal's machine-readable reason, when its details carry one. */
function reasonCodeOf(details: unknown): string | undefined {
  const reason = (details as { reason_code?: unknown } | null)?.reason_code;
  return typeof reason === "string" ? reason : undefined;
}

const CALLER_LIMITED_NOTICE = {
  repository: "callerLimitedRepository",
  credential: "callerLimitedCredential",
  mcp_server: "callerLimitedMcpServer",
  tool: "callerLimitedTool",
} as const;

function callerLimitDimensionOf(
  details: unknown,
): keyof typeof CALLER_LIMITED_NOTICE {
  const dimension = (details as { dimension?: unknown } | null)?.dimension;
  return typeof dimension === "string" && dimension in CALLER_LIMITED_NOTICE
    ? (dimension as keyof typeof CALLER_LIMITED_NOTICE)
    : "tool";
}

/** The line for a mention the agent's own stop leaves unheard (section 10). */
const UNHEARD_MENTION_NOTICE: Partial<
  Record<LifecycleStop, SlackNoticeMessage>
> = {
  agent_inactive: "agentInactive",
  agent_ownerless: "agentOwnerless",
};

const RETRYABLE_SESSION_CODES = new Set([
  "RATE_LIMITED",
  "BACKEND_UNAVAILABLE",
]);

class SlackLeaseLost extends Error {
  constructor() {
    super("Slack event lease lost before its effects");
  }
}

/**
 * A binding not in use is one the bot is out of, as far as the handling
 * table goes: left, gone, or never finished.
 */
function lifecycleStopOf(
  place: {
    agentActive: boolean;
    agentOwnerless: boolean;
    channelState: string;
  },
  live: { status: string },
): LifecycleStop | null {
  if (!place.agentActive) return "agent_inactive";
  if (place.agentOwnerless) return "agent_ownerless";
  if (place.channelState !== "active") return "channel_archived";
  if (live.status === "pending_approval") return "pending_approval";
  return live.status !== "ready" ? "bot_removed" : null;
}

/**
 * A task closed by a stop before its first turn: the first cancelled input
 * is the task's request, the rest waited behind it.
 */
function closedNotice(cancelled: number) {
  const waiting = cancelled - 1;
  return waiting > 0
    ? { message: "taskStoppedBeforeStartQueued" as const, count: waiting }
    : { message: "taskStoppedBeforeStart" as const };
}

/**
 * The text a turn gets: the bot's own mention taken out, with or without
 * the display name Slack may put after a `|`.
 */
export function withoutBotMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g"), "")
    .trim();
}

/** How long a reply of work going on waits for its judgment (PM Q2). */
export const SLACK_TASK_REPLY_WAIT_MS = 30_000;
/** How soon a reply waiting for its judgment is looked at again. */
export const SLACK_TASK_REPLY_RECHECK_MS = 2_000;
/**
 * How often a mention looks again at work in its thread that is closing,
 * or closed with its link still open (94S-2537, 94S-2506): it waits until
 * the link closes or the close fails, however long the drain takes.
 */
export const SLACK_CLOSED_WORK_MENTION_RECHECK_MS = 5_000;

export type SlackSessionHandlerDeps = {
  inbox: Pick<SurfaceInboundEventStore, "renew">;
  /** The lease each effect is held under, renewed just before it. */
  leaseMs: number;
  authorization: AuthorizationPolicy;
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  links: Pick<LinkedAccountStore, "resolveLinkedSubject">;
  bindings: Pick<
    SurfaceBindingStore,
    | "resolveSlackChannel"
    | "ensureDmBinding"
    | "findPendingApproval"
    | "findLiveSlackChannel"
    | "requireApproval"
  >;
  /** Whether the agent waits for a mention in every channel in use. */
  settings: Pick<SurfaceAppStore, "getSettings">;
  /** Bot-started turns in a row per thread, across the workspace's agents. */
  botTurns: BotTurnStore;
  sessionLinks: SessionLinkStore;
  /** Where a message made a turn of is taken as its topic's input. */
  conversations: ConversationStore;
  /** The agent's switch and the channel's state, for the judgment buffer. */
  buffer: JudgmentBufferStore;
  /** A bound thread's unmentioned replies once the rollout is on (v1-b/U1). */
  boundReplies: BoundReplyStore;
  /**
   * How long a reply of work going on waits for M1's judgment before the
   * work takes it anyway; SLACK_TASK_REPLY_WAIT_MS when unset.
   */
  taskReplyWaitMs?: number;
  /**
   * Where a mention goes once the agent's rollout is on and the handling
   * table answers `m2`: a conversation turn, queued (v1-b/D1).
   */
  mentionTurns: {
    /** `queuing` runs between the turn's write and its queueing. */
    start(
      request: MentionTurnRequest,
      queuing: () => Promise<void>,
    ): Promise<MentionTurnStart>;
  };
  sessions: Pick<SessionService, "createSession" | "appendMessage">;
  /** Stops a thread's work when its requester asks (handling table row 12). */
  stops: Pick<SessionStop, "stop" | "stoppedBefore">;
  /** The agent's active release, which a new thread's session runs. */
  agentDetails: Pick<AgentStore, "get">;
  /**
   * Slack names no repository, so a session starts as `releaseStartable`
   * says; true when it cannot (no usable repository, a repository outside the
   * workspace ceiling, or GitHub
   * settings that cannot be read).
   */
  releaseRepositoryUnusable(
    workspaceId: string,
    releaseId: string,
  ): Promise<boolean>;
  slack: SlackBotApi;
  /** Whether a channel's posts and a person's may be held at all. */
  audience: Pick<SlackAudience, "unheardReason">;
  /** The app's bot token from the secret store; null when it has none. */
  botToken(workspaceId: string, slackAppId: string): Promise<string | null>;
  notices: SlackNoticeSink;
  logger: SlackInboxLogger;
  /** The web page where a person links their Slack account. */
  connectUrl: string;
  /** The console's agent list, for a channel with no agent yet; "" for none. */
  agentsUrl: string;
  newRequestId?: () => string;
};

/**
 * The `slack` role's handler: a mention, a DM or a reply in a
 * linked thread becomes a turn of the thread's one session. A refusal
 * leaves a notice and no session.
 */
export function createSlackSessionHandler(
  deps: SlackSessionHandlerDeps,
): SlackInboundHandler {
  const newRequestId = deps.newRequestId ?? (() => crypto.randomUUID());

  return async (claim) => {
    const parsed = slackMessageSchema.safeParse(
      (claim.payload as { event?: unknown }).event,
    );
    // Not a channel message: the member-joined handler acts on a bot's own
    // channel join.
    if (!parsed.success) return;
    const event = parsed.data;
    const ids = { id: claim.id, event_id: claim.eventId };
    // A person's file or /me line only starts the bots' count over (below);
    // neither is a turn.
    const resetOnly =
      event.subtype !== undefined &&
      SLACK_PERSON_RESET_SUBTYPES.has(event.subtype);
    if (
      event.subtype !== undefined &&
      event.subtype !== "thread_broadcast" &&
      !resetOnly
    ) {
      return;
    }
    // Another app's bot: only a direct mention from a bot the agent allows
    // goes on, and it acts as the agent, with no person behind it.
    const fromBot = event.bot_id !== undefined;
    const agent = await agentForSlackEvent(deps.agents, {
      appId: claim.appId,
      teamId: claim.teamId,
      agentId: claim.agentId,
    });
    if (agent.status === "dropped") {
      deps.logger.info("Slack event names no agent of this app; ignored", {
        ...ids,
        reason: agent.reason,
      });
      return;
    }
    if (event.user === agent.botUserId) return;
    // The door drops these too; an agent whose app was made since then
    // is caught here.
    if (agent.werftBotUserIds.includes(event.user)) {
      deps.logger.info("Slack message from another Werft agent; ignored", {
        ...ids,
        reason: "werft_agent_bot",
      });
      return;
    }

    const dm = event.channel_type === "im";
    const threadTs = event.thread_ts ?? event.ts;
    const surfaceRef = formatSurfaceRef(event.channel, threadTs);
    const thread = {
      workspaceId: agent.workspaceId,
      teamId: claim.teamId,
      channelId: event.channel,
      threadTs,
    };
    /**
     * What becomes of an unmentioned post by the handling table (a0/D2):
     * `current_path` when the switch is off, or in `shadow` when the
     * current path takes the post itself; the post to hold in the buffer;
     * or null when the table drops it. Shadow holds what the current path
     * leaves, for a judgment that only records.
     */
    const bufferedInput = async (): Promise<
      BufferedInputReceipt | null | "current_path"
    > => {
      const place = await deps.buffer.place({
        kind: "channel",
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        teamId: claim.teamId,
        channelId: event.channel,
      });
      if (place.rollout === "off") return "current_path";
      const live = await deps.bindings.findLiveSlackChannel(
        agent.installationId,
        event.channel,
      );
      // No binding: the agent is not in the channel, so nothing is heard.
      if (live === null) {
        return place.rollout === "on" ? null : "current_path";
      }
      const lifecycleStop = lifecycleStopOf(place, live);
      // An unbound thread the agent took part in lately: its replies are
      // judged for the record (`m1_engaged`), never made a turn (a1/J5).
      const engaged =
        event.thread_ts !== undefined &&
        (await deps.buffer.engagedThread({
          kind: "channel",
          workspaceId: agent.workspaceId,
          agentId: agent.agentId,
          teamId: claim.teamId,
          channelId: event.channel,
          threadTs,
        }));
      const handling = inboundHandling({
        place: "channel",
        work: "none",
        engaged,
        input: event.thread_ts === undefined ? "top_level" : "reply",
        rollout: place.rollout,
        mode: live.mode,
        listen: live.listen,
        lifecycleStop,
      });
      const judged =
        handling.kind === "table" ? handling.handling : handling.shadow;
      const holds = judged === "buffer_m1" || (engaged && judged === "m1");
      if (handling.kind === "current_path") {
        if (!holds) return "current_path";
        const currentPathTakes =
          judged === "buffer_m1" &&
          live.mode === "on" &&
          event.thread_ts === undefined &&
          (await deps.settings.getSettings(agent.workspaceId, agent.agentId))
            ?.mention_only === false;
        if (currentPathTakes) return "current_path";
      }
      if (!holds) {
        deps.logger.info("Slack message not held for the judgment", {
          ...ids,
          handling: judged,
        });
        return null;
      }
      if (
        live.approvedAt !== null &&
        Number(event.ts) * 1000 < live.approvedAt.getTime()
      ) {
        return null;
      }
      const bufferedBody = unescapeSlackText(event.text);
      if (!messageTextSchema.safeParse(bufferedBody).success) return null;
      const unheard = await deps.audience.unheardReason({
        agentId: agent.agentId,
        teamId: claim.teamId,
        channelId: event.channel,
        slackUserId: event.user,
        botToken: await deps.botToken(claim.workspaceId, claim.slackAppId),
      });
      if (unheard !== null) {
        deps.logger.info("Slack message not held for the judgment", {
          ...ids,
          handling: judged,
          reason: unheard,
        });
        return null;
      }
      const conversation = await conversationOf(
        { dm: false, personUserId: null, channelId: event.channel },
        claim.teamId,
        agent,
      );
      if (conversation === null) {
        throw new Error("A Slack channel has no conversation");
      }
      const topic = await deps.conversations.findOrCreateThreadTopic(
        conversation.id,
        { teamId: claim.teamId, channelId: event.channel, threadTs },
      );
      deps.logger.info("Slack message held for the judgment", {
        ...ids,
        rollout: place.rollout,
      });
      return {
        topicId: topic.id,
        channelId: event.channel,
        ts: event.ts,
        buffered: {
          body: bufferedBody,
          slackUserId: event.user,
        },
        ...(judged === "m1" ? { judgment: "m1_engaged" as const } : {}),
      };
    };

    // The held text a work's turn takes in place of the event's, an edit
    // having changed it while M1 judged it.
    let editedText: string | undefined;

    /**
     * What becomes of a person's unmentioned reply in a thread bound to work
     * once the agent's rollout is on (v1-b/U1): `current_path` before then,
     * or where the handling table leaves it to the work; for work done, the
     * post held for an `m1` judgment whose speak alone answers it (B); for
     * work going on, `session` once M1 spoke or could not judge it in time
     * (PM Q2); null: nothing more. A reply still waiting for its judgment
     * defers the event.
     */
    const boundReplyRoute = async (
      sessionId: string,
    ): Promise<BufferedInputReceipt | null | "current_path" | "session"> => {
      const place = await deps.buffer.place({
        kind: "channel",
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        teamId: claim.teamId,
        channelId: event.channel,
      });
      if (place.rollout !== "on") return "current_path";
      // A reply held for its work's judgment keeps that grade, the work
      // closed since or not, and its hold answers it: the checks below were
      // made when it was held, and Slack unable to say its audience now does
      // not undo its quiet.
      const held = await deps.boundReplies.heldForWork({
        agentId: agent.agentId,
        teamId: claim.teamId,
        channelId: event.channel,
        ts: event.ts,
      });
      const work =
        held || (await deps.boundReplies.work(sessionId)) === "open"
          ? "open"
          : "closed";
      const waitMs = deps.taskReplyWaitMs ?? SLACK_TASK_REPLY_WAIT_MS;
      // A wait of none: work going on takes its replies as before.
      if (work === "open" && waitMs === 0 && !held) return "current_path";
      // Work done takes no unmentioned reply: one M1 does not answer is left.
      const unjudged = work === "closed" ? null : "current_path";
      if (!held) {
        const live = await deps.bindings.findLiveSlackChannel(
          agent.installationId,
          event.channel,
        );
        if (live === null) return unjudged;
        // Before M1 reads it: an event that does not say its channel's kind,
        // in a channel bound as public, asks Slack as the current path does,
        // which sends a channel turned private to approval first.
        if (
          event.channel_type === undefined &&
          live.channelKind === "public_channel"
        ) {
          const token = await deps.botToken(
            claim.workspaceId,
            claim.slackAppId,
          );
          if (
            token === null ||
            (await deps.slack.channelKind(token, event.channel)) ===
              "private_channel"
          ) {
            return "current_path";
          }
        }
        const handling = inboundHandling({
          place: "channel",
          work,
          engaged: true,
          input: isStopRequest(withoutBotMention(event.text, agent.botUserId))
            ? "stop_request"
            : "reply",
          rollout: place.rollout,
          mode: live.mode,
          listen: live.listen,
          lifecycleStop: lifecycleStopOf(place, live),
        });
        const judged = handling.kind === "table" ? handling.handling : null;
        if (judged !== (work === "closed" ? "m1" : "m1_to_task")) {
          deps.logger.info("Slack bound reply not judged", {
            ...ids,
            handling: judged,
            work,
          });
          return unjudged;
        }
        if (
          (live.approvedAt !== null &&
            Number(event.ts) * 1000 < live.approvedAt.getTime()) ||
          !messageTextSchema.safeParse(unescapeSlackText(event.text)).success
        ) {
          return unjudged;
        }
        const unheard = await deps.audience.unheardReason({
          agentId: agent.agentId,
          teamId: claim.teamId,
          channelId: event.channel,
          slackUserId: event.user,
          botToken: await deps.botToken(claim.workspaceId, claim.slackAppId),
        });
        if (unheard !== null) {
          deps.logger.info("Slack bound reply not judged", {
            ...ids,
            reason: unheard,
            work,
          });
          return unjudged;
        }
      }
      const conversation = await conversationOf(
        { dm: false, personUserId: null, channelId: event.channel },
        claim.teamId,
        agent,
      );
      if (conversation === null) {
        throw new Error("A Slack channel has no conversation");
      }
      const topic = await deps.conversations.findOrCreateThreadTopic(
        conversation.id,
        { teamId: claim.teamId, channelId: event.channel, threadTs },
      );
      const rule = judgeThreadReply(event.text, agent.botUserId);
      // Held as the buffer holds a post: Slack's entities decoded.
      const buffered = {
        body: unescapeSlackText(event.text),
        slackUserId: event.user,
      };
      if (work === "closed") {
        deps.logger.info("Slack reply of work done held for the judgment", ids);
        return {
          topicId: topic.id,
          channelId: event.channel,
          ts: event.ts,
          buffered,
          judgment: { grade: "m1", rule },
        };
      }
      const route = await deps.boundReplies.taskReply({
        kind: "channel",
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        teamId: claim.teamId,
        channelId: event.channel,
        fence: { id: claim.id, claimToken: claim.claimToken },
        topicId: topic.id,
        ts: event.ts,
        ...buffered,
        rule,
        waitMs,
      });
      if (route === "waiting") {
        throw new SlackInboundDeferred(SLACK_TASK_REPLY_RECHECK_MS);
      }
      deps.logger.info("Slack reply of work going on judged", {
        ...ids,
        route: typeof route === "object" ? "edited" : route,
      });
      if (typeof route === "object") editedText = route.edited;
      if (route === "quiet") return null;
      // Closed since it was held (94S-2506): as a closed work's reply, it
      // goes to no session. M1's speak answered it with an unasked turn as
      // it was written, and a reply M1 could not judge is left.
      if ((await deps.boundReplies.work(sessionId)) === "closed") {
        deps.logger.info("Slack reply of work closed while it waited", ids);
        return null;
      }
      return "session";
    };

    /**
     * A mention in a thread bound to work that is closed (decision 35) with
     * its link still open, once the rollout is on (94S-2537, 94S-2506): it
     * waits out the work's drain (closing) and its link's close, to be the
     * conversation turn a closed thread's mention is, or the work's turn
     * again should the close fail. Whoever mentioned is told once a
     * closing. Returns when the work is open, or the rollout is not on.
     */
    /**
     * `refused`: the session just refused this mention as closing or
     * closed; work read open again since (a close that failed back) is
     * waited out too, so the next look appends to it, not a failed line.
     */
    const waitOutClosedWork = async (
      link: SessionLinkRecord,
      sessionId: string,
      refused = false,
    ): Promise<void> => {
      const place = await deps.buffer.place({
        kind: "channel",
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        teamId: claim.teamId,
        channelId: event.channel,
      });
      if (place.rollout !== "on") return;
      const closed = await deps.boundReplies.closedWork(sessionId);
      if (closed === null) {
        if (!refused) return;
        deps.logger.info(
          "Slack mention refused by work open again; looked at again",
          {
            ...ids,
            session_id: sessionId,
          },
        );
        throw new SlackInboundDeferred(SLACK_CLOSED_WORK_MENTION_RECHECK_MS);
      }
      if (closed.admission === "closing" && !fromBot) {
        await deps.notices.recordInThread({
          workspaceId: agent.workspaceId,
          agentId: agent.agentId,
          installationId: agent.installationId,
          slackAppId: claim.slackAppId,
          teamId: claim.teamId,
          channelId: event.channel,
          threadTs,
          sessionId,
          sessionLinkId: link.id,
          notice: { message: "taskClosingWait" },
          // A close found by its receipt; one asked by another principal
          // is keyed by the session, so a later closing of it says nothing.
          onceKey: `${agent.installationId}:${surfaceRef}:closing_wait:${
            closed.closeReceiptId ?? sessionId
          }`,
          readerSlackUserId: event.user,
        });
      }
      deps.logger.info("Slack mention waits for its thread's work to close", {
        ...ids,
        session_id: sessionId,
        admission: closed.admission,
      });
      throw new SlackInboundDeferred(SLACK_CLOSED_WORK_MENTION_RECHECK_MS);
    };

    /**
     * What the handling table makes of a mention or a DM with no work bound
     * to its thread (rows 1, 7 and 14), or `current_path` while the agent's
     * rollout is not on: `off` and `shadow` take it as before. `notice`:
     * the line a channel mention the agent does not hear gets.
     */
    const mentionTableHandling = async (): Promise<{
      handling: TableHandling | "current_path" | "no_binding";
      notice?: SlackNoticeMessage;
    }> => {
      // A DM has no channel conversation, so its channel state reads active.
      const place = await deps.buffer.place({
        kind: "channel",
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        teamId: claim.teamId,
        channelId: event.channel,
      });
      if (place.rollout !== "on") return { handling: "current_path" };
      const live = dm
        ? await deps.bindings.ensureDmBinding(agent.installationId)
        : await deps.bindings.findLiveSlackChannel(
            agent.installationId,
            event.channel,
          );
      if (live === null) {
        return {
          handling: "no_binding",
          ...(dm ? {} : { notice: "channelUnbound" as const }),
        };
      }
      const lifecycleStop = lifecycleStopOf(place, live);
      const handling = inboundHandling({
        place: dm ? "dm" : "channel",
        work: "none",
        engaged: false,
        input: "mention",
        rollout: place.rollout,
        mode: live.mode,
        listen: live.listen,
        lifecycleStop,
      });
      if (handling.kind !== "table") return { handling: "current_path" };
      // Only where the bot may still speak: an agent stop over a channel
      // archived, left or waiting for approval says nothing there.
      const notice = dm
        ? undefined
        : handling.handling === "drop_with_off_notice"
          ? "channelOff"
          : handling.handling === "lifecycle_stopped" &&
              lifecycleStop === "pending_approval"
            ? "pendingApproval"
            : handling.handling === "lifecycle_stopped" &&
                lifecycleStop !== null &&
                lifecycleStopOf(
                  { ...place, agentActive: true, agentOwnerless: false },
                  live,
                ) === null
              ? UNHEARD_MENTION_NOTICE[lifecycleStop]
              : undefined;
      return {
        handling: handling.handling,
        ...(notice === undefined ? {} : { notice }),
      };
    };

    /**
     * The mention or DM as a turn of its thread's topic, the person who
     * wrote it its requester as the decision recorded them; a DM's topic is
     * in that person's DM conversation, one topic per top-level DM. The
     * thread shows "processing" until the Slack role's pass ends the turn.
     */
    const mentionTurn = async (
      botToken: string,
      requesterUserId: string | null,
      text: string,
      slackSubject: MentionTurnRequest["slackSubject"],
    ): Promise<void> => {
      if (requesterUserId === null) {
        deps.logger.info("Slack mention not made a turn", {
          ...ids,
          reason: "no_linked_person",
        });
        return;
      }
      const held = await deps.inbox.renew(claim, deps.leaseMs);
      if (held === null) throw new SlackLeaseLost();
      if (held.installationStatus === "revoked") {
        throw new SlackInboundDropped("installation_revoked");
      }
      await stopIfLeft();
      const place = {
        dm,
        personUserId: dm ? requesterUserId : null,
        channelId: event.channel,
      };
      const conversation = await conversationOf(place, claim.teamId, agent);
      if (conversation === null) {
        throw new Error("A Slack channel has no conversation");
      }
      // Before a runtime can take the turn, so an ending never comes first.
      const processing = async () => {
        try {
          await deps.slack.setStatus(botToken, {
            channelId: event.channel,
            threadTs,
            status: "processing",
          });
        } catch (error) {
          // The turn goes on without it; its end sets the thread back anyway.
          deps.logger.warn("Slack status not set for a mention turn", {
            ...ids,
            code: error instanceof SlackApiError ? error.code : "error",
          });
        }
      };
      const started = await deps.mentionTurns.start(
        {
          workspaceId: agent.workspaceId,
          agentId: agent.agentId,
          conversationId: conversation.id,
          topicId: await topicOf(
            place,
            claim.teamId,
            threadTs,
            agent,
            conversation,
          ),
          slackInstallationId: agent.installationId,
          message: {
            teamId: claim.teamId,
            channelId: event.channel,
            ts: event.ts,
          },
          requesterUserId,
          text,
          slackSubject,
        },
        processing,
      );
      if (started.outcome !== "queued") {
        deps.logger.info("Slack mention not made a turn", {
          ...ids,
          reason: started.outcome,
        });
        return;
      }
      deps.logger.info("Slack mention made a conversation turn", {
        ...ids,
        turn_id: started.turnId,
      });
    };

    /**
     * What the handling table makes of a stop word in a thread bound to open
     * work (row 12): `stop_session` once the agent's rollout is on, whatever
     * the channel listens to.
     */
    const stopHandling = async (): Promise<TableHandling | null> => {
      const place = await deps.buffer.place({
        kind: "channel",
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        teamId: claim.teamId,
        channelId: event.channel,
      });
      const live = dm
        ? await deps.bindings.ensureDmBinding(agent.installationId)
        : await deps.bindings.findLiveSlackChannel(
            agent.installationId,
            event.channel,
          );
      if (live === null) return null;
      const handling = inboundHandling({
        place: dm ? "dm" : "channel",
        work: "open",
        engaged: true,
        input: "stop_request",
        rollout: place.rollout,
        mode: live.mode,
        listen: live.listen,
        // Running work goes on while its agent is ownerless, so its
        // requester may still stop it.
        lifecycleStop: lifecycleStopOf(
          { ...place, agentOwnerless: false },
          live,
        ),
      });
      return handling.kind === "table" ? handling.handling : null;
    };

    // A stop's key is its post: the post's two events and every retry of
    // them are one stop.
    const stopKey = `slack-stop:${claim.teamId}:${event.channel}:${event.ts}`;

    // Set once the poster was told they may not stop the work: if the session
    // then refuses the word as input too, that is not said a second time.
    let stopRefused = false;

    /**
     * Stops the thread's work for the person who wrote the stop word and
     * says so in the thread. False when the message is input after all: the
     * person may not stop the work (they are told so, alone), or it closed.
     */
    const stopRequest = async (
      caller: Caller,
      link: SessionLinkRecord,
      sessionId: string,
    ): Promise<boolean> => {
      const held = await deps.inbox.renew(claim, deps.leaseMs);
      if (held === null) throw new SlackLeaseLost();
      if (held.installationStatus === "revoked") {
        throw new SlackInboundDropped("installation_revoked");
      }
      await stopIfLeft();
      // Input queued until now is cancelled: the thread's earlier posts are
      // in, and its later ones wait for this event's lease.
      const stopped = await deps.stops.stop(caller, sessionId, {
        idempotencyKey: stopKey,
      });
      deps.logger.info("Slack stop request", {
        ...ids,
        session_id: sessionId,
        outcome: stopped.outcome,
        ...(stopped.outcome === "stopped"
          ? { interrupted: stopped.interrupted, cancelled: stopped.cancelled }
          : {}),
      });
      if (stopped.outcome === "closed") return false;
      if (stopped.outcome === "not_permitted") {
        await deps.notices.record({
          workspaceId: agent.workspaceId,
          agentId: agent.agentId,
          installationId: agent.installationId,
          slackAppId: claim.slackAppId,
          teamId: claim.teamId,
          channelId: event.channel,
          threadTs,
          slackUserId: event.user,
          reason: "stop_not_permitted",
          notice: { message: "stopNotPermitted" },
          onceKey: `${agent.installationId}:${surfaceRef}:${event.user}:stop:${event.ts}`,
        });
        stopRefused = true;
        return false;
      }
      if (stopped.outcome === "nothing_running") {
        // Nothing to stop (94S-2472): the word is no input, and only whoever
        // wrote it is told, once per post.
        await deps.notices.record({
          workspaceId: agent.workspaceId,
          agentId: agent.agentId,
          installationId: agent.installationId,
          slackAppId: claim.slackAppId,
          teamId: claim.teamId,
          channelId: event.channel,
          threadTs,
          slackUserId: event.user,
          reason: "nothing_to_stop",
          notice: { message: "nothingToStop" },
          onceKey: `${agent.installationId}:${surfaceRef}:${event.user}:stop:${event.ts}`,
        });
        return true;
      }
      const line = {
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        installationId: agent.installationId,
        slackAppId: claim.slackAppId,
        teamId: claim.teamId,
        channelId: event.channel,
        threadTs,
        sessionId,
        sessionLinkId: link.id,
        onceKey: `${agent.installationId}:${surfaceRef}:stop:${event.ts}`,
        // Whoever may stop it is its requester or one who may control it:
        // the line answers them, as a task's thread line does its requester.
        readerSlackUserId: event.user,
      };
      if (stopped.outcome === "stopped" && stopped.closed) {
        try {
          await deps.notices.recordInThread({
            ...line,
            notice: closedNotice(stopped.cancelled),
          });
        } catch (error) {
          // Not retried: the closed session's link may close before a
          // retry, which then ends as a stop already made and would not
          // write the line either.
          deps.logger.warn("Slack stop line lost for a task it closed", {
            ...ids,
            session_id: sessionId,
            code: error instanceof Error ? error.name : "error",
          });
        }
        return true;
      }
      await deps.notices.recordInThread({
        ...line,
        notice:
          stopped.cancelled > 0
            ? { message: "sessionStoppedQueued", count: stopped.cancelled }
            : { message: "sessionStopped" },
      });
      return true;
    };

    // A person wrote in the thread, whatever becomes of it: the bots there
    // may go on again.
    if (!fromBot && event.thread_ts !== undefined) {
      await deps.botTurns.reset(thread, event.ts);
    }
    if (resetOnly) return;
    const mentioned =
      event.type === "app_mention" ||
      new RegExp(`<@${agent.botUserId}(?:\\||>)`).test(event.text);
    // A DM calls the agent as a mention does; the text alone decides, so a
    // retry or the post's other event judges the same.
    const openedAs: EngagementKind = dm || mentioned ? "mention" : "reply";
    /**
     * A person's unmentioned reply in a bound thread, in `shadow` and when
     * the poster may be heard: its rule's call, for M1 to judge beside it
     * (a1/J5). The turn goes on whatever either says. Once the rollout is
     * on, the judgment comes before any turn (v1-b/U1), so none comes here.
     */
    const replyJudgment = async (): Promise<
      { judgment: { rule: ThreadReplyRule } } | Record<string, never>
    > => {
      if (dm || mentioned || fromBot) return {};
      if (event.thread_ts === undefined || event.thread_ts === event.ts) {
        return {};
      }
      const place = await deps.buffer.place({
        kind: "channel",
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        teamId: claim.teamId,
        channelId: event.channel,
      });
      if (place.rollout !== "shadow") return {};
      const unheard = await deps.audience.unheardReason({
        agentId: agent.agentId,
        teamId: claim.teamId,
        channelId: event.channel,
        slackUserId: event.user,
        botToken: await deps.botToken(claim.workspaceId, claim.slackAppId),
      });
      if (unheard !== null) return {};
      return {
        judgment: { rule: judgeThreadReply(event.text, agent.botUserId) },
      };
    };
    const found = await deps.sessionLinks.find(
      agent.installationId,
      surfaceRef,
    );
    if (found !== null && found.revokedAt !== null) return;
    // A retry of a message whose turn was taken before the pass died: the
    // turn stands, so its input is taken whatever this pass would judge now.
    const sessionId =
      found === null
        ? null
        : (found.sessionId ?? (await deps.sessionLinks.openedSession(found)));
    const taken =
      sessionId === null
        ? null
        : await deps.sessionLinks.slackTurn(sessionId, {
            teamId: claim.teamId,
            channelId: event.channel,
            ts: event.ts,
          });
    if (found !== null && sessionId !== null && taken !== null) {
      // The session was made but the pass died before the link learned it.
      if (found.sessionId === null) {
        const attached = await deps.sessionLinks.attachSession(
          found.id,
          sessionId,
        );
        if (attached.sessionId !== sessionId) {
          throw new Error(`Slack thread ${found.id} holds another session`);
        }
      }
      return inputOf(
        { sessionId, sequence: taken.sequence },
        { dm, personUserId: taken.requesterId, channelId: event.channel },
        claim.teamId,
        threadTs,
        event.ts,
        agent,
        found.openedByTs === event.ts ? openedAs : "bound",
        found.openedByTs === event.ts ? {} : await replyJudgment(),
      );
    }
    // Before the early returns below, which let most unmentioned talk go:
    // the event itself says the channel is private, so a binding made for a
    // public one waits for approval now, whoever spoke and whatever was said.
    if (!dm && event.channel_type === "group") {
      const bound = await deps.bindings.resolveSlackChannel(
        agent.installationId,
        event.channel,
      );
      if (bound !== null && bound.channelKind === "public_channel") {
        await deps.bindings.requireApproval(bound.id);
      }
    }
    // A stop word alone whose stop was made in work this thread has closed
    // since: the post read again, by its other event or by a retry of the
    // pass that lost its lease after the stop. It is done, whatever the
    // thread holds now: taken on, it would be held for judgment, a mention
    // of the thread, or a stop of the work opened there since. Only once the
    // channel's kind is judged, so the post still sends a binding to
    // approval. A new stop word is another post, under another key.
    let madeBefore: Promise<boolean> | undefined;
    const stopMadeBefore = () => {
      madeBefore ??=
        !fromBot &&
        isStopRequest(withoutBotMention(event.text, agent.botUserId))
          ? deps.sessionLinks
              .closedSessions(agent.installationId, surfaceRef)
              .then((sessionIds) =>
                deps.stops.stoppedBefore(sessionIds, {
                  idempotencyKey: stopKey,
                }),
              )
          : Promise.resolve(false);
      return madeBefore;
    };
    // An event that says its channel's kind, judged just above, ends here;
    // so does an unmentioned one headed for the judgment buffer, which never
    // asks Slack. Any other waits until Slack has said the kind.
    if (
      (event.channel_type !== undefined ||
        (event.type === "message" && found === null && !mentioned)) &&
      (await stopMadeBefore())
    ) {
      deps.logger.info("Slack stop request already made; its work closed", ids);
      return;
    }
    if (
      fromBot &&
      (dm || !mentioned || !agent.allowedBotUserIds.includes(event.user))
    ) {
      return;
    }
    // A person's unmentioned reply in a thread bound to work: once the
    // rollout is on, M1 judges it before any session hears it.
    if (
      found !== null &&
      sessionId !== null &&
      found.openedByTs !== event.ts &&
      !mentioned &&
      !dm &&
      !fromBot &&
      event.thread_ts !== undefined &&
      event.thread_ts !== event.ts
    ) {
      const routed = await boundReplyRoute(sessionId);
      if (routed !== "current_path" && routed !== "session") {
        return routed ?? undefined;
      }
    }
    // A person's unmentioned post outside a bound thread: the handling
    // table says whether the judgment buffer holds it.
    if (found === null && !mentioned && !dm && !fromBot) {
      const held = await bufferedInput();
      if (held !== "current_path") return held ?? undefined;
    }
    // A stray reply is nobody's request in any mode; skip the lookup.
    if (found === null && !mentioned && !dm && event.thread_ts !== undefined)
      return;
    // A person's mention or DM outside a bound thread, once the agent's
    // rollout is on: the handling table says whether it becomes a
    // conversation turn. A DM thread bound to work goes to it as before (M0).
    const mentionTable =
      found === null && (mentioned || dm) && !fromBot
        ? await mentionTableHandling()
        : { handling: "current_path" as const };
    const mentionHandling = mentionTable.handling;
    if (mentionHandling !== "current_path" && mentionHandling !== "m2") {
      deps.logger.info("Slack mention not made a turn", {
        ...ids,
        handling: mentionHandling,
      });
      // Its line waits for the channel checks below.
      if (mentionTable.notice === undefined) return;
    }
    // Observe only: the reply goes on as a turn whatever the judgment says.
    // The text is not logged; `event_id` joins the case to its inbox row. A
    // retried event logs again.
    const isReply =
      event.thread_ts !== undefined && event.thread_ts !== event.ts;
    if (found !== null && isReply && !mentioned && !dm) {
      deps.logger.info("Slack thread reply judged without a mention", {
        ...ids,
        channel: event.channel,
        thread_ts: threadTs,
        ...judgeThreadReply(event.text, agent.botUserId),
        shadow: true,
      });
    }
    const binding = dm
      ? await deps.bindings.ensureDmBinding(agent.installationId)
      : await deps.bindings.resolveSlackChannel(
          agent.installationId,
          event.channel,
        );
    // Unless the agent waits for a mention, a channel in use takes a
    // person's top-level message unmentioned, never a reply in a thread the
    // agent is not part of.
    if (
      found === null &&
      !mentioned &&
      !dm &&
      !(
        binding?.mode === "on" &&
        event.thread_ts === undefined &&
        (await deps.settings.getSettings(agent.workspaceId, agent.agentId))
          ?.mention_only === false
      )
    )
      return;
    const botToken = await deps.botToken(claim.workspaceId, claim.slackAppId);
    if (botToken === null) {
      throw new Error("The Slack app has no bot token stored");
    }
    const user = await deps.slack.userInfo(botToken, event.user);
    // Slack still lists a deleted or deactivated bot: its mention is not
    // answered, as the console shows it gone.
    if (fromBot && (user.is_bot !== true || user.deleted === true)) {
      deps.logger.info("Slack bot is gone or no bot; mention ignored", ids);
      return;
    }
    const notice = async (
      reason: string,
      text: SlackNotice,
      wait?: { id: string; revision: number },
    ) => {
      // Someone talking unmentioned did not ask the agent, so a
      // refusal is not theirs to read on every message. A bot reads no
      // ephemeral message.
      if ((found === null && !mentioned && !dm) || fromBot) return;
      await deps.notices.record({
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        installationId: agent.installationId,
        slackAppId: claim.slackAppId,
        teamId: claim.teamId,
        channelId: event.channel,
        threadTs,
        slackUserId: event.user,
        reason,
        notice: text,
        onceKey: `${agent.installationId}:${surfaceRef}:${event.user}${
          wait === undefined ? "" : `:${wait.id}:${wait.revision}`
        }`,
      });
    };

    // A person's mention outside a bound thread once the rollout is on: its
    // channel lines go to them alone, once a UTC day per person and line.
    const rolloutOnMention =
      found === null &&
      mentioned &&
      !dm &&
      !fromBot &&
      mentionHandling !== "current_path";
    const tellOnceADay = async (
      message: "channelUnbound" | "pendingApproval",
      reason: string,
      linkUrl?: string,
    ) => {
      const day = new Date(Number(event.ts) * 1000).toISOString().slice(0, 10);
      await deps.notices.record({
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        installationId: agent.installationId,
        slackAppId: claim.slackAppId,
        teamId: claim.teamId,
        channelId: event.channel,
        threadTs,
        slackUserId: event.user,
        reason,
        notice: {
          message,
          ...(linkUrl === undefined ? {} : { link_url: linkUrl }),
        },
        onceKey: `${agent.installationId}:${event.channel}:${event.user}:${message}:${day}`,
      });
    };

    // The bot left a channel this event was queued for: the receipt says so
    // instead of "processed"; nothing is taken or said.
    const stopIfLeft = async (): Promise<void> => {
      if (dm) return;
      const live = await deps.bindings.findLiveSlackChannel(
        agent.installationId,
        event.channel,
      );
      if (live?.status === "left")
        throw new SlackInboundDropped("channel_left");
      if (live?.status === "gone")
        throw new SlackInboundDropped("channel_gone");
    };

    // A channel whose kind Slack now reports otherwise than the binding was
    // set for is not the place the binding allowed (DECIDED 11).
    // `app_mention` carries no `channel_type`: Slack is asked instead.
    const eventKind =
      event.channel_type !== undefined
        ? CHANNEL_KIND_OF[event.channel_type]
        : binding !== null && binding.channelKind !== "dm"
          ? await deps.slack.channelKind(botToken, event.channel)
          : undefined;
    if (
      binding !== null &&
      binding.channelKind === "public_channel" &&
      eventKind === "private_channel"
    ) {
      const waiting = await deps.bindings.requireApproval(binding.id);
      if (waiting !== null) {
        deps.logger.warn("Slack channel turned private; waits for approval", {
          ...ids,
        });
        // Once the rollout is on, the same daily line a mention in a
        // channel waiting for approval gets, so it is not said twice.
        if (rolloutOnMention) {
          // Not over an agent stop the table saw, as a waiting channel's
          // mention says nothing then.
          if (
            (mentionHandling === "m2" ||
              mentionTable.notice === "channelOff") &&
            waiting.mode === "on" &&
            slackUserKindOf(user, claim.teamId) !== "external"
          ) {
            await tellOnceADay("pendingApproval", "pending_approval");
          }
          return;
        }
        await notice(
          "pending_approval",
          { message: "pendingApproval" },
          { id: waiting.id, revision: waiting.revision },
        );
        return;
      }
    }
    if (
      binding !== null &&
      eventKind !== undefined &&
      binding.channelKind !== eventKind
    ) {
      deps.logger.warn("Slack channel kind differs from its binding; refused", {
        ...ids,
        binding_kind: binding.channelKind,
        event_kind: eventKind,
      });
      const refused = slackNoticeFor(
        { outcome: "deny", reason_code: "surface_ceiling" },
        "session.submit",
        { connectUrl: deps.connectUrl },
      );
      if (refused !== null) await notice("channel_kind_mismatch", refused);
      return;
    }
    // A post that named no channel kind (an app_mention, a mentioned message,
    // a reply in a thread with an open link): done once Slack has said it.
    if (await stopMadeBefore()) {
      deps.logger.info("Slack stop request already made; its work closed", ids);
      return;
    }
    // A person's mention in a channel with no binding in use: the bot was
    // let in, but no agent was set up for the channel there. Once the
    // rollout is on, a channel waiting for approval as well; before it, the
    // decision below tells that one. Only the person who wrote sees the
    // line, once a UTC day in the channel; it names no channel or agent.
    const unboundLine =
      mentionTable.notice === "channelUnbound" ||
      mentionTable.notice === "pendingApproval";
    if (found === null && mentioned && !dm && !fromBot && binding === null) {
      // Read again: the table's read may be older than a binding made since.
      const live = await deps.bindings.findLiveSlackChannel(
        agent.installationId,
        event.channel,
      );
      const line =
        live === null
          ? ("channelUnbound" as const)
          : // Waiting for approval where the table heard the agent: it said
            // so, or the binding went from ready to waiting since.
            live.status === "pending_approval" &&
              live.mode === "on" &&
              rolloutOnMention &&
              (mentionTable.notice === "pendingApproval" ||
                mentionHandling === "m2")
            ? ("pendingApproval" as const)
            : undefined;
      if (line === undefined) {
        // A waiting binding the rollout's table did not hear says nothing.
        if (
          unboundLine ||
          (rolloutOnMention && live?.status === "pending_approval")
        ) {
          return;
        }
      } else {
        if (slackUserKindOf(user, claim.teamId) === "external") return;
        // The agent list only for someone who can sign in to the console.
        const linked =
          line === "channelUnbound" && deps.agentsUrl !== ""
            ? await deps.links.resolveLinkedSubject({
                provider: "slack",
                externalTenant: claim.teamId,
                externalUserId: event.user,
              })
            : null;
        const opens =
          linked?.status === "linked" &&
          linked.workspaceId === agent.workspaceId;
        await tellOnceADay(
          line,
          line === "channelUnbound" ? "channel_unbound" : "pending_approval",
          opens ? deps.agentsUrl : undefined,
        );
        return;
      }
    }
    // A mention the table does not hear, where the checks above still let
    // the bot speak: one line in the thread for all to see, once a UTC day
    // per person in the channel, whichever thread they mention the agent in.
    if (mentionTable.notice !== undefined) {
      // Only on a binding still in use whose kind Slack confirmed above, and
      // never for someone from another organization, as the decision judges.
      if (
        unboundLine ||
        binding === null ||
        binding.mode !== "on" ||
        eventKind === undefined ||
        slackUserKindOf(user, claim.teamId) === "external" ||
        // Written before the channel's approval, as the input path below.
        (binding.approvedAt != null &&
          Number(event.ts) * 1000 < binding.approvedAt.getTime())
      ) {
        return;
      }
      const day = new Date(Number(event.ts) * 1000).toISOString().slice(0, 10);
      await deps.notices.recordInThread({
        workspaceId: agent.workspaceId,
        agentId: agent.agentId,
        installationId: agent.installationId,
        slackAppId: claim.slackAppId,
        teamId: claim.teamId,
        channelId: event.channel,
        threadTs,
        sessionId: null,
        sessionLinkId: null,
        notice: { message: mentionTable.notice },
        onceKey: `${agent.installationId}:${event.channel}:${event.user}:${mentionTable.notice}:${day}`,
      });
      return;
    }

    let release: { id: string } | null = null;
    let resource: SlackInput["resource"];
    if (found === null) {
      const detail = await deps.agentDetails.get(
        agent.workspaceId,
        agent.agentId,
      );
      // Without a release the decision still judges who may start the
      // agent; only someone it lets in is told the agent has none.
      release = detail?.active_release ?? null;
      resource =
        release === null
          ? { kind: "surface_binding" }
          : { kind: "surface_binding", releaseId: release.id };
    } else {
      resource = { kind: "session_link", id: found.id };
    }
    const requestId = newRequestId();
    const decision = await authorizeSlackInput(deps, {
      event: {
        appId: claim.appId,
        teamId: claim.teamId,
        agentId: claim.agentId,
      },
      user,
      ...(fromBot ? { bot: true } : {}),
      action: "session.submit",
      channel: { id: event.channel, dm },
      resource,
      requestId,
      connectUrl: deps.connectUrl,
    });
    if (decision.status === "dropped") {
      // Queued while the channel was in use, taken after the bot left: the
      // receipt says why nothing happened.
      if (
        decision.reason === "channel_left" ||
        decision.reason === "channel_gone"
      ) {
        throw new SlackInboundDropped(decision.reason);
      }
      return;
    }
    if (decision.decision.outcome !== "allow") {
      // The decision itself failed, not the person: try the event again.
      if (decision.decision.reason_code === "error") {
        throw new Error("Slack input decision failed");
      }
      deps.logger.info("Slack input refused", {
        ...ids,
        reason: decision.decision.reason_code,
      });
      if (decision.notice !== null) {
        await (decision.pending === null
          ? notice(decision.decision.reason_code, decision.notice)
          : notice("pending_approval", decision.notice, decision.pending));
      }
      return;
    }
    if (found === null && release === null) {
      deps.logger.warn("Slack agent has no active release; refused", ids);
      await notice("no_active_release", { message: "noActiveRelease" });
      return;
    }
    // Read again: the binding the decision allowed on may be a newer one
    // than the one read before it, approved after this message was sent.
    const allowedOn = dm
      ? binding
      : await deps.bindings.resolveSlackChannel(
          agent.installationId,
          event.channel,
        );
    if (!dm && allowedOn === null) {
      await stopIfLeft();
      deps.logger.info("Slack channel is no longer in use; input ignored", ids);
      return;
    }
    if (
      allowedOn?.approvedAt != null &&
      Number(event.ts) * 1000 < allowedOn.approvedAt.getTime()
    ) {
      deps.logger.info("Slack input predates the channel's approval; ignored", {
        ...ids,
      });
      return;
    }

    // A held text an edit changed is decoded already, so it is not decoded
    // again; the agent's mention is still taken out of it, as an edit may add
    // one (a stop, say).
    const message =
      editedText === undefined
        ? unescapeSlackText(withoutBotMention(event.text, agent.botUserId))
        : withoutBotMention(editedText, agent.botUserId);
    if (!messageTextSchema.safeParse(message).success) {
      deps.logger.info("Slack message has no text to send; ignored", ids);
      return;
    }
    if (mentionHandling === "m2") {
      await mentionTurn(
        botToken,
        decision.actorUserId,
        message,
        event.user
          ? { subject: decision.subject, slackUserId: event.user }
          : null,
      );
      return;
    }
    const caller = slackCallerOf(decision, requestId);
    // A stop word alone in a thread its open work is bound to, by its
    // requester or anyone the session lets control it: the work stops and
    // the message is no input. Anyone else's goes on as input.
    // The session recovered above counts too: a task's effect makes one
    // outside this channel's lease, before its link learns it.
    if (
      !fromBot &&
      found !== null &&
      sessionId !== null &&
      found.openedByTs !== event.ts &&
      isStopRequest(message) &&
      (await stopHandling()) === "stop_session"
    ) {
      // A stop that takes ends here, so the link learns its session first.
      if (found.sessionId === null) {
        await deps.sessionLinks.attachSession(found.id, sessionId);
      }
      const stopped = await stopRequest(caller, found, sessionId);
      if (stopped) return;
    }
    if (
      found !== null &&
      sessionId !== null &&
      found.openedByTs !== event.ts &&
      mentioned &&
      !dm
    ) {
      await waitOutClosedWork(found, sessionId);
    }
    const slackMessage: SlackMessageRef = {
      team_id: claim.teamId,
      channel_id: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts ?? null,
      permalink: await permalinkOf(botToken, event.channel, event.ts, ids),
    };

    const held = await deps.inbox.renew(claim, deps.leaseMs);
    if (held === null) throw new SlackLeaseLost();
    if (held.installationStatus === "revoked") {
      throw new SlackInboundDropped("installation_revoked");
    }
    // The permalink lookup is the slow step; the bot may have left meanwhile.
    // A leave that lands after this read still finds the turn in flight.
    await stopIfLeft();

    // Last before the turn, so only a turn about to run is counted.
    const botTurn = { messageTs: event.ts, agentId: agent.agentId };
    if (fromBot) {
      const counted = await deps.botTurns.claim(
        thread,
        botTurn,
        SLACK_BOT_TURN_LIMIT,
      );
      if (counted.outcome === "limit") {
        deps.logger.info("Slack thread reached its bot-turn limit", {
          ...ids,
          first: counted.first,
        });
        // Every stopped mention asks for the one line; its key keeps it one,
        // and a later mention posts it if the first one's write was lost.
        await deps.notices.recordInThread({
          workspaceId: agent.workspaceId,
          agentId: agent.agentId,
          installationId: agent.installationId,
          slackAppId: claim.slackAppId,
          teamId: claim.teamId,
          channelId: event.channel,
          threadTs,
          sessionId: found?.sessionId ?? null,
          sessionLinkId: found?.id ?? null,
          notice: { message: "botTurnLimit" },
          onceKey: `${claim.teamId}:${surfaceRef}:bot_turn_limit:${counted.stop}`,
        });
        return;
      }
    }

    let link: SessionLinkRecord;
    if (found !== null) {
      link = found;
    } else {
      if (binding === null || release === null) {
        if (fromBot) await deps.botTurns.release(thread, botTurn);
        throw new Error("The channel's binding is gone since the decision");
      }
      link = (
        await deps.sessionLinks
          .reserve({
            workspaceId: agent.workspaceId,
            installationId: agent.installationId,
            surfaceBindingId: binding.id,
            surfaceRef,
            channelId: event.channel,
            threadId: threadTs,
            openedByTs: event.ts,
            agentId: agent.agentId,
            releaseId: release.id,
            createdBy: decision.actorUserId,
          })
          .catch(async (error: unknown) => {
            if (fromBot) await deps.botTurns.release(thread, botTurn);
            throw error;
          })
      ).link;
    }
    const place = {
      dm,
      personUserId: decision.actorUserId,
      channelId: event.channel,
    };
    // Found once: the new session's parent and the input's topic share it.
    let lookup: Promise<Conversation | null> | undefined;
    const conversation = () => {
      lookup ??= conversationOf(place, claim.teamId, agent);
      return lookup;
    };
    // Once the session took the turn it counts, whatever fails after.
    let accepted = false;
    try {
      // Before the turn: the turn's transaction takes the message as this
      // topic's input.
      const topicId = await topicOf(
        place,
        claim.teamId,
        threadTs,
        agent,
        await conversation(),
      );
      if (link.sessionId === null && link.openedByTs !== event.ts) {
        link = await adoptOrReopen(link, event.ts);
      }
      if (link.sessionId === null || link.openedByTs === event.ts) {
        await openSession(
          caller,
          link,
          message,
          dm
            ? "private"
            : allowedOn?.channelKind === "private_channel"
              ? "private_channel"
              : undefined,
          await conversation(),
          slackMessage,
          { topicId, engagement: openedAs },
          () => {
            accepted = true;
          },
        );
      } else {
        await deps.sessions.appendMessage(caller, link.sessionId, {
          idempotencyKey: `${claim.teamId}:${event.channel}:${event.ts}`,
          body: { message, mode: "enqueue" },
          slackMessage,
          slackInput: {
            topicId,
            engagement: "bound",
            ...(await replyJudgment()),
          },
        });
      }
      // The turn's insert marks the thread's status due; the outbox pass
      // that follows this one sends it.
    } catch (error) {
      // No turn was taken, so the bot did not take one. A retry claims the
      // same turn again; one taken before a later step failed stays counted,
      // and its retry finds it so.
      if (fromBot && !accepted) await deps.botTurns.release(thread, botTurn);
      if (
        !(error instanceof SessionServiceError) ||
        RETRYABLE_SESSION_CODES.has(error.code)
      ) {
        throw error;
      }
      // Closed since the look above: the mention waits as it would have.
      if (
        (error.code === "SESSION_CLOSING" || error.code === "SESSION_CLOSED") &&
        mentioned &&
        !dm &&
        link.sessionId !== null &&
        link.openedByTs !== event.ts
      ) {
        await waitOutClosedWork(link, link.sessionId, true);
      }
      deps.logger.warn("Slack input refused by the session", {
        ...ids,
        code: error.code,
        reason_code: reasonCodeOf(error.details),
      });
      // Slack deleted what the turn would come from, or the poster was already
      // told of the stop's refusal: nothing is said, the warning above is the
      // record.
      if (error.code === "SOURCE_DELETED") return;
      if (stopRefused) {
        // Nothing more is said, but a storage refusal still ends dropped.
        if (error.code === "STORAGE_LIMIT_EXCEEDED") {
          throw new SlackInboundDropped("storage_limit_exceeded");
        }
        return;
      }
      if (
        // GITHUB_REFUSED: unreadable GitHub settings or the workspace ceiling.
        (error.code === "UNSUPPORTED_CAPABILITY" ||
          error.code === "GITHUB_REFUSED") &&
        (await deps.releaseRepositoryUnusable(
          agent.workspaceId,
          link.releaseId,
        ))
      ) {
        await notice("repository_required", { message: "repositoryRequired" });
      } else if (error.code === "RELEASE_SPEC_UNAVAILABLE") {
        await notice("release_unavailable", { message: "releaseUnavailable" });
      } else if (reasonCodeOf(error.details) === "agent_ownerless") {
        await notice("agent_ownerless", { message: "agentOwnerless" });
      } else if (reasonCodeOf(error.details) === "caller_limited") {
        await notice("caller_limited", {
          message: CALLER_LIMITED_NOTICE[callerLimitDimensionOf(error.details)],
        });
      } else if (error.code === "STORAGE_LIMIT_EXCEEDED") {
        // Refused at the check or at commit, with the turn rolled back: the
        // item ends dropped, never retried, and the requester is told once.
        if (dm && !fromBot) {
          await deps.notices.recordInThread({
            workspaceId: agent.workspaceId,
            agentId: agent.agentId,
            installationId: agent.installationId,
            slackAppId: claim.slackAppId,
            teamId: claim.teamId,
            channelId: event.channel,
            threadTs,
            sessionId: link.sessionId,
            sessionLinkId: link.id,
            notice: { message: "storageLimit" },
            onceKey: `${agent.installationId}:${surfaceRef}:${event.user}:storage_limit`,
          });
        } else {
          await notice(error.code, { message: "storageLimit" });
        }
        throw new SlackInboundDropped("storage_limit_exceeded");
      } else {
        await notice(error.code, { message: "failed" });
      }
      return;
    }
    // The turn's transaction took the input with it.
  };

  /** The thread's topic, in its main conversation. */
  async function topicOf(
    place: { dm: boolean; personUserId: string | null; channelId: string },
    teamId: string,
    threadTs: string,
    agent: { workspaceId: string; agentId: string },
    found?: Conversation | null,
  ): Promise<ConversationTopicId> {
    const conversation = found ?? (await conversationOf(place, teamId, agent));
    if (conversation === null) {
      throw new Error("A Slack DM has no person to take its input");
    }
    const topic = await deps.conversations.findOrCreateThreadTopic(
      conversation.id,
      { teamId, channelId: place.channelId, threadTs },
    );
    return topic.id;
  }

  /**
   * The input of a message a turn took before the turn's transaction took
   * it too, in the thread's topic: the inbox row's completion takes it.
   */
  async function inputOf(
    turn: InboundInputReceipt["turn"],
    place: { dm: boolean; personUserId: string | null; channelId: string },
    teamId: string,
    threadTs: string,
    ts: string,
    agent: { workspaceId: string; agentId: string },
    engagement: EngagementKind,
    judgment: Pick<InboundInputReceipt, "judgment">,
  ): Promise<InboundInputReceipt> {
    return {
      topicId: await topicOf(place, teamId, threadTs, agent),
      channelId: place.channelId,
      ts,
      turn,
      engagement,
      ...judgment,
    };
  }

  /** The thread's main conversation; none for a DM with no person. */
  async function conversationOf(
    place: { dm: boolean; personUserId: string | null; channelId: string },
    teamId: string,
    agent: { workspaceId: string; agentId: string },
  ): Promise<Conversation | null> {
    if (place.dm && place.personUserId === null) return null;
    return deps.conversations.findOrCreateConversation(
      place.dm
        ? {
            kind: "dm",
            workspaceId: agent.workspaceId,
            agentId: agent.agentId,
            personUserId: place.personUserId as string,
          }
        : {
            kind: "channel",
            workspaceId: agent.workspaceId,
            agentId: agent.agentId,
            teamId,
            channelId: place.channelId,
          },
    );
  }

  /**
   * The link's opening message gave out before the link learned its
   * session: keep the session it made, or let this message open one.
   */
  async function adoptOrReopen(
    link: SessionLinkRecord,
    ts: string,
  ): Promise<SessionLinkRecord> {
    const made = await deps.sessionLinks.openedSession(link);
    if (made !== null) return deps.sessionLinks.attachSession(link.id, made);
    deps.logger.warn("Slack thread's opening message ran out; reopened", {
      link_id: link.id,
    });
    return deps.sessionLinks.reopen(link.id, ts);
  }

  async function openSession(
    caller: Caller,
    link: SessionLinkRecord,
    message: string,
    // A DM is its person's; a private channel's session is its current
    // members', the channel's kind as the binding read it from Slack (its
    // events say channel_type "C" too).
    shareScope: "private" | "private_channel" | undefined,
    parent: Conversation | null,
    slackMessage: SlackMessageRef,
    slackInput: TurnInputTopic,
    onCreated: () => void,
  ): Promise<void> {
    const created = await deps.sessions.createSession(caller, {
      idempotencyKey: link.id,
      body: {
        agent_release_id: link.releaseId,
        message,
      },
      ...(shareScope === undefined ? {} : { shareScope }),
      ...(parent === null ? {} : { parentConversationId: parent.id }),
      slackMessage,
      slackInput,
    });
    onCreated();
    const attached = await deps.sessionLinks.attachSession(
      link.id,
      created.session_id,
    );
    if (attached.sessionId !== created.session_id) {
      throw new Error(`Slack thread ${link.id} already holds another session`);
    }
  }

  /** The message's link for the web; a turn goes on without one. */
  async function permalinkOf(
    botToken: string,
    channelId: string,
    ts: string,
    ids: Record<string, unknown>,
  ): Promise<string | null> {
    try {
      return await deps.slack.permalink(botToken, { channelId, ts });
    } catch (error) {
      const code = error instanceof SlackApiError ? error.code : "error";
      deps.logger.warn("Slack permalink not given; going on", { ...ids, code });
      return null;
    }
  }
}

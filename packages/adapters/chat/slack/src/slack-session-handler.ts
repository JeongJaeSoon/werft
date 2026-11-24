import {
  type ConversationTopicId,
  type EngagementKind,
  formatSurfaceRef,
  messageTextSchema,
  SLACK_BOT_TURN_LIMIT,
  type SlackMessageRef,
  type SlackNotice,
  type SurfaceChannelKind,
  slackNoticeFor,
} from "@werft-ai/contracts";
import type {
  AgentIdentityStore,
  AgentStore,
  BotTurnStore,
  BufferedInputReceipt,
  Conversation,
  ConversationStore,
  InboundInputReceipt,
  JudgmentBufferStore,
  LinkedAccountStore,
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
  type LifecycleStop,
  type SessionService,
  SessionServiceError,
} from "@werft-ai/platform";
import { z } from "zod";
import type { SlackAudience } from "./slack-audience.ts";
import { SlackApiError, type SlackBotApi } from "./slack-config-api.ts";
import {
  authorizeSlackInput,
  type SlackInput,
  slackCallerOf,
} from "./slack-decision.ts";
import {
  SLACK_PERSON_RESET_SUBTYPES,
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
 * The text a turn gets: the bot's own mention taken out, with or without
 * the display name Slack may put after a `|`.
 */
export function withoutBotMention(text: string, botUserId: string): string {
  return text
    .replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g"), "")
    .trim();
}

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
  sessions: Pick<SessionService, "createSession" | "appendMessage">;
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
      // A binding not in use is one the bot is out of, as far as the table
      // goes: left, gone, or never finished.
      const lifecycleStop: LifecycleStop | null = !place.agentActive
        ? "agent_inactive"
        : place.channelState !== "active"
          ? "channel_archived"
          : live.status === "pending_approval"
            ? "pending_approval"
            : live.status !== "ready"
              ? "bot_removed"
              : null;
      const handling = inboundHandling({
        place: "channel",
        work: "none",
        engaged: false,
        input: event.thread_ts === undefined ? "top_level" : "reply",
        rollout: place.rollout,
        mode: live.mode,
        listen: live.listen,
        lifecycleStop,
      });
      const judged =
        handling.kind === "table" ? handling.handling : handling.shadow;
      if (handling.kind === "current_path") {
        if (judged !== "buffer_m1") return "current_path";
        const currentPathTakes =
          live.mode === "on" &&
          event.thread_ts === undefined &&
          (await deps.settings.getSettings(agent.workspaceId, agent.agentId))
            ?.mention_only === false;
        if (currentPathTakes) return "current_path";
      }
      if (judged !== "buffer_m1") {
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
      if (!messageTextSchema.safeParse(event.text).success) return null;
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
        buffered: { body: event.text, slackUserId: event.user },
      };
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
    if (
      fromBot &&
      (dm || !mentioned || !agent.allowedBotUserIds.includes(event.user))
    ) {
      return;
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

    const message = withoutBotMention(event.text, agent.botUserId);
    if (!messageTextSchema.safeParse(message).success) {
      deps.logger.info("Slack message has no text to send; ignored", ids);
      return;
    }
    const caller = slackCallerOf(decision, requestId);
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
          slackInput: { topicId, engagement: "bound" },
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
      deps.logger.warn("Slack input refused by the session", {
        ...ids,
        code: error.code,
        reason_code: reasonCodeOf(error.details),
      });
      // Slack deleted what the turn would come from: nothing is said there,
      // the warning above is the record.
      if (error.code === "SOURCE_DELETED") return;
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
  ): Promise<InboundInputReceipt> {
    return {
      topicId: await topicOf(place, teamId, threadTs, agent),
      channelId: place.channelId,
      ts,
      turn,
      engagement,
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

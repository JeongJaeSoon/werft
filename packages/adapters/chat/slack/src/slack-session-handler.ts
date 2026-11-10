import {
  formatSurfaceRef,
  messageTextSchema,
  type SlackMessageRef,
  type SlackNotice,
  type SurfaceChannelKind,
  slackNoticeFor,
} from "@werft-ai/contracts";
import type {
  AgentIdentityStore,
  AgentStore,
  LinkedAccountStore,
  SessionLinkRecord,
  SessionLinkStore,
  SlackAppStore,
  SlackInboundEventStore,
  SurfaceBindingStore,
} from "@werft-ai/platform";
import {
  type AuthorizationPolicy,
  agentForSlackEvent,
  type Caller,
  type SessionService,
  SessionServiceError,
} from "@werft-ai/platform";
import { z } from "zod";
import { SlackApiError, type SlackBotApi } from "./slack-config-api.ts";
import {
  authorizeSlackInput,
  type SlackInput,
  slackCallerOf,
} from "./slack-decision.ts";
import {
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
  inbox: Pick<SlackInboundEventStore, "renew">;
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
  settings: Pick<SlackAppStore, "getSettings">;
  sessionLinks: SessionLinkStore;
  sessions: Pick<SessionService, "createSession" | "appendMessage">;
  /** The agent's active release, which a new thread's session runs. */
  agentDetails: Pick<AgentStore, "get">;
  /**
   * Slack names no repository, so a session starts as `releaseStartable`
   * says; true when it cannot (no usable repository for a profile that needs
   * one, a repository outside the profile or workspace ceiling, or GitHub
   * settings that cannot be read).
   */
  releaseRepositoryUnusable(
    workspaceId: string,
    releaseId: string,
  ): Promise<boolean>;
  slack: SlackBotApi;
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
 * leaves a notice for 94S-792 and no session.
 */
export function createSlackSessionHandler(
  deps: SlackSessionHandlerDeps,
): SlackInboundHandler {
  const newRequestId = deps.newRequestId ?? (() => crypto.randomUUID());

  return async (claim) => {
    const parsed = slackMessageSchema.safeParse(
      (claim.payload as { event?: unknown }).event,
    );
    // Not a channel message: 94S-794 acts on a bot's own channel join.
    if (!parsed.success) return;
    const event = parsed.data;
    const ids = { id: claim.id, event_id: claim.eventId };
    if (
      event.bot_id !== undefined ||
      (event.subtype !== undefined && event.subtype !== "thread_broadcast")
    ) {
      return;
    }
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

    const dm = event.channel_type === "im";
    const threadTs = event.thread_ts ?? event.ts;
    const surfaceRef = formatSurfaceRef(event.channel, threadTs);
    const found = await deps.sessionLinks.find(
      agent.installationId,
      surfaceRef,
    );
    if (found !== null && found.revokedAt !== null) return;
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
    const mentioned =
      event.type === "app_mention" ||
      new RegExp(`<@${agent.botUserId}(?:\\||>)`).test(event.text);
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
    const notice = async (
      reason: string,
      text: SlackNotice,
      wait?: { id: string; revision: number },
    ) => {
      // Someone talking unmentioned did not ask the agent, so a
      // refusal is not theirs to read on every message.
      if (found === null && !mentioned && !dm) return;
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

    let release: { id: string; runtime_profile_id: string } | null = null;
    let resource: SlackInput["resource"];
    if (found === null) {
      const detail = await deps.agentDetails.get(
        agent.workspaceId,
        agent.agentId,
      );
      if (!detail?.active_release) {
        deps.logger.warn("Slack agent has no active release; refused", ids);
        await notice("no_active_release", { message: "noActiveRelease" });
        return;
      }
      release = detail.active_release;
      resource = { kind: "surface_binding", releaseId: release.id };
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
      action: "session.submit",
      channel: { id: event.channel, dm },
      resource,
      requestId,
      connectUrl: deps.connectUrl,
    });
    if (decision.status === "dropped") {
      // Queued while the channel was in use, taken after the bot left: the
      // receipt says why nothing happened.
      if (decision.reason === "channel_left") {
        throw new SlackInboundDropped("channel_left");
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

    let link: SessionLinkRecord;
    if (found !== null) {
      link = found;
    } else {
      if (binding === null || release === null) {
        throw new Error("The channel's binding is gone since the decision");
      }
      link = (
        await deps.sessionLinks.reserve({
          workspaceId: agent.workspaceId,
          installationId: agent.installationId,
          surfaceBindingId: binding.id,
          surfaceRef,
          channelId: event.channel,
          threadId: threadTs,
          openedByTs: event.ts,
          agentId: agent.agentId,
          releaseId: release.id,
          profileId: release.runtime_profile_id,
          createdBy: decision.actorUserId,
        })
      ).link;
    }
    try {
      if (link.sessionId === null && link.openedByTs !== event.ts) {
        link = await adoptOrReopen(link, event.ts);
      }
      if (link.sessionId === null || link.openedByTs === event.ts) {
        await openSession(caller, link, message, dm, slackMessage);
      } else {
        await deps.sessions.appendMessage(caller, link.sessionId, {
          idempotencyKey: `${claim.teamId}:${event.channel}:${event.ts}`,
          body: { message, mode: "enqueue" },
          slackMessage,
        });
      }
      // The turn's insert marks the thread's status due; the outbox pass
      // that follows this one sends it.
    } catch (error) {
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
      } else if (
        error.code === "PROFILE_DIGEST_MISMATCH" ||
        error.code === "PROFILE_BLOCKED"
      ) {
        await notice("profile_unavailable", { message: "profileUnavailable" });
      } else {
        await notice(error.code, { message: "failed" });
      }
    }
  };

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
    dm: boolean,
    slackMessage: SlackMessageRef,
  ): Promise<void> {
    const created = await deps.sessions.createSession(caller, {
      idempotencyKey: link.id,
      body: {
        profile_id: link.profileId,
        agent_release_id: link.releaseId,
        message,
      },
      ...(dm ? { shareScope: "private" as const } : {}),
      slackMessage,
    });
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

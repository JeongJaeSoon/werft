import { SLACK_CHANNEL_MEMBER_LIMIT } from "@werft-ai/contracts";
import {
  type AgentIdentityStore,
  agentForSlackEvent,
  type ChannelMemberCheckable,
  type ChannelMemberStore,
} from "@werft-ai/platform";
import { z } from "zod";
import { lifecycleChannelOf } from "./slack-channel-lifecycle.ts";
import {
  SLACK_CHANNEL_PAGE_SIZE,
  SlackApiError,
  type SlackChannelMemberApi,
  SlackRateLimitedError,
} from "./slack-config-api.ts";
import type { SlackInboundHandler, SlackInboxLogger } from "./slack-inbox.ts";

const PAGE_LIMIT = Math.ceil(
  SLACK_CHANNEL_MEMBER_LIMIT / SLACK_CHANNEL_PAGE_SIZE,
);

/** Why a member check answered false without knowing; logged, never shown. */
export type SlackMemberCheckUnconfirmed =
  | "no_bot_token"
  | "rate_limited"
  | "slack_error"
  | "slack_unanswered"
  | "too_many_members"
  | "overtaken"
  | "failed";

function unconfirmedOf(error: unknown): SlackMemberCheckUnconfirmed {
  if (error instanceof SlackRateLimitedError) return "rate_limited";
  if (error instanceof SlackApiError) {
    return error.answered ? "slack_error" : "slack_unanswered";
  }
  return "failed";
}

/**
 * The member check over Slack's `conversations.members`, one list per
 * channel of an install, cached `SLACK_MEMBER_CACHE_TTL_MS`. Every page is
 * read before the list is kept: a list cut short would hide real members.
 */
export function createSlackChannelMembers(deps: {
  store: ChannelMemberStore;
  slack: SlackChannelMemberApi;
  botToken(workspaceId: string, agentId: string): Promise<string | null>;
  logger: Pick<SlackInboxLogger, "warn">;
}): ChannelMemberCheckable {
  return {
    async isMember(input) {
      const unconfirmed = (
        reason: SlackMemberCheckUnconfirmed,
        error?: unknown,
      ) => {
        deps.logger.warn("Slack channel members unconfirmed; not a member", {
          event: "slack.member_check.unconfirmed",
          reason,
          workspace_id: input.workspaceId,
          agent_id: input.agentId,
          channel_id: input.channelId,
          ...(error instanceof SlackApiError
            ? { slack_error: error.code }
            : {}),
        });
        return false;
      };
      try {
        const subject = await deps.store.subject(input);
        if (subject === null) return false;
        const read = await deps.store.cached(
          subject.installationId,
          input.channelId,
        );
        if (read.memberIds !== null) {
          return read.memberIds.includes(subject.slackUserId);
        }
        const botToken = await deps.botToken(input.workspaceId, input.agentId);
        if (botToken === null) return unconfirmed("no_bot_token");
        const members = new Set<string>();
        let cursor: string | null = null;
        for (let page = 0; ; page += 1) {
          if (page === PAGE_LIMIT) return unconfirmed("too_many_members");
          const answer = await deps.slack.channelMembers(botToken, {
            channelId: input.channelId,
            cursor,
          });
          for (const id of answer.memberIds) members.add(id);
          if (members.size > SLACK_CHANNEL_MEMBER_LIMIT) {
            return unconfirmed("too_many_members");
          }
          cursor = answer.nextCursor;
          if (cursor === null) break;
        }
        // A list the store refused was overtaken (a member event, a
        // revoke): it answers nothing, and the next question reads again.
        if (
          !(await deps.store.remember(
            subject.installationId,
            input.channelId,
            [...members],
            read.checkedAt,
          ))
        ) {
          return unconfirmed("overtaken");
        }
        return members.has(subject.slackUserId);
      } catch (error) {
        return unconfirmed(unconfirmedOf(error), error);
      }
    },
  };
}

const memberChangeSchema = z.object({
  type: z.enum([
    "member_joined_channel",
    "member_left_channel",
    "channel_left",
    "group_left",
  ]),
  channel: z.string().min(1),
});

/**
 * The `slack` role's first handler: anyone joining or leaving a channel,
 * the bot included, or the channel being archived, unarchived, renamed or
 * deleted, voids that channel's member list for this app's install before
 * the event goes on to `next`.
 */
export function createSlackMemberCacheInvalidator(deps: {
  agents: Pick<AgentIdentityStore, "resolveSlackEvent">;
  members: Pick<ChannelMemberStore, "forget">;
  next: SlackInboundHandler;
}): SlackInboundHandler {
  return async (claim) => {
    const event = (claim.payload as { event?: unknown }).event;
    const parsed = memberChangeSchema.safeParse(event);
    // An archive, a rename or a delete voids the list too: who may read the
    // channel is asked again.
    const channel = parsed.success
      ? parsed.data.channel
      : lifecycleChannelOf(event);
    if (channel !== null) {
      const agent = await agentForSlackEvent(deps.agents, {
        appId: claim.appId,
        teamId: claim.teamId,
        agentId: claim.agentId,
      });
      if (agent.status === "resolved") {
        await deps.members.forget(agent.installationId, channel);
      }
    }
    return deps.next(claim);
  };
}

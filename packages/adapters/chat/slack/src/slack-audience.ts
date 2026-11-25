import {
  SLACK_MEMBER_CACHE_TTL_MS,
  type SlackChannelSharing,
  type SlackUnheardReason,
  type SlackUserKind,
  slackUnheardReasonOf,
  slackUserKindOf,
} from "@werft-ai/contracts";
import type { SurfaceBindingStore } from "@werft-ai/platform";
import {
  SlackApiError,
  type SlackBotApi,
  type SlackChannelSharingApi,
} from "./slack-config-api.ts";
import type { SlackInboxLogger } from "./slack-inbox.ts";

/** How long a share or a person's kind is reused, as the member list is. */
export const SLACK_AUDIENCE_CACHE_TTL_MS = SLACK_MEMBER_CACHE_TTL_MS;
const CACHE_LIMIT = 10_000;

export type SlackChannelQuestion = {
  agentId: string;
  channelId: string;
  /** Null when the app has no bot token: nothing can be confirmed. */
  botToken: string | null;
  /** Skips what is kept and asks Slack. */
  fresh?: boolean;
};

export type SlackAuthorQuestion = SlackChannelQuestion & {
  /** The team that installed the app; a person of another is external. */
  teamId: string;
  slackUserId: string;
};

/**
 * Who may be heard in a channel: whether another organization shares it and
 * whether the author is a guest or a stranger. The judgment buffer, the M1
 * judgment and the read tools ask here, so they agree.
 */
export type SlackAudience = {
  /** Why an unmentioned post is not heard; null when it may be. */
  unheardReason(
    question: SlackAuthorQuestion,
  ): Promise<SlackUnheardReason | null>;
  /**
   * Why a post of a channel already found not shared is not heard: its
   * author is a guest or a stranger, or could not be told. Asks only of the
   * author.
   */
  authorUnheardReason(
    question: SlackAuthorQuestion,
  ): Promise<SlackUnheardReason | null>;
  /**
   * Whether another organization shares the channel; null when Slack could
   * not tell. An answer Slack gives is recorded on the channel's binding,
   * which removes the channel's held posts when it is shared.
   */
  channelSharing(
    question: SlackChannelQuestion,
  ): Promise<SlackChannelSharing | null>;
};

type Kept<T> = Map<string, { value: T; at: number }>;

/**
 * What the audience keeps between answers. The slack role makes its handlers
 * again every pass; one cache made once outlives them.
 */
export type SlackAudienceCache = {
  channels: Kept<SlackChannelSharing>;
  authors: Kept<SlackUserKind>;
};

export function createSlackAudienceCache(): SlackAudienceCache {
  return { channels: new Map(), authors: new Map() };
}

export function createSlackAudience(deps: {
  slack: Pick<SlackBotApi, "userInfo"> & SlackChannelSharingApi;
  bindings: Pick<SurfaceBindingStore, "recordExternalShared">;
  logger: Pick<SlackInboxLogger, "warn">;
  cache?: SlackAudienceCache;
  ttlMs?: number;
  now?: () => number;
}): SlackAudience {
  const ttlMs = deps.ttlMs ?? SLACK_AUDIENCE_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;
  const { channels, authors } = deps.cache ?? createSlackAudienceCache();

  function kept<T>(map: Kept<T>, key: string): T | undefined {
    const hit = map.get(key);
    if (hit !== undefined && now() - hit.at < ttlMs) return hit.value;
    map.delete(key);
    return undefined;
  }
  function keep<T>(map: Kept<T>, key: string, value: T) {
    map.delete(key);
    const oldest = map.size >= CACHE_LIMIT ? map.keys().next() : undefined;
    if (oldest?.done === false) map.delete(oldest.value);
    map.set(key, { value, at: now() });
  }
  const unanswered = (
    method: string,
    question: SlackChannelQuestion,
    error: unknown,
  ) =>
    deps.logger.warn("Slack audience unconfirmed", {
      event: "slack.audience.unconfirmed",
      method,
      agent_id: question.agentId,
      channel_id: question.channelId,
      ...(error instanceof SlackApiError ? { slack_error: error.code } : {}),
    });

  async function channelSharing(
    question: SlackChannelQuestion,
  ): Promise<SlackChannelSharing | null> {
    const key = `${question.agentId}:${question.channelId}`;
    if (question.fresh) channels.delete(key);
    const hit = kept(channels, key);
    if (hit !== undefined) return hit;
    if (question.botToken === null) return null;
    const askedAt = new Date(now());
    let sharing: SlackChannelSharing;
    try {
      sharing = await deps.slack.channelSharing(
        question.botToken,
        question.channelId,
      );
    } catch (error) {
      unanswered("conversations.info", question, error);
      return null;
    }
    const recorded = await deps.bindings.recordExternalShared(
      question.agentId,
      question.channelId,
      sharing === "external",
      askedAt,
    );
    // Only a share is kept: a kept "internal" would let posts be held after a
    // share whose event never came. Nor is an answer older than the binding's.
    if (recorded && sharing === "external") keep(channels, key, sharing);
    return sharing;
  }

  async function authorKind(
    question: SlackAuthorQuestion,
  ): Promise<SlackUserKind | null> {
    const key = `${question.agentId}:${question.slackUserId}`;
    const hit = kept(authors, key);
    if (hit !== undefined) return hit;
    if (question.botToken === null) return null;
    try {
      const user = await deps.slack.userInfo(
        question.botToken,
        question.slackUserId,
      );
      const kind = slackUserKindOf(user, question.teamId);
      keep(authors, key, kind);
      return kind;
    } catch (error) {
      unanswered("users.info", question, error);
      return null;
    }
  }

  return {
    channelSharing,
    async authorUnheardReason(question) {
      return slackUnheardReasonOf({
        sharing: "internal",
        author: await authorKind(question),
      });
    },
    async unheardReason(question) {
      const sharing = await channelSharing(question);
      // A shared channel is not heard whoever wrote; its author is not asked.
      return slackUnheardReasonOf({
        sharing,
        author: sharing === "internal" ? await authorKind(question) : null,
      });
    },
  };
}

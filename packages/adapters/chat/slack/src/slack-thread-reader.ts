import type {
  ConversationThreadMessage,
  ConversationThreadReader,
} from "@werft-ai/platform";
import type { SlackAudience } from "./slack-audience.ts";
import {
  SlackApiError,
  SlackRateLimitedError,
  type SlackThreadApi,
} from "./slack-config-api.ts";
import { unescapeSlackText } from "./slack-entities.ts";
import type { SlackInboxLogger } from "./slack-inbox.ts";

// Not a post anyone wrote: a join, a topic change, and the like.
const NOT_WRITTEN = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
]);

/**
 * A conversation turn's thread read, with the agent's bot token. A channel
 * another organization shares is not read, nor one whose sharing Slack
 * would not tell; then the thread's posts by a guest or a stranger, or by
 * someone the audience could not judge, are left out before anything goes
 * to the model (a1/S7's judgment, one place for both).
 */
export function createSlackThreadReader(deps: {
  slack: SlackThreadApi;
  audience: Pick<SlackAudience, "channelSharing" | "authorUnheardReason">;
  botToken(workspaceId: string, agentId: string): Promise<string | null>;
  logger: Pick<SlackInboxLogger, "warn">;
}): ConversationThreadReader {
  return {
    async read(input) {
      try {
        return await readThread(input);
      } catch (error) {
        // Any of the read's asks, the audience's too: the turn reads no more.
        if (error instanceof SlackRateLimitedError) {
          return { outcome: "rate_limited" };
        }
        throw error;
      }
    },
  };

  async function readThread({
    workspaceId,
    agentId,
    thread,
    limit,
  }: Parameters<ConversationThreadReader["read"]>[0]): ReturnType<
    ConversationThreadReader["read"]
  > {
    const botToken = await deps.botToken(workspaceId, agentId);
    if (botToken === null) return { outcome: "unavailable" };
    const asked = {
      agentId,
      channelId: thread.channelId,
      botToken,
      rateLimitThrows: true,
    };
    // Asked of Slack each read, as a "not shared" answer is never kept: a
    // channel shared since the last read is read no more.
    const sharing = await deps.audience.channelSharing(asked);
    if (sharing === "external") return { outcome: "external_shared" };
    if (sharing === null) return { outcome: "unavailable" };
    let posts: Awaited<ReturnType<SlackThreadApi["threadReplies"]>>;
    try {
      posts = await deps.slack.threadReplies(botToken, {
        channelId: thread.channelId,
        threadTs: thread.ts,
        limit,
      });
    } catch (error) {
      if (error instanceof SlackRateLimitedError) throw error;
      deps.logger.warn("Slack thread read failed", {
        event: "slack.thread_read.failed",
        agent_id: agentId,
        channel_id: thread.channelId,
        ...(error instanceof SlackApiError ? { slack_error: error.code } : {}),
      });
      return { outcome: "unavailable" };
    }
    const messages: ConversationThreadMessage[] = [];
    let withheld = 0;
    for (const post of posts) {
      if (post.subtype !== undefined && NOT_WRITTEN.has(post.subtype)) {
        continue;
      }
      if (post.botId !== undefined || post.subtype === "bot_message") {
        messages.push({
          ts: post.ts,
          author: { kind: "bot" },
          text: unescapeSlackText(post.text),
        });
        continue;
      }
      if (post.user === undefined) {
        withheld += 1;
        continue;
      }
      const unheard = await deps.audience.authorUnheardReason({
        ...asked,
        teamId: thread.teamId,
        slackUserId: post.user,
      });
      if (unheard !== null) {
        withheld += 1;
        continue;
      }
      messages.push({
        ts: post.ts,
        author: { kind: "person", slackUserId: post.user },
        text: unescapeSlackText(post.text),
      });
    }
    return { outcome: "read", messages, withheld };
  }
}

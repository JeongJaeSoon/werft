import { z } from "zod";

import { opaqueCursorSchema } from "../shared/index.ts";
import { slackIdSchema } from "./agent-identities.ts";

export const lookupSlackChannelsQuerySchema = z
  .object({
    ids: z
      .string()
      .min(1)
      .max(3249)
      .transform((value) => value.split(","))
      .pipe(z.array(slackIdSchema).min(1).max(50)),
  })
  .strict();

export const lookupSlackChannelsResponseSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: slackIdSchema,
            name: z.string().min(1).max(255),
            state: z.enum(["known", "unknown"]),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();

export type LookupSlackChannelsQuery = z.infer<
  typeof lookupSlackChannelsQuerySchema
>;
export type LookupSlackChannelsResponse = z.infer<
  typeof lookupSlackChannelsResponseSchema
>;

// Searching the channels an agent's Slack bot can see, for the console's
// channel picker. The server reads Slack's whole list into a short
// cache and pages through it with a cursor of its own.

export const SLACK_CHANNEL_SEARCH_LIMIT_DEFAULT = 20;
export const SLACK_CHANNEL_SEARCH_LIMIT_MAX = 50;
export const SLACK_CHANNEL_QUERY_MAX_LENGTH = 80;

export const searchSlackChannelsQuerySchema = z
  .object({
    q: z.string().max(SLACK_CHANNEL_QUERY_MAX_LENGTH).default("").meta({
      description:
        "A prefix of the channel name, any case; a leading `#` is ignored. Empty matches every channel.",
    }),
    cursor: opaqueCursorSchema.max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SLACK_CHANNEL_SEARCH_LIMIT_MAX)
      .default(SLACK_CHANNEL_SEARCH_LIMIT_DEFAULT),
  })
  .strict();

export const slackChannelSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(255),
    is_private: z.boolean(),
    /** Whether the agent's bot is in the channel. Always true for a private one. */
    is_member: z.boolean(),
  })
  .strict();

export const searchSlackChannelsResponseSchema = z
  .object({
    items: z.array(slackChannelSchema).max(SLACK_CHANNEL_SEARCH_LIMIT_MAX),
    next_cursor: opaqueCursorSchema.nullable(),
    /** The bot sees more channels than the server keeps; some are missing. */
    truncated: z.boolean(),
    /** Slack is rate limiting: this is the last list read, older than usual. */
    stale: z.boolean(),
  })
  .strict();

// Shown as the API's error message, so the web screen says the same.
export const SLACK_CHANNEL_SEARCH_MESSAGES = {
  cursorExpired:
    "채널 목록이 새로 바뀌어 이 다음 페이지는 더 쓸 수 없어요. 처음부터 다시 검색하세요",
  rateLimited: "Slack이 잠시 요청을 막고 있어요. 조금 뒤에 다시 검색하세요",
} as const;

export type SearchSlackChannelsQuery = z.infer<
  typeof searchSlackChannelsQuerySchema
>;
export type SlackChannel = z.infer<typeof slackChannelSchema>;
export type SearchSlackChannelsResponse = z.infer<
  typeof searchSlackChannelsResponseSchema
>;

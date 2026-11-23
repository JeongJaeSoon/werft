import { z } from "zod";

import {
  agentIdSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

export const conversationIdSchema = z.uuid().brand<"ConversationId">();
export type ConversationId = z.infer<typeof conversationIdSchema>;
export const channelContextIdSchema = z.uuid().brand<"ChannelContextId">();
export type ChannelContextId = z.infer<typeof channelContextIdSchema>;
export const conversationTopicIdSchema = z
  .uuid()
  .brand<"ConversationTopicId">();
export type ConversationTopicId = z.infer<typeof conversationTopicIdSchema>;
export const conversationInputIdSchema = z
  .uuid()
  .brand<"ConversationInputId">();
export type ConversationInputId = z.infer<typeof conversationInputIdSchema>;

/**
 * The key a web client gives an input so a retry finds it again: unique per
 * agent and person, with no expiry. The DB checks the same pattern.
 */
export const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const clientMessageIdSchema = z
  .string()
  .regex(CLIENT_MESSAGE_ID_PATTERN)
  .brand<"ClientMessageId">();
export type ClientMessageId = z.infer<typeof clientMessageIdSchema>;

/**
 * Whether Slack is to mirror a web input: `not_target` when the person has
 * no Slack account linked, which only a DM input can be, since a channel
 * input from such a person is refused; `pending` until Slack places it.
 */
export const CONVERSATION_INPUT_SLACK_MIRROR_VALUES = [
  "not_target",
  "pending",
] as const;
export const conversationInputSlackMirrorSchema = z.enum(
  CONVERSATION_INPUT_SLACK_MIRROR_VALUES,
);
export type ConversationInputSlackMirror = z.infer<
  typeof conversationInputSlackMirrorSchema
>;

/**
 * An agent's main conversation: one per channel it is in, one per person it
 * talks to in DMs.
 */
export const CONVERSATION_KIND_VALUES = ["channel", "dm"] as const;
export const conversationKindSchema = z.enum(CONVERSATION_KIND_VALUES);
export type ConversationKind = z.infer<typeof conversationKindSchema>;

/**
 * A Slack team or channel id. The scope key joins segments with ":", so a
 * segment holding one would let two scopes share a key. The DB checks the
 * same pattern.
 */
export const SLACK_SCOPE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const slackScopeSegmentSchema = z
  .string()
  .regex(SLACK_SCOPE_SEGMENT_PATTERN);
/** A Slack message ts: seconds, a dot, the fraction. */
export const SLACK_TS_PATTERN = /^[0-9]{1,20}\.[0-9]{1,20}$/;
export const slackTsSchema = z.string().regex(SLACK_TS_PATTERN);

/** What a piece of context may be read under. */
export const scopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("channel"),
    workspaceId: workspaceIdSchema,
    teamId: slackScopeSegmentSchema,
    channelId: slackScopeSegmentSchema,
  }),
  z.object({
    kind: z.literal("person"),
    workspaceId: workspaceIdSchema,
    userId: userIdSchema,
  }),
  z.object({
    kind: z.literal("agent"),
    workspaceId: workspaceIdSchema,
    agentId: agentIdSchema,
  }),
]);
export type Scope = z.infer<typeof scopeSchema>;

export const scopeKeySchema = z
  .string()
  .regex(
    /^(channel:[0-9a-f-]{36}:[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}|person:[0-9a-f-]{36}:[0-9a-f-]{36}|agent:[0-9a-f-]{36}:[0-9a-f-]{36})$/,
  )
  .brand<"ScopeKey">();
/**
 * `channel:{W}:{T}:{C}` · `person:{W}:{U}` · `agent:{W}:{A}`. Every agent in
 * a channel reads the one channel key; U is a Werft user id, not Slack's.
 */
export type ScopeKey = z.infer<typeof scopeKeySchema>;

export function scopeKeyOf(input: Scope): ScopeKey {
  const scope = scopeSchema.parse(input);
  // Uuids may arrive in either case; one scope has one key.
  const w = scope.workspaceId.toLowerCase();
  const raw =
    scope.kind === "channel"
      ? `channel:${w}:${scope.teamId}:${scope.channelId}`
      : scope.kind === "person"
        ? `person:${w}:${scope.userId.toLowerCase()}`
        : `agent:${w}:${scope.agentId.toLowerCase()}`;
  return scopeKeySchema.parse(raw);
}

/** Where a main conversation is: a channel of a Slack team, or one person. */
export type ConversationPlace =
  | {
      kind: "channel";
      workspaceId: string;
      teamId: string;
      channelId: string;
    }
  | { kind: "dm"; workspaceId: string; personUserId: string };

/**
 * The scope a conversation reads: a channel conversation reads the channel's,
 * shared by every agent there; a DM reads the person's.
 */
export function conversationScopeKey(place: ConversationPlace): ScopeKey {
  return place.kind === "channel"
    ? scopeKeyOf(place)
    : scopeKeyOf({
        kind: "person",
        workspaceId: place.workspaceId,
        userId: place.personUserId,
      });
}

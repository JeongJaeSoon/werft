import { z } from "zod";

import {
  bindingListenSchema,
  m1JudgmentsPerHourSchema,
  reportModeChoiceSchema,
  surfaceBindingSchema,
  surfaceCeilingSchema,
  surfaceChannelKindSchema,
} from "../agents/surfaces.ts";
import {
  agentIdSchema,
  receiptIdSchema,
  revisionSchema,
  surfaceBindingIdSchema,
} from "../shared/index.ts";

// How an agent answers in each Slack channel of its app's install, and in
// its DMs. One write sets one channel; the DM binding is the
// install's single row with no channel id.

/**
 * `off`: the channel is not used. `on`: in use; the agent's `mention_only`
 * setting says whether it waits for a mention.
 */
export const SLACK_BINDING_MODE_VALUES = ["off", "on"] as const;
export const slackBindingModeSchema = z.enum(SLACK_BINDING_MODE_VALUES);

// Slack's channel ids (`C…`, `G…`); names are resolved by the console.
const slackChannelIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9]+$/);

/**
 * Replaces the binding for one channel, or the install's DM binding, whole:
 * a missing `ceiling` is the default one. A missing `listen`,
 * `m1_judgments_per_hour` or `report_mode` keeps the channel's, or is
 * `free`, 12 or none picked for a new one; a null `report_mode` picks none
 * (`defaultReportMode`). `home: true` moves the agent's
 * home here. The server asks Slack what kind of channel it is;
 * `channel_kind`, when sent, only has to agree on whether it is the DM row.
 */
export const putSlackBindingRequestSchema = z
  .object({
    channel_id: slackChannelIdSchema.nullable(),
    channel_kind: surfaceChannelKindSchema.optional(),
    mode: slackBindingModeSchema,
    listen: bindingListenSchema.optional(),
    m1_judgments_per_hour: m1JudgmentsPerHourSchema.optional(),
    report_mode: reportModeChoiceSchema.nullable().optional(),
    home: z.boolean().default(false),
    ceiling: surfaceCeilingSchema.optional(),
    /**
     * Why the channel is turned on again after an emergency stop; required
     * then (400 otherwise) and kept in the receipt. Ignored on any other save.
     */
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (
      request.channel_kind !== undefined &&
      (request.channel_kind === "dm") !== (request.channel_id === null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["channel_id"],
        message: "a dm binding names no channel, and only a dm binding",
      });
    }
    if (request.home && request.channel_id === null) {
      ctx.addIssue({
        code: "custom",
        path: ["home"],
        message: "a dm binding is never home",
      });
    }
  });

export const putSlackBindingResponseSchema = z
  .object({
    slack_binding: surfaceBindingSchema,
    receipt_id: receiptIdSchema,
    /**
     * How many messages the channel held for judgment this save dropped:
     * it now listens to less, is off, or waits for approval. A server
     * older than this field leaves it out.
     */
    dropped_buffered: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * An owner's or admin's decision on a private channel waiting for approval.
 * `revision` is the binding's revision as the caller read it: a decision on
 * a binding that changed since answers 409, and the same decision again
 * after it landed answers the binding it left.
 */
export const resolveSlackBindingRequestSchema = z
  .object({ revision: revisionSchema })
  .strict();

export const resolveSlackBindingResponseSchema = z
  .object({
    slack_binding: surfaceBindingSchema,
    /** Null when the decision was already made and this call only replays it. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

/** What the channel is told when its agent is stopped in an emergency. */
export const SLACK_EMERGENCY_STOP_TEXT = "관리자가 이 에이전트를 멈췄어요";

/** Why the agent is stopped in the channel: required, kept in the receipt. */
export const emergencyStopSlackBindingRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();

/**
 * What an emergency stop stopped, as counts only: nothing anyone wrote in
 * the channel or its sessions is returned.
 */
export const emergencyStopSlackBindingResponseSchema = z
  .object({
    slack_binding: surfaceBindingSchema,
    stopped: z
      .object({
        sessions: z.number().int().nonnegative(),
        turns: z.number().int().nonnegative(),
        posts: z.number().int().nonnegative(),
      })
      .strict(),
    receipt_id: receiptIdSchema,
  })
  .strict();

export const slackBindingParamsSchema = z
  .object({
    id: agentIdSchema,
    binding_id: surfaceBindingIdSchema,
  })
  .strict();

export const SLACK_BINDING_LIST_LIMIT = 500;

/** The agent's live bindings: home first, then oldest first. */
export const listSlackBindingsResponseSchema = z
  .object({
    items: z.array(surfaceBindingSchema).max(SLACK_BINDING_LIST_LIMIT),
  })
  .strict();

// Shown as the API's error message, so the web screen says the same.
export const SLACK_BINDING_MESSAGES = {
  notInstalled:
    "이 에이전트는 Slack 앱에 연결돼 있지 않아요. 앱을 연결한 뒤 채널을 설정하세요",
  conflict:
    "같은 채널 설정이 동시에 바뀌었어요. 목록을 새로 읽고 다시 시도하세요",
  dmChannel: "DM은 채널 id 없이 DM 설정으로 정하세요",
  channelUnknown:
    "Slack이 이 채널을 알려주지 않아요. 에이전트를 채널에 초대한 뒤 다시 시도하세요",
  slackUnavailable:
    "지금 Slack에서 채널 정보를 읽지 못했어요. 잠시 뒤 다시 시도하세요",
  pendingHome:
    "승인을 기다리는 비공개 채널은 홈으로 정할 수 없어요. 먼저 승인하세요",
  notPending:
    "이 채널은 승인을 기다리고 있지 않거나, 그 사이에 바뀌었어요. 목록을 새로 읽고 다시 시도하세요",
  externalShared:
    "외부 조직과 공유한 채널은 멘션으로만 들을 수 있어요. 듣기를 mention이나 off로 정하세요",
  notChannel:
    "긴급 정지는 채널에서만 할 수 있어요. DM은 DM 설정을 off로 정하세요",
  alreadyStopped:
    "이 채널의 에이전트는 이미 긴급 정지돼 있어요. 다시 켜려면 이유를 적고 켜세요",
  reasonRequired: "긴급 정지된 채널을 다시 켜려면 이유를 적어야 해요",
} as const;
/** The `details.reason_code` sent with each of those messages. */
export const SLACK_BINDING_REASON_CODES = {
  notInstalled: "not_installed",
  conflict: "conflict",
  dmChannel: "dm_channel",
  channelUnknown: "channel_unknown",
  slackUnavailable: "slack_unavailable",
  pendingHome: "pending_home",
  notPending: "not_pending",
  externalShared: "external_shared_channel",
  notChannel: "not_channel",
  alreadyStopped: "already_emergency_stopped",
  reasonRequired: "reason_required",
} as const satisfies Record<keyof typeof SLACK_BINDING_MESSAGES, string>;

export type PutSlackBindingRequest = z.infer<
  typeof putSlackBindingRequestSchema
>;
export type PutSlackBindingResponse = z.infer<
  typeof putSlackBindingResponseSchema
>;
export type ResolveSlackBindingRequest = z.infer<
  typeof resolveSlackBindingRequestSchema
>;
export type ResolveSlackBindingResponse = z.infer<
  typeof resolveSlackBindingResponseSchema
>;
export type EmergencyStopSlackBindingRequest = z.infer<
  typeof emergencyStopSlackBindingRequestSchema
>;
export type EmergencyStopSlackBindingResponse = z.infer<
  typeof emergencyStopSlackBindingResponseSchema
>;
export type ListSlackBindingsResponse = z.infer<
  typeof listSlackBindingsResponseSchema
>;

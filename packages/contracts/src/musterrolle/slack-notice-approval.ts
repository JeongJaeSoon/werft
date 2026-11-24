import { z } from "zod";

import {
  slackNoticeApprovalIdSchema,
  slackNoticeLocaleSchema,
  slackNoticeVersionSchema,
} from "../domain/slack-notice.ts";
import { timestampSchema, userIdSchema } from "../shared/index.ts";
import { slackIdSchema } from "./agent-identities.ts";
import { displayNameSchema, emailSchema } from "./workspaces.ts";

export const slackNoticeTextSchema = z
  .object({
    /** Paragraphs, drawn as written. */
    body: z.array(z.string().min(1)).min(1),
    /** Opens in a new tab. */
    policy_link: z
      .object({
        label: z.string().min(1),
        href: z.url({ protocol: /^https$/ }),
      })
      .strict(),
  })
  .strict();

/**
 * `not_installed`: no live Slack install to approve for; `reapproval_required`:
 * an approval of an older version is live but the current version asks for a
 * new one, and the agent does not listen until it is given.
 */
export const SLACK_NOTICE_STATE_VALUES = [
  "no_notice",
  "not_installed",
  "not_approved",
  "reapproval_required",
  "approved",
] as const;
export const slackNoticeStateSchema = z.enum(SLACK_NOTICE_STATE_VALUES);

export const slackNoticeApprovalViewSchema = z
  .object({
    id: slackNoticeApprovalIdSchema,
    slack_team_id: slackIdSchema,
    notice_version: slackNoticeVersionSchema,
    /** False for an approval of a version before the current one asked anew. */
    counts: z.boolean(),
    approved_by: z
      .object({
        user_id: userIdSchema,
        display_name: displayNameSchema,
        /** Null unless the reader is a workspace owner or admin. */
        email: emailSchema.nullable(),
      })
      .strict(),
    approved_at: timestampSchema,
  })
  .strict();

export const getSlackNoticeResponseSchema = z
  .object({
    /** The current version; null before the first one is published. */
    notice: z
      .object({
        version: slackNoticeVersionSchema,
        requires_reapproval: z.boolean(),
        text: z
          .object({ ko: slackNoticeTextSchema, ja: slackNoticeTextSchema })
          .strict(),
      })
      .strict()
      .nullable(),
    state: slackNoticeStateSchema,
    /** The reader may approve and revoke: a workspace owner or admin. */
    can_approve: z.boolean(),
    approvals: z.array(slackNoticeApprovalViewSchema),
  })
  .strict();

export const approveSlackNoticeRequestSchema = z
  .object({
    /** The version the approver was shown; another current one is refused. */
    notice_version: slackNoticeVersionSchema,
    /** The language it was shown in, kept on the receipt. */
    locale: slackNoticeLocaleSchema,
  })
  .strict();

export type SlackNoticeState = z.infer<typeof slackNoticeStateSchema>;
export type GetSlackNoticeResponse = z.infer<
  typeof getSlackNoticeResponseSchema
>;
export type ApproveSlackNoticeRequest = z.infer<
  typeof approveSlackNoticeRequestSchema
>;

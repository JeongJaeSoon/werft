import { z } from "zod";

import {
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import { displayNameSchema } from "./workspaces.ts";

export const SECRET_PURPOSE_VALUES = [
  "slack_config_token",
  "slack_signing_secret",
  "slack_client_secret",
  "slack_bot_token",
  "github_app_private_key",
  "github_oauth_client_secret",
  "github_packages_token",
  "settings_credential",
] as const;
export const secretPurposeSchema = z.enum(SECRET_PURPOSE_VALUES);

export const SECRET_VALUE_MIN_LENGTH = 8;
export const SECRET_VALUE_MAX_LENGTH = 4096;
// Printable ASCII without spaces: Slack's tokens and secrets are, and a
// pasted newline or space would otherwise be stored as part of the value.
export const secretValueSchema = z
  .string()
  .min(SECRET_VALUE_MIN_LENGTH)
  .max(SECRET_VALUE_MAX_LENGTH)
  .regex(/^[\x21-\x7e]+$/, "must be printable ASCII without spaces");

export const putSlackSecretRequestSchema = z
  .object({ value: secretValueSchema })
  .strict();

export const slackSecretSummarySchema = z
  .object({
    configured: z.boolean(),
    last4: z.string().length(4).nullable(),
    updated_at: timestampSchema.nullable(),
    /** The console user who last set it; null once that account is gone. */
    updated_by: z
      .object({ user_id: userIdSchema, display_name: displayNameSchema })
      .strict()
      .nullable(),
  })
  .strict();

export const putSlackSecretResponseSchema = slackSecretSummarySchema
  .extend({ receipt_id: receiptIdSchema })
  .strict();

export const deleteSlackSecretResponseSchema = z
  .object({ receipt_id: receiptIdSchema })
  .strict();

export type SecretPurpose = z.infer<typeof secretPurposeSchema>;
export type SlackSecretSummary = z.infer<typeof slackSecretSummarySchema>;
export type PutSlackSecretResponse = z.infer<
  typeof putSlackSecretResponseSchema
>;
export type DeleteSlackSecretResponse = z.infer<
  typeof deleteSlackSecretResponseSchema
>;

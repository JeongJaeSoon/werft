import { z } from "zod";

import {
  receiptIdSchema,
  sha256HexSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";

// Skills a workspace registers, approves and attaches (decision
// skills-and-mcp.md 2–4, 7). A skill is one `SKILL.md` directory; each
// registration of new content is its next version. Every write comes from a
// signed-in console session, never an API key.

/** A skill tree holds at most 8 MiB; base64 and JSON framing add about a third. */
export const SKILL_UPLOAD_BODY_MAX_BYTES = 12 * 1024 * 1024;
export const SKILL_UPLOAD_FILES_MAX = 256;
export const SKILL_UPLOAD_PATH_MAX = 1024;

export const skillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, {
  message: "must be lowercase letters, digits and dashes, 1-64 characters",
});
export const skillVersionIdSchema = z.uuid();
export const skillReviewSchema = z.enum(["pending", "approved", "rejected"]);
export const skillAttachmentModeSchema = z.enum([
  "required",
  "optional",
  "forbidden",
]);

export const skillUploadFileSchema = z
  .object({
    path: z.string().min(1).max(SKILL_UPLOAD_PATH_MAX).meta({
      description:
        "The file's path inside the skill directory, `SKILL.md` at its root.",
    }),
    content_base64: z.base64(),
    executable: z.boolean().optional(),
  })
  .strict();

export const registerSkillRequestSchema = z
  .object({
    name: skillNameSchema.meta({
      description:
        "The skill's name: its directory and its `SKILL.md` frontmatter `name`.",
    }),
    files: z.array(skillUploadFileSchema).min(1).max(SKILL_UPLOAD_FILES_MAX),
  })
  .strict();
export type RegisterSkillRequest = z.infer<typeof registerSkillRequestSchema>;

export const skillVersionSchema = z
  .object({
    id: skillVersionIdSchema,
    name: skillNameSchema,
    version: z.number().int().positive().nullable().meta({
      description:
        "The registration order of this name: 1, 2, … Null on a bundle registered before skills, which no new version can join.",
    }),
    digest: sha256HexSchema,
    source: z.enum(["upload", "github"]),
    size_bytes: z.number().int().positive(),
    has_scripts: z.boolean(),
    review: skillReviewSchema,
    registered_by: userIdSchema,
    registered_at: timestampSchema,
    reviewed_by: userIdSchema.nullable(),
    reviewed_at: timestampSchema.nullable(),
    archived_at: timestampSchema.nullable(),
  })
  .strict();
export type SkillVersion = z.infer<typeof skillVersionSchema>;

export const skillWorkspaceAttachmentSchema = z
  .object({ version_id: skillVersionIdSchema, mode: skillAttachmentModeSchema })
  .strict();

export const skillSchema = z
  .object({
    name: skillNameSchema,
    versions: z.array(skillVersionSchema).meta({
      description: "Every version of the name, oldest first.",
    }),
    workspace_attachment: skillWorkspaceAttachmentSchema.nullable(),
  })
  .strict();
export type Skill = z.infer<typeof skillSchema>;

export const skillListSchema = z
  .object({ items: z.array(skillSchema) })
  .strict();
export type SkillList = z.infer<typeof skillListSchema>;

export const registerSkillResponseSchema = z
  .object({
    outcome: z.enum(["registered", "already_registered"]),
    version: skillVersionSchema,
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();
export type RegisterSkillResponse = z.infer<typeof registerSkillResponseSchema>;

export const skillVersionParamsSchema = z
  .object({ id: skillVersionIdSchema })
  .strict();
export const skillNameParamsSchema = z
  .object({ name: skillNameSchema })
  .strict();
export const agentSkillParamsSchema = z
  .object({ id: z.uuid(), name: skillNameSchema })
  .strict();

export const reviewSkillVersionRequestSchema = z
  .object({ decision: z.enum(["approved", "rejected"]) })
  .strict();
export type ReviewSkillVersionRequest = z.infer<
  typeof reviewSkillVersionRequestSchema
>;

export const skillVersionChangeResponseSchema = z
  .object({
    version: skillVersionSchema,
    receipt_id: receiptIdSchema.nullable().meta({
      description: "Null when the version already was in that state.",
    }),
  })
  .strict();
export type SkillVersionChangeResponse = z.infer<
  typeof skillVersionChangeResponseSchema
>;

export const putSkillAttachmentRequestSchema = z
  .object({ version_id: skillVersionIdSchema, mode: skillAttachmentModeSchema })
  .strict();
export type PutSkillAttachmentRequest = z.infer<
  typeof putSkillAttachmentRequestSchema
>;

export const skillAttachmentResponseSchema = z
  .object({
    name: skillNameSchema,
    scope: z.enum(["workspace", "agent"]),
    agent_id: z.uuid().nullable(),
    attachment: skillWorkspaceAttachmentSchema.nullable().meta({
      description:
        "The version and mode the scope now names; null once taken back.",
    }),
    receipt_id: receiptIdSchema.nullable().meta({
      description: "Null when nothing was attached to take back.",
    }),
  })
  .strict();
export type SkillAttachmentResponse = z.infer<
  typeof skillAttachmentResponseSchema
>;

export const agentSkillListSchema = z
  .object({
    items: z.array(
      z
        .object({
          name: skillNameSchema,
          scope: z.enum(["workspace", "agent"]),
          mode: skillAttachmentModeSchema,
          version: skillVersionSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type AgentSkillList = z.infer<typeof agentSkillListSchema>;

export const skillFileSchema = z
  .object({
    path: z.string(),
    executable: z.boolean(),
    size_bytes: z.number().int().nonnegative(),
    sha256: sha256HexSchema,
    text: z.string().nullable().meta({
      description: "The file as UTF-8 text; null for a binary file.",
    }),
    change: z.enum(["added", "changed", "unchanged"]).meta({
      description:
        "Against the previous approved version; every file is `added` when there is none.",
    }),
    diff: z.string().nullable().meta({
      description:
        "A unified line diff from the previous approved version for a changed text file; null otherwise, and when the change is too large to show.",
    }),
  })
  .strict();

export const skillVersionFilesSchema = z
  .object({
    version: skillVersionSchema,
    previous_approved: skillVersionSchema.nullable(),
    files: z.array(skillFileSchema).meta({
      description: "Every file of the stored tree, by path.",
    }),
    removed: z
      .array(
        z
          .object({
            path: z.string(),
            size_bytes: z.number().int().nonnegative(),
            sha256: sha256HexSchema,
          })
          .strict(),
      )
      .meta({
        description: "Files of the previous approved version this one drops.",
      }),
  })
  .strict();
export type SkillVersionFiles = z.infer<typeof skillVersionFilesSchema>;

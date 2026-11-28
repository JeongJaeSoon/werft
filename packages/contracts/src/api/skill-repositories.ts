import { z } from "zod";

import {
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import {
  githubRepositoryIdSchema,
  skillGitRefSchema,
  skillIssueSchema,
  skillNameSchema,
} from "./skills.ts";

// Skill repositories: a workspace registers a public GitHub repository, and
// registering is the approval. Every `SKILL.md` directory in it is listed,
// each switched off; nothing in this file turns one on.

export const SKILL_REPOSITORY_ACCESS_VALUES = [
  // A public repository, read with an installation of the workspace's App.
  "public",
] as const;
export type SkillRepositoryAccess =
  (typeof SKILL_REPOSITORY_ACCESS_VALUES)[number];

export const SKILL_REPOSITORY_TRIGGER_VALUES = [
  "register",
  "manual",
  "ref",
] as const;
export type SkillRepositoryTriggerKind =
  (typeof SKILL_REPOSITORY_TRIGGER_VALUES)[number];

export const SKILL_REPOSITORY_SYNC_RESULT_VALUES = [
  // The listing was read and written.
  "listed",
  "github_unavailable",
  // The repository, or its ref, is gone, or it is no longer public.
  "source_missing",
  // The tree is past what a listing reads; `issues` says which limit.
  "rejected",
] as const;
export type SkillRepositorySyncResult =
  (typeof SKILL_REPOSITORY_SYNC_RESULT_VALUES)[number];

export const SKILL_REPOSITORY_SKILL_STATUS_VALUES = [
  // Listed and switched off.
  "off",
  // The listing check refused it; `issues` says why.
  "unavailable",
  // Another skill of the workspace holds its name.
  "conflict",
] as const;
export type SkillRepositorySkillStatus =
  (typeof SKILL_REPOSITORY_SKILL_STATUS_VALUES)[number];

/** `https://github.com/<owner>/<name>`, with or without `.git` or a last slash. */
export const SKILL_REPOSITORY_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

export const registerSkillRepositoryRequestSchema = z
  .object({
    url: z.string().max(300).regex(SKILL_REPOSITORY_URL).meta({
      description:
        "The repository's address on github.com: `https://github.com/<owner>/<name>`.",
    }),
    ref: skillGitRefSchema.optional().meta({
      description:
        "A branch, a tag or a 40-character commit. Left out, the repository's default branch as it is named now.",
    }),
  })
  .strict();
export type RegisterSkillRepositoryRequest = z.infer<
  typeof registerSkillRepositoryRequestSchema
>;

export const putSkillRepositoryRefRequestSchema = z
  .object({ ref: skillGitRefSchema })
  .strict();
export type PutSkillRepositoryRefRequest = z.infer<
  typeof putSkillRepositoryRefRequestSchema
>;

export const skillRepositoryParamsSchema = z.object({ id: z.uuid() }).strict();

export const skillRepositorySyncSchema = z
  .object({
    at: timestampSchema,
    trigger: z
      .object({
        kind: z.enum(SKILL_REPOSITORY_TRIGGER_VALUES),
        user_id: userIdSchema.nullable(),
      })
      .strict(),
    commit: z.string().nullable().meta({
      description: "The commit the ref named; null when it was not resolved.",
    }),
    result: z.enum(SKILL_REPOSITORY_SYNC_RESULT_VALUES),
    issues: z.array(skillIssueSchema).meta({
      description: "Why the listing was refused; empty otherwise.",
    }),
  })
  .strict();

export const skillRepositorySchema = z
  .object({
    id: z.uuid(),
    repository_id: githubRepositoryIdSchema,
    /** `owner/name` when it was registered; the id is what is matched. */
    repository: z.string(),
    ref: z.string(),
    access: z.enum(SKILL_REPOSITORY_ACCESS_VALUES),
    /** The workspace's author App connection that reads it. */
    connection_id: z.uuid(),
    /** The installation whose access reads it; it need not cover the repository. */
    installation_id: z.number().int().positive(),
    owner_id: z.number().int().positive().meta({
      description: "The owning GitHub account's id when it was registered.",
    }),
    license: z.string().nullable().meta({
      description:
        "The repository's license as GitHub names it (an SPDX id) at the last listing; null when GitHub names none.",
    }),
    state: z.enum(["active", "removed"]).meta({
      description:
        "`removed`: its skills are withdrawn. Registering the same repository again brings the row back.",
    }),
    last_commit: z.string().nullable().meta({
      description: "The commit of the listing shown.",
    }),
    last_sync: skillRepositorySyncSchema.nullable(),
    skill_count: z.number().int().nonnegative().meta({
      description: "Skill directories the last listing found.",
    }),
    created_by: userIdSchema,
    created_at: timestampSchema,
    removed_by: userIdSchema.nullable(),
    removed_at: timestampSchema.nullable(),
  })
  .strict();
export type SkillRepositoryView = z.infer<typeof skillRepositorySchema>;

export const skillRepositorySkillSchema = z
  .object({
    id: z.uuid(),
    path: z.string().meta({
      description: "The directory holding `SKILL.md`; empty for the root.",
    }),
    name: skillNameSchema.nullable().meta({
      description:
        "The `SKILL.md` frontmatter `name`; null when it could not be read.",
    }),
    description: z.string().nullable(),
    license: z.string().nullable(),
    status: z.enum(SKILL_REPOSITORY_SKILL_STATUS_VALUES),
    issues: z.array(skillIssueSchema).meta({
      description:
        "What the listing check refused, from the tree's paths, modes and sizes and from `SKILL.md`; empty unless `unavailable`.",
    }),
    name_owner: z.enum(["upload", "github"]).nullable().meta({
      description:
        "The source of the workspace skill that holds this name; null when none does.",
    }),
    name_shared: z.boolean().meta({
      description:
        "Another listed directory, in this or another registered repository, reads the same name.",
    }),
    present: z.boolean().meta({
      description: "False once the directory is gone from the repository.",
    }),
    enabled: z.boolean(),
    tree_sha: z.string(),
    file_count: z.number().int().nonnegative(),
    size_bytes: z.number().int().nonnegative(),
    has_scripts: z.boolean().meta({
      description:
        "A file with an execute bit or without a document extension, as the tree names them.",
    }),
  })
  .strict();
export type SkillRepositorySkillView = z.infer<
  typeof skillRepositorySkillSchema
>;

export const skillRepositoryListSchema = z
  .object({ items: z.array(skillRepositorySchema) })
  .strict();
export type SkillRepositoryList = z.infer<typeof skillRepositoryListSchema>;

export const skillRepositoryDetailSchema = z
  .object({
    repository: skillRepositorySchema,
    skills: z.array(skillRepositorySkillSchema).meta({
      description: "Every skill directory listed, by path.",
    }),
  })
  .strict();
export type SkillRepositoryDetail = z.infer<typeof skillRepositoryDetailSchema>;

export const registerSkillRepositoryResponseSchema = skillRepositoryDetailSchema
  .extend({
    outcome: z.enum(["registered", "restored"]).meta({
      description:
        "`restored`: the repository was registered before and removed; the same row is active again, every skill switched off.",
    }),
    receipt_id: receiptIdSchema,
  })
  .strict();
export type RegisterSkillRepositoryResponse = z.infer<
  typeof registerSkillRepositoryResponseSchema
>;

export const removeSkillRepositoryResponseSchema = z
  .object({
    repository: skillRepositorySchema,
    receipt_id: receiptIdSchema.nullable().meta({
      description: "Null when it already was removed.",
    }),
  })
  .strict();
export type RemoveSkillRepositoryResponse = z.infer<
  typeof removeSkillRepositoryResponseSchema
>;

export const checkSkillRepositoryResponseSchema = skillRepositoryDetailSchema
  .extend({
    outcome: z.enum(["checked", "queued"]).meta({
      description:
        "`queued`: a listing of the repository was running, and the process that runs it reads once more when it ends. Should that process stop first, the queued request may be lost; checks answer `queued` until its hold (5 minutes) has passed, and one made after that reads the listing.",
    }),
  })
  .strict();
export type CheckSkillRepositoryResponse = z.infer<
  typeof checkSkillRepositoryResponseSchema
>;

export const putSkillRepositoryRefResponseSchema = skillRepositoryDetailSchema
  .extend({
    receipt_id: receiptIdSchema.nullable().meta({
      description: "Null when the repository already followed that ref.",
    }),
    check: z.enum(["checked", "queued"]).nullable().meta({
      description:
        "The listing this call ran at the new ref; null when the ref did not change.",
    }),
  })
  .strict();
export type PutSkillRepositoryRefResponse = z.infer<
  typeof putSkillRepositoryRefResponseSchema
>;

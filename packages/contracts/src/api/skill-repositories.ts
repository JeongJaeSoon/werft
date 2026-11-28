import { z } from "zod";

import {
  receiptIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import {
  githubRepositoryIdSchema,
  SKILL_CHECK_OUTCOME_VALUES,
  skillGitRefSchema,
  skillIssueSchema,
  skillNameSchema,
  skillVersionIdSchema,
} from "./skills.ts";

// Skill repositories: a workspace registers a public GitHub repository, and
// registering is the approval. Every `SKILL.md` directory in it is listed,
// each switched off. A manager switches a skill on; its content then passes
// the automatic gate before it is stored, and no person approves a version.

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
  // The daily pass.
  "daily",
  // A skill's switch turned on, by a person: that skill is checked.
  "enable",
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
  // Another account owns the repository than when it was registered. Nothing
  // of it is read until it is removed and registered again.
  "owner_changed",
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
  // Switched on, and not checked yet.
  "checking",
  // Switched on with a current version: an agent can be given it.
  "on",
  // Switched on with no current version; `last_check` says why.
  "failed",
] as const;
export type SkillRepositorySkillStatus =
  (typeof SKILL_REPOSITORY_SKILL_STATUS_VALUES)[number];

export const SKILL_REPOSITORY_CHECK_RESULT_VALUES = [
  // The content passed the gate, or is a version that already had: it is the
  // skill's current version.
  "passed",
  // The gate refused the content; `blocks` says by which rules. None of it
  // is stored.
  "blocked",
  // The checker refused the tree; `issues` says why.
  "rejected",
  // The directory is gone at that commit.
  "source_missing",
  "github_unavailable",
  // The gate or the secret scan gave no answer (busy, out of time, failed).
  // That is never a pass: the next check runs them again.
  "gate_unavailable",
  // The content is a version a manager rejected or archived: it stays out.
  "withheld",
  // Another version of the skill was approved or rejected while the gate
  // ran; the next check judges again.
  "baseline_changed",
  // Another skill of the workspace took the name first; the switch is off.
  "name_conflict",
] as const;
export type SkillRepositoryCheckResult =
  (typeof SKILL_REPOSITORY_CHECK_RESULT_VALUES)[number];

/**
 * `https://github.com/<owner>/<name>`, with or without `.git` or a last
 * slash. A name of `.` or `..` is a path step, never a repository.
 */
export const SKILL_REPOSITORY_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/(?!\.\.?(?:\.git)?\/?$)([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

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
export const skillRepositorySkillParamsSchema = z
  .object({ id: z.uuid(), skill_id: z.uuid() })
  .strict();

export const putSkillRepositorySkillSwitchRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export type PutSkillRepositorySkillSwitchRequest = z.infer<
  typeof putSkillRepositorySkillSwitchRequestSchema
>;

const skillRepositoryTriggerSchema = z
  .object({
    kind: z.enum(SKILL_REPOSITORY_TRIGGER_VALUES),
    user_id: userIdSchema.nullable(),
  })
  .strict();

export const skillGateFindingSchema = z
  .object({
    rule: z.string().meta({
      description:
        "The gate rule: `file_type`, `hidden_override` or `secret` among `blocks`; `hidden_unicode`, `instruction_like`, `host_not_allowlisted`, `network_call`, `license_missing`, `license_unclassified` or `license_notice_missing` among `warnings`; `license_changed` or `binary_added` among `notices`. A later version may name more.",
    }),
    paths: z.array(z.string()).meta({
      description: "Up to 20 stored-tree paths the rule matched.",
    }),
    samples: z.array(z.string()).meta({
      description:
        "Up to 20 values of at most 200 characters: hosts, code points (`U+202E`), matched rule ids. Never a matched secret.",
    }),
  })
  .strict();
export type SkillGateFindingView = z.infer<typeof skillGateFindingSchema>;

export const skillRepositorySkillCheckSchema = z
  .object({
    at: timestampSchema,
    trigger: skillRepositoryTriggerSchema,
    commit: z.string().nullable().meta({
      description: "The commit the content was read at; null when none was.",
    }),
    result: z.enum(SKILL_REPOSITORY_CHECK_RESULT_VALUES),
    version_id: skillVersionIdSchema.nullable().meta({
      description:
        "The version the content is, when it is one (`passed`, `withheld`); null otherwise.",
    }),
    issues: z.array(skillIssueSchema).meta({
      description: "Why the checker refused the tree; empty unless `rejected`.",
    }),
    blocks: z.array(skillGateFindingSchema).meta({
      description:
        "The rules that refused the content; empty unless `blocked`.",
    }),
    warnings: z.array(skillGateFindingSchema).meta({
      description:
        "What the gate found and let through, in what changed since the approved version before it.",
    }),
    notices: z.array(skillGateFindingSchema),
  })
  .strict();
export type SkillRepositorySkillCheckView = z.infer<
  typeof skillRepositorySkillCheckSchema
>;

export const skillRepositorySyncSchema = z
  .object({
    at: timestampSchema,
    trigger: skillRepositoryTriggerSchema,
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
        "What the listing check refused, from the tree's paths, modes and sizes and from `SKILL.md`; a skill with any cannot be switched on.",
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
    enabled: z.boolean().meta({
      description:
        "The switch. On, the skill is checked at once and by the daily pass; its current version, once it has one, is what agents can be given.",
    }),
    current_version_id: skillVersionIdSchema.nullable().meta({
      description:
        "The skill's current version; null while it has none, and for a directory that holds no skill of the workspace.",
    }),
    last_check: skillRepositorySkillCheckSchema.nullable().meta({
      description:
        "The last check of the content since the switch was last turned on; null before the first. Anything but `passed` beside a current version means the update is held back and that version stays.",
    }),
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
    outcome: z.enum(SKILL_CHECK_OUTCOME_VALUES).meta({
      description:
        "`queued`: a check of the repository was running, and the process that runs it reads once more when it ends. Should that process stop first, or fail to start that read, the queued request may be lost; checks answer `queued` until its hold (5 minutes) has passed, and one made after that, or the daily pass, reads it. `lease_lost`: another process took the repository over before this check had written everything.",
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
    check: z.enum(SKILL_CHECK_OUTCOME_VALUES).nullable().meta({
      description:
        "The check this call ran at the new ref; null when the ref did not change.",
    }),
  })
  .strict();
export type PutSkillRepositoryRefResponse = z.infer<
  typeof putSkillRepositoryRefResponseSchema
>;

export const putSkillRepositorySkillSwitchResponseSchema =
  skillRepositoryDetailSchema
    .extend({
      receipt_id: receiptIdSchema.nullable().meta({
        description: "Null when the switch already was in that state.",
      }),
      check: z.enum(SKILL_CHECK_OUTCOME_VALUES).nullable().meta({
        description:
          "The check turning the switch on ran; the skill's `last_check` holds its result. Null when the call turned it off or changed nothing.",
      }),
    })
    .strict();
export type PutSkillRepositorySkillSwitchResponse = z.infer<
  typeof putSkillRepositorySkillSwitchResponseSchema
>;

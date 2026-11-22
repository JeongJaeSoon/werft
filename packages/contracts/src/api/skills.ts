import { z } from "zod";

import {
  receiptIdSchema,
  sha256HexSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import { REQUEST_BODY_MAX_BYTES } from "./session.ts";

// Skills a workspace registers, approves and attaches. A skill is one `SKILL.md` directory; each
// registration of new content is its next version. Every write comes from a
// signed-in console session, never an API key.

/**
 * The API server's transport cap, which Bun applies to every route alike and
 * which it receives in full even when a handler refuses unread: raising it for
 * one route would raise it for unauthenticated ones too. A stored tree may
 * still hold 8 MiB; larger uploads need a path of their own.
 */
export const SKILL_UPLOAD_BODY_MAX_BYTES = REQUEST_BODY_MAX_BYTES * 2;
/** A stored tree holds 256 files, one of them the manifest the platform adds. */
export const SKILL_UPLOAD_FILES_MAX = 255;
export const SKILL_UPLOAD_PATH_MAX = 1024;

export const skillNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, {
  message: "must be lowercase letters, digits and dashes, 1-64 characters",
});
export const skillVersionIdSchema = z.uuid();
export const skillReviewSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "superseded",
]);
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

// A skill from GitHub:
// its source is fixed by its first registration, and every later version
// comes from one check that resolves the ref again through the API.

export const SKILL_SYNC_TRIGGER_VALUES = [
  // The first registration, by a person.
  "register",
  "webhook",
  "daily",
  // "지금 확인", by a person.
  "manual",
  // Turning sync back on checks once, by a person.
  "resume",
] as const;
export const skillSyncTriggerKindSchema = z.enum(SKILL_SYNC_TRIGGER_VALUES);
export type SkillSyncTriggerKind = z.infer<typeof skillSyncTriggerKindSchema>;

export const SKILL_SYNC_RESULT_VALUES = [
  // A new `pending` version.
  "created",
  // The content is a version the skill already has.
  "unchanged",
  // The ref or the path is gone.
  "source_missing",
  // The checker refused the tree; `issues` says why.
  "rejected",
  // GitHub did not answer, refused the App, or the App connection is gone.
  "github_unavailable",
  // Sync was paused while GitHub was read; nothing was written.
  "paused",
] as const;
export const skillSyncResultSchema = z.enum(SKILL_SYNC_RESULT_VALUES);
export type SkillSyncResult = z.infer<typeof skillSyncResultSchema>;

export const gitCommitSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const githubRepositoryIdSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const skillSyncTriggerSchema = z
  .object({
    kind: skillSyncTriggerKindSchema,
    /** The webhook delivery (`X-GitHub-Delivery`); null for other kinds. */
    delivery_id: z.string().nullable(),
    /** The person who registered, pressed or resumed; null for the sync. */
    user_id: userIdSchema.nullable(),
  })
  .strict();
export type SkillSyncTrigger = z.infer<typeof skillSyncTriggerSchema>;

export const skillGitVersionSchema = z
  .object({
    repository_id: githubRepositoryIdSchema,
    path: z.string(),
    ref: z.string(),
    commit: gitCommitSchema,
    trigger: skillSyncTriggerSchema,
  })
  .strict();

export const skillIssueSchema = z
  .object({ path: z.string(), code: z.string(), message: z.string() })
  .strict();

export const SKILL_AUTO_APPROVAL_REASON_VALUES = [
  // The ref is a tag or a commit.
  "not_branch",
  // No rule on the branch requires a pull request with an approving review.
  "protection_missing",
  // The commit came in by no merged pull request whose reviews approve it.
  "no_reviewed_pull_request",
  // GitHub did not answer.
  "github_unreachable",
  // The version failed a fixed-rule check; `checks` says which.
  "checks_failed",
  // Another version was approved while the checks ran; a person reviews.
  "baseline_changed",
] as const;
export const skillAutoApprovalReasonSchema = z.enum(
  SKILL_AUTO_APPROVAL_REASON_VALUES,
);
export type SkillAutoApprovalReason = z.infer<
  typeof skillAutoApprovalReasonSchema
>;

export const SKILL_CHECK_RULE_VALUES = [
  // A file under `scripts/`, with the execute bit or not a document, that the approved version did not run.
  "scripts_added",
  // More than 300 changed text lines, or a change too large to diff.
  "large_change",
  // An added line names a URL host no file of the approved version does.
  "new_url",
  // Control (a NUL included), zero-width, bidi or tag characters in an added line or a new path.
  "hidden_unicode",
  // An added line reads as an instruction to the agent (ignore instructions, send credentials, hide from the user).
  "instruction_like",
  // The `SKILL.md` description, which decides when the skill is used, changed.
  "description_changed",
] as const;
export const skillCheckRuleSchema = z.enum(SKILL_CHECK_RULE_VALUES);
export type SkillCheckRule = z.infer<typeof skillCheckRuleSchema>;

export const skillCheckFindingSchema = z
  .object({
    rule: skillCheckRuleSchema,
    /** Up to 20 stored-tree paths that fail it. */
    paths: z.array(z.string()),
    /**
     * Up to 20 values: the new hosts, the hidden code points (`U+200B`), the
     * matched sentence ids, or the changed line count (`too_large`).
     */
    samples: z.array(z.string()),
  })
  .strict();
export type SkillCheckFinding = z.infer<typeof skillCheckFindingSchema>;

export const skillProtectionRuleSchema = z
  .object({
    kind: z.enum(["ruleset", "branch_protection"]),
    required_reviews: z.number().int().positive(),
  })
  .strict();

export const skillAutoApprovalSchema = z
  .object({
    result: z.enum(["approved", "pending"]),
    /** Why it stayed `pending`; null once approved. */
    reason: skillAutoApprovalReasonSchema.nullable(),
    /** The rule that required review; null when none was found. */
    rule: skillProtectionRuleSchema.nullable(),
    pull_request: z.number().int().positive().nullable(),
    checks: z.array(skillCheckFindingSchema).meta({
      description:
        "The fixed-rule checks the version failed against the approved version before it; empty when it failed none or was not checked.",
    }),
  })
  .strict();

export const skillSyncCheckSchema = z
  .object({
    at: timestampSchema,
    trigger: skillSyncTriggerSchema,
    /** What the ref resolved to; null when it did not resolve. */
    commit: gitCommitSchema.nullable(),
    result: skillSyncResultSchema,
    /** The version the content is (`created`, `unchanged`); null otherwise. */
    version_id: skillVersionIdSchema.nullable(),
    issues: z.array(skillIssueSchema).meta({
      description: "Why the checker refused the tree; empty otherwise.",
    }),
    auto_approval: skillAutoApprovalSchema.nullable().meta({
      description:
        "How the new version's auto-approval went (`created` with auto-approve on); null otherwise.",
    }),
  })
  .strict();
export type SkillSyncCheck = z.infer<typeof skillSyncCheckSchema>;

export const SKILL_WEBHOOK_STATE_VALUES = [
  // GitHub can call this installation, and the App's secret is stored.
  "ready",
  // The installation has no address GitHub reaches: daily checks only.
  "no_public_url",
  // The App connection has no webhook secret stored, or is gone.
  "no_secret",
] as const;

export const skillGitSourceSchema = z
  .object({
    /** The workspace's author App connection that reads it. */
    connection_id: z.uuid(),
    installation_id: z.number().int().positive(),
    repository_id: githubRepositoryIdSchema,
    /** `owner/name` when it was registered; the id is what is matched. */
    repository: z.string(),
    path: z.string(),
    ref: z.string(),
    sync_enabled: z.boolean(),
    webhook: z.enum(SKILL_WEBHOOK_STATE_VALUES),
    auto_approve: z
      .object({
        state: z.enum(["off", "requested", "on"]),
        requested_by: userIdSchema.nullable(),
        consented_by: userIdSchema.nullable(),
      })
      .strict()
      .meta({
        description:
          "Protected-branch auto-approve: one manager requests, another consents.",
      }),
    last_check: skillSyncCheckSchema.nullable(),
  })
  .strict();
export type SkillGitSource = z.infer<typeof skillGitSourceSchema>;

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
    /** Where a GitHub version was read; null for an upload. */
    git: skillGitVersionSchema.nullable(),
    size_bytes: z.number().int().positive(),
    has_scripts: z.boolean(),
    review: skillReviewSchema.meta({
      description:
        "`superseded`: it was still `pending` when a newer version was approved or made current, so it no longer waits for review. A manager can still approve or reject it.",
    }),
    registered_by: userIdSchema.nullable().meta({
      description:
        "Who registered it; null for a version the Git sync made (`git.trigger` says what started it).",
    }),
    registered_at: timestampSchema,
    reviewed_by: userIdSchema.nullable().meta({
      description:
        "Who reviewed it; null while `pending`, and on a version the sync approved under auto-approve. On a `superseded` version, who approved or made current the newer one; null when the sync's auto-approve did, and on one the upgrade to migration 0306 closed.",
    }),
    reviewed_at: timestampSchema.nullable(),
    archived_at: timestampSchema.nullable(),
    current: z.boolean().meta({
      description:
        "The skill's current version: what a following attachment uses in a new session.",
    }),
  })
  .strict();
export type SkillVersion = z.infer<typeof skillVersionSchema>;

export const skillWorkspaceAttachmentSchema = z
  .object({
    version_id: skillVersionIdSchema.nullable().meta({
      description:
        "The version named; for a following attachment the current version, null while there is none.",
    }),
    follows: z.boolean(),
    mode: skillAttachmentModeSchema,
  })
  .strict();

export const skillSchema = z
  .object({
    name: skillNameSchema,
    /** Fixed by the first registration: a GitHub skill takes no upload. */
    source: z.enum(["upload", "github"]),
    /** The repository, path and ref and how its sync stands; null for an upload skill. */
    git: skillGitSourceSchema.nullable(),
    /** Versions waiting for review (not archived). */
    pending_count: z.number().int().nonnegative(),
    versions: z.array(skillVersionSchema).meta({
      description: "Every version of the name, oldest first.",
    }),
    workspace_attachment: skillWorkspaceAttachmentSchema.nullable(),
  })
  .strict();
export type Skill = z.infer<typeof skillSchema>;

const gitPathSegment = /^(?!\.{1,2}$)[^/\0]+$/;
export const skillGitPathSchema = z
  .string()
  .max(SKILL_UPLOAD_PATH_MAX)
  .refine(
    (path) =>
      path === "" ||
      path.split("/").every((segment) => gitPathSegment.test(segment)),
    {
      message:
        "must be a directory in the repository without leading or trailing slashes, `.` or `..`; empty for its root",
    },
  );

export const registerGitHubSkillRequestSchema = z
  .object({
    name: skillNameSchema.meta({
      description:
        "The skill's name; the `SKILL.md` at `path` must carry it as its frontmatter `name`.",
    }),
    repository: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
      .meta({ description: "`owner/name` on GitHub." }),
    path: skillGitPathSchema.meta({
      description:
        "The skill directory, holding `SKILL.md`; empty for the repository root.",
    }),
    ref: z
      .string()
      .min(1)
      .max(255)
      .regex(/^(?!\/)(?!.*\/$)(?!.*\.\.)[^\s~^:?*[\\\0]+$/)
      .meta({
        description:
          "A branch, a tag or a 40-character commit. A commit never moves, so it is never synced.",
      }),
    connection_id: z.uuid().optional().meta({
      description:
        "The author App connection that reads it; may be left out while the workspace has one.",
    }),
  })
  .strict();
export type RegisterGitHubSkillRequest = z.infer<
  typeof registerGitHubSkillRequestSchema
>;

export const putSkillSyncRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export type PutSkillSyncRequest = z.infer<typeof putSkillSyncRequestSchema>;

export const skillSyncResponseSchema = z
  .object({
    name: skillNameSchema,
    git: skillGitSourceSchema,
    receipt_id: receiptIdSchema.nullable().meta({
      description: "Null when sync already was in that state.",
    }),
  })
  .strict();
export type SkillSyncResponse = z.infer<typeof skillSyncResponseSchema>;

export const checkSkillResponseSchema = z
  .object({
    outcome: z.enum(["checked", "queued"]).meta({
      description:
        "`queued`: a check of the skill was running, and it runs once more when it ends.",
    }),
    last_check: skillSyncCheckSchema.nullable(),
  })
  .strict();
export type CheckSkillResponse = z.infer<typeof checkSkillResponseSchema>;

/** What GitHub is answered: the checks it starts run after the answer. */
export const githubWebhookResponseSchema = z
  .object({ accepted: z.literal(true) })
  .strict();

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

export const putSkillAttachmentRequestSchema = z.union([
  z
    .object({
      version_id: skillVersionIdSchema,
      mode: skillAttachmentModeSchema,
    })
    .strict(),
  z
    .object({
      follow: z.literal(true).meta({
        description:
          "Follow the skill's current version: each new session takes the one current when it starts.",
      }),
      mode: z.enum(["required", "optional"]),
    })
    .strict(),
]);
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
          follows: z.boolean(),
          version: skillVersionSchema.nullable().meta({
            description:
              "The version named; for a following attachment the current version, null while there is none.",
          }),
        })
        .strict(),
    ),
  })
  .strict();
export type AgentSkillList = z.infer<typeof agentSkillListSchema>;

export const putSkillAutoApproveRequestSchema = z
  .object({
    action: z.enum(["request", "consent", "off"]).meta({
      description:
        "`request` and `consent` are by two managers (one, when the workspace has one); `off` turns it off at once.",
    }),
  })
  .strict();
export type PutSkillAutoApproveRequest = z.infer<
  typeof putSkillAutoApproveRequestSchema
>;

export const revertSkillResponseSchema = z
  .object({
    name: skillNameSchema,
    from: skillVersionSchema,
    to: skillVersionSchema,
    receipt_id: receiptIdSchema,
  })
  .strict();
export type RevertSkillResponse = z.infer<typeof revertSkillResponseSchema>;

export const skillFileSchema = z
  .object({
    path: z.string().meta({
      description:
        "The path in the stored tree (`skills/<name>/…`), which also holds the manifest the platform adds.",
    }),
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
        "A unified line diff from the previous approved version for a text file whose content changed; null otherwise (an execute bit alone shows in `executable`), and when the change is too large to show.",
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
    checks: z.array(skillCheckFindingSchema).meta({
      description:
        "The fixed-rule checks this version fails against `previous_approved`, one per rule; empty when it fails none. Shown to the reviewer; they never approve or reject.",
    }),
  })
  .strict();
export type SkillVersionFiles = z.infer<typeof skillVersionFilesSchema>;

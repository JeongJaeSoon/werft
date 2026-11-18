import { z } from "zod";

import {
  agentIdSchema,
  agentReleaseIdSchema,
  receiptIdSchema,
  sessionIdSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";
import { GITHUB_REVIEW_EVENT_VALUES } from "./github-work.ts";
import { GITHUB_PULL_REQUEST_OUTCOME_STATE_VALUES } from "./session-outcome.ts";

/**
 * What the platform itself sees a session do. Fixed in code: adding one
 * takes code and a migration (docs/contributing/decisions/achievement-rules.md §3).
 */
export const ACHIEVEMENT_EVIDENCE_KIND_VALUES = [
  "github_pull_request",
  "github_review",
  "out_file",
  "conversation",
] as const;

/** Read from GitHub rather than written by the agent, so it counts without a person confirming it. */
export const AUTO_REVIEWED_EVIDENCE_KIND_VALUES = [
  "github_pull_request",
  "github_review",
] as const satisfies readonly (typeof ACHIEVEMENT_EVIDENCE_KIND_VALUES)[number][];

/** `always` counts without asking the judge; `luna` asks it. */
export const ACHIEVEMENT_RULE_JUDGE_VALUES = ["always", "luna"] as const;

/** Non-archived types per workspace. */
export const ACHIEVEMENT_TYPE_LIMIT = 50;
/** Rules in use (latest version, not disabled) per workspace. */
export const ACHIEVEMENT_RULE_LIMIT = 30;

export const ACHIEVEMENT_CATEGORY_NAME_MAX = 32;
export const ACHIEVEMENT_TYPE_NAME_MAX = 40;
export const ACHIEVEMENT_RULE_TITLE_MAX = 80;
export const ACHIEVEMENT_RULE_DEFINITION_MAX = 2_000;
export const ACHIEVEMENT_TYPE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

export const achievementEvidenceKindSchema = z.enum(
  ACHIEVEMENT_EVIDENCE_KIND_VALUES,
);
export const achievementRuleJudgeSchema = z.enum(ACHIEVEMENT_RULE_JUDGE_VALUES);

/** Every workspace has these, from its creation or from the migration. */
export const BUILTIN_ACHIEVEMENT_TYPES = [
  {
    key: "pull_request",
    name: "GitHub PR",
    evidence_kind: "github_pull_request",
  },
  { key: "code_review", name: "코드 리뷰", evidence_kind: "github_review" },
  { key: "document", name: "문서", evidence_kind: "out_file" },
] as const satisfies readonly {
  key: string;
  name: string;
  evidence_kind: (typeof ACHIEVEMENT_EVIDENCE_KIND_VALUES)[number];
}[];

// A stored position is any integer column value; one set by hand stays well
// under it, so a new category can always go after the last.
const positionSchema = z.number().int().min(0).max(2_147_483_647);
const positionRequestSchema = z.number().int().min(0).max(1_000_000);
export const achievementCategoryNameSchema = z
  .string()
  .min(1)
  .max(ACHIEVEMENT_CATEGORY_NAME_MAX);
export const achievementTypeKeySchema = z
  .string()
  .regex(ACHIEVEMENT_TYPE_KEY_PATTERN);
export const achievementTypeNameSchema = z
  .string()
  .min(1)
  .max(ACHIEVEMENT_TYPE_NAME_MAX);
export const achievementRuleTitleSchema = z
  .string()
  .min(1)
  .max(ACHIEVEMENT_RULE_TITLE_MAX);
export const achievementRuleDefinitionSchema = z
  .string()
  .min(1)
  .max(ACHIEVEMENT_RULE_DEFINITION_MAX);
/**
 * What a client sends for a name, title or definition: the ends trimmed, so
 * whitespace alone is refused and `A` and `A ` are one name. Stored values
 * read through the untrimmed schema, as they were written.
 */
const trimmedInput = (max: number) => z.string().trim().min(1).max(max);

export const achievementCategorySchema = z
  .object({
    id: z.uuid(),
    name: achievementCategoryNameSchema,
    position: positionSchema,
    created_by: userIdSchema,
    created_at: timestampSchema,
    archived_at: timestampSchema.nullable(),
    archived_by: userIdSchema.nullable(),
  })
  .strict();

export const achievementTypeSchema = z
  .object({
    id: z.uuid(),
    key: achievementTypeKeySchema,
    name: achievementTypeNameSchema,
    evidence_kind: achievementEvidenceKindSchema,
    builtin: z.boolean(),
    /** Null for a built-in type. */
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    archived_at: timestampSchema.nullable(),
    archived_by: userIdSchema.nullable(),
  })
  .strict();

export const achievementRuleSchema = z
  .object({
    id: z.uuid(),
    family_id: z.uuid(),
    version: z.number().int().positive(),
    category_id: z.uuid(),
    title: achievementRuleTitleSchema,
    type_id: z.uuid(),
    definition: achievementRuleDefinitionSchema,
    judge: achievementRuleJudgeSchema,
    /** Null: every agent. */
    agent_ids: z.array(agentIdSchema).nullable(),
    created_by: userIdSchema,
    created_at: timestampSchema,
    superseded_by: z.uuid().nullable(),
    disabled_at: timestampSchema.nullable(),
    disabled_by: userIdSchema.nullable(),
  })
  .strict();

export const listAchievementCategoriesResponseSchema = z
  .object({ items: z.array(achievementCategorySchema) })
  .strict();
export const listAchievementTypesResponseSchema = z
  .object({ items: z.array(achievementTypeSchema) })
  .strict();
export const listAchievementRulesResponseSchema = z
  .object({ items: z.array(achievementRuleSchema) })
  .strict();

export const createAchievementCategoryRequestSchema = z
  .object({ name: trimmedInput(ACHIEVEMENT_CATEGORY_NAME_MAX) })
  .strict();
export const updateAchievementCategoryRequestSchema = z
  .object({
    name: trimmedInput(ACHIEVEMENT_CATEGORY_NAME_MAX).optional(),
    position: positionRequestSchema.optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.position !== undefined, {
    message: "name or position is required",
  });

export const createAchievementTypeRequestSchema = z
  .object({
    key: achievementTypeKeySchema,
    name: trimmedInput(ACHIEVEMENT_TYPE_NAME_MAX),
    evidence_kind: achievementEvidenceKindSchema,
  })
  .strict();
/** Only the name changes; `key` and `evidence_kind` are fixed. */
export const updateAchievementTypeRequestSchema = z
  .object({ name: trimmedInput(ACHIEVEMENT_TYPE_NAME_MAX) })
  .strict();

/** The whole rule: a new version replaces every field. */
export const achievementRuleRequestSchema = z
  .object({
    category_id: z.uuid(),
    title: trimmedInput(ACHIEVEMENT_RULE_TITLE_MAX),
    type_id: z.uuid(),
    definition: trimmedInput(ACHIEVEMENT_RULE_DEFINITION_MAX),
    judge: achievementRuleJudgeSchema,
    agent_ids: z.null().default(null),
  })
  .strict();

export const achievementCategoryParamsSchema = z
  .object({ id: z.uuid() })
  .strict();
export const achievementTypeParamsSchema = achievementCategoryParamsSchema;
export const achievementRuleFamilyParamsSchema = z
  .object({ family_id: z.uuid() })
  .strict();

/** `receipt_id` is null when nothing changed (archiving the archived). */
export const achievementCategoryChangeResponseSchema = z
  .object({
    category: achievementCategorySchema,
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();
export const achievementTypeChangeResponseSchema = z
  .object({
    type: achievementTypeSchema,
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();
export const achievementRuleChangeResponseSchema = z
  .object({
    rule: achievementRuleSchema,
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

export type AchievementEvidenceKind = z.infer<
  typeof achievementEvidenceKindSchema
>;
export type AchievementRuleJudge = z.infer<typeof achievementRuleJudgeSchema>;
export type AchievementCategory = z.infer<typeof achievementCategorySchema>;
export type AchievementType = z.infer<typeof achievementTypeSchema>;
export type AchievementRule = z.infer<typeof achievementRuleSchema>;
export type ListAchievementCategoriesResponse = z.infer<
  typeof listAchievementCategoriesResponseSchema
>;
export type ListAchievementTypesResponse = z.infer<
  typeof listAchievementTypesResponseSchema
>;
export type ListAchievementRulesResponse = z.infer<
  typeof listAchievementRulesResponseSchema
>;
export type CreateAchievementCategoryRequest = z.infer<
  typeof createAchievementCategoryRequestSchema
>;
export type UpdateAchievementCategoryRequest = z.infer<
  typeof updateAchievementCategoryRequestSchema
>;
export type CreateAchievementTypeRequest = z.infer<
  typeof createAchievementTypeRequestSchema
>;
export type UpdateAchievementTypeRequest = z.infer<
  typeof updateAchievementTypeRequestSchema
>;
export type AchievementRuleRequest = z.infer<
  typeof achievementRuleRequestSchema
>;
export type AchievementCategoryChangeResponse = z.infer<
  typeof achievementCategoryChangeResponseSchema
>;
export type AchievementTypeChangeResponse = z.infer<
  typeof achievementTypeChangeResponseSchema
>;
export type AchievementRuleChangeResponse = z.infer<
  typeof achievementRuleChangeResponseSchema
>;

/** What queued a judgment (achievement-rules.md §4). */
export const ACHIEVEMENT_JUDGMENT_TRIGGER_VALUES = [
  "evidence",
  "turns",
  "idle",
  "manual",
] as const;

/** `deferred` waits for the next day's budget; `skipped` had no judge. */
export const ACHIEVEMENT_JUDGMENT_STATUS_VALUES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "deferred",
  "skipped",
] as const;
/** At most one per session; a newer trigger folds into it. */
export const PENDING_ACHIEVEMENT_JUDGMENT_STATUSES = [
  "queued",
  "deferred",
] as const satisfies readonly (typeof ACHIEVEMENT_JUDGMENT_STATUS_VALUES)[number][];
export const UNFINISHED_ACHIEVEMENT_JUDGMENT_STATUSES = [
  "queued",
  "running",
  "deferred",
] as const satisfies readonly (typeof ACHIEVEMENT_JUDGMENT_STATUS_VALUES)[number][];

export const ACHIEVEMENT_JUDGE_BACKEND_VALUES = ["luna"] as const;

/** Why a judgment did not judge every rule and evidence pair it had. */
export const ACHIEVEMENT_JUDGMENT_ERROR_VALUES = [
  "judge_unavailable",
  "outputs_unavailable",
  "session_limit",
  /** The judge refused a pair; it is not an achievement and is not asked again. */
  "judge_refused",
  /** The last try's call: no answer within 10 seconds. */
  "judge_timeout",
  /** The last try's call: an error status, or the judge was not reached. */
  "judge_http_error",
  /** The last try's call: an answer of another shape. */
  "judge_bad_response",
] as const;

/** `auto` counts at once; `needs_review` counts once a person confirms it. */
export const ACHIEVEMENT_REVIEW_STATE_VALUES = [
  "auto",
  "needs_review",
  "confirmed",
  "rejected",
] as const;

export const achievementJudgmentTriggerSchema = z.enum(
  ACHIEVEMENT_JUDGMENT_TRIGGER_VALUES,
);
export const achievementJudgmentStatusSchema = z.enum(
  ACHIEVEMENT_JUDGMENT_STATUS_VALUES,
);
export const achievementJudgmentErrorSchema = z.enum(
  ACHIEVEMENT_JUDGMENT_ERROR_VALUES,
);
export const achievementReviewStateSchema = z.enum(
  ACHIEVEMENT_REVIEW_STATE_VALUES,
);

/** `owner/repo`, as an achievement's title names it. */
const repositoryNameSchema = z.string().regex(/^[^/\s]+\/[^/\s]+$/);

// A built-in type's payload, copied by code from the evidence.
export const pullRequestAchievementPayloadSchema = z
  .object({
    repository: repositoryNameSchema,
    number: z.number().int().positive(),
    url: z.url(),
    state: z.enum(GITHUB_PULL_REQUEST_OUTCOME_STATE_VALUES),
    merged_at: timestampSchema.nullable(),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const codeReviewAchievementPayloadSchema = z
  .object({
    repository: repositoryNameSchema,
    number: z.number().int().positive(),
    url: z.url(),
    event: z.enum(GITHUB_REVIEW_EVENT_VALUES),
    commit_id: z.string().min(1),
  })
  .strict();
export const documentAchievementPayloadSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
  })
  .strict();

/** By built-in type key; a type a person made has no payload. */
export const BUILTIN_ACHIEVEMENT_PAYLOAD_SCHEMAS = {
  pull_request: pullRequestAchievementPayloadSchema,
  code_review: codeReviewAchievementPayloadSchema,
  document: documentAchievementPayloadSchema,
} as const satisfies Record<
  (typeof BUILTIN_ACHIEVEMENT_TYPES)[number]["key"],
  z.ZodType
>;

export const achievementPayloadSchema = z.union([
  pullRequestAchievementPayloadSchema,
  codeReviewAchievementPayloadSchema,
  documentAchievementPayloadSchema,
]);

export const sessionAchievementSchema = z
  .object({
    id: z.uuid(),
    session_id: sessionIdSchema,
    agent_id: agentIdSchema.nullable(),
    agent_release_id: agentReleaseIdSchema.nullable(),
    /** The rule version that counted it, and that version's type. */
    rule_id: z.uuid(),
    rule_family_id: z.uuid(),
    type_id: z.uuid(),
    title: z.string().min(1),
    link: z.string().min(1),
    evidence_kind: achievementEvidenceKindSchema,
    /** Null for `conversation`. */
    evidence_id: z.string().min(1).nullable(),
    /** Null for a type a person made. */
    payload: achievementPayloadSchema.nullable(),
    judge: achievementRuleJudgeSchema,
    /** The rule version's title and number, and its type's key. */
    rule_title: achievementRuleTitleSchema,
    rule_version: z.number().int().positive(),
    type_key: achievementTypeKeySchema,
    /** Null for `always`. */
    probability: z.number().min(0).max(1).nullable(),
    /** The threshold its judgment asked against; null when it asked none. */
    threshold: z.number().min(0).max(1).nullable(),
    /**
     * Pull request evidence counted by a judgment after its merge, in a
     * session judged before the merge too.
     */
    rejudged_after_merge: z.boolean(),
    judgment_id: z.uuid(),
    review_state: achievementReviewStateSchema,
    reviewed_by: userIdSchema.nullable(),
    reviewed_at: timestampSchema.nullable(),
    review_note: z.string().nullable(),
    created_at: timestampSchema,
  })
  .strict();

export const ACHIEVEMENT_EVIDENCE_CHANGE_VALUES = ["pr_merged"] as const;

export const achievementJudgmentSchema = z
  .object({
    id: z.uuid(),
    trigger: achievementJudgmentTriggerSchema,
    status: achievementJudgmentStatusSchema,
    error_code: achievementJudgmentErrorSchema.nullable(),
    /**
     * `pr_merged`: an `evidence` judgment whose session had a pull request
     * merge since the judgment before it.
     */
    evidence_change: z.enum(ACHIEVEMENT_EVIDENCE_CHANGE_VALUES).nullable(),
    created_at: timestampSchema,
    finished_at: timestampSchema.nullable(),
  })
  .strict();

export const listSessionAchievementsResponseSchema = z
  .object({
    /** Those in force, oldest first. */
    items: z.array(sessionAchievementSchema),
    /** The session's latest judgment; null before its first. */
    judgment: achievementJudgmentSchema.nullable(),
    /** The session's finished judgments, and what their calls cost. */
    judgment_count: z.number().int().nonnegative(),
    judge_cost_usd: z.number().nonnegative(),
  })
  .strict();

export const ACHIEVEMENT_REVIEW_ACTION_VALUES = ["confirm", "reject"] as const;
export const ACHIEVEMENT_REVIEW_NOTE_MAX = 500;

export const achievementParamsSchema = z.object({ id: z.uuid() }).strict();

/** `confirm` counts a `needs_review` achievement; `reject` drops one not yet decided. */
export const reviewAchievementRequestSchema = z
  .object({
    action: z.enum(ACHIEVEMENT_REVIEW_ACTION_VALUES),
    note: z.string().min(1).max(ACHIEVEMENT_REVIEW_NOTE_MAX).optional(),
  })
  .strict();

export const reviewAchievementResponseSchema = z
  .object({
    achievement: sessionAchievementSchema,
    receipt_id: receiptIdSchema,
  })
  .strict();

export type ReviewAchievementRequest = z.infer<
  typeof reviewAchievementRequestSchema
>;
export type ReviewAchievementResponse = z.infer<
  typeof reviewAchievementResponseSchema
>;

/** The judgment the session's manual rejudge queued, or merged into. */
export const rejudgeSessionResponseSchema = z
  .object({
    judgment_id: z.uuid(),
    receipt_id: receiptIdSchema,
  })
  .strict();

export type RejudgeSessionResponse = z.infer<
  typeof rejudgeSessionResponseSchema
>;
export type AchievementJudgmentTrigger = z.infer<
  typeof achievementJudgmentTriggerSchema
>;
export type AchievementJudgmentStatus = z.infer<
  typeof achievementJudgmentStatusSchema
>;
export type AchievementJudgmentError = z.infer<
  typeof achievementJudgmentErrorSchema
>;
export type AchievementReviewState = z.infer<
  typeof achievementReviewStateSchema
>;
export type AchievementPayload = z.infer<typeof achievementPayloadSchema>;
export type SessionAchievement = z.infer<typeof sessionAchievementSchema>;
export type AchievementJudgment = z.infer<typeof achievementJudgmentSchema>;
export type ListSessionAchievementsResponse = z.infer<
  typeof listSessionAchievementsResponseSchema
>;

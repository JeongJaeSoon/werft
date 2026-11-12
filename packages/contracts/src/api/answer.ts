import { z } from "zod";
import { surfaceKindSchema } from "../kollegium/surfaces.ts";
import { receiptActorSchema } from "../musterrolle/authorization.ts";
import { requestIdSchema } from "../shared/index.ts";
import type { PendingQuestion } from "./pending.ts";
import { receiptAcceptedResponseSchema } from "./receipt.ts";

export const PERMISSION_ANSWER_ACTIONS = ["allow", "deny"] as const;
const permissionActionSchema = z.enum(PERMISSION_ANSWER_ACTIONS);

/**
 * One permission rule the engine proposed to remember for the session: the
 * tool, and the part of its input the rule matches when it has one. A rule
 * the engine would add is always an allow; anything else is dropped before
 * it is offered.
 */
export const rememberRuleSchema = z
  .object({
    tool_name: z.string().min(1),
    rule_content: z.string().min(1).optional(),
  })
  .strict();

/** `session`: the engine process keeps the rule until it ends. */
export const rememberSchema = z.literal("session");

const REMEMBER_NEEDS_ALLOW = "Only an allow can be remembered for the session";

/**
 * A permission answer as stored and handed to the worker. The stored key
 * stays `decision`; the API takes `action` (`postSessionAnswerInputSchema`).
 */
export const permissionAnswerSchema = z
  .object({
    request_id: requestIdSchema,
    kind: z.literal("permission"),
    decision: permissionActionSchema,
    /** Optional even on a denial; the worker tells the model it was denied. */
    reason: z.string().min(1).optional(),
    /**
     * Allow, and keep allowing the rules the request offered until the
     * session's engine ends. Only with `allow`, and only for a request that
     * offered rules; a worker that does not announce `approval_remember`
     * is handed the answer without it.
     */
    remember: rememberSchema.optional(),
  })
  .strict()
  .refine(
    (answer) => answer.remember === undefined || answer.decision === "allow",
    { message: REMEMBER_NEEDS_ALLOW, path: ["remember"] },
  );

const permissionAnswerFields = {
  request_id: requestIdSchema,
  kind: z.literal("permission"),
  reason: z.string().min(1).optional(),
  remember: rememberSchema.optional(),
};

/** A permission answer from the API. */
export const permissionAnswerInputSchema = z
  .object({ ...permissionAnswerFields, action: permissionActionSchema })
  .strict()
  .refine(
    (answer) => answer.remember === undefined || answer.action === "allow",
    { message: REMEMBER_NEEDS_ALLOW, path: ["remember"] },
  );

export const questionAnswerSchema = z
  .object({
    question_id: z.string().min(1),
    selected_option_ids: z.array(z.string().min(1)),
    free_text: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (answer) =>
      answer.selected_option_ids.length > 0 || answer.free_text !== undefined,
    "An answer needs a selected option or free text",
  );

export const questionsAnswerSchema = z
  .object({
    request_id: requestIdSchema,
    kind: z.literal("question"),
    answers: z.array(questionAnswerSchema).min(1),
  })
  .strict()
  .superRefine((answer, context) => {
    const ids = new Set<string>();
    for (const [index, item] of answer.answers.entries()) {
      if (ids.has(item.question_id)) {
        context.addIssue({
          code: "custom",
          message: "Question IDs must be unique",
          path: ["answers", index, "question_id"],
        });
      }
      ids.add(item.question_id);
    }
  });

/**
 * Why an answer cannot stand for the questions asked, or null when it can:
 * exactly one answer per question, only options that question offered, one
 * of them unless it is multi-select, and free text only where allowed. The
 * server refuses on it and the worker checks it again before acting, since
 * a partial or made-up answer would let the engine act on something nobody
 * chose.
 */
export function questionAnswerMismatch(
  questions: PendingQuestion[],
  answers: QuestionAnswer[],
): string | null {
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = questions.find(
      (candidate) => candidate.question_id === answer.question_id,
    );
    if (question === undefined) {
      return `No question ${answer.question_id} was asked`;
    }
    if (seen.has(answer.question_id)) {
      return `Question ${answer.question_id} was answered twice`;
    }
    seen.add(answer.question_id);
    const selected = new Set(answer.selected_option_ids);
    if (selected.size !== answer.selected_option_ids.length) {
      return `Question ${answer.question_id} selects an option twice`;
    }
    for (const id of selected) {
      if (!question.options.some((option) => option.option_id === id)) {
        return `Question ${answer.question_id} has no option ${id}`;
      }
    }
    if (!question.multi_select && selected.size > 1) {
      return `Question ${answer.question_id} takes one option`;
    }
    if (answer.free_text !== undefined && !question.allow_free_text) {
      return `Question ${answer.question_id} takes no free text`;
    }
  }
  const missing = questions.find((question) => !seen.has(question.question_id));
  return missing === undefined
    ? null
    : `Question ${missing.question_id} was not answered`;
}

export const postSessionAnswerRequestSchema = z.discriminatedUnion("kind", [
  permissionAnswerSchema,
  questionsAnswerSchema,
]);
/** The body of `POST /v1/sessions/{id}/answers`. */
export const postSessionAnswerInputSchema = z.discriminatedUnion("kind", [
  permissionAnswerInputSchema,
  questionsAnswerSchema,
]);

/** The stored form of an API answer, so either name hashes the same. */
export function storedAnswer(
  input: PostSessionAnswerInput,
): PostSessionAnswerRequest {
  if (input.kind !== "permission") return input;
  const { action, ...rest } = input;
  return { ...rest, decision: action };
}
/**
 * Who answered, from where, and the `session.approve` decision that let them.
 * `answered_by` is null for a principal with no recorded actor.
 */
export const approvalRecordSchema = z
  .object({
    answered_by: receiptActorSchema.nullable(),
    surface: surfaceKindSchema,
    decision_id: z.uuid(),
  })
  .strict();
/**
 * `approval` is absent only when replaying an answer stored before it
 * existed; `resumed` and `waiting_for` likewise, and from a server older than
 * them.
 */
export const postSessionAnswerResponseSchema =
  receiptAcceptedResponseSchema.extend({
    approval: approvalRecordSchema.optional(),
    resumed: z.boolean().optional().meta({
      description:
        "Whether this answer resumed a parked session: it closed the last open request of the parked turn's group, and the session went `resuming`. False for an answer to a turn still waiting, which the worker hands over as before.",
    }),
    waiting_for: z.number().int().nonnegative().optional().meta({
      description:
        "How many requests of the same group are still neither answered nor expired. A parked turn resumes when this reaches 0.",
    }),
  });

export type PendingRememberRule = z.infer<typeof rememberRuleSchema>;
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;
export type PostSessionAnswerRequest = z.infer<
  typeof postSessionAnswerRequestSchema
>;
export type PostSessionAnswerInput = z.infer<
  typeof postSessionAnswerInputSchema
>;
export type PostSessionAnswerResponse = z.infer<
  typeof postSessionAnswerResponseSchema
>;

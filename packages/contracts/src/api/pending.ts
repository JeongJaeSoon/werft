import { z } from "zod";
import {
  attemptIdSchema,
  requestIdSchema,
  requiredUnknownSchema,
  timestampSchema,
  turnIdSchema,
} from "../shared/index.ts";
import { TOOL_VERB_VALUES } from "./present-action.ts";

export const pendingQuestionOptionSchema = z.object({
  option_id: z.string().min(1),
  label: z.string().min(1),
});
export const pendingQuestionSchema = z.object({
  question_id: z.string().min(1),
  prompt: z.string().min(1),
  options: z.array(pendingQuestionOptionSchema),
  multi_select: z.boolean(),
  allow_free_text: z.boolean(),
});

const pendingRequestBase = {
  request_id: requestIdSchema,
  turn_id: turnIdSchema,
  attempt_id: attemptIdSchema,
  created_at: timestampSchema,
  expires_at: timestampSchema,
  // The three below are absent from a server older than them: read that as
  // a live wait that never parks.
  state: z.enum(["waiting", "parked"]).optional().meta({
    description:
      "`waiting`: the turn that asked is still open on it. `parked`: that turn stopped with its checkpoint and the session is paused; an answer before `expires_at` still counts, whichever worker asked, and resumes the turn once its group is closed.",
  }),
  park_at: timestampSchema.nullable().optional().meta({
    description:
      "When the platform parks the turn if this is still unanswered. Null when it does not park: it waits for its worker until it expires.",
  }),
  group: turnIdSchema.optional().meta({
    description:
      "The turn the request was asked in, as `turn_id`: a parked turn resumes once every request of its group is answered or expired, and they expire together.",
  }),
};
// presentPendingRequest's result: message keys, not text; each surface words them.
export const toolRequestPresentationSchema = z.object({
  verb: z.object({
    key: z.enum(TOOL_VERB_VALUES.map((name) => `action.tool.${name}` as const)),
    params: z.record(z.string(), z.string()).optional(),
  }),
  target: z.string().nullable(),
  excerpt: z.string().nullable(),
});
export const pendingRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    ...pendingRequestBase,
    kind: z.literal("permission"),
    tool: z.string().min(1),
    input: requiredUnknownSchema,
    // Absent from a server older than it: show the raw input alone.
    summary: toolRequestPresentationSchema.optional().meta({
      description:
        "What the tool does and to what, as message keys (`presentPendingRequest`): the same line a Slack card shows over the raw `input`.",
    }),
  }),
  z.object({
    ...pendingRequestBase,
    kind: z.literal("question"),
    questions: z.array(pendingQuestionSchema).min(1),
  }),
]);
export const listPendingRequestsResponseSchema = z.object({
  items: z.array(pendingRequestSchema),
  answerable: z.boolean().meta({
    description:
      "Whether this caller may answer the session's requests: its creator, its agent's admins and the workspace's owners and admins may; someone who only sees it through its share may not (POST /answers is then 403). A hint for what to offer; the answer is judged again.",
  }),
});

export type PendingQuestionOption = z.infer<typeof pendingQuestionOptionSchema>;
export type PendingQuestion = z.infer<typeof pendingQuestionSchema>;
export type PendingRequest = z.infer<typeof pendingRequestSchema>;
export type ListPendingRequestsResponse = z.infer<
  typeof listPendingRequestsResponseSchema
>;

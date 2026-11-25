import { z } from "zod";

import { conversationInputIdSchema } from "./conversation.ts";

/**
 * A task session's fields (v2.4 4-1). A session from before them, and a
 * standalone one, has none: every field is optional on the row.
 */

/** Why a task closed. The same four a session link closes with. */
export const TASK_CLOSED_REASONS = [
  "completed",
  "cancelled",
  "failed",
  "abandoned",
] as const;
export const taskClosedReasonSchema = z.enum(TASK_CLOSED_REASONS);
export type TaskClosedReason = z.infer<typeof taskClosedReasonSchema>;

/** Slack's own cap on a message's text. */
const REQUEST_TEXT_MAX = 40_000;
const INTERPRETATION_TEXT_MAX = 4_000;

/**
 * The requester's message the task was opened from, as they wrote it, and
 * the input that names its place. Attached by the server, never taken from
 * the model (G6). Part of the task session's record: kept and erased with
 * it, unlike a turn input that keeps only the place.
 */
export const taskRequestSchema = z.strictObject({
  inputId: conversationInputIdSchema,
  text: z.string().max(REQUEST_TEXT_MAX),
});
export type TaskRequest = z.infer<typeof taskRequestSchema>;

/**
 * What the agent made of the request: the goal, when it is done, and the
 * limits it works within. Written from the model's result; it has no place
 * for the requester's text.
 */
export const taskInterpretationSchema = z.strictObject({
  goal: z.string().trim().min(1).max(INTERPRETATION_TEXT_MAX),
  doneWhen: z.string().trim().min(1).max(INTERPRETATION_TEXT_MAX),
  limits: z.strictObject({
    turns: z.int().positive(),
    hours: z.int().positive(),
  }),
});
export type TaskInterpretation = z.infer<typeof taskInterpretationSchema>;

/**
 * The closing rules a task was opened under, fixed by the server then: a
 * later change to the defaults leaves an open task on its own. The model
 * never writes them.
 */
export const taskClosingSchema = z.strictObject({
  /** Whether events close it: its pull request merged or closed. */
  eventRules: z.boolean(),
  /** Days without activity after which it closes as abandoned. */
  idleDays: z.int().positive(),
  /** Days without an answer, once it reached its limits, after which it closes. */
  quietAfterLimitDays: z.int().positive(),
});
export type TaskClosing = z.infer<typeof taskClosingSchema>;

/** The closing rules a task opens under today (decision 24). */
export const TASK_CLOSING_DEFAULT: TaskClosing = {
  eventRules: true,
  idleDays: 14,
  quietAfterLimitDays: 7,
};

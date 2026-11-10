import { z } from "zod";

import { revisionSchema, turnIdSchema } from "../shared/index.ts";
import { receiptAcceptedResponseSchema } from "./receipt.ts";
import { admissionStateSchema, terminalTurnStatusSchema } from "./session.ts";

export const RECOVERY_DECISION_VALUES = [
  "abandon",
  "confirm_completed",
  "close",
  "start_fresh",
  "retry_restore",
] as const;
export const recoveryDecisionSchema = z.enum(RECOVERY_DECISION_VALUES);

export const interruptSessionRequestSchema = z
  .object({ target_turn_id: turnIdSchema })
  .strict();
export const pauseSessionRequestSchema = z
  .object({
    expected_revision: revisionSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();
export const terminateSessionRequestSchema = pauseSessionRequestSchema;
export const closeSessionRequestSchema = pauseSessionRequestSchema;
export const resumeSessionRequestSchema = z
  .object({ expected_revision: revisionSchema })
  .strict();
const recoveryDecisionBase = {
  expected_revision: revisionSchema,
  reason: z.string().min(1),
};
export const recoveryDecisionRequestSchema = z.discriminatedUnion("decision", [
  z
    .object({
      ...recoveryDecisionBase,
      decision: z.literal("abandon"),
      target_turn_id: turnIdSchema,
    })
    .strict(),
  z
    .object({
      ...recoveryDecisionBase,
      decision: z.literal("confirm_completed"),
      target_turn_id: turnIdSchema,
      evidence_ref: z.string().min(1),
    })
    .strict(),
  z.object({ ...recoveryDecisionBase, decision: z.literal("close") }).strict(),
  // Continue a session whose context cannot be restored on a new
  // engine session that does not remember the turns before it. Nothing is
  // restored, the checkpoints so far are retired, and queued input runs.
  z
    .object({ ...recoveryDecisionBase, decision: z.literal("start_fresh") })
    .strict(),
  // Restore the same checkpoint again on a session its failed restores
  // stopped, once what made them fail is fixed. The
  // failure count starts over and queued input runs.
  z
    .object({ ...recoveryDecisionBase, decision: z.literal("retry_restore") })
    .strict(),
]);
export const controlAcceptedResponseSchema = receiptAcceptedResponseSchema;
// The 202 itself says that a kill undoes nothing the execution already did
// outside; the receipt repeats it once the kill is observed.
export const terminateSessionResponseSchema = receiptAcceptedResponseSchema
  .extend({ external_effects_reverted: z.literal(false) })
  .strict();
// What an interrupt receipt settles with: the terminal the target turn
// actually reached. `no_op` is true when that terminal was not the
// interrupt's doing — the turn had already ended when it was asked, or ended
// on its own first — and false for `interrupted` and for `outcome_unknown`
// reached while it was pending, where nobody can say.
export const interruptReceiptResultSchema = z.object({
  turn_id: turnIdSchema,
  terminal: terminalTurnStatusSchema,
  no_op: z.boolean(),
});
// The receipt result of a recovery decision (api.md § recovery 결정 후
// 상태). `resumable` is false whenever the session has no committed
// checkpoint at all: a resume would then be refused CHECKPOINT_UNAVAILABLE.
export const recoveryDecisionResultSchema = z.object({
  resulting_admission_state: admissionStateSchema,
  checkpoint_revision: revisionSchema.nullable(),
  resumable: z.boolean(),
});
// What a pause settles with once its execution is observed gone: the
// checkpoint the session will be restored from, and the input still waiting
// for it. Queued input is never cancelled by a pause.
export const pauseReceiptResultSchema = z.object({
  resulting_admission_state: z.literal("paused"),
  checkpoint_revision: revisionSchema.nullable(),
  queued_turn_count: z.number().int().nonnegative(),
});
// What a close settles with once the session is closed. checkpoint_revision
// is null only for a session that never ran a turn; cancelled_turn_count is
// the queued input the close cancelled.
export const closeReceiptResultSchema = z.object({
  resulting_admission_state: z.literal("closed"),
  checkpoint_revision: revisionSchema.nullable(),
  cancelled_turn_count: z.number().int().nonnegative(),
});
// What a resume commits. From `stopped` it is written at acceptance and the
// next worker restores this revision. From `paused` it is written once the
// new worker reports that it restored it. A resume that cancels a pause
// still draining writes the pointer as it stands, which may be none yet.
export const resumeReceiptResultSchema = z.object({
  resulting_admission_state: admissionStateSchema,
  checkpoint_revision: revisionSchema.nullable(),
  queued_turn_count: z.number().int().nonnegative(),
});

export type RecoveryDecision = z.infer<typeof recoveryDecisionSchema>;
export type InterruptSessionRequest = z.infer<
  typeof interruptSessionRequestSchema
>;
export type PauseSessionRequest = z.infer<typeof pauseSessionRequestSchema>;
export type TerminateSessionRequest = z.infer<
  typeof terminateSessionRequestSchema
>;
export type CloseSessionRequest = z.infer<typeof closeSessionRequestSchema>;
export type ResumeSessionRequest = z.infer<typeof resumeSessionRequestSchema>;
export type RecoveryDecisionRequest = z.infer<
  typeof recoveryDecisionRequestSchema
>;
export type ControlAcceptedResponse = z.infer<
  typeof controlAcceptedResponseSchema
>;
export type TerminateSessionResponse = z.infer<
  typeof terminateSessionResponseSchema
>;
export type InterruptReceiptResult = z.infer<
  typeof interruptReceiptResultSchema
>;
export type RecoveryDecisionResult = z.infer<
  typeof recoveryDecisionResultSchema
>;
export type PauseReceiptResult = z.infer<typeof pauseReceiptResultSchema>;
export type CloseReceiptResult = z.infer<typeof closeReceiptResultSchema>;
export type ResumeReceiptResult = z.infer<typeof resumeReceiptResultSchema>;

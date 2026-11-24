import { z } from "zod";

export const healthResponseSchema = z.object({ status: z.literal("ok") });
// Each readiness check the API performs; a 503 names the failing one in
// error.details.check.
export const READINESS_CHECK_VALUES = ["database", "schema", "config"] as const;
export const readinessCheckSchema = z.enum(READINESS_CHECK_VALUES);
// What a ready instance still wants an operator to know; a key is left out
// when it has nothing to say, and `detail` with it when no key is left.
export const readyDetailSchema = z.object({
  // Sessions whose checkpoints a start gave up on an emptied object store
  // (CHECKPOINT_OBJECTS_LOST=forget), until an administrator closes the notice.
  checkpoints_forgotten_on_boot: z.number().int().positive().optional(),
});
export const readyResponseSchema = z.object({
  status: z.literal("ready"),
  checks: z.record(readinessCheckSchema, z.literal("ok")),
  detail: readyDetailSchema.optional(),
});
export const apiRootResponseSchema = z
  .object({
    status: z.literal("ok"),
    owner_id: z.string().min(1),
  })
  .strict();

export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;
export type ReadyDetail = z.infer<typeof readyDetailSchema>;

import { z } from "zod";

export const healthResponseSchema = z.object({ status: z.literal("ok") });
// Each readiness check the API performs; a 503 names the failing one in
// error.details.check.
export const READINESS_CHECK_VALUES = ["database", "schema", "config"] as const;
export const readinessCheckSchema = z.enum(READINESS_CHECK_VALUES);
export const readyResponseSchema = z.object({
  status: z.literal("ready"),
  checks: z.record(readinessCheckSchema, z.literal("ok")),
});
export const apiRootResponseSchema = z
  .object({
    status: z.literal("ok"),
    owner_id: z.string().min(1),
  })
  .strict();

export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

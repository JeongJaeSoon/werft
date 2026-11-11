import { z } from "zod";

import {
  revisionSchema,
  sessionIdParamsSchema,
  sessionIdSchema,
  sha256HexSchema,
} from "../shared/index.ts";

export const OUTPUT_OMITTED_VALUES = ["too_large"] as const;

/**
 * A file the session left under `out/`, as its latest committed checkpoint
 * lists it. An omitted file was over the output limits: it is listed so a
 * person learns it exists, but its bytes were never stored.
 */
export const sessionOutputSchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: sha256HexSchema.nullable(),
  omitted: z.enum(OUTPUT_OMITTED_VALUES).nullable(),
});

export const listSessionOutputsResponseSchema = z.object({
  session_id: sessionIdSchema,
  // Null while the session has no committed checkpoint; `items` is then empty.
  checkpoint_revision: revisionSchema.nullable(),
  items: z.array(sessionOutputSchema),
});

export const sessionOutputParamsSchema = sessionIdParamsSchema.extend({
  path: z.string().min(1).max(4096),
});

export type ListSessionOutputsResponse = z.infer<
  typeof listSessionOutputsResponseSchema
>;

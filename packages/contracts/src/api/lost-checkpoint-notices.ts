import { z } from "zod";
import { timestampSchema } from "../shared/index.ts";

/**
 * One start at which the API gave up the checkpoints an emptied object store
 * held (CHECKPOINT_OBJECTS_LOST=forget, test installations on LocalStack).
 */
export const lostCheckpointNoticeSchema = z.object({
  id: z.uuid(),
  forgotten_at: timestampSchema,
  /** Sessions whose checkpoints that start gave up. */
  sessions: z.number().int().positive(),
});

/** As many as one read answers and one close takes. */
export const LOST_CHECKPOINT_NOTICES_MAX = 100;

/**
 * The notices nobody has closed yet, oldest first. Past the limit the rest
 * follow once these are closed.
 */
export const lostCheckpointNoticesSchema = z.object({
  notices: z.array(lostCheckpointNoticeSchema).max(LOST_CHECKPOINT_NOTICES_MAX),
});
export type LostCheckpointNotices = z.infer<typeof lostCheckpointNoticesSchema>;

/**
 * The notices the administrator saw, by id: a start that happened after they
 * were read stays open.
 */
export const closeLostCheckpointNoticesRequestSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(LOST_CHECKPOINT_NOTICES_MAX),
  })
  .strict();
export type CloseLostCheckpointNoticesRequest = z.infer<
  typeof closeLostCheckpointNoticesRequestSchema
>;

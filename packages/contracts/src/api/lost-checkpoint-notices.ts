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

/** Every notice nobody has closed yet, oldest first. */
export const lostCheckpointNoticesSchema = z.object({
  notices: z.array(lostCheckpointNoticeSchema),
});
export type LostCheckpointNotices = z.infer<typeof lostCheckpointNoticesSchema>;

/** As many ids as one close takes; a longer list goes in several. */
export const LOST_CHECKPOINT_NOTICES_CLOSE_MAX = 100;

/**
 * The notices the administrator saw, by id: a start that happened after they
 * were read stays open.
 */
export const closeLostCheckpointNoticesRequestSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(LOST_CHECKPOINT_NOTICES_CLOSE_MAX),
  })
  .strict();
export type CloseLostCheckpointNoticesRequest = z.infer<
  typeof closeLostCheckpointNoticesRequestSchema
>;

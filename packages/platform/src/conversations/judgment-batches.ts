import {
  type ConversationId,
  type ConversationInputId,
  type ConversationTopicId,
  type JudgmentBatchId,
  M1_JUDGMENTS_PER_HOUR_DEFAULT,
} from "@werft-ai/contracts";

/** A batch closes once its channel has been quiet this long (decision 24). */
export const JUDGMENT_BATCH_QUIET_MS = 15_000;
/** ...or once its oldest message has waited this long, however the talk goes on. */
export const JUDGMENT_BATCH_MAX_WAIT_MS = 60_000;
/**
 * A judging batch not ended by then is taken as failed: its judge died. Past
 * a judgment's 60 seconds, so a slow one is not ended under it.
 */
export const JUDGMENT_BATCH_DEADLINE_MS = 120_000;

/**
 * M1's cap per agent and channel: at most this many batch judgments in the
 * sliding window just past (Architect Q1). What counts is in
 * `countsAgainstM1Cap` of packages/db judgment-batches.ts: a batch that
 * called the model, or may have (judging, or failed), and the
 * `m1_engaged` replies' judgments that did (J5). Those of bound threads'
 * replies do not count (Q2).
 */
export const M1_CHANNEL_WINDOW_MS = 60 * 60_000;
/** A channel whose binding is gone has the starting cap. */
export const M1_JUDGMENTS_PER_CHANNEL_WINDOW = M1_JUDGMENTS_PER_HOUR_DEFAULT;

/** One buffered message as a batch carries it, its text as of the close. */
export type JudgmentBatchInput = {
  inputId: ConversationInputId;
  topicId: ConversationTopicId;
  ts: string;
  slackUserId: string;
  body: string;
  receivedAt: Date;
  /** When `body` became the message's text by an edit; unset: never edited. */
  editedAt?: Date | null;
  /** Its edit mark as the close read it (marked_at); null for none. */
  editMark: string | null;
};

export type JudgmentBatch = {
  id: JudgmentBatchId;
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  teamId: string;
  channelId: string;
  /** The agent's active release at the close (an agent_releases id). */
  releaseId: string;
  /** Oldest first. */
  inputs: JudgmentBatchInput[];
  /**
   * The database's time once the channel's marks in progress at the close
   * were done: a context message marked since is one the judgment may not
   * have read (a1/J6). The close's time when not given.
   */
  readAt?: string;
};

export type ClosedJudgmentBatch =
  // To judge: the channel's one judging batch until it ends.
  | { outcome: "judging"; batch: JudgmentBatch }
  // Past the channel's cap: no judgment now. Its messages stay buffered and
  // go to the first batch the window has room for, or expire unjudged.
  | { outcome: "rate_limited"; batch: JudgmentBatch };

/** What a judgment did, as the judge reports it. */
export type JudgmentBatchResult = {
  /** Whether the model was called; a batch stopped before it does not count. */
  modelCalled: boolean;
  /**
   * Messages the judgment left out (the context's size): to the next batch.
   * A judgment that took none of its batch fails it instead.
   */
  left: readonly ConversationInputId[];
  /**
   * Stopped before the model by a cause that clears by itself (the channel's
   * concurrency cap): every message goes to a later batch, and this run
   * judges no more, so the channel is not closed again at once.
   */
  deferred?: true;
};

export interface JudgmentBatchStore {
  /**
   * Closes the next channel that is due and not taken by another caller, or
   * returns null when none is. `now` unset: the database clock.
   */
  closeNext(options?: { now?: Date }): Promise<ClosedJudgmentBatch | null>;
  /** "late" when the batch had already been ended as failed. */
  finish(
    id: JudgmentBatchId,
    result: JudgmentBatchResult,
    options?: { now?: Date },
  ): Promise<"finished" | "late">;
  /** Ends a judging batch as failed; its messages wait for the buffer's end. */
  fail(id: JudgmentBatchId, options?: { now?: Date }): Promise<void>;
}

/** M1's judge (a1/J5). */
export interface JudgmentBatchJudge {
  judge(batch: JudgmentBatch): Promise<JudgmentBatchResult>;
  /** A batch past the cap, for its record; no model call. */
  rateLimited(batch: JudgmentBatch): Promise<void>;
}

export type JudgmentBatchRun = {
  judged: number;
  rateLimited: number;
  failed: number;
};

/**
 * Closes and judges the channels that are due, one at a time, until none is
 * or `deadline` (epoch ms) passes. A judge that throws fails its batch.
 */
export async function runJudgmentBatches(deps: {
  store: JudgmentBatchStore;
  judge: JudgmentBatchJudge;
  logger: {
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  };
  deadline: number;
  now?: () => Date;
  clock?: () => number;
}): Promise<JudgmentBatchRun> {
  const clock = deps.clock ?? Date.now;
  const at = () => (deps.now === undefined ? {} : { now: deps.now() });
  const run: JudgmentBatchRun = { judged: 0, rateLimited: 0, failed: 0 };
  while (clock() < deps.deadline) {
    const closed = await deps.store.closeNext(at());
    if (closed === null) break;
    const { batch } = closed;
    if (closed.outcome === "rate_limited") {
      run.rateLimited += 1;
      try {
        await deps.judge.rateLimited(batch);
      } catch (error) {
        deps.logger.warn("Rate-limited judgment batch not recorded", {
          batch_id: batch.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    let result: JudgmentBatchResult;
    try {
      result = await deps.judge.judge(batch);
    } catch (error) {
      run.failed += 1;
      await deps.store.fail(batch.id, at());
      deps.logger.warn("Judgment batch failed", {
        batch_id: batch.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const left = new Set(result.left);
    if (
      result.deferred !== true &&
      batch.inputs.every((input) => left.has(input.inputId))
    ) {
      // Taking none of it, the next close would carry the same batch at
      // once: failed, its messages expire unjudged.
      run.failed += 1;
      await deps.store.fail(batch.id, at());
      deps.logger.warn("Judgment batch left out whole", {
        batch_id: batch.id,
        left_count: result.left.length,
      });
      continue;
    }
    if ((await deps.store.finish(batch.id, result, at())) === "late") {
      run.failed += 1;
      deps.logger.warn("Judgment batch ended past its deadline", {
        batch_id: batch.id,
      });
      continue;
    }
    run.judged += 1;
    if (result.deferred === true) break;
  }
  return run;
}

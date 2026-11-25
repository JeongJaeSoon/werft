import type {
  ConversationInputId,
  ConversationJudgmentId,
  M1SummaryOutcome,
} from "@werft-ai/contracts";
import { startPolling } from "../polling.ts";
import type {
  ChannelSummaryWriteResult,
  NewChannelSummaryLine,
} from "../ports/channel-summary-store.ts";
import {
  type JudgmentBatch,
  type JudgmentBatchJudge,
  type JudgmentBatchStore,
  runJudgmentBatches,
} from "./judgment-batches.ts";
import {
  copiesMessage,
  type M1Judge,
  type M1Post,
  type M1Record,
  type M1Subject,
  type M1SummaryDraft,
  m1NotCalled,
  summaryTextFits,
} from "./m1-judge.ts";

/** The channel a judgment is in. */
export type M1Place = {
  workspaceId: string;
  agentId: string;
  teamId: string;
  channelId: string;
};

/** A reply waiting for its judgment, taken by one judge. */
export type ClaimedReplyJudgment = {
  id: ConversationJudgmentId;
  subject: M1Subject;
  /** Past the channel's M1 cap (counted for `m1_engaged` alone): no call. */
  rateLimited: boolean;
};

/**
 * Where M1's records go. Each write asks the switch, the notice approval and
 * the channel's sharing again, under the agent's row: closed, nothing is
 * written.
 */
export interface M1JudgmentStore {
  /** Asked right before each call. */
  gateOpen(place: M1Place): Promise<boolean>;
  /**
   * Adds a batch judgment's line to its channel's summary if the summary is
   * at `expectedVersion`, in a transaction of its own under the gate;
   * `gate_closed`, writing nothing, when the gate has closed;
   * `channel_gone` when any agent's binding of the channel is gone, as a
   * delete of the channel removes the summary every agent shares.
   */
  writeSummaryLine(
    batch: JudgmentBatch,
    line: NewChannelSummaryLine & { expectedVersion: number },
  ): Promise<
    | ChannelSummaryWriteResult
    | { outcome: "gate_closed" }
    | { outcome: "channel_gone" }
  >;
  /**
   * Writes a batch's record and removes the buffered messages it judged;
   * false, writing and removing nothing, when the gate has closed.
   */
  recordBatch(
    batch: JudgmentBatch,
    record: M1Record,
    judged: readonly ConversationInputId[],
  ): Promise<boolean>;
  /**
   * Gives up the replies that waited past the buffer's time or whose judge
   * died, then takes the oldest waiting one; null when none waits.
   */
  claimReply(options?: { now?: Date }): Promise<ClaimedReplyJudgment | null>;
  /**
   * Writes a reply's record, or drops its row when `record` is null or the
   * gate has closed; a held reply's text goes either way.
   */
  finishReply(
    id: ConversationJudgmentId,
    record: M1Record | null,
  ): Promise<"written" | "dropped">;
}

const subjectOfBatch = (batch: JudgmentBatch): M1Subject => ({
  grade: "buffer_m1",
  workspaceId: batch.workspaceId,
  agentId: batch.agentId,
  conversationId: batch.conversationId,
  teamId: batch.teamId,
  channelId: batch.channelId,
  topicId: null,
  key: batch.id,
  posts: batch.inputs.map(
    (input): M1Post => ({
      inputId: input.inputId,
      ts: input.ts,
      body: input.body,
      receivedAt: input.receivedAt,
      editedAt: input.editedAt ?? null,
      sources: [
        {
          inputId: input.inputId,
          slack: {
            teamId: batch.teamId,
            channelId: batch.channelId,
            ts: input.ts,
          },
        },
      ],
    }),
  ),
});

/** Writes a summary line tries at most this many times (a1/J8). */
export const M1_SUMMARY_WRITE_ATTEMPTS = 3;

/**
 * Adds a batch judgment's summary line (a1/J8): not one that copies a
 * message the call read; on a lost version compare, again on the version
 * the loss names, adding only this line, up to M1_SUMMARY_WRITE_ATTEMPTS.
 * Its sources are resolved off rows the batch's buffer drop has not yet
 * removed, as the record is written after it. Null: the gate closed.
 */
export async function writeM1SummaryLine(
  store: Pick<M1JudgmentStore, "writeSummaryLine">,
  batch: JudgmentBatch,
  draft: M1SummaryDraft,
): Promise<M1SummaryOutcome | null> {
  if (!summaryTextFits(draft.text)) return "invalid";
  if (copiesMessage(draft.text, draft.messages)) return "copied";
  let expectedVersion = draft.expectedVersion;
  for (let attempt = 1; attempt <= M1_SUMMARY_WRITE_ATTEMPTS; attempt += 1) {
    const result = await store.writeSummaryLine(batch, {
      text: draft.text,
      sources: draft.sources,
      expectedVersion,
    });
    switch (result.outcome) {
      case "gate_closed":
        return null;
      case "channel_gone":
        return "channel_gone";
      case "written":
        return result.lineIds.length > 0 ? "written" : "skipped";
      case "conflict":
        expectedVersion = result.version;
        continue;
      default:
        return "invalid";
    }
  }
  return "lost";
}

/**
 * J4's batches judged by M1: each summary line written, then each record,
 * then the messages it judged removed. One the channel's concurrency cap
 * stopped keeps its messages for the next batch (J7).
 */
export function createM1BatchJudge(deps: {
  judge: M1Judge;
  store: Pick<M1JudgmentStore, "recordBatch" | "writeSummaryLine">;
}): JudgmentBatchJudge {
  return {
    async judge(batch) {
      const subject = subjectOfBatch(batch);
      const judgment = await deps.judge.judge(subject);
      const { left, modelCalled } = judgment;
      let { record } = judgment;
      if (record === null) return { modelCalled, left: [] };
      if (judgment.summary && record.verdict.outcome === "judged") {
        record = {
          ...record,
          summary: await writeM1SummaryLine(
            deps.store,
            batch,
            judgment.summary,
          ),
        };
      }
      const deferred =
        record.verdict.outcome === "not_called" &&
        record.verdict.reason === "concurrency_limited";
      const judged = new Set(record.refs);
      await deps.store.recordBatch(
        batch,
        record,
        deferred
          ? []
          : subject.posts
              .filter((post) => judged.has(post.ts))
              .map((post) => post.inputId),
      );
      return deferred
        ? {
            modelCalled,
            left: subject.posts.map((post) => post.inputId),
            deferred: true,
          }
        : { modelCalled, left: left.map((post) => post.inputId) };
    },
    async rateLimited(batch) {
      const subject = subjectOfBatch(batch);
      await deps.store.recordBatch(
        batch,
        m1NotCalled(subject, "rate_limited", batch.releaseId),
        [],
      );
    },
  };
}

export type ReplyJudgmentRun = { judged: number; dropped: number };

/** Judges waiting replies one at a time until none waits or `deadline` passes. */
export async function runReplyJudgments(deps: {
  store: Pick<M1JudgmentStore, "claimReply" | "finishReply">;
  judge: M1Judge;
  logger: {
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  };
  deadline: number;
  clock?: () => number;
}): Promise<ReplyJudgmentRun> {
  const clock = deps.clock ?? Date.now;
  const run: ReplyJudgmentRun = { judged: 0, dropped: 0 };
  while (clock() < deps.deadline) {
    const claimed = await deps.store.claimReply();
    if (claimed === null) break;
    let record: M1Record | null = null;
    if (claimed.rateLimited) {
      record = m1NotCalled(claimed.subject, "rate_limited", null);
    } else {
      try {
        record = (await deps.judge.judge(claimed.subject)).record;
      } catch (error) {
        deps.logger.warn("Reply judgment failed", {
          judgment_id: claimed.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if ((await deps.store.finishReply(claimed.id, record)) === "written") {
      run.judged += 1;
    } else {
      run.dropped += 1;
    }
  }
  return run;
}

/** How often a replica looks for batches and replies to judge. */
export const M1_POLL_INTERVAL_MS = 5_000;
/** How long one look may go on judging. */
export const M1_RUN_BUDGET_MS = 30_000;

/**
 * Judges what is due on every replica: batches first, then replies. Each
 * batch and each reply is taken by one replica alone.
 */
export function createM1JudgmentRunner(deps: {
  batches: JudgmentBatchStore;
  store: M1JudgmentStore;
  judge: M1Judge;
  logger: {
    info(message: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  };
  clock?: () => number;
}) {
  const clock = deps.clock ?? Date.now;
  const batchJudge = createM1BatchJudge(deps);
  async function runOnce(stopped: () => boolean = () => false) {
    const deadline = clock() + M1_RUN_BUDGET_MS;
    // A stop ends the pass after the judgment in hand.
    const until = () => (stopped() ? Number.POSITIVE_INFINITY : clock());
    const batches = await runJudgmentBatches({
      store: deps.batches,
      judge: batchJudge,
      logger: deps.logger,
      deadline,
      clock: until,
    });
    const replies = await runReplyJudgments({
      store: deps.store,
      judge: deps.judge,
      logger: deps.logger,
      deadline,
      clock: until,
    });
    if (
      batches.judged + batches.rateLimited + batches.failed + replies.judged >
      0
    ) {
      deps.logger.info("M1 judgment pass", { ...batches, replies });
    }
    return { batches, replies };
  }
  function start(intervalMs = M1_POLL_INTERVAL_MS) {
    return startPolling(intervalMs, runOnce, (error) =>
      deps.logger.warn("M1 judgment pass failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return { runOnce, start };
}

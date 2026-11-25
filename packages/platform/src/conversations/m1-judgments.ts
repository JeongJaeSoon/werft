import type {
  ConversationJudgmentId,
  JudgmentVoidedReason,
} from "@werft-ai/contracts";
import { startPolling } from "../polling.ts";
import {
  type JudgmentBatch,
  type JudgmentBatchJudge,
  type JudgmentBatchStore,
  runJudgmentBatches,
} from "./judgment-batches.ts";
import {
  type M1Judge,
  type M1Post,
  type M1Record,
  type M1Subject,
  m1NotCalled,
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

/** A post a judgment read, with the text it read. */
export type M1ReadPost = Pick<M1Post, "inputId" | "ts" | "body">;

/**
 * What a batch's write found. `voided`: a post the model read was deleted
 * or edited while it ran (check spot ②, a1/J6), so a voided row was written
 * in place of the result; `remaining` are the judged posts still there,
 * with their text now, for the one judgment again (none once it was `final`,
 * when their buffered rows went too).
 */
export type M1BatchWrite =
  | { outcome: "written" }
  | { outcome: "closed" }
  | {
      outcome: "voided";
      reason: JudgmentVoidedReason;
      remaining: M1ReadPost[];
    };

/**
 * What a reply's write found. `voided` with `rejudge`: the reply waits
 * for one judgment again on that text (its buffered text now, or the text
 * read when only its context was deleted); with null, the reply's row is
 * now the voided record.
 */
export type M1ReplyWrite =
  | "written"
  | "dropped"
  | { voided: JudgmentVoidedReason; rejudge: string | null };

/**
 * Where M1's records go. Each write asks the switch, the notice approval and
 * the channel's sharing again, under the agent's row: closed, nothing is
 * written. A judged result is written only if no message it read was
 * deleted or edited since (check spot ②).
 */
export interface M1JudgmentStore {
  /** Asked right before each call. */
  gateOpen(place: M1Place): Promise<boolean>;
  /**
   * Writes a batch's record and removes the buffered messages it judged;
   * `closed`, writing and removing nothing, when the gate has closed.
   * `final`: the judgment again, whose voiding removes what it judged.
   */
  recordBatch(
    batch: JudgmentBatch,
    record: M1Record,
    judged: readonly M1ReadPost[],
    options?: { final?: boolean },
  ): Promise<M1BatchWrite>;
  /**
   * Gives up the replies that waited past the buffer's time or whose judge
   * died, then takes the oldest waiting one; null when none waits.
   */
  claimReply(options?: { now?: Date }): Promise<ClaimedReplyJudgment | null>;
  /**
   * Writes a reply's record, or drops its row when `record` is null or the
   * gate has closed; a held reply's text goes either way, unless it waits
   * for its judgment again. `read`: the text the judgment read. `final`:
   * the judgment again, which is not repeated.
   */
  finishReply(
    id: ConversationJudgmentId,
    record: M1Record | null,
    options?: { read?: string; final?: boolean },
  ): Promise<M1ReplyWrite>;
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

type VoidLogger = {
  info?(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

const logVoided = (
  logger: VoidLogger | undefined,
  record: M1Record,
  reason: JudgmentVoidedReason,
) => logger?.info?.("M1 judgment voided", { call_key: record.callKey, reason });

/**
 * J4's batches judged by M1: each record written, then the messages it
 * judged removed. One the channel's concurrency cap stopped keeps its
 * messages for the next batch (J7). A result voided because a message it
 * read was deleted or edited meanwhile is judged once more on what is left,
 * with the new text (J6); none left, nothing is called again.
 */
export function createM1BatchJudge(deps: {
  judge: M1Judge;
  store: Pick<M1JudgmentStore, "recordBatch">;
  logger?: VoidLogger;
}): JudgmentBatchJudge {
  const ids = (posts: readonly M1Post[]) => posts.map((post) => post.inputId);
  return {
    async judge(batch) {
      let subject = subjectOfBatch(batch);
      let modelCalled = false;
      const left: M1Post[] = [];
      for (const rejudge of [false, true]) {
        const judgment = await deps.judge.judge(subject, { rejudge });
        modelCalled ||= judgment.modelCalled;
        left.push(...judgment.left);
        const { record } = judgment;
        if (record === null) break;
        if (
          record.verdict.outcome === "not_called" &&
          record.verdict.reason === "concurrency_limited"
        ) {
          await deps.store.recordBatch(batch, record, []);
          return {
            modelCalled,
            left: ids([...subject.posts, ...left]),
            deferred: true,
          };
        }
        const refs = new Set(record.refs);
        const written = await deps.store.recordBatch(
          batch,
          record,
          subject.posts.filter((post) => refs.has(post.ts)),
          { final: rejudge },
        );
        if (written.outcome !== "voided") break;
        logVoided(deps.logger, record, written.reason);
        // Voided again: the store dropped what the batch still held.
        if (rejudge) return { modelCalled, left: [] };
        if (written.remaining.length === 0) break;
        const byInput = new Map(
          subject.posts.map((post) => [post.inputId, post]),
        );
        subject = {
          ...subject,
          posts: written.remaining.flatMap((post) => {
            const read = byInput.get(post.inputId);
            return read === undefined ? [] : [{ ...read, body: post.body }];
          }),
        };
      }
      return { modelCalled, left: ids(left) };
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

export type ReplyJudgmentRun = {
  judged: number;
  dropped: number;
  /** Results voided by a delete or an edit of the reply (J6). */
  voided: number;
};

/** Judges waiting replies one at a time until none waits or `deadline` passes. */
export async function runReplyJudgments(deps: {
  store: Pick<M1JudgmentStore, "claimReply" | "finishReply">;
  judge: M1Judge;
  logger: {
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  } & VoidLogger;
  deadline: number;
  clock?: () => number;
}): Promise<ReplyJudgmentRun> {
  const clock = deps.clock ?? Date.now;
  const run: ReplyJudgmentRun = { judged: 0, dropped: 0, voided: 0 };
  const judge = async (claimed: ClaimedReplyJudgment, rejudge: boolean) => {
    try {
      return (await deps.judge.judge(claimed.subject, { rejudge })).record;
    } catch (error) {
      deps.logger.warn("Reply judgment failed", {
        judgment_id: claimed.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };
  while (clock() < deps.deadline) {
    let claimed = await deps.store.claimReply();
    if (claimed === null) break;
    let record = claimed.rateLimited
      ? m1NotCalled(claimed.subject, "rate_limited", null)
      : await judge(claimed, false);
    let read = claimed.subject.posts[0]?.body;
    let written = await deps.store.finishReply(claimed.id, record, {
      ...(read === undefined ? {} : { read }),
    });
    if (typeof written === "object" && record !== null) {
      logVoided(deps.logger, record, written.voided);
      if (written.rejudge !== null) {
        // Once more on the buffer's new text; voided again, it is not.
        read = written.rejudge;
        const text = read;
        claimed = {
          ...claimed,
          subject: {
            ...claimed.subject,
            posts: claimed.subject.posts.map((post) => ({
              ...post,
              body: text,
            })),
          },
        };
        record = await judge(claimed, true);
        written = await deps.store.finishReply(claimed.id, record, {
          read,
          final: true,
        });
        if (typeof written === "object" && record !== null) {
          logVoided(deps.logger, record, written.voided);
        }
      }
    }
    if (written === "written") run.judged += 1;
    else if (written === "dropped") run.dropped += 1;
    else run.voided += 1;
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
      batches.judged +
        batches.rateLimited +
        batches.failed +
        replies.judged +
        replies.voided >
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

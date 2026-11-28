import type {
  ConversationId,
  ConversationInputId,
  ConversationJudgmentId,
  ConversationTopicId,
  JudgmentVoidedReason,
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
import type { SummaryFolder } from "./summary-folds.ts";

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
  /** Held in the buffer with its text: no session's turn took the reply. */
  held?: boolean;
  /** As JudgmentBatch's: when the claim's channel marks were done. */
  readAt?: string;
};

/** A post a judgment read, with the text it read. */
export type M1ReadPost = Pick<M1Post, "inputId" | "ts" | "body" | "editMark">;

/**
 * What a batch's write found. `voided`: a post the model read was deleted
 * or edited while it ran (check spot ②, a1/J6), so a voided row was written
 * in place of the result; `remaining` are the judged posts still there,
 * with their text now, for the one judgment again (none once it was `final`,
 * when their buffered rows went too).
 */
export type M1BatchWrite =
  | { outcome: "written"; judgmentId: ConversationJudgmentId }
  | { outcome: "closed" }
  | {
      outcome: "voided";
      reason: JudgmentVoidedReason;
      remaining: M1ReadPost[];
      /** When the remaining posts were read again, for that judgment's write. */
      readAt: string;
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
  | {
      voided: JudgmentVoidedReason;
      rejudge: (Pick<M1Post, "body" | "editMark"> & { readAt: string }) | null;
    };

/**
 * Where M1's records go. Each write asks the switch and the channel's
 * sharing again, under the agent's row: closed, nothing is
 * written. A judged result is written only if no message it read was
 * deleted or edited since (check spot ②).
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
   * `closed`, writing and removing nothing, when the gate has closed.
   * `final`: the judgment again, whose voiding removes what it judged.
   */
  recordBatch(
    batch: JudgmentBatch,
    record: M1Record,
    judged: readonly M1ReadPost[],
    options?: { final?: boolean; readAt?: string },
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
    options?: {
      read?: Pick<M1Post, "body" | "editMark">;
      final?: boolean;
      readAt?: string;
    },
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
      editedAt: input.editedAt ?? null,
      editMark: input.editMark,
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

/**
 * A judgment that spoke, as its record was written (v1-b/U1): the post it
 * answers, whose text is the unasked turn's instruction and whose thread is
 * where the turn answers, and the other posts it judged, given to the turn
 * as reference alone. Texts as the judgment read them.
 */
export type M1Spoken = {
  judgmentId: ConversationJudgmentId;
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  teamId: string;
  channelId: string;
  target: {
    inputId: ConversationInputId;
    topicId: ConversationTopicId;
    ts: string;
    body: string;
  };
  context: { ts: string; body: string }[];
};

/**
 * Makes the agent's unasked turn of a judgment that spoke, once its rollout
 * is on; under `shadow` nothing is made. Whatever it does is the record's:
 * a failure here leaves the judgment as written.
 */
export interface M1Speaker {
  speak(spoken: M1Spoken): Promise<void>;
}

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

type VoidLogger = {
  info?(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn?(message: string, fields?: Readonly<Record<string, unknown>>): void;
};

const logVoided = (
  logger: VoidLogger | undefined,
  record: M1Record,
  reason: JudgmentVoidedReason,
) => logger?.info?.("M1 judgment voided", { call_key: record.callKey, reason });

/**
 * J4's batches judged by M1: each summary line written, then each record,
 * then the messages it judged removed. One the channel's concurrency cap
 * stopped keeps its messages for the next batch (J7). A result voided
 * because a message it read was deleted or edited meanwhile is judged once
 * more on what is left, with the new text (J6); none left, nothing is called
 * again. A batch that added a line folds the summary, once its record is
 * written, if the line took it past its cap (a1/J10).
 */
export function createM1BatchJudge(deps: {
  judge: M1Judge;
  store: Pick<M1JudgmentStore, "recordBatch" | "writeSummaryLine">;
  folder?: Pick<SummaryFolder, "fold">;
  speaker?: M1Speaker;
  logger?: VoidLogger;
}): JudgmentBatchJudge {
  const fold = async (batch: JudgmentBatch) => {
    if (deps.folder === undefined) return;
    try {
      const folded = await deps.folder.fold(batch);
      if (folded !== "within_cap") {
        deps.logger?.info?.("Channel summary fold", { outcome: folded });
      }
    } catch (error) {
      deps.logger?.warn?.("Channel summary fold failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const ids = (posts: readonly M1Post[]) => posts.map((post) => post.inputId);
  // A batch that spoke: its turn answers the post it named, in that post's
  // thread, the rest of what it judged as reference.
  const speakOf = async (
    batch: JudgmentBatch,
    posts: readonly M1Post[],
    record: M1Record,
    judgmentId: ConversationJudgmentId,
  ) => {
    const target = spokenTarget(record, posts);
    const input = batch.inputs.find((each) => each.inputId === target?.inputId);
    if (deps.speaker === undefined || target === null || input === undefined) {
      return;
    }
    const refs = new Set(record.refs);
    await speakSafely(deps.speaker, deps.logger, {
      judgmentId,
      workspaceId: batch.workspaceId,
      agentId: batch.agentId,
      conversationId: batch.conversationId,
      teamId: batch.teamId,
      channelId: batch.channelId,
      target: {
        inputId: target.inputId,
        topicId: input.topicId,
        ts: target.ts,
        body: target.body,
      },
      context: posts
        .filter((post) => post !== target && refs.has(post.ts))
        .map((post) => ({ ts: post.ts, body: post.body })),
    });
  };
  return {
    async judge(batch) {
      let subject = subjectOfBatch(batch);
      let modelCalled = false;
      let readAt = batch.readAt;
      let lineWritten = false;
      const left: M1Post[] = [];
      for (const rejudge of [false, true]) {
        const judgment = await deps.judge.judge(subject, { rejudge });
        modelCalled ||= judgment.modelCalled;
        left.push(...judgment.left);
        let { record } = judgment;
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
        // Each call's own line; a voided record keeps none, and its line,
        // made from a message since deleted or edited, has gone with it.
        if (judgment.summary && record.verdict.outcome === "judged") {
          record = {
            ...record,
            summary: await writeM1SummaryLine(
              deps.store,
              batch,
              judgment.summary,
            ),
          };
          lineWritten ||= record.summary === "written";
        }
        const refs = new Set(record.refs);
        const written = await deps.store.recordBatch(
          batch,
          record,
          subject.posts.filter((post) => refs.has(post.ts)),
          { final: rejudge, ...(readAt === undefined ? {} : { readAt }) },
        );
        if (written.outcome === "written") {
          await speakOf(batch, subject.posts, record, written.judgmentId);
        }
        if (written.outcome !== "voided") break;
        logVoided(deps.logger, record, written.reason);
        // Voided again: the store dropped what the batch still held.
        if (rejudge) {
          if (lineWritten) await fold(batch);
          return { modelCalled, left: [] };
        }
        if (written.remaining.length === 0) break;
        readAt = written.readAt;
        const byInput = new Map(
          subject.posts.map((post) => [post.inputId, post]),
        );
        subject = {
          ...subject,
          posts: written.remaining.flatMap((post) => {
            const read = byInput.get(post.inputId);
            return read === undefined
              ? []
              : [{ ...read, body: post.body, editMark: post.editMark }];
          }),
        };
      }
      if (lineWritten) await fold(batch);
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

/** The judged post a record that spoke answers; null when it spoke none. */
function spokenTarget(
  record: M1Record | null,
  posts: readonly M1Post[],
): M1Post | null {
  if (
    record === null ||
    record.verdict.outcome !== "judged" ||
    record.verdict.decision !== "speak" ||
    record.target === null
  ) {
    return null;
  }
  return posts.find((post) => post.ts === record.target) ?? null;
}

async function speakSafely(
  speaker: M1Speaker,
  logger: VoidLogger | undefined,
  spoken: M1Spoken,
) {
  try {
    await speaker.speak(spoken);
  } catch (error) {
    logger?.warn?.("Unasked turn not made", {
      judgment_id: spoken.judgmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
  /**
   * Makes a turn of a reply that spoke and no session took: one in a thread
   * the agent took part in (`m1_engaged`), or one held in a thread of work
   * done (`m1`, v1-b/U1 B). A reply a session took is the session's to
   * answer, and a reply of work going on (`m1_to_task`) goes to its work.
   */
  speaker?: M1Speaker;
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
    const [post] = claimed.subject.posts;
    let written = await deps.store.finishReply(claimed.id, record, {
      ...(post === undefined
        ? {}
        : { read: { body: post.body, editMark: post.editMark } }),
      ...(claimed.readAt === undefined ? {} : { readAt: claimed.readAt }),
    });
    if (typeof written === "object" && record !== null) {
      logVoided(deps.logger, record, written.voided);
      if (written.rejudge !== null) {
        // Once more on the text it has now; voided again, it is not.
        const { readAt, ...read } = written.rejudge;
        claimed = {
          ...claimed,
          subject: {
            ...claimed.subject,
            posts: claimed.subject.posts.map((each) => ({ ...each, ...read })),
          },
        };
        record = await judge(claimed, true);
        written = await deps.store.finishReply(claimed.id, record, {
          read,
          readAt,
          final: true,
        });
        if (typeof written === "object" && record !== null) {
          logVoided(deps.logger, record, written.voided);
        }
      }
    }
    if (written === "written") {
      run.judged += 1;
      const target = spokenTarget(record, claimed.subject.posts);
      const { subject } = claimed;
      if (
        deps.speaker !== undefined &&
        target !== null &&
        (subject.grade === "m1_engaged" ||
          (subject.grade === "m1" && claimed.held === true)) &&
        subject.topicId !== null
      ) {
        await speakSafely(deps.speaker, deps.logger, {
          judgmentId: claimed.id,
          workspaceId: subject.workspaceId,
          agentId: subject.agentId,
          conversationId: subject.conversationId,
          teamId: subject.teamId,
          channelId: subject.channelId,
          target: {
            inputId: target.inputId,
            topicId: subject.topicId,
            ts: target.ts,
            body: target.body,
          },
          context: [],
        });
      }
    } else if (written === "dropped") run.dropped += 1;
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
  folder?: Pick<SummaryFolder, "fold">;
  /** Unset: judgments are recorded and nothing more (a1/J5). */
  speaker?: M1Speaker;
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
      ...(deps.speaker === undefined ? {} : { speaker: deps.speaker }),
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

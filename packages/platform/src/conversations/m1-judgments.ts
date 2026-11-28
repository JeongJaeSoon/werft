import type {
  ConversationId,
  ConversationInputId,
  ConversationJudgmentId,
  ConversationTopicId,
  JudgmentGrade,
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
  /**
   * The reply's thread, and its Slack poster when it is held in the buffer
   * for its judgment (null when it is a turn's input), for its `speak`.
   */
  reply: { threadTs: string; slackUserId: string | null };
  /** Past the channel's M1 cap (counted for `m1_engaged` alone): no call. */
  rateLimited: boolean;
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
 * A recorded `speak` (v1-b/U1): the one judged post it answers, with what
 * its effect needs of it, read before the record let the post's text go.
 */
export type M1Speak = {
  judgmentId: ConversationJudgmentId;
  grade: JudgmentGrade;
  workspaceId: string;
  agentId: string;
  conversationId: ConversationId;
  teamId: string;
  channelId: string;
  post: {
    inputId: ConversationInputId;
    topicId: ConversationTopicId | null;
    ts: string;
    threadTs: string;
    /** Null when the post is no held one, as a bound reply under shadow. */
    slackUserId: string | null;
    body: string;
  };
};

/**
 * What a recorded `speak` did: `turn` queued the agent's own conversation
 * turn, `to_task` sent the reply on to its thread's task; `not_on` when
 * the agent's rollout is not `on` (shadow records only); `duplicate` when
 * an earlier run did it; `source_deleted` when the post was deleted since,
 * its record then quiet with `invalid_target`; anything else the turn
 * could not be started for.
 */
export type M1SpeakOutcome =
  | "turn"
  | "to_task"
  | "not_on"
  | "duplicate"
  | "source_deleted"
  | (string & {});

/** Where a recorded `speak` takes effect. */
export interface M1SpeakEffect {
  speak(speak: M1Speak): Promise<M1SpeakOutcome>;
}

/** What a `speak`'s effect writes besides a turn. */
export interface M1SpeakStore {
  /**
   * A held reply M1 sent on to its thread's work (`m1_to_task`): its event
   * put in the inbox again, under the agent's rollout on, its text as the
   * buffer holds it now, once per verdict. A post deleted since is not
   * sent, its record then quiet with `invalid_target`.
   */
  sendOnToWork(
    speak: M1Speak,
  ): Promise<"to_task" | "not_on" | "duplicate" | "source_deleted" | "gone">;
  /** A `speak` whose post was deleted before its effect: quiet, `invalid_target`. */
  voidSpeak(judgmentId: ConversationJudgmentId): Promise<void>;
}

/**
 * A recorded `speak`'s effect (v1-b/U1): a held reply in a thread whose work
 * is open goes on to the work; any other held post is answered by the
 * agent's own conversation turn. A post that was no held one (a reply a
 * turn took, under shadow) has no effect: its turn answered it.
 */
export function createM1SpeakEffect(deps: {
  store: M1SpeakStore;
  startTurn(speak: M1Speak): Promise<M1SpeakOutcome>;
}): M1SpeakEffect {
  return {
    async speak(speak) {
      if (speak.post.slackUserId === null) return "not_held";
      if (speak.grade === "m1_to_task") return deps.store.sendOnToWork(speak);
      const started = await deps.startTurn(speak);
      if (started === "source_deleted") {
        await deps.store.voidSpeak(speak.judgmentId);
      }
      return started;
    },
  };
}

/** Runs a speak's effect; a failure leaves the record, logged, and says nothing. */
async function takeSpeak(
  effect: M1SpeakEffect | undefined,
  logger: VoidLogger | undefined,
  speak: M1Speak,
) {
  if (effect === undefined) return;
  try {
    const outcome = await effect.speak(speak);
    logger?.info?.("M1 speak", {
      judgment_id: speak.judgmentId,
      grade: speak.grade,
      speak_outcome: outcome,
    });
  } catch (error) {
    logger?.warn?.("M1 speak failed", {
      judgment_id: speak.judgmentId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
  speak?: M1SpeakEffect;
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
        if (written.outcome === "written" && record.replyTo != null) {
          const target = subject.posts.find(
            (post) => post.ts === record.replyTo,
          );
          const input = batch.inputs.find(
            (each) => each.inputId === target?.inputId,
          );
          if (target !== undefined && input !== undefined) {
            await takeSpeak(deps.speak, deps.logger, {
              judgmentId: written.judgmentId,
              grade: "buffer_m1",
              workspaceId: batch.workspaceId,
              agentId: batch.agentId,
              conversationId: batch.conversationId,
              teamId: batch.teamId,
              channelId: batch.channelId,
              post: {
                inputId: input.inputId,
                topicId: input.topicId,
                ts: input.ts,
                threadTs: input.threadTs,
                slackUserId: input.slackUserId,
                body: target.body,
              },
            });
          }
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
  speak?: M1SpeakEffect;
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
      const answered = claimed.subject.posts.find(
        (each) => each.ts === record?.replyTo,
      );
      if (answered !== undefined) {
        await takeSpeak(deps.speak, deps.logger, {
          judgmentId: claimed.id,
          grade: claimed.subject.grade,
          workspaceId: claimed.subject.workspaceId,
          agentId: claimed.subject.agentId,
          conversationId: claimed.subject.conversationId,
          teamId: claimed.subject.teamId,
          channelId: claimed.subject.channelId,
          post: {
            inputId: answered.inputId,
            topicId: claimed.subject.topicId,
            ts: answered.ts,
            threadTs: claimed.reply.threadTs,
            slackUserId: claimed.reply.slackUserId,
            body: answered.body,
          },
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
  /** Where a recorded `speak` takes effect; unset, it is recorded only. */
  speak?: M1SpeakEffect;
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
      ...(deps.speak === undefined ? {} : { speak: deps.speak }),
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

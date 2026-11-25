import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  conversationIdSchema,
  conversationInputIdSchema,
  conversationJudgmentIdSchema,
  judgmentBatchIdSchema,
} from "@werft-ai/contracts";
import type { ChannelSummaryWriteResult } from "../ports/channel-summary-store.ts";
import {
  type JudgmentBatch,
  type JudgmentBatchStore,
  runJudgmentBatches,
} from "./judgment-batches.ts";
import type { M1Judge, M1Judgment, M1Record, M1Subject } from "./m1-judge.ts";
import {
  type ClaimedReplyJudgment,
  createM1BatchJudge,
  M1_SUMMARY_WRITE_ATTEMPTS,
  type M1BatchWrite,
  type M1JudgmentStore,
  type M1ReadPost,
  type M1ReplyWrite,
  runReplyJudgments,
} from "./m1-judgments.ts";

const quietLogger = { warn: () => {}, info: () => {} };

function batchOf(...ts: string[]): JudgmentBatch {
  return {
    id: judgmentBatchIdSchema.parse(randomUUID()),
    workspaceId: randomUUID(),
    agentId: randomUUID(),
    conversationId: conversationIdSchema.parse(randomUUID()),
    teamId: "T1",
    channelId: "C1",
    releaseId: "release-1",
    inputs: ts.map((t) => ({
      inputId: conversationInputIdSchema.parse(randomUUID()),
      topicId: randomUUID() as never,
      ts: t,
      slackUserId: "U1",
      body: `post ${t}`,
      receivedAt: new Date(),
      editMark: null,
    })),
  };
}

function recordOf(
  subject: M1Subject,
  verdict: M1Record["verdict"],
  refs = subject.posts.map((post) => post.ts),
): M1Record {
  return {
    verdict,
    refs,
    sources: { keys: [], overflow: false },
    releaseId: "release-1",
    callKey: `${subject.key}:m1` as never,
    attempts: verdict.outcome === "not_called" ? 0 : 1,
    summary: null,
  };
}

const judgeOf = (
  answer: (subject: M1Subject) => Promise<M1Judgment>,
): M1Judge & { subjects: M1Subject[]; rejudged: boolean[] } => {
  const subjects: M1Subject[] = [];
  const rejudged: boolean[] = [];
  return {
    subjects,
    rejudged,
    judge: async (subject, options = {}) => {
      subjects.push(subject);
      rejudged.push(options.rejudge === true);
      return answer(subject);
    },
  };
};

type Recorded = {
  record: M1Record;
  judged: readonly string[];
  read: readonly M1ReadPost[];
  final: boolean;
  readAt?: string;
};

type LineWrite =
  | ChannelSummaryWriteResult
  | { outcome: "gate_closed" }
  | { outcome: "channel_gone" };

/**
 * A batch store whose writes answer `writes` in turn, then "written"; its
 * summary lines answer `lineWrites` alike.
 */
function batchStore(writes: M1BatchWrite[] = [], lineWrites: LineWrite[] = []) {
  const recorded: Recorded[] = [];
  const lines: { text: string; expectedVersion: number }[] = [];
  const order: ("line" | "record")[] = [];
  const store: Pick<M1JudgmentStore, "recordBatch" | "writeSummaryLine"> = {
    writeSummaryLine: async (_batch, line) => {
      lines.push({ text: line.text, expectedVersion: line.expectedVersion });
      order.push("line");
      return (
        lineWrites.shift() ?? {
          outcome: "written",
          version: line.expectedVersion + 1,
          lineIds: [randomUUID() as never],
          skipped: [],
        }
      );
    },
    recordBatch: async (_batch, record, judged, options = {}) => {
      order.push("record");
      recorded.push({
        record,
        judged: judged.map((post) => post.inputId),
        read: judged,
        final: options.final === true,
        ...(options.readAt === undefined ? {} : { readAt: options.readAt }),
      });
      return writes.shift() ?? { outcome: "written" };
    },
  };
  return { recorded, lines, order, store };
}

const judgedQuiet = (subject: M1Subject): M1Judgment => ({
  record: recordOf(subject, {
    outcome: "judged",
    decision: "quiet",
    reason: "human_conversation",
  }),
  left: [],
  modelCalled: true,
});

function loggerOf() {
  const infos: { message: string; fields: unknown }[] = [];
  return {
    infos,
    logger: {
      warn: () => {},
      info: (message: string, fields?: unknown) =>
        infos.push({ message, fields }),
    },
  };
}

describe("createM1BatchJudge", () => {
  test("records the batch and removes the posts it judged, not those left", async () => {
    const batch = batchOf("1.1", "1.2");
    const [first, second] = batch.inputs;
    if (first === undefined || second === undefined) throw new Error("two");
    const judge = judgeOf(async (subject) => ({
      record: recordOf(
        subject,
        { outcome: "judged", decision: "quiet", reason: "human_conversation" },
        ["1.1"],
      ),
      left: subject.posts.slice(1),
      modelCalled: true,
    }));
    const { recorded, store } = batchStore();
    const result = await createM1BatchJudge({ judge, store }).judge(batch);
    expect(judge.subjects[0]?.grade).toBe("buffer_m1");
    expect(judge.subjects[0]?.key).toBe(batch.id);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.judged).toEqual([first.inputId]);
    expect(result).toEqual({ modelCalled: true, left: [second.inputId] });
  });

  test("a concurrency-limited batch keeps every post for the next one", async () => {
    const batch = batchOf("1.1", "1.2");
    const judge = judgeOf(async (subject) => ({
      record: recordOf(subject, {
        outcome: "not_called",
        decision: "quiet",
        reason: "concurrency_limited",
      }),
      left: [],
      modelCalled: false,
    }));
    const { recorded, store } = batchStore();
    const result = await createM1BatchJudge({ judge, store }).judge(batch);
    expect(recorded[0]?.record.verdict.reason).toBe("concurrency_limited");
    expect(recorded[0]?.judged).toEqual([]);
    expect(result).toEqual({
      modelCalled: false,
      left: batch.inputs.map((input) => input.inputId),
      deferred: true,
    });
  });

  test("no record (gate closed) writes nothing", async () => {
    const judge = judgeOf(async () => ({
      record: null,
      left: [],
      modelCalled: false,
    }));
    const { recorded, store } = batchStore();
    await createM1BatchJudge({ judge, store }).judge(batchOf("1.1"));
    expect(recorded).toEqual([]);
  });

  test("a rate-limited batch is recorded quiet, its posts kept, no call", async () => {
    const judge = judgeOf(async () => {
      throw new Error("not called");
    });
    const { recorded, store } = batchStore();
    await createM1BatchJudge({ judge, store }).rateLimited(batchOf("1.1"));
    expect(judge.subjects).toEqual([]);
    expect(recorded[0]?.record.verdict).toEqual({
      outcome: "not_called",
      decision: "quiet",
      reason: "rate_limited",
    });
    expect(recorded[0]?.judged).toEqual([]);
  });
});

describe("the summary line (a1/J8)", () => {
  const draftOf = (subject: M1Subject, text: string, expectedVersion = 4) => ({
    text,
    expectedVersion,
    sources: subject.posts.flatMap((post) => post.sources),
    messages: subject.posts.map((post) => post.body),
  });
  const judgedWith = (text: string | null, expectedVersion = 4) =>
    judgeOf(async (subject) => ({
      record: recordOf(subject, {
        outcome: "judged",
        decision: "quiet",
        reason: "human_conversation",
      }),
      left: [],
      modelCalled: true,
      summary: text === null ? null : draftOf(subject, text, expectedVersion),
    }));

  test("is added before the record, on the version the call read", async () => {
    const { recorded, lines, order, store } = batchStore();
    await createM1BatchJudge({
      judge: judgedWith("someone asked where the deploy doc is"),
      store,
    }).judge(batchOf("1.1"));
    expect(order).toEqual(["line", "record"]);
    expect(lines).toEqual([
      { text: "someone asked where the deploy doc is", expectedVersion: 4 },
    ]);
    expect(recorded[0]?.record.summary).toBe("written");
  });

  test("a lost compare writes again on the version it names, then gives up", async () => {
    const conflict = (version: number) => ({
      outcome: "conflict" as const,
      version,
    });
    const once = batchStore([], [conflict(5)]);
    await createM1BatchJudge({
      judge: judgedWith("a person said the build is broken"),
      store: once.store,
    }).judge(batchOf("1.1"));
    expect(once.lines.map((line) => line.expectedVersion)).toEqual([4, 5]);
    expect(once.recorded[0]?.record.summary).toBe("written");

    const always = batchStore([], [conflict(5), conflict(6), conflict(7)]);
    await createM1BatchJudge({
      judge: judgedWith("a person said the build is broken"),
      store: always.store,
    }).judge(batchOf("1.1"));
    expect(always.lines).toHaveLength(M1_SUMMARY_WRITE_ATTEMPTS);
    expect(always.lines.map((line) => line.expectedVersion)).toEqual([4, 5, 6]);
    expect(always.recorded[0]?.record.summary).toBe("lost");
    // The judgment is recorded and its posts removed all the same.
    expect(always.recorded[0]?.judged).toHaveLength(1);
  });

  test("one that copies a message the call read is not written", async () => {
    const base = batchOf("1.1");
    const body =
      "the deploy to production is blocked until the database migration finishes tonight";
    const batch = {
      ...base,
      inputs: base.inputs.map((input) => ({ ...input, body })),
    };
    const copied = `someone said ${body.slice(10, 60)}`;
    const { recorded, lines, store } = batchStore();
    await createM1BatchJudge({
      judge: judgedWith(copied),
      store,
    }).judge(batch);
    expect(lines).toEqual([]);
    expect(recorded[0]?.record.summary).toBe("copied");
  });

  test("a source marked since it was read, or a closed gate, adds no line", async () => {
    const skipped = batchStore(
      [],
      [{ outcome: "written", version: 4, lineIds: [], skipped: [] }],
    );
    await createM1BatchJudge({
      judge: judgedWith("someone asked for a review"),
      store: skipped.store,
    }).judge(batchOf("1.1"));
    expect(skipped.recorded[0]?.record.summary).toBe("skipped");

    const closed = batchStore([], [{ outcome: "gate_closed" }]);
    await createM1BatchJudge({
      judge: judgedWith("someone asked for a review"),
      store: closed.store,
    }).judge(batchOf("1.1"));
    expect(closed.recorded[0]?.record.summary).toBeNull();

    // A deleted channel's: the record says why.
    const gone = batchStore([], [{ outcome: "channel_gone" }]);
    await createM1BatchJudge({
      judge: judgedWith("someone asked for a review"),
      store: gone.store,
    }).judge(batchOf("1.1"));
    expect(gone.recorded[0]?.record.summary).toBe("channel_gone");
  });

  test("an empty or too long line, or none, is not written", async () => {
    for (const [text, summary] of [
      [" ", "invalid"],
      ["x".repeat(2001), "invalid"],
      [null, null],
    ] as const) {
      const { recorded, lines, store } = batchStore();
      await createM1BatchJudge({ judge: judgedWith(text), store }).judge(
        batchOf("1.1"),
      );
      expect(lines).toEqual([]);
      expect(recorded[0]?.record.summary).toBe(summary);
    }
  });

  test("a voided result's call and the one again each write their own line", async () => {
    const batch = batchOf("1.1", "1.2");
    const [, two] = batch.inputs;
    if (!two) throw new Error("two");
    const { recorded, lines, order, store } = batchStore([
      {
        outcome: "voided",
        reason: "voided_by_delete",
        remaining: [
          { inputId: two.inputId, ts: "1.2", body: two.body, editMark: null },
        ],
        readAt: "t1",
      },
    ]);
    await createM1BatchJudge({
      judge: judgedWith("someone asked for a review"),
      store,
    }).judge(batch);
    expect(order).toEqual(["line", "record", "line", "record"]);
    expect(lines).toHaveLength(2);
    expect(recorded[1]?.record.summary).toBe("written");
  });
});

describe("createM1BatchJudge at check spot ② (a1/J6)", () => {
  test("one of three deleted while judged: judged once more on the two left, then no more", async () => {
    const batch = batchOf("1.1", "1.2", "1.3");
    const [one, two, three] = batch.inputs;
    if (!one || !two || !three) throw new Error("three");
    const judge = judgeOf(async (subject) => judgedQuiet(subject));
    const { recorded, store } = batchStore([
      {
        outcome: "voided",
        reason: "voided_by_delete",
        remaining: [two, three].map(({ inputId, ts, body }) => ({
          inputId,
          ts,
          body,
          editMark: null,
        })),
        readAt: "t1",
      },
    ]);
    const { infos, logger } = loggerOf();
    const result = await createM1BatchJudge({ judge, store, logger }).judge(
      batch,
    );
    expect(judge.rejudged).toEqual([false, true]);
    expect(judge.subjects[1]?.posts.map((post) => post.ts)).toEqual([
      "1.2",
      "1.3",
    ]);
    expect(recorded.map((write) => [write.judged.length, write.final])).toEqual(
      [
        [3, false],
        [2, true],
      ],
    );
    expect(result).toEqual({ modelCalled: true, left: [] });
    expect(infos).toEqual([
      {
        message: "M1 judgment voided",
        fields: { call_key: `${batch.id}:m1`, reason: "voided_by_delete" },
      },
    ]);
    expect(JSON.stringify(infos)).not.toContain("post 1.");
  });

  test("every post deleted: no call again", async () => {
    const judge = judgeOf(async (subject) => judgedQuiet(subject));
    const { recorded, store } = batchStore([
      {
        outcome: "voided",
        reason: "voided_by_delete",
        remaining: [],
        readAt: "t1",
      },
    ]);
    await createM1BatchJudge({ judge, store }).judge(batchOf("1.1", "1.2"));
    expect(judge.subjects).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  test("an edit: judged once more on the buffer's new text; edited again, no third call", async () => {
    const batch = batchOf("1.1");
    const [only] = batch.inputs;
    if (!only) throw new Error("one");
    const judge = judgeOf(async (subject) => judgedQuiet(subject));
    const { recorded, store } = batchStore([
      {
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: [
          {
            inputId: only.inputId,
            ts: "1.1",
            body: "new text",
            editMark: "m1",
          },
        ],
        readAt: "t1",
      },
      {
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: [],
        readAt: "t2",
      },
    ]);
    await createM1BatchJudge({ judge, store }).judge(batch);
    expect(judge.subjects.map((subject) => subject.posts[0]?.body)).toEqual([
      "post 1.1",
      "new text",
    ]);
    expect(recorded.map((write) => write.read[0]?.body)).toEqual([
      "post 1.1",
      "new text",
    ]);
    expect(recorded[1]?.final).toBe(true);
    // The judgment again is checked against what it read, when it read it.
    expect(recorded[1]?.read[0]?.editMark).toBe("m1");
    expect(recorded[1]?.readAt).toBe("t1");
  });

  test("voided again: nothing is left to a later batch", async () => {
    const batch = batchOf("1.1", "1.2");
    const [one, two] = batch.inputs;
    if (!one || !two) throw new Error("two");
    const judge = judgeOf(async (subject) => ({
      ...judgedQuiet(subject),
      left: subject.posts.filter((post) => post.ts === "1.2"),
    }));
    const { store } = batchStore([
      {
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: [one, two].map(({ inputId, ts }) => ({
          inputId,
          ts,
          body: "edited",
          editMark: "m1",
        })),
        readAt: "t1",
      },
      {
        outcome: "voided",
        reason: "voided_by_edit",
        remaining: [],
        readAt: "t2",
      },
    ]);
    const result = await createM1BatchJudge({ judge, store }).judge(batch);
    expect(judge.subjects).toHaveLength(2);
    expect(result).toEqual({ modelCalled: true, left: [] });
  });

  test("the gate closed at the write: nothing judged again", async () => {
    const judge = judgeOf(async (subject) => judgedQuiet(subject));
    const { store } = batchStore([{ outcome: "closed" }]);
    await createM1BatchJudge({ judge, store }).judge(batchOf("1.1"));
    expect(judge.subjects).toHaveLength(1);
  });
});

describe("runJudgmentBatches with a deferred batch", () => {
  test("finishes it, does not fail it, and judges no more this run", async () => {
    const batch = batchOf("1.1");
    const finished: unknown[] = [];
    const failed: unknown[] = [];
    let closes = 0;
    const store: JudgmentBatchStore = {
      closeNext: async () => {
        closes += 1;
        return { outcome: "judging", batch };
      },
      finish: async (_id, result) => {
        finished.push(result);
        return "finished";
      },
      fail: async (id) => {
        failed.push(id);
      },
    };
    const run = await runJudgmentBatches({
      store,
      judge: {
        judge: async () => ({
          modelCalled: false,
          left: batch.inputs.map((input) => input.inputId),
          deferred: true,
        }),
        rateLimited: async () => {},
      },
      logger: quietLogger,
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(closes).toBe(1);
    expect(failed).toEqual([]);
    expect(finished).toHaveLength(1);
    expect(run).toEqual({ judged: 1, rateLimited: 0, failed: 0 });
  });
});

describe("runReplyJudgments", () => {
  function replyStore(
    claims: ClaimedReplyJudgment[],
    writes: M1ReplyWrite[] = [],
  ) {
    const finished: {
      id: string;
      record: M1Record | null;
      options?: Parameters<M1JudgmentStore["finishReply"]>[2];
    }[] = [];
    const store: Pick<M1JudgmentStore, "claimReply" | "finishReply"> = {
      claimReply: async () => claims.shift() ?? null,
      finishReply: async (id, record, options) => {
        finished.push({ id, record, ...(options ? { options } : {}) });
        return writes.shift() ?? (record === null ? "dropped" : "written");
      },
    };
    return { store, finished };
  }

  function claimOf(rateLimited = false): ClaimedReplyJudgment {
    const inputId = conversationInputIdSchema.parse(randomUUID());
    return {
      id: conversationJudgmentIdSchema.parse(randomUUID()),
      rateLimited,
      subject: {
        grade: "m1_engaged",
        workspaceId: randomUUID(),
        agentId: randomUUID(),
        conversationId: conversationIdSchema.parse(randomUUID()),
        teamId: "T1",
        channelId: "C1",
        topicId: null,
        key: inputId,
        posts: [
          {
            inputId,
            ts: "1.1",
            body: "thanks all",
            receivedAt: new Date(),
            editMark: null,
            sources: [],
          },
        ],
      },
    };
  }

  test("judges each reply and writes its record", async () => {
    const claim = claimOf();
    const { store, finished } = replyStore([claim]);
    const judge = judgeOf(async (subject) => ({
      record: recordOf(subject, {
        outcome: "judged",
        decision: "quiet",
        reason: "already_handled",
      }),
      left: [],
      modelCalled: true,
    }));
    const run = await runReplyJudgments({
      store,
      judge,
      logger: quietLogger,
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(judge.subjects).toEqual([claim.subject]);
    expect(finished[0]?.record?.verdict.outcome).toBe("judged");
    expect(run).toEqual({ judged: 1, dropped: 0, voided: 0 });
  });

  test("a rate-limited reply is recorded quiet without a call", async () => {
    const { store, finished } = replyStore([claimOf(true)]);
    const judge = judgeOf(async () => {
      throw new Error("not called");
    });
    await runReplyJudgments({
      store,
      judge,
      logger: quietLogger,
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(judge.subjects).toEqual([]);
    expect(finished[0]?.record?.verdict).toEqual({
      outcome: "not_called",
      decision: "quiet",
      reason: "rate_limited",
    });
  });

  test("a judge that throws drops the reply and logs no text", async () => {
    const claim = claimOf();
    const { store, finished } = replyStore([claim]);
    const warned: unknown[] = [];
    const run = await runReplyJudgments({
      store,
      judge: judgeOf(async () => {
        throw new Error("boom");
      }),
      logger: { warn: (message, fields) => warned.push({ message, fields }) },
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(finished).toEqual([
      {
        id: claim.id,
        record: null,
        options: { read: { body: "thanks all", editMark: null } },
      },
    ]);
    expect(run).toEqual({ judged: 0, dropped: 1, voided: 0 });
    expect(JSON.stringify(warned)).not.toContain("thanks all");
  });

  test("an engaged reply edited while judged is judged once more on its new text", async () => {
    const claim = claimOf();
    const { store, finished } = replyStore(
      [claim],
      [
        {
          voided: "voided_by_edit",
          rejudge: { body: "new text", editMark: "m1", readAt: "t1" },
        },
        "written",
      ],
    );
    const judge = judgeOf(async (subject) => judgedQuiet(subject));
    const run = await runReplyJudgments({
      store,
      judge,
      logger: quietLogger,
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(judge.rejudged).toEqual([false, true]);
    expect(judge.subjects[1]?.posts[0]?.body).toBe("new text");
    expect(finished.map((write) => write.options)).toEqual([
      { read: { body: "thanks all", editMark: null } },
      {
        read: { body: "new text", editMark: "m1" },
        readAt: "t1",
        final: true,
      },
    ]);
    expect(run).toEqual({ judged: 1, dropped: 0, voided: 0 });
  });

  test("a reply voided with nothing to judge again calls no more and logs its key", async () => {
    const claim = claimOf();
    const { store } = replyStore(
      [claim],
      [{ voided: "voided_by_delete", rejudge: null }],
    );
    const judge = judgeOf(async (subject) => judgedQuiet(subject));
    const { infos, logger } = loggerOf();
    const run = await runReplyJudgments({
      store,
      judge,
      logger,
      deadline: Number.POSITIVE_INFINITY,
    });
    expect(judge.subjects).toHaveLength(1);
    expect(run).toEqual({ judged: 0, dropped: 0, voided: 1 });
    expect(infos).toEqual([
      {
        message: "M1 judgment voided",
        fields: {
          call_key: `${claim.subject.key}:m1`,
          reason: "voided_by_delete",
        },
      },
    ]);
  });
});

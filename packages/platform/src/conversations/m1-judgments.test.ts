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
  type M1JudgmentStore,
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
): M1Judge & { subjects: M1Subject[] } => {
  const subjects: M1Subject[] = [];
  return {
    subjects,
    judge: async (subject) => {
      subjects.push(subject);
      return answer(subject);
    },
  } as M1Judge & { subjects: M1Subject[] };
};

function batchStore(
  writes: (ChannelSummaryWriteResult | { outcome: "gate_closed" })[] = [],
) {
  const recorded: { record: M1Record; judged: readonly string[] }[] = [];
  const lines: { text: string; expectedVersion: number }[] = [];
  return {
    recorded,
    lines,
    store: {
      writeSummaryLine: async (
        _batch: JudgmentBatch,
        line: { text: string; expectedVersion: number },
      ) => {
        lines.push({ text: line.text, expectedVersion: line.expectedVersion });
        // Records lines are written before the batch's record.
        expect(recorded).toEqual([]);
        return (
          writes.shift() ?? {
            outcome: "written" as const,
            version: line.expectedVersion + 1,
            lineIds: [randomUUID() as never],
            skipped: [],
          }
        );
      },
      recordBatch: async (
        _batch: JudgmentBatch,
        record: M1Record,
        judged: readonly string[],
      ) => {
        recorded.push({ record, judged });
        return true;
      },
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
    const { recorded, lines, store } = batchStore();
    await createM1BatchJudge({
      judge: judgedWith("someone asked where the deploy doc is"),
      store,
    }).judge(batchOf("1.1"));
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
    const once = batchStore([conflict(5)]);
    await createM1BatchJudge({
      judge: judgedWith("a person said the build is broken"),
      store: once.store,
    }).judge(batchOf("1.1"));
    expect(once.lines.map((line) => line.expectedVersion)).toEqual([4, 5]);
    expect(once.recorded[0]?.record.summary).toBe("written");

    const always = batchStore([conflict(5), conflict(6), conflict(7)]);
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
    const skipped = batchStore([
      { outcome: "written", version: 4, lineIds: [], skipped: [] },
    ]);
    await createM1BatchJudge({
      judge: judgedWith("someone asked for a review"),
      store: skipped.store,
    }).judge(batchOf("1.1"));
    expect(skipped.recorded[0]?.record.summary).toBe("skipped");

    const closed = batchStore([{ outcome: "gate_closed" }]);
    await createM1BatchJudge({
      judge: judgedWith("someone asked for a review"),
      store: closed.store,
    }).judge(batchOf("1.1"));
    expect(closed.recorded[0]?.record.summary).toBeNull();
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
  function replyStore(claims: ClaimedReplyJudgment[]) {
    const finished: { id: string; record: M1Record | null }[] = [];
    const store: Pick<M1JudgmentStore, "claimReply" | "finishReply"> = {
      claimReply: async () => claims.shift() ?? null,
      finishReply: async (id, record) => {
        finished.push({ id, record });
        return record === null ? "dropped" : "written";
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
    expect(run).toEqual({ judged: 1, dropped: 0 });
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
    expect(finished).toEqual([{ id: claim.id, record: null }]);
    expect(run).toEqual({ judged: 0, dropped: 1 });
    expect(JSON.stringify(warned)).not.toContain("thanks all");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONVERSATION_TOPIC_SESSION_IDLE_MS,
  CONVERSATION_TOPIC_SESSION_LIMIT,
  type ConversationRuntimeTurn,
  type ConversationTopicId,
  conversationRuntimeTurnSchema,
} from "@werft-ai/contracts";
import type {
  AgentRun,
  RuntimeEvent,
  RuntimeModule,
} from "@werft-ai/runtime-core";
import { fakePermitRelay } from "../testing/fake-permit-relay.ts";
import { TopicDirectories } from "./topic-directories.ts";
import { TopicSessions } from "./topic-sessions.ts";
import { createConversationTurnRunner } from "./turn-runner.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "topic-sessions-"));
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

const topic = () => crypto.randomUUID() as ConversationTopicId;

/**
 * An engine module whose every run answers each input it is sent with
 * `reply(input)`, or ends the turn in error when that is null; it counts
 * starts and closes, and keeps what each run was sent.
 */
function engine(reply: (text: string) => string | null = () => "ok") {
  const runs: { sent: string[]; closed: boolean }[] = [];
  const module = {
    descriptor: { kind: "test_engine" },
    builtinTools: ["Bash"],
    eventCodec: {
      kind: "test_engine",
      withNeutralFields: (event: unknown) => event,
    },
    createRuntime: () => ({
      start: () => {
        const record = { sent: [] as string[], closed: false };
        runs.push(record);
        const waiting: ((event: RuntimeEvent[]) => void)[] = [];
        const queued: RuntimeEvent[][] = [];
        return {
          ready: async () => ({}),
          send: ({ message }: { message: string }) => {
            record.sent.push(message);
            const answer = reply(message);
            const events: RuntimeEvent[] =
              answer === null
                ? [ended(true)]
                : [
                    {
                      type: "public",
                      event: { event: "assistant", data: { text: answer } },
                    } as RuntimeEvent,
                    ended(false),
                  ];
            const next = waiting.shift();
            if (next) next(events);
            else queued.push(events);
          },
          async *events() {
            for (;;) {
              const batch =
                queued.shift() ??
                (await new Promise<RuntimeEvent[]>((resolve) =>
                  waiting.push(resolve),
                ));
              yield* batch;
            }
          },
          abort: () => {},
          finishInput: () => {},
          close: async () => {
            record.closed = true;
          },
        } as unknown as AgentRun;
      },
    }),
  } as unknown as RuntimeModule;
  return { module, runs };
}

const ended = (isError: boolean): RuntimeEvent => ({
  type: "turn.ended",
  turn: {
    isError,
    abortedByStop: false,
    budgetExceeded: false,
    ...(isError ? { failure: { reason: "error_during_execution" } } : {}),
    engineResult: {},
    cost: { countRestarted: false, unknown: true },
    inputs: [],
  },
});

function turnOf(
  topicId: ConversationTopicId,
  text: string,
  check?: "keep" | "drop",
): ConversationRuntimeTurn {
  return conversationRuntimeTurnSchema.parse({
    turn_id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    lease_expires_at: "2026-11-24T00:02:30.000Z",
    scope: {
      workspace_id: crypto.randomUUID(),
      agent_id: crypto.randomUUID(),
      conversation_id: crypto.randomUUID(),
      topic_id: topicId,
    },
    model: "claude-haiku-5",
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "egress_token", token: ["wec", "t"].join("_") },
    },
    call: { id: crypto.randomUUID(), max_tokens: 1_024 },
    input: { id: crypto.randomUUID(), text },
    fresh_input: { id: crypto.randomUUID(), text: `context: ${text}` },
    ...(check === undefined ? {} : { topic_session: check }),
  });
}

function setup(options: { maxBytes?: number; limit?: number } = {}) {
  let clock = 0;
  const e = engine();
  const relay = fakePermitRelay();
  const sessions = new TopicSessions(new TopicDirectories(root), relay, {
    now: () => clock,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });
  const runner = createConversationTurnRunner({
    runtime: e.module,
    sessions,
    relay,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  });
  const live = new AbortController().signal;
  return {
    ...e,
    relay,
    sessions,
    run: (turn: ConversationRuntimeTurn) => runner.run(turn, live),
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("a topic's session", () => {
  test("goes on for a kept turn within its idle time, and is new past it", async () => {
    const s = setup();
    const t = topic();
    await s.run(turnOf(t, "one"));
    s.tick(CONVERSATION_TOPIC_SESSION_IDLE_MS - 1);
    await s.run(turnOf(t, "two", "keep"));
    // The idle time counts from the last turn's end.
    s.tick(CONVERSATION_TOPIC_SESSION_IDLE_MS - 1);
    await s.run(turnOf(t, "three", "keep"));
    s.tick(CONVERSATION_TOPIC_SESSION_IDLE_MS);
    await s.run(turnOf(t, "four", "keep"));

    expect(s.runs.map((run) => run.sent)).toEqual([
      ["context: one", "two", "three"],
      ["context: four"],
    ]);
    expect(s.runs.map((run) => run.closed)).toEqual([true, false]);
  });

  test("is new for a turn on another model, provider or output cap than it started on", async () => {
    const s = setup();
    const t = topic();
    await s.run(turnOf(t, "one"));
    await s.run({ ...turnOf(t, "two", "keep"), model: "claude-sonnet-5" });
    const three = turnOf(t, "three", "keep");
    await s.run({
      ...three,
      model: "claude-sonnet-5",
      call: { ...three.call, max_tokens: 2_048 },
    });
    await s.run({
      ...turnOf(t, "four", "keep"),
      model: "claude-sonnet-5",
      call: { ...three.call, max_tokens: 2_048 },
    });

    expect(s.runs.map((run) => run.sent)).toEqual([
      ["context: one"],
      ["context: two"],
      ["context: three", "four"],
    ]);
  });

  test("is new when the control host's check drops it, or made none", async () => {
    const s = setup();
    const t = topic();
    await s.run(turnOf(t, "one"));
    await s.run(turnOf(t, "two", "drop"));
    await s.run(turnOf(t, "three"));

    expect(s.runs.map((run) => run.sent)).toEqual([
      ["context: one"],
      ["context: two"],
      ["context: three"],
    ]);
  });

  test("is new, never compacted, once what it was sent and said would pass its size", async () => {
    // "context: one" + "ok" is 14 bytes; "two" would make it 17.
    const s = setup({ maxBytes: 16 });
    const t = topic();
    await s.run(turnOf(t, "one"));
    await s.run(turnOf(t, "two", "keep"));

    expect(s.runs.map((run) => run.sent)).toEqual([
      ["context: one"],
      ["context: two"],
    ]);
  });

  test("is dropped with its directory when its turn fails", async () => {
    let fail = false;
    const s = setup();
    const e = engine(() => (fail ? null : "ok"));
    const runner = createConversationTurnRunner({
      runtime: e.module,
      sessions: s.sessions,
      relay: s.relay,
    });
    const live = new AbortController().signal;
    const t = topic();
    await runner.run(turnOf(t, "one"), live);
    fail = true;
    expect((await runner.run(turnOf(t, "two", "keep"), live)).outcome).toBe(
      "failed",
    );

    expect(s.sessions.size).toBe(0);
    expect(await stat(join(root, t)).catch(() => null)).toBeNull();
    expect(e.runs[0]?.closed).toBe(true);
  });

  test("of another topic is another engine and directory, which sees nothing of this one", async () => {
    const s = setup();
    const [a, b] = [topic(), topic()];
    await s.run(turnOf(a, "about a"));
    await s.run(turnOf(b, "about b", "keep"));
    await s.run(turnOf(a, "more on a", "keep"));

    expect(s.runs.map((run) => run.sent)).toEqual([
      ["context: about a", "more on a"],
      ["context: about b"],
    ]);
    expect((await readdir(root)).sort()).toEqual([a, b].sort());
  });
});

describe("the runtime's sessions", () => {
  test(`hold ${CONVERSATION_TOPIC_SESSION_LIMIT} at most: one more drops the one idle longest`, async () => {
    const s = setup();
    const topics = Array.from(
      { length: CONVERSATION_TOPIC_SESSION_LIMIT },
      topic,
    );
    for (const t of topics) {
      await s.run(turnOf(t, "hi"));
      s.tick(1_000);
    }
    // The first topic is used again, so the second is now idle longest.
    await s.run(turnOf(topics[0] as ConversationTopicId, "again", "keep"));
    s.tick(1_000);
    const extra = topic();
    await s.run(turnOf(extra, "hi"));

    expect(s.sessions.size).toBe(CONVERSATION_TOPIC_SESSION_LIMIT);
    expect(s.runs.map((run) => run.closed)).toEqual([
      false,
      true,
      ...Array(CONVERSATION_TOPIC_SESSION_LIMIT - 1).fill(false),
    ]);
    expect(
      await stat(join(root, topics[1] as string)).catch(() => null),
    ).toBeNull();
  });

  test("are none after a reset, which removes what an earlier process left", async () => {
    const s = setup();
    await s.run(turnOf(topic(), "hi"));
    const leftover = await new TopicDirectories(root).open(topic());

    await s.sessions.reset();

    expect(s.sessions.size).toBe(0);
    expect(await readdir(root)).toEqual([]);
    expect(await stat(leftover.root).catch(() => null)).toBeNull();
  });

  test("a sweep drops only those idle for their lifetime", async () => {
    const s = setup();
    const [old, fresh] = [topic(), topic()];
    await s.run(turnOf(old, "hi"));
    s.tick(CONVERSATION_TOPIC_SESSION_IDLE_MS - 1_000);
    await s.run(turnOf(fresh, "hi"));
    s.tick(1_000);

    await s.sessions.sweep();

    expect(await readdir(root)).toEqual([fresh]);
  });
});

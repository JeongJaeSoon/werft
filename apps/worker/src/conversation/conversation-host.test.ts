import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConversationRuntimeTurn,
  type ConversationTurnResult,
  conversationRuntimeTurnSchema,
} from "@werft-ai/contracts";
import { createConsoleLogger } from "../console-logger.ts";
import { ConversationHost } from "./conversation-host.ts";
import { HEALTH_STALE_MS, healthy } from "./main.ts";
import type { AgentRun } from "@werft-ai/runtime-core";
import { TopicDirectories } from "./topic-directories.ts";
import { TopicSessions } from "./topic-sessions.ts";
import type { ConversationTurnRunner } from "./turn-runner.ts";
import type { ConversationTurnSource } from "./turn-source.ts";

const INPUT = "the input text that stays out of the log";
const ANSWER = "the answer text that stays out of the log";
const TOKEN = ["wec", "one-call-token"].join("_");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "conversation-host-"));
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

function turnOf(leaseMs = 150_000): ConversationRuntimeTurn {
  return conversationRuntimeTurnSchema.parse({
    turn_id: crypto.randomUUID(),
    lease_id: crypto.randomUUID(),
    lease_expires_at: new Date(Date.now() + leaseMs).toISOString(),
    scope: {
      workspace_id: crypto.randomUUID(),
      agent_id: crypto.randomUUID(),
      conversation_id: crypto.randomUUID(),
      topic_id: crypto.randomUUID(),
    },
    model: "claude-haiku-5",
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.com",
      auth: { kind: "egress_token", token: TOKEN },
    },
    call: { id: crypto.randomUUID(), max_tokens: 1_024 },
    input: { id: crypto.randomUUID(), text: INPUT },
    fresh_input: { id: crypto.randomUUID(), text: INPUT },
  });
}

type Step = ConversationRuntimeTurn | null | Error;

/** An engine that is started and closed, and plays nothing. */
const idleRun = () =>
  ({
    async *events() {},
    finishInput() {},
    async close() {},
  }) as unknown as AgentRun;

/** A host over a scripted source: it stops itself once the script is spent. */
function harness(options: {
  script: Step[];
  run?: ConversationTurnRunner["run"];
  report?: (attempt: number) => "recorded" | "refused" | Error;
  /** Called at each poll, before the script's next step. */
  onPoll?: (poll: number) => void;
}) {
  const lines: string[] = [];
  const reports: Array<{ turnId: string; result: ConversationTurnResult }> = [];
  const ran: string[] = [];
  let clock = 0;
  const sessions = new TopicSessions(new TopicDirectories(root), {
    now: () => clock,
  });
  let attempts = 0;
  let polls = 0;
  let host: ConversationHost | undefined;
  const source: ConversationTurnSource = {
    async next() {
      polls += 1;
      options.onPoll?.(polls);
      const step = options.script.shift();
      if (step === undefined) {
        host?.stop("script spent");
        return null;
      }
      if (step instanceof Error) throw step;
      return step;
    },
    async report(turn, result) {
      attempts += 1;
      const answer = options.report?.(attempts) ?? "recorded";
      if (answer instanceof Error) throw answer;
      reports.push({ turnId: turn.turn_id, result });
      return answer;
    },
  };
  const runner: ConversationTurnRunner = {
    async run(turn, stop) {
      ran.push(turn.turn_id);
      // What a real turn leaves: its topic's session, and its directory.
      await sessions.open(turn.scope.topic_id, idleRun);
      return options.run
        ? options.run(turn, stop)
        : { outcome: "completed", text: ANSWER };
    },
  };
  host = new ConversationHost({
    source,
    runner,
    sessions,
    logger: createConsoleLogger({ write: (line) => lines.push(line) }),
    statusFile: join(root, "..", `status-${crypto.randomUUID()}.json`),
    retryMs: 1,
  });
  return {
    host,
    lines,
    reports,
    ran,
    sessions,
    tick: (ms: number) => {
      clock += ms;
    },
    events: () => lines.map((line) => JSON.parse(line).event),
  };
}

describe("ConversationHost", () => {
  test("takes each turn in order, runs it, reports it, and drops its topic's directory", async () => {
    const [first, second] = [turnOf(), turnOf()];
    const h = harness({ script: [first, null, second] });

    await h.host.run();

    expect(h.ran).toEqual([first.turn_id, second.turn_id]);
    expect(h.reports).toEqual([
      { turnId: first.turn_id, result: { outcome: "completed", text: ANSWER } },
      {
        turnId: second.turn_id,
        result: { outcome: "completed", text: ANSWER },
      },
    ]);
    // Stopping drops every session: nothing of either topic is left.
    expect(h.sessions.size).toBe(0);
    expect(await readdir(root)).toEqual([]);
    expect(h.events()).toEqual([
      "conversation_runtime.started",
      "conversation_turn.started",
      "conversation_turn.ended",
      "conversation_turn.reported",
      "conversation_turn.started",
      "conversation_turn.ended",
      "conversation_turn.reported",
      "conversation_runtime.stopping",
      "conversation_runtime.stopped",
    ]);
  });

  test("between polls, drops a session whose topic has been idle for its lifetime", async () => {
    const kept: number[] = [];
    let h: ReturnType<typeof harness> | undefined;
    // The sweep runs before each poll: after the turn, the clock moves to 9
    // minutes idle, then to 10.
    h = harness({
      script: [turnOf(), null, null],
      onPoll: (poll) => {
        if (poll === 2) h?.tick(9 * 60_000);
        if (poll === 3) {
          kept.push(h?.sessions.size ?? -1);
          h?.tick(60_000);
        }
        if (poll === 4) kept.push(h?.sessions.size ?? -1);
      },
    });

    await h.host.run();

    expect(kept).toEqual([1, 0]);
  });

  test("logs a turn by its ids and outcome, never its input, its answer or its token", async () => {
    const turn = turnOf();
    const h = harness({ script: [turn] });

    await h.host.run();

    const all = h.lines.join("\n");
    expect(all).toContain(turn.turn_id);
    expect(all).toContain(turn.call.id);
    expect(all).toContain(turn.scope.topic_id);
    expect(all).not.toContain(INPUT);
    expect(all).not.toContain(ANSWER);
    expect(all).not.toContain(TOKEN);
  });

  test("starts from an empty topics root, whatever an earlier process left", async () => {
    const stale = new TopicDirectories(root);
    const left = await stale.open(turnOf().scope.topic_id);
    const h = harness({ script: [] });

    await h.host.run();

    expect(await stat(left.root).catch(() => null)).toBeNull();
  });

  test("a poll that fails is tried again; a runner that throws is reported as a failed turn", async () => {
    const turn = turnOf();
    const h = harness({
      script: [new Error("gateway unreachable"), turn],
      run: async () => {
        throw new Error("engine would not start");
      },
    });

    await h.host.run();

    expect(h.reports).toEqual([
      {
        turnId: turn.turn_id,
        result: { outcome: "failed", reason: "runtime_failed" },
      },
    ]);
    expect(h.events()).toContain("conversation_runtime.poll_failed");
    expect(await readdir(root)).toEqual([]);
  });

  test("a report that does not arrive is sent again until it does", async () => {
    const turn = turnOf();
    const h = harness({
      script: [turn],
      report: (attempt) => (attempt < 3 ? new Error("503") : "recorded"),
    });

    await h.host.run();

    expect(h.reports).toHaveLength(1);
    expect(
      h.events().filter((event) => event === "conversation_turn.report_failed"),
    ).toHaveLength(2);
  });

  test("a report still failing at the lease's end is given up, and the next turn is served", async () => {
    const [expired, next] = [turnOf(-1), turnOf()];
    const h = harness({
      script: [expired, next],
      report: (attempt) => (attempt === 1 ? new Error("503") : "recorded"),
    });

    await h.host.run();

    expect(h.events()).toContain("conversation_turn.report_abandoned");
    expect(h.reports.map((report) => report.turnId)).toEqual([next.turn_id]);
  });

  test("a refused report is final", async () => {
    const h = harness({ script: [turnOf()], report: () => "refused" });

    await h.host.run();

    expect(h.reports).toHaveLength(1);
    expect(
      h.lines
        .map((line) => JSON.parse(line))
        .find((line) => line.event === "conversation_turn.reported")?.reported,
    ).toBe("refused");
  });

  test("stopping cuts the running turn, which is reported as interrupted, and takes no other", async () => {
    const [running, never] = [turnOf(), turnOf()];
    let host: ConversationHost | undefined;
    const h = harness({
      script: [running, never],
      run: (_turn, stop) =>
        new Promise((resolve) => {
          stop.addEventListener("abort", () =>
            resolve({ outcome: "failed", reason: "interrupted" }),
          );
          queueMicrotask(() => host?.stop("received SIGTERM"));
        }),
    });
    host = h.host;

    await h.host.run();

    expect(h.ran).toEqual([running.turn_id]);
    expect(h.reports).toEqual([
      {
        turnId: running.turn_id,
        result: { outcome: "failed", reason: "interrupted" },
      },
    ]);
  });

  test("writes when it last reached the control host, which the health check reads", async () => {
    const statusFile = join(root, "status.json");
    const lines: string[] = [];
    const topicsRoot = join(root, "topics");
    await (await import("node:fs/promises")).mkdir(topicsRoot);
    let host: ConversationHost | undefined;
    host = new ConversationHost({
      source: {
        async next() {
          host?.stop("done");
          return null;
        },
        async report() {
          return "recorded";
        },
      },
      runner: { run: async () => ({ outcome: "completed", text: "" }) },
      sessions: new TopicSessions(new TopicDirectories(topicsRoot)),
      logger: createConsoleLogger({ write: (line) => lines.push(line) }),
      statusFile,
    });

    expect(await healthy({ CONVERSATION_STATUS_FILE: statusFile })).toBe(false);
    await host.run();

    const { polled_at } = JSON.parse(await readFile(statusFile, "utf8"));
    expect(
      await healthy(
        { CONVERSATION_STATUS_FILE: statusFile },
        Date.parse(polled_at) + HEALTH_STALE_MS - 1_000,
      ),
    ).toBe(true);
    expect(
      await healthy(
        { CONVERSATION_STATUS_FILE: statusFile },
        Date.parse(polled_at) + HEALTH_STALE_MS + 1_000,
      ),
    ).toBe(false);
  });
});

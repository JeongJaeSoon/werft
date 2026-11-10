import { describe, expect, test } from "bun:test";
import type { RuntimeEvent } from "@werft-ai/runtime-core";

import { CodexRun, type CodexRunOptions } from "./run.ts";
import { FakeAppServer } from "./testing/fake-app-server.ts";

type Answers = "ask" | "edits" | "none";

function setup(answers: Answers = "ask", extra: Partial<CodexRunOptions> = {}) {
  const server = new FakeAppServer();
  let killed = false;
  const run = new CodexRun({
    transport: server,
    launch: {
      answers,
      approvalPolicy: "untrusted",
      developerInstructions: undefined,
      threadConfig: {},
    },
    cwd: "/work",
    model: "gpt-test",
    heldInputs: async () => new Set(),
    descendants: () => [],
    kill: () => {
      killed = true;
    },
    startupProblem: () => undefined,
    ...extra,
  });
  const seen: RuntimeEvent[] = [];
  const waiters: Array<() => void> = [];
  void (async () => {
    for await (const event of run.events()) {
      seen.push(event);
      for (const wake of waiters.splice(0)) wake();
    }
    for (const wake of waiters.splice(0)) wake();
  })();
  const until = async (found: () => RuntimeEvent | undefined) => {
    const deadline = Date.now() + 2_000;
    for (;;) {
      const hit = found();
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) {
        throw new Error(`Not seen: ${JSON.stringify(seen.map((e) => e.type))}`);
      }
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  };
  const ofType = (type: RuntimeEvent["type"]) => () =>
    seen.find((event) => event.type === type);
  return { server, run, seen, until, ofType, killed: () => killed };
}

const COMMAND = {
  type: "commandExecution",
  id: "call-1",
  command: "touch x",
  cwd: "/work",
  status: "inProgress",
};

async function started(t: ReturnType<typeof setup>) {
  await t.run.ready();
  t.run.send({ uuid: "in-1", message: "hello" });
  await t.until(() =>
    t.server.started("turn/start") ? ({ type: "x" } as never) : undefined,
  );
}

function announcePatch(
  t: ReturnType<typeof setup>,
  id: string,
  changes: Array<{ path: string; kind: string; diff: string }>,
) {
  t.server.emit("item/started", {
    threadId: "thread-1",
    item: { type: "fileChange", id, status: "inProgress", changes },
  });
}

function askCommand(t: ReturnType<typeof setup>) {
  t.server.emit("item/started", { threadId: "thread-1", item: COMMAND });
  return t.server.ask("item/commandExecution/requestApproval", {
    threadId: "thread-1",
    itemId: "call-1",
    command: "touch x",
    cwd: "/work",
  });
}

describe("start", () => {
  test("a new thread carries the claim's policy and never the sandbox", async () => {
    const t = setup();
    await t.run.ready();
    const start = t.server.started("thread/start");
    expect(start).toMatchObject({
      cwd: "/work",
      model: "gpt-test",
      approvalPolicy: "untrusted",
      sandbox: "danger-full-access",
      ephemeral: false,
    });
    expect(t.server.notifications).toEqual(["initialized"]);
  });

  test("a resume names the thread and restates the policy", async () => {
    const t = setup("ask", { resume: "thread-9" });
    await t.run.ready();
    expect(t.server.started("thread/resume")).toMatchObject({
      threadId: "thread-9",
      approvalPolicy: "untrusted",
    });
  });

  test("an engine that ignored a setting is a failed start", async () => {
    const t = setup("ask", { startupProblem: () => "ignored a setting" });
    await expect(t.run.ready()).rejects.toThrow("ignored a setting");
  });
});

describe("approvals", () => {
  test("a command is announced, then asked, and allow runs it", async () => {
    const t = setup();
    await started(t);
    const reply = askCommand(t);
    const asked = await t.until(t.ofType("approval.requested"));
    if (asked.type !== "approval.requested") throw new Error("unreachable");

    const order = t.seen.map((e) => e.type).filter((type) => type !== "public");
    expect(order).toEqual(["tool.called", "approval.requested"]);
    expect(asked.request.tool.name).toBe("exec_command");

    const result = await t.run.answer({
      localId: asked.request.localId,
      inputHash: asked.request.inputHash,
      kind: "selected",
      optionKind: "allow_once",
    });
    expect(result).toBe("applied");
    expect(await reply).toEqual({ decision: "accept" });
  });

  test("deny declines", async () => {
    const t = setup();
    await started(t);
    const reply = askCommand(t);
    const asked = await t.until(t.ofType("approval.requested"));
    if (asked.type !== "approval.requested") throw new Error("unreachable");
    await t.run.answer({
      localId: asked.request.localId,
      inputHash: asked.request.inputHash,
      kind: "selected",
      optionKind: "reject_once",
    });
    expect(await reply).toEqual({ decision: "decline" });
  });

  test("an answer for other arguments is stale and the request stays open", async () => {
    const t = setup();
    await started(t);
    const reply = askCommand(t);
    const asked = await t.until(t.ofType("approval.requested"));
    if (asked.type !== "approval.requested") throw new Error("unreachable");
    const result = await t.run.answer({
      localId: asked.request.localId,
      inputHash: "0".repeat(64),
      kind: "selected",
      optionKind: "allow_once",
    });
    expect(result).toBe("stale");
    await t.run.answer({
      localId: asked.request.localId,
      inputHash: asked.request.inputHash,
      kind: "selected",
      optionKind: "reject_once",
    });
    expect(await reply).toEqual({ decision: "decline" });
  });

  test("dontAsk declines every ask without a person", async () => {
    const t = setup("none");
    await started(t);
    expect(await askCommand(t)).toEqual({ decision: "decline" });
    expect(t.seen.some((e) => e.type === "approval.requested")).toBe(false);
  });

  test("acceptEdits accepts a file change and still asks the person about commands", async () => {
    const t = setup("edits");
    await started(t);
    announcePatch(t, "patch-1", [{ path: "a.txt", kind: "add", diff: "+hi" }]);
    const change = await t.server.ask("item/fileChange/requestApproval", {
      threadId: "thread-1",
      itemId: "patch-1",
      grantRoot: "/work",
    });
    expect(change).toEqual({ decision: "accept" });

    const reply = askCommand(t);
    const asked = await t.until(t.ofType("approval.requested"));
    if (asked.type !== "approval.requested") throw new Error("unreachable");
    expect(asked.request.tool.name).toBe("exec_command");
    await t.run.answer({
      localId: asked.request.localId,
      inputHash: asked.request.inputHash,
      kind: "selected",
      optionKind: "allow_once",
    });
    expect(await reply).toEqual({ decision: "accept" });
  });

  test("a file change the engine never announced is declined, in every mode", async () => {
    for (const answers of ["ask", "edits"] as const) {
      const t = setup(answers);
      await started(t);
      expect(
        await t.server.ask("item/fileChange/requestApproval", {
          threadId: "thread-1",
          itemId: "unseen",
          grantRoot: "/work",
        }),
      ).toEqual({ decision: "decline" });
    }
  });

  test("the same path with another diff is another approval", async () => {
    const t = setup();
    await started(t);
    const hashes: string[] = [];
    for (const [id, diff] of [
      ["patch-a", "+one"],
      ["patch-b", "+two"],
    ] as const) {
      announcePatch(t, id, [{ path: "a.txt", kind: "update", diff }]);
      void t.server.ask("item/fileChange/requestApproval", {
        threadId: "thread-1",
        itemId: id,
        grantRoot: "/work",
      });
      await t.until(() =>
        t.seen.filter((e) => e.type === "approval.requested").length ===
        hashes.length + 1
          ? ({ type: "x" } as never)
          : undefined,
      );
      const asked = t.seen
        .filter((e) => e.type === "approval.requested")
        .at(-1);
      if (asked?.type !== "approval.requested") throw new Error("unreachable");
      hashes.push(asked.request.inputHash);
    }
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  test("an approval is bound to the changes, not to the directory they are under", async () => {
    const t = setup();
    await started(t);
    const hashes: string[] = [];
    for (const [id, path] of [
      ["patch-a", "a.txt"],
      ["patch-b", "b.txt"],
    ] as const) {
      announcePatch(t, id, [{ path, kind: "update", diff: `+${path}` }]);
      void t.server.ask("item/fileChange/requestApproval", {
        threadId: "thread-1",
        itemId: id,
        grantRoot: "/work",
      });
      await t.until(() =>
        t.seen.filter((e) => e.type === "approval.requested").length ===
        hashes.length + 1
          ? ({ type: "x" } as never)
          : undefined,
      );
      const asked = t.seen
        .filter((e) => e.type === "approval.requested")
        .at(-1);
      if (asked?.type !== "approval.requested") throw new Error("unreachable");
      expect(asked.request.tool.input).toMatchObject({ paths: [path] });
      hashes.push(asked.request.inputHash);
    }
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  test("a tool the host refuses is declined before anyone is asked", async () => {
    const t = setup("ask", { precheckTool: async () => "denied by rule" });
    await started(t);
    expect(await askCommand(t)).toEqual({ decision: "decline" });
    expect(t.seen.some((e) => e.type === "approval.requested")).toBe(false);
  });

  test("the engine withdrawing a request resolves it as withdrawn", async () => {
    const t = setup();
    await started(t);
    void askCommand(t);
    await t.until(t.ofType("approval.requested"));
    t.server.emit("serverRequest/resolved", {
      threadId: "thread-1",
      requestId: 100,
    });
    const resolved = await t.until(t.ofType("approval.resolved"));
    expect(resolved).toMatchObject({ outcome: "withdrawn" });
  });

  test("questions, permission grants and dynamic tools are refused", async () => {
    const t = setup();
    await started(t);
    for (const method of [
      "item/tool/requestUserInput",
      "item/permissions/requestApproval",
      "item/tool/call",
    ]) {
      await expect(
        t.server.ask(method, { threadId: "thread-1" }),
      ).rejects.toThrow("does not answer");
    }
  });

  test("an elicitation from a server the run does not relay is declined", async () => {
    const t = setup();
    await started(t);
    await expect(
      t.server.ask("mcpServer/elicitation/request", {
        threadId: "thread-1",
        serverName: "other",
      }),
    ).resolves.toMatchObject({ action: "decline" });
  });
});

describe("turns", () => {
  test("a turn is sent once per input uuid and ends with its usage", async () => {
    const t = setup();
    await started(t);
    t.run.send({ uuid: "in-1", message: "hello" });
    expect(
      t.server.requests.filter((r) => r.method === "turn/start"),
    ).toHaveLength(1);
    expect(t.server.started("turn/start")).toMatchObject({
      threadId: "thread-1",
      clientUserMessageId: "in-1",
    });

    t.server.emit("thread/tokenUsage/updated", {
      threadId: "thread-1",
      tokenUsage: {
        last: {
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
        },
      },
    });
    t.server.emit("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    const ended = await t.until(t.ofType("turn.ended"));
    if (ended.type !== "turn.ended") throw new Error("unreachable");
    expect(ended.turn).toMatchObject({
      isError: false,
      inputs: ["in-1"],
      usage: { input_tokens: 10, output_tokens: 5 },
      cost: { unknown: true },
    });
  });

  test("an input the thread already holds is not sent again", async () => {
    const t = setup("ask", { heldInputs: async () => new Set(["in-1"]) });
    await t.run.ready();
    t.run.send({ uuid: "in-1", message: "hello" });
    expect(await t.run.holdsInput("in-1")).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(t.server.started("turn/start")).toBeUndefined();
  });

  test("interrupt returns what stayed queued and stops the active turn", async () => {
    const t = setup();
    await started(t);
    t.run.send({ uuid: "in-2", message: "later" });
    const result = await t.run.interrupt();
    expect(result.stillQueued).toEqual(["in-2"]);
    expect(t.server.started("turn/interrupt")).toMatchObject({
      turnId: "turn-1",
    });
  });

  test("an engine that exits fails the turn and ends the stream", async () => {
    const t = setup();
    await started(t);
    t.server.exit({ code: 1, signal: null, stderr: "boom" });
    const ended = await t.until(t.ofType("turn.ended"));
    if (ended.type !== "turn.ended") throw new Error("unreachable");
    expect(ended.turn.isError).toBe(true);
  });
});

describe("checkpoints", () => {
  test("an idle thread is ready and names the thread to resume", async () => {
    const t = setup();
    await t.run.ready();
    const prepared = await t.run.prepareCheckpoint("turn_end");
    expect(prepared).toMatchObject({
      status: "ready",
      checkpoint: { engine: "codex", resume: "thread-1" },
    });
    expect(t.server.started("thread/read")).toBeDefined();
  });

  test("a running turn is not a checkpoint", async () => {
    const t = setup();
    await started(t);
    expect(await t.run.prepareCheckpoint("turn_end")).toMatchObject({
      status: "rejected",
      reason: "turn_in_flight",
    });
  });

  test("a running tool is not a checkpoint", async () => {
    const t = setup();
    await t.run.ready();
    t.server.emit("item/started", { threadId: "thread-1", item: COMMAND });
    expect(await t.run.prepareCheckpoint("turn_end")).toMatchObject({
      status: "rejected",
      reason: "tool_in_flight",
    });
  });

  test("a process the engine left behind is not a checkpoint", async () => {
    const t = setup("ask", { descendants: () => [4242] });
    await t.run.ready();
    expect(await t.run.prepareCheckpoint("turn_end")).toMatchObject({
      status: "rejected",
      reason: "background_writer",
    });
  });

  test("two checkpoints asked at once: one is taken, one is told a checkpoint is being taken", async () => {
    const t = setup();
    await t.run.ready();
    let release!: () => void;
    t.server.on(
      "thread/read",
      () =>
        new Promise((resolve) => {
          release = () => resolve({ thread: { id: "thread-1" } });
        }),
    );
    const one = t.run.leaseCheckpoint("turn_end");
    const two = t.run.leaseCheckpoint("turn_end");
    expect((await two).preparation).toMatchObject({
      status: "rejected",
      reason: "checkpoint_lease_held",
    });
    release();
    expect((await one).preparation).toMatchObject({ status: "ready" });
  });

  test("no turn starts while the engine's record is being flushed", async () => {
    const t = setup();
    await t.run.ready();
    let release!: () => void;
    t.server.on(
      "thread/read",
      () =>
        new Promise((resolve) => {
          release = () => resolve({ thread: { id: "thread-1" } });
        }),
    );
    const preparing = t.run.prepareCheckpoint("turn_end");
    t.run.send({ uuid: "in-1", message: "hi" });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.server.started("turn/start")).toBeUndefined();
    release();
    expect(await preparing).toMatchObject({ status: "ready" });
    await t.until(() =>
      t.server.started("turn/start") ? ({ type: "x" } as never) : undefined,
    );
  });

  test("a tool the engine started while the record was flushed is not a checkpoint", async () => {
    const t = setup();
    await t.run.ready();
    let release!: () => void;
    t.server.on(
      "thread/read",
      () =>
        new Promise((resolve) => {
          release = () => resolve({ thread: { id: "thread-1" } });
        }),
    );
    const preparing = t.run.prepareCheckpoint("turn_end");
    t.server.emit("item/started", { threadId: "thread-1", item: COMMAND });
    release();
    expect(await preparing).toMatchObject({
      status: "rejected",
      reason: "tool_in_flight",
    });
  });

  test("a system that cannot list the engine's children is not called quiet", async () => {
    const t = setup("ask", { descendants: () => undefined });
    await t.run.ready();
    expect(await t.run.prepareCheckpoint("turn_end")).toMatchObject({
      status: "rejected",
      reason: "background_writer",
    });
  });

  test("a held lease holds off a second one and the next turn", async () => {
    const t = setup();
    await t.run.ready();
    const grant = await t.run.leaseCheckpoint("turn_end");
    expect(grant.lease).not.toBeNull();
    expect(await t.run.prepareCheckpoint("turn_end")).toMatchObject({
      reason: "checkpoint_lease_held",
    });
    t.run.send({ uuid: "in-1", message: "hi" });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.server.started("turn/start")).toBeUndefined();
    grant.lease?.release();
    await t.until(() =>
      t.server.started("turn/start") ? ({ type: "x" } as never) : undefined,
    );
  });

  test("approval checkpoints are not offered", async () => {
    const t = setup();
    await t.run.ready();
    expect(await t.run.prepareCheckpoint("approval_wait")).toMatchObject({
      status: "rejected",
    });
  });
});

describe("abort", () => {
  test("kills the engine process and ends the stream", async () => {
    const t = setup();
    await t.run.ready();
    t.run.abort();
    expect(t.killed()).toBe(true);
  });
});

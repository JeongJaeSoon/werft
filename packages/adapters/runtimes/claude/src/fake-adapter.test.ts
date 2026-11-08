import { describe, expect, test } from "bun:test";
import type { ClaudeRuntimeConfig } from "./config.ts";
import type { AgentFrame } from "./driver.ts";
import { FakeAgentRuntime } from "./testing/fake-adapter.ts";

const config: ClaudeRuntimeConfig = {
  claudeConfigDir: "/tmp/fake/config",
  correlationId: "fake-correlation",
  mode: "new",
  cwd: "/tmp/fake/workspace",
  home: "/tmp/fake/home",
  model: "fake-model",
  profile: {
    kind: "anthropic",
    endpoint: "http://127.0.0.1:4000",
    auth: { kind: "api_key", value: "placeholder" },
    principal: { ownerScope: "owner-a" },
  },
  tools: ["Read"],
};

describe("fake agent runtime", () => {
  test("a deduplicated send does not count as an arrival", async () => {
    const runtime = new FakeAgentRuntime(
      [
        { type: "await-input" },
        { type: "await-input" },
        {
          type: "emit",
          message: { type: "result", subtype: "success", session_id: "r" },
        },
      ],
      { resumedTranscript: ["old"] },
    );
    const run = runtime.start(
      { ...config, mode: "resume", resume: "r" },
      { onPermission: async () => ({ behavior: "allow" as const }) },
    );
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })().catch(() => {});
    run.send({ message: "old", uuid: "old" });
    run.send({ message: "fresh", uuid: "fresh" });
    await Bun.sleep(20);
    // Only one input was taken; the script is still waiting on its second.
    expect(frames).toEqual([]);
    run.close();
    await consume;
  });

  test("ignores an input its resumed transcript already holds, the way the SDK does", async () => {
    const runtime = new FakeAgentRuntime(
      [
        { type: "await-input" },
        {
          type: "emit",
          message: {
            type: "result",
            subtype: "success",
            session_id: "resumed",
            user_message_uuid: "fresh",
          },
        },
      ],
      { resumedTranscript: ["consumed"] },
    );
    const allow = {
      onPermission: async () => ({ behavior: "allow" as const }),
    };
    // Only a resumed run carries the transcript; a new session holds nothing.
    expect(await runtime.start(config, allow).holdsInput("consumed")).toBe(
      false,
    );
    const run = runtime.start(
      { ...config, mode: "resume", resume: "resumed" },
      allow,
    );
    expect(await run.holdsInput("consumed")).toBe(true);
    expect(await run.holdsInput("fresh")).toBe(false);

    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({ message: "again", uuid: "consumed" });
    // No answer, and an interrupt has nothing running to end.
    expect(await run.interrupt()).toEqual({ stillQueued: [] });
    await Bun.sleep(20);
    expect(frames).toEqual([]);

    // The ignored send is no arrival: the script still waits for a real one.
    expect(frames).toEqual([]);
    // A fresh input is still taken, and is held from then on.
    run.send({ message: "new", uuid: "fresh" });
    await consume;
    expect(frames.map((frame) => frame.envelope.message.type)).toEqual([
      "result",
    ]);
    expect(await run.holdsInput("fresh")).toBe(true);
    expect(runtime.inputs.map((input) => input.uuid)).toEqual([
      "consumed",
      "fresh",
    ]);
  });

  test("prepares a checkpoint only once a session id is known and the turn has ended", async () => {
    const runtime = new FakeAgentRuntime([
      {
        type: "emit",
        message: { type: "system", subtype: "init", session_id: "ckpt" },
      },
      {
        type: "emit",
        message: {
          type: "result",
          subtype: "success",
          session_id: "ckpt",
          user_message_uuid: "go",
        },
      },
    ]);
    const allow = {
      onPermission: async () => ({ behavior: "allow" as const }),
    };
    const run = runtime.start(config, allow);
    expect(await run.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "no_engine_session",
      detail: "No SDK session has started",
    });
    run.send({ message: "go", uuid: "go" });
    const iterator = run.events()[Symbol.asyncIterator]();
    await iterator.next();
    expect(await run.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "turn_in_flight",
      detail: "A turn is still running",
    });
    await iterator.next();
    await iterator.next();
    expect(await run.prepareCheckpoint()).toEqual({
      status: "ready",
      checkpoint: { engine: "claude", resume: "ckpt", sdkVersion: "0.3.319" },
    });
    const resumed = runtime.start(
      { ...config, mode: "resume", resume: "ckpt" },
      allow,
    );
    expect(await resumed.prepareCheckpoint()).toEqual({
      status: "ready",
      checkpoint: { engine: "claude", resume: "ckpt", sdkVersion: "0.3.319" },
    });
    resumed.send({ message: "queued", uuid: "queued-1" });
    expect(await resumed.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "turn_in_flight",
      detail: "A turn is still running",
    });
  });

  test("rejects a checkpoint while a second queued input is still outstanding", async () => {
    const result = { type: "result", subtype: "success", session_id: "two" };
    const runtime = new FakeAgentRuntime([
      { type: "emit", message: { ...result, user_message_uuid: "1" } },
      { type: "emit", message: { ...result, user_message_uuid: "2" } },
    ]);
    const run = runtime.start(config, {
      onPermission: async () => ({ behavior: "allow" }),
    });
    run.send({ message: "one", uuid: "1" });
    run.send({ message: "two", uuid: "2" });
    const iterator = run.events()[Symbol.asyncIterator]();
    await iterator.next();
    expect(await run.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "turn_in_flight",
      detail: "A turn is still running",
    });
    await iterator.next();
    expect((await run.prepareCheckpoint()).status).toBe("ready");
  });

  test("an interrupt settles the queued inputs so a checkpoint becomes possible", async () => {
    const run = new FakeAgentRuntime([
      { type: "delay", delayMs: 10_000 },
    ]).start(
      { ...config, mode: "resume", resume: "ckpt" },
      { onPermission: async () => ({ behavior: "allow" }) },
    );
    run.send({ message: "one", uuid: "u1" });
    run.send({ message: "two", uuid: "u2" });
    expect((await run.prepareCheckpoint()).status).toBe("rejected");
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    await Bun.sleep(5);
    expect(await run.interrupt()).toEqual({ stillQueued: [] });
    await consume;
    expect(frames).toHaveLength(1);
    expect(frames[0]?.envelope.message.terminal_reason).toBe(
      "aborted_streaming",
    );
    expect(frames[0]?.envelope.message.user_message_uuids).toEqual([
      "u1",
      "u2",
    ]);
    // The interrupt's result names the session the run resumed, as the SDK's does.
    expect(await run.prepareCheckpoint()).toEqual({
      status: "ready",
      checkpoint: {
        engine: "claude",
        resume: "ckpt",
        sdkVersion: "0.3.319",
      },
    });
  });

  test("the first accepted terminal action wins between interrupt and abort", async () => {
    const start = () =>
      new FakeAgentRuntime([{ type: "delay", delayMs: 10_000 }]).start(
        { ...config, mode: "resume", resume: "ckpt" },
        { onPermission: async () => ({ behavior: "allow" }) },
      );

    const interruptedFirst = start();
    interruptedFirst.send({ message: "one", uuid: "u1" });
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of interruptedFirst) frames.push(frame);
    })();
    await Bun.sleep(5);
    await interruptedFirst.interrupt();
    interruptedFirst.abort();
    await consume;
    expect(
      frames.map((frame) => frame.envelope.message.terminal_reason),
    ).toEqual(["aborted_streaming"]);
    expect((await interruptedFirst.prepareCheckpoint()).status).toBe("ready");

    const abortedFirst = start();
    abortedFirst.send({ message: "one", uuid: "u1" });
    const consumeAborted = (async () => {
      for await (const _frame of abortedFirst) void _frame;
    })();
    await Bun.sleep(5);
    abortedFirst.abort();
    await abortedFirst.interrupt();
    await expect(consumeAborted).rejects.toMatchObject({ name: "AbortError" });
    expect((await abortedFirst.prepareCheckpoint()).status).toBe("rejected");
  });

  test("an interrupt ends only the current turn; the next scripted turn still runs", async () => {
    const result = { type: "result", subtype: "success", session_id: "s" };
    const run = new FakeAgentRuntime([
      { type: "await-input" },
      { type: "delay", delayMs: 10_000 },
      { type: "emit", message: { ...result, user_message_uuid: "u1" } },
      { type: "await-input" },
      { type: "emit", message: { ...result, user_message_uuid: "u2" } },
    ]).start(config, { onPermission: async () => ({ behavior: "allow" }) });
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({ message: "one", uuid: "u1" });
    await Bun.sleep(5);
    await run.interrupt();
    await waitFor(() => frames.length === 1);
    expect(frames[0]?.envelope.message.terminal_reason).toBe(
      "aborted_streaming",
    );
    expect(frames[0]?.envelope.message.user_message_uuid).toBe("u1");
    expect((await run.prepareCheckpoint()).status).toBe("ready");

    run.send({ message: "two", uuid: "u2" });
    await within(consume, 200);
    expect(frames.map((frame) => frame.envelope.message.subtype)).toEqual([
      "error_during_execution",
      "success",
    ]);
    expect(frames[1]?.envelope.message.user_message_uuid).toBe("u2");
  });

  test("an interrupt settles the tools it cut short and drops the inputs it named", async () => {
    const result = { type: "result", subtype: "success", session_id: "s" };
    const runtime = new FakeAgentRuntime([
      { type: "await-input" },
      { type: "tool-start", toolUseId: "toolu_cut" },
      { type: "delay", delayMs: 10_000 },
      { type: "tool-end", toolUseId: "toolu_cut" },
      { type: "emit", message: { ...result, user_message_uuid: "u1" } },
      { type: "await-input" },
      { type: "emit", message: { ...result, user_message_uuid: "u3" } },
    ]);
    const run = runtime.start(config, {
      onPermission: async () => ({ behavior: "allow" }),
    });
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({ message: "one", uuid: "u1" });
    run.send({ message: "queued", uuid: "u2" });
    await waitFor(() => runtime.toolAdmissions.length === 1);
    await run.interrupt();
    await waitFor(() => frames.length === 1);
    // A tool was running, so the SDK names that abort, not a streaming one.
    expect(frames[0]?.envelope.message.terminal_reason).toBe("aborted_tools");
    expect(frames[0]?.envelope.message.user_message_uuids).toEqual([
      "u1",
      "u2",
    ]);
    expect((await run.prepareCheckpoint()).status).toBe("ready");

    // u2 ended with the interrupt, so the next turn waits for a new input.
    run.send({ message: "three", uuid: "u3" });
    await within(consume, 200);
    expect(
      frames.map((frame) => frame.envelope.message.user_message_uuid),
    ).toEqual(["u2", "u3"]);
  });

  test("an interrupt in the last turn settles its tools before the terminal is read", async () => {
    const runtime = new FakeAgentRuntime([
      { type: "await-input" },
      { type: "tool-start", toolUseId: "toolu_last" },
      { type: "delay", delayMs: 10_000 },
      { type: "tool-end", toolUseId: "toolu_last" },
    ]);
    const run = runtime.start(config, {
      onPermission: async () => ({ behavior: "allow" }),
    });
    const iterator = run[Symbol.asyncIterator]();
    run.send({ message: "one", uuid: "u1" });
    const first = iterator.next();
    await waitFor(() => runtime.toolAdmissions.length === 1);
    await run.interrupt();
    expect((await first).done).toBe(false);
    expect((await run.prepareCheckpoint()).status).toBe("ready");
    expect((await iterator.next()).done).toBe(true);
  });

  test("an input sent after the interrupt terminal is delivered survives into the next turn", async () => {
    const result = { type: "result", subtype: "success", session_id: "s" };
    const run = new FakeAgentRuntime([
      { type: "await-input" },
      { type: "delay", delayMs: 10_000 },
      { type: "await-input" },
      { type: "emit", message: { ...result, user_message_uuid: "u2" } },
    ]).start(config, { onPermission: async () => ({ behavior: "allow" }) });
    const iterator = run[Symbol.asyncIterator]();
    run.send({ message: "one", uuid: "u1" });
    const first = iterator.next();
    await Bun.sleep(5);
    await run.interrupt();
    await first;
    // Sent while the generator is suspended on the terminal it just yielded.
    run.send({ message: "two", uuid: "u2" });
    const second = await within(iterator.next(), 200);
    expect(second.done).toBe(false);
  });

  test("rejects a duplicate uuid before it reaches the input queue", () => {
    const runtime = new FakeAgentRuntime([]);
    const run = runtime.start(config, {
      onPermission: async () => ({ behavior: "allow" }),
    });
    run.send({ message: "one", uuid: "dup" });
    expect(() => run.send({ message: "again", uuid: "dup" })).toThrow(
      "Input uuid is already queued: dup",
    );
    expect(runtime.inputs).toHaveLength(1);
  });

  test("refuses a second event consumer", async () => {
    const run = new FakeAgentRuntime([]).start(config, {
      onPermission: async () => ({ behavior: "allow" }),
    });
    await run.events()[Symbol.asyncIterator]().next();
    await expect(
      (async () => {
        for await (const _frame of run) void _frame;
      })(),
    ).rejects.toThrow("AgentRun events can only be consumed once");
  });

  test("controls init, arbitrary order, usage, and result errors", async () => {
    const runtime = new FakeAgentRuntime([
      {
        type: "emit",
        message: { type: "system", subtype: "init", session_id: "fake" },
      },
      {
        type: "emit",
        message: { type: "tool_use_summary", summary: "later first" },
      },
      {
        type: "emit",
        message: {
          type: "result",
          subtype: "error_max_turns",
          session_id: "fake",
          is_error: true,
          usage: { input_tokens: 2 },
        },
      },
    ]);
    const run = runtime.start(config, {
      onPermission: async () => ({
        behavior: "deny",
        message: "unused",
      }),
    });
    run.send({ message: "start", uuid: "input-1" });
    run.finishInput();
    const frames = [];
    for await (const frame of run) frames.push(frame);
    expect(runtime.inputs).toEqual([{ message: "start", uuid: "input-1" }]);
    expect(frames.map((frame) => frame.envelope.message.type)).toEqual([
      "system",
      "tool_use_summary",
      "result",
    ]);
    expect(frames[2]?.events[0]?.event).toBe("result");
  });

  test("runs permission callbacks in parallel", async () => {
    const runtime = new FakeAgentRuntime([
      {
        type: "permissions",
        requests: ["one", "two"].map((id) => ({
          input: { id },
          requestId: `request-${id}`,
          tool: "Read",
          toolUseId: `tool-${id}`,
        })),
      },
    ]);
    let active = 0;
    let maxActive = 0;
    const run = runtime.start(config, {
      onPermission: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(10);
        active -= 1;
        return { behavior: "allow" };
      },
    });
    const frames: AgentFrame[] = [];
    for await (const frame of run) frames.push(frame);
    // Only the assistant message carrying both calls, before they are asked.
    expect(
      frames.map((frame) => frame.events.map((item) => item.event)),
    ).toEqual([["tool_use", "tool_use"]]);
    expect(maxActive).toBe(2);
    expect(runtime.permissionDecisions).toHaveLength(2);
  });

  test("distinguishes interrupt, abort, and injected exceptions", async () => {
    const interruptRuntime = new FakeAgentRuntime([
      { type: "delay", delayMs: 1 },
      {
        type: "emit",
        message: { type: "assistant", message: { content: [] } },
      },
    ]);
    const interrupted = interruptRuntime.start(config, {
      onPermission: async () => ({
        behavior: "allow",
      }),
    });
    await interrupted.interrupt();
    const interruptedFrames = [];
    for await (const frame of interrupted) interruptedFrames.push(frame);
    expect(interruptedFrames[0]?.envelope.message.terminal_reason).toBe(
      "aborted_streaming",
    );

    const aborted = interruptRuntime.start(config, {
      onPermission: async () => ({
        behavior: "allow",
      }),
    });
    aborted.abort();
    await expect(async () => {
      for await (const _frame of aborted) void _frame;
    }).toThrow("Run aborted");

    const failure = new FakeAgentRuntime([
      { type: "error", error: new Error("injected fake failure") },
    ]).start(config, { onPermission: async () => ({ behavior: "allow" }) });
    await expect(async () => {
      for await (const _frame of failure) void _frame;
    }).toThrow("injected fake failure");
  });

  test("aborts delay and pending permission waits immediately", async () => {
    const delayed = new FakeAgentRuntime([
      { type: "delay", delayMs: 10_000 },
    ]).start(config, { onPermission: async () => ({ behavior: "allow" }) });
    const delayedConsume = (async () => {
      for await (const _frame of delayed) void _frame;
    })();
    await Bun.sleep(5);
    delayed.abort();
    await expect(delayedConsume).rejects.toMatchObject({ name: "AbortError" });

    let permissionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    const pending = new FakeAgentRuntime([
      {
        type: "permissions",
        requests: [
          {
            input: {},
            requestId: "pending-request",
            tool: "Read",
            toolUseId: "pending-tool",
          },
        ],
      },
    ]).start(config, {
      onPermission: async ({ signal }) => {
        permissionStarted?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { behavior: "deny", message: "aborted" };
      },
    });
    const pendingConsume = (async () => {
      for await (const _frame of pending) void _frame;
    })();
    await started;
    pending.abort();
    await expect(pendingConsume).rejects.toMatchObject({ name: "AbortError" });
  });

  test("interrupts delay and pending permission waits immediately", async () => {
    const delayed = new FakeAgentRuntime([
      { type: "delay", delayMs: 10_000 },
    ]).start(config, { onPermission: async () => ({ behavior: "allow" }) });
    const delayedFrames: AgentFrame[] = [];
    const delayedConsume = (async () => {
      for await (const frame of delayed) delayedFrames.push(frame);
    })();
    await Bun.sleep(5);
    await delayed.interrupt();
    await within(delayedConsume, 100);
    expect(delayedFrames[0]?.envelope.message.terminal_reason).toBe(
      "aborted_streaming",
    );

    let permissionStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      permissionStarted = resolve;
    });
    const pending = new FakeAgentRuntime([
      {
        type: "permissions",
        requests: [
          {
            input: {},
            requestId: "pending-request",
            tool: "Read",
            toolUseId: "pending-tool",
          },
        ],
      },
    ]).start(config, {
      onPermission: async ({ signal }) => {
        permissionStarted?.();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { behavior: "deny", message: "interrupted" };
      },
    });
    const pendingFrames: AgentFrame[] = [];
    const pendingConsume = (async () => {
      for await (const frame of pending) pendingFrames.push(frame);
    })();
    await started;
    await pending.interrupt();
    await within(pendingConsume, 100);
    // After the frame carrying the call the permission was about.
    expect(pendingFrames[1]?.envelope.message.terminal_reason).toBe(
      "aborted_tools",
    );
  });

  test("an interrupt after the calls frame asks no permission", async () => {
    let asked = 0;
    const run = new FakeAgentRuntime([
      {
        type: "permissions",
        requests: [
          { input: {}, requestId: "request", tool: "Read", toolUseId: "tool" },
        ],
      },
    ]).start(config, {
      onPermission: async () => {
        asked += 1;
        return { behavior: "allow" };
      },
    });
    const frames: AsyncIterator<AgentFrame> = run[Symbol.asyncIterator]();
    const calls: AgentFrame = (await frames.next()).value;
    expect(calls.events.map((item) => item.event)).toEqual(["tool_use"]);
    await run.interrupt();
    const terminal: AgentFrame = (await within(frames.next(), 100)).value;
    expect(terminal.envelope.message.terminal_reason).toBe("aborted_tools");
    expect((await frames.next()).done).toBe(true);
    expect(asked).toBe(0);
  });

  test("await-input holds the script until each turn's input arrives", async () => {
    const runtime = new FakeAgentRuntime([
      { type: "await-input" },
      {
        type: "emit",
        message: {
          type: "result",
          subtype: "success",
          session_id: "s",
          user_message_uuid: "first",
        },
      },
      { type: "await-input" },
      {
        type: "emit",
        message: {
          type: "result",
          subtype: "success",
          session_id: "s",
          user_message_uuid: "second",
        },
      },
    ]);
    const run = runtime.start(config, {
      onPermission: async () => ({ behavior: "allow" as const }),
    });
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();

    run.send({ message: "one", uuid: "first" });
    await within(
      waitFor(() => frames.length === 1),
      200,
    );
    // Nothing more can be emitted until the second input is sent.
    await Bun.sleep(10);
    expect(frames).toHaveLength(1);

    run.send({ message: "two", uuid: "second" });
    await within(consume, 200);
    expect(
      frames.map((frame) => frame.envelope.message.user_message_uuid),
    ).toEqual(["first", "second"]);
  });

  test("await-input stops waiting once the input stream is closed", async () => {
    const runtime = new FakeAgentRuntime([
      { type: "await-input" },
      { type: "emit", message: { type: "system", subtype: "done" } },
    ]);
    const run = runtime.start(config, {
      onPermission: async () => ({ behavior: "allow" as const }),
    });
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.finishInput();
    await within(consume, 200);

    expect(frames).toHaveLength(1);
  });
});

describe("fake run checkpoint quiescence", () => {
  const resumed = { ...config, mode: "resume" as const, resume: "ckpt" };

  test("an open tool callback refuses a checkpoint between turns", async () => {
    let answer: (() => void) | undefined;
    const run = new FakeAgentRuntime([
      {
        type: "permissions",
        requests: [
          { input: {}, requestId: "r1", tool: "Bash", toolUseId: "toolu_1" },
        ],
      },
    ]).start(resumed, {
      onPermission: () =>
        new Promise((resolve) => {
          answer = () => resolve({ behavior: "allow" });
        }),
    });
    const consume = (async () => {
      for await (const _frame of run) void _frame;
    })();
    await waitFor(() => answer !== undefined);
    expect(await run.prepareCheckpoint()).toEqual({
      status: "rejected",
      reason: "tool_in_flight",
      detail: "1 tool call(s) still running",
    });
    expect((await run.leaseCheckpoint()).lease).toBeNull();
    answer?.();
    await consume;
    expect((await run.prepareCheckpoint()).status).toBe("ready");
  });

  test("a tool that starts while the lease is held is refused", async () => {
    const runtime = new FakeAgentRuntime([
      { type: "tool-start", toolUseId: "toolu_before" },
      { type: "tool-end", toolUseId: "toolu_before" },
      { type: "delay", delayMs: 50 },
      { type: "tool-start", toolUseId: "toolu_during" },
      {
        type: "permissions",
        requests: [
          { input: {}, requestId: "r1", tool: "Bash", toolUseId: "toolu_x" },
        ],
      },
    ]);
    const run = runtime.start(resumed, {
      onPermission: async () => ({ behavior: "allow" }),
    });
    const consume = (async () => {
      for await (const _frame of run) void _frame;
    })();
    await waitFor(() => runtime.toolAdmissions.length === 1);
    const grant = await run.leaseCheckpoint();
    expect(grant.preparation.status).toBe("ready");
    await consume;

    const refused =
      "A checkpoint is being saved; no tool may start until it is committed";
    expect(runtime.toolAdmissions).toEqual([
      { toolUseId: "toolu_before", admission: { allowed: true } },
      {
        toolUseId: "toolu_during",
        admission: { allowed: false, message: refused },
      },
    ]);
    expect(runtime.permissionDecisions).toEqual([
      { behavior: "deny", message: refused },
    ]);
    grant.lease?.release();
  });
});

async function waitFor(
  condition: () => boolean,
  intervalMs = 1,
): Promise<void> {
  while (!condition()) await Bun.sleep(intervalMs);
}

async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    operation,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error("Operation did not settle within the expected time");
    }),
  ]);
}

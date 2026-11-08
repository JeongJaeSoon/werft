import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { type Options, query } from "@anthropic-ai/claude-agent-sdk";
import type { TranscriptKey } from "@werft-ai/runtime-core";
import { createMemoryCheckpointObjectStore } from "@werft-ai/testkit/checkpoint-objects";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";
import type { ClaudeRuntimeConfig } from "./config.ts";
import type { AgentFrame } from "./driver.ts";
import { InputStream } from "./run.ts";
import { buildSdkOptions, ClaudeSdkRuntime } from "./runtime.ts";
import { ClaudeSessionStore } from "./session-store.ts";
import { TurnLedger } from "./turn-ledger.ts";

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

describe("actual Claude SDK adapter with local Messages API", () => {
  test("keeps a streaming process across turns with explicit isolated options", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-18-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      textReply(`turn-${index + 1}`),
    );
    const spawnedPids: number[] = [];
    const exitedPids: number[] = [];
    const runtime = new ClaudeSdkRuntime(
      {
        endpoints: [server.url],
        models: ["claude-sonnet-4-5"],
      },
      {
        onSpawn: (pid) => spawnedPids.push(pid),
        onExit: (pid) => exitedPids.push(pid),
      },
    );
    const runtimeConfig = {
      appendSystemPrompt: "APPEND_SENTINEL_94S_18",
      claudeConfigDir: home,
      correlationId: "actual-local",
      mode: "new" as const,
      cwd: workspace,
      home,
      maxTurns: 4,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic" as const,
        endpoint: server.url,
        auth: { kind: "api_key" as const, value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      settingSources: ["project"] as ["project"],
      tools: [],
    };
    const run = runtime.start(runtimeConfig, {
      onPermission: async () => ({
        behavior: "deny",
        message: "No tools expected",
      }),
    });

    let firstResult: (() => void) | undefined;
    const firstResultSeen = new Promise<void>((resolve) => {
      firstResult = resolve;
    });
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) {
        frames.push(frame);
        if (
          frame.envelope.message.type === "result" &&
          server?.requests.length === 1
        ) {
          firstResult?.();
        }
      }
    })();

    run.send({ message: "first turn", uuid: crypto.randomUUID() });
    await Promise.race([
      firstResultSeen,
      Bun.sleep(20_000).then(() => {
        throw new Error("First SDK turn did not finish");
      }),
    ]);
    run.send({ message: "second turn", uuid: crypto.randomUUID() });
    run.finishInput();
    await consume;

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]?.headers["x-api-key"]).toBe("placeholder-local");
    expect(JSON.stringify(server.requests[0]?.body.system)).toContain(
      "APPEND_SENTINEL_94S_18",
    );
    expect(server.requests.map((request) => request.body.model)).toEqual([
      "claude-sonnet-4-5",
      "claude-sonnet-4-5",
    ]);
    expect(
      frames.filter((frame) => frame.envelope.message.type === "result"),
    ).toHaveLength(2);
    const sessionIds = new Set(
      frames
        .map((frame) => frame.envelope.message.session_id)
        .filter((value): value is string => typeof value === "string"),
    );
    expect(sessionIds.size).toBe(1);
    expect(spawnedPids).toHaveLength(1);
    const sessionId = [...sessionIds][0];
    if (sessionId === undefined)
      throw new Error("SDK session ID was not emitted");
    expect(await run.prepareCheckpoint()).toEqual({
      status: "ready",
      checkpoint: {
        engine: "claude",
        resume: sessionId,
        sdkVersion: "0.3.319",
      },
    });
    const init = frames.find(
      (frame) =>
        frame.envelope.message.type === "system" &&
        frame.envelope.message.subtype === "init",
    );
    expect(init?.envelope.message.claude_code_version).toBe("2.1.319");
    expect(init?.envelope.sdk_version).toBe("0.3.319");
    expect(
      frames.every((frame) => frame.envelope.message.type.length > 0),
    ).toBe(true);

    const resumed = runtime.start(
      {
        ...runtimeConfig,
        correlationId: "actual-resume",
        // This run has no checkpoint behind it: the resume handle points at the
        // transcript the first run just wrote to this container's own disk.
        localTranscriptResume: true,
        mode: "resume",
        resume: sessionId,
      },
      {
        onPermission: async () => ({
          behavior: "deny",
          message: "No tools expected",
        }),
      },
    );
    resumed.send({
      message: "after process restart",
      uuid: crypto.randomUUID(),
    });
    resumed.finishInput();
    const resumedFrames = [];
    for await (const frame of resumed) resumedFrames.push(frame);
    expect(server.requests).toHaveLength(3);
    expect(
      resumedFrames.some(
        (frame) =>
          frame.envelope.message.type === "result" &&
          frame.envelope.message.session_id === sessionId,
      ),
    ).toBe(true);
    expect(spawnedPids).toHaveLength(2);
    expect(new Set(spawnedPids).size).toBe(2);
    await waitFor(() => exitedPids.length === 2, 5_000);
  }, 30_000);

  test("forwards permission request correlation through the adapter", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-18-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            {
              command: `printf denied > ${JSON.stringify(join(workspace, "permission-denied.txt"))}`,
            },
            "toolu_permission",
          )
        : textReply("permission handled"),
    );
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const permissionRequests: Array<{ requestId: string; toolUseId: string }> =
      [];
    const run = runtime.start(
      {
        claudeConfigDir: home,
        correlationId: "actual-permission",
        mode: "new",
        cwd: workspace,
        home,
        maxTurns: 2,
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
          principal: { ownerScope: "owner-a" },
        },
        settingSources: ["project"],
        tools: ["Bash"],
      },
      {
        onPermission: async (request) => {
          permissionRequests.push({
            requestId: request.requestId,
            toolUseId: request.toolUseId,
          });
          return { behavior: "deny", message: "Permission denied by host" };
        },
      },
    );
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({ message: "request a command", uuid: crypto.randomUUID() });
    run.finishInput();
    await withTimeout(consume, 5_000, "Permission adapter did not settle");

    expect(permissionRequests).toEqual([
      { requestId: expect.any(String), toolUseId: "toolu_permission" },
    ]);
    expect(
      frames.some((frame) => frame.envelope.message.type === "result"),
    ).toBe(true);
  }, 30_000);

  test("a turn parked at its permission prompt ends without running the tool or asking the model again", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-858-" });
    const { home, workspace } = isolated;
    const marker = join(workspace, "parked-tool-ran.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf ran > ${JSON.stringify(marker)}` },
            "toolu_parked",
          )
        : textReply("FOLLOW_UP_AFTER_PARK"),
    );
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    let readiness: unknown;
    const run = runtime.start(
      {
        claudeConfigDir: home,
        correlationId: "actual-park",
        mode: "new",
        cwd: workspace,
        home,
        maxTurns: 2,
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
          principal: { ownerScope: "owner-a" },
        },
        settingSources: [],
        tools: ["Bash"],
      },
      {
        // What the worker does on a park: the deny carries the interrupt,
        // and the run is interrupted beside it.
        onPermission: async () => {
          readiness = run.parkable();
          void run.interrupt();
          return {
            behavior: "deny",
            message: "The approval was set aside for a later turn",
            interrupt: true,
          };
        },
      },
    );
    const frames: AgentFrame[] = [];
    let requestsByParkedResult: number | undefined;
    const consume = (async () => {
      for await (const frame of run) {
        frames.push(frame);
        if (
          frame.envelope.message.type === "result" &&
          requestsByParkedResult === undefined
        ) {
          requestsByParkedResult = server?.requests.length;
          // The run outlives the cut, as the worker's does until it releases.
          run.send({ message: "follow up", uuid: crypto.randomUUID() });
          run.finishInput();
        }
      }
    })();
    run.send({ message: "request a command", uuid: crypto.randomUUID() });
    await withTimeout(consume, 10_000, "Parked adapter did not settle");

    const results = frames
      .map((frame) => frame.envelope.message)
      .filter((message) => message.type === "result");
    expect(results[0]).toMatchObject({ terminal_reason: "aborted_tools" });
    expect(requestsByParkedResult).toBe(1);
    expect(readiness).toEqual({ ok: true, resume: expect.any(String) });
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(JSON.stringify(frames)).toContain("FOLLOW_UP_AFTER_PARK");
  }, 30_000);

  test("interrupts the current turn and returns a receipt", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-18-" });
    const { home, workspace } = isolated;
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    server = startFakeAnthropicServer(async (_request, index) => {
      requestStarted?.();
      if (index === 0) {
        await Bun.sleep(500);
        return textReply("INTERRUPTED_RESPONSE_MUST_NOT_SURFACE");
      }
      return textReply("FOLLOW_UP_AFTER_INTERRUPT");
    });
    const spawnedPids: number[] = [];
    const exitedPids: number[] = [];
    const runtime = new ClaudeSdkRuntime(
      { endpoints: [server.url], models: ["claude-sonnet-4-5"] },
      {
        onSpawn: (pid) => spawnedPids.push(pid),
        onExit: (pid) => exitedPids.push(pid),
      },
    );
    const run = runtime.start(
      {
        claudeConfigDir: home,
        correlationId: "actual-interrupt",
        mode: "new",
        cwd: workspace,
        home,
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
          principal: { ownerScope: "owner-a" },
        },
        settingSources: [],
        tools: [],
      },
      {
        onPermission: async () => ({
          behavior: "deny",
          message: "No tools expected",
        }),
      },
    );
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({ message: "wait for the response", uuid: crypto.randomUUID() });
    await started;
    const receipt = await run.interrupt();
    run.send({ message: "follow up", uuid: crypto.randomUUID() });
    run.finishInput();
    await withTimeout(consume, 5_000, "Interrupted adapter did not settle");

    expect(receipt.stillQueued).toEqual([]);
    expect(spawnedPids).toHaveLength(1);
    const serialized = JSON.stringify(frames);
    expect(serialized).not.toContain("INTERRUPTED_RESPONSE_MUST_NOT_SURFACE");
    expect(serialized).toContain("FOLLOW_UP_AFTER_INTERRUPT");
    await waitFor(() => exitedPids.length === 1, 5_000);
  }, 30_000);

  test("an interrupt sent in the same tick as its input still ends that turn", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-351-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer(async () => {
      await Bun.sleep(15_000);
      return textReply("COMPLETED_DESPITE_INTERRUPT");
    });
    const runtime = new ClaudeSdkRuntime(
      { endpoints: [server.url], models: ["claude-sonnet-4-5"] },
      { onSpawn: () => {}, onExit: () => {} },
    );
    const run = runtime.start(
      {
        claudeConfigDir: home,
        correlationId: "same-tick-interrupt",
        mode: "new",
        cwd: workspace,
        home,
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
          principal: { ownerScope: "owner-a" },
        },
        settingSources: [],
        tools: [],
      },
      {
        onPermission: async () => ({
          behavior: "deny",
          message: "No tools expected",
        }),
      },
    );
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) {
        frames.push(frame);
        if (frame.envelope.message.type === "result") return;
      }
    })();
    await run.ready();
    // What the worker does with an interrupt taken while the input was being
    // checked: before the fix it reached the engine first and was a no-op.
    run.send({ message: "wait for the response", uuid: crypto.randomUUID() });
    await run.interrupt();
    await withTimeout(consume, 5_000, "The interrupt did not end the turn");
    run.close();

    const result = frames.at(-1)?.envelope.message as {
      terminal_reason?: string;
    };
    expect(result.terminal_reason).toBe("aborted_streaming");
    expect(JSON.stringify(frames)).not.toContain("COMPLETED_DESPITE_INTERRUPT");
  }, 30_000);

  test("aborts the whole adapter run and reaps its process", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-18-" });
    const { home, workspace } = isolated;
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    server = startFakeAnthropicServer(async (request) => {
      requestStarted?.();
      await aborted(request.signal);
      return new Response("request aborted", { status: 499 });
    });
    const spawnedPids: number[] = [];
    const exitedPids: number[] = [];
    const runtime = new ClaudeSdkRuntime(
      { endpoints: [server.url], models: ["claude-sonnet-4-5"] },
      {
        onSpawn: (pid) => spawnedPids.push(pid),
        onExit: (pid) => exitedPids.push(pid),
      },
    );
    const run = runtime.start(
      {
        claudeConfigDir: home,
        correlationId: "actual-abort",
        mode: "new",
        cwd: workspace,
        home,
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
          principal: { ownerScope: "owner-a" },
        },
        settingSources: [],
        tools: [],
      },
      {
        onPermission: async () => ({
          behavior: "deny",
          message: "No tools expected",
        }),
      },
    );
    const consume = (async () => {
      for await (const _frame of run) void _frame;
    })();
    run.send({ message: "wait for the response", uuid: crypto.randomUUID() });
    await started;
    run.abort();
    const outcome = await withTimeout(
      consume.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      5_000,
      "Aborted adapter did not settle",
    );

    expect(outcome).toBe("rejected");
    expect(spawnedPids).toHaveLength(1);
    await waitFor(() => exitedPids.length === 1, 5_000);
  }, 30_000);
});

describe("transcript mirror against the actual SDK", () => {
  test("mirrors every local transcript entry to the session store", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-124-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      textReply(`mirrored-turn-${index + 1}`),
    );
    const objects = createMemoryCheckpointObjectStore();
    const mirror = new ClaudeSessionStore({
      generation: 1,
      objects,
      prefix: "sessions/direct-local/mirror",
    });
    const mirrored: TranscriptKey[] = [];
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const run = runtime.start(
      {
        claudeConfigDir: home,
        correlationId: "actual-mirror",
        mode: "new",
        cwd: workspace,
        home,
        maxTurns: 2,
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: server.url,
          auth: { kind: "api_key", value: "placeholder-local" },
          principal: { ownerScope: "owner-a" },
        },
        sessionStore: {
          append: async (key, entries) => {
            mirrored.push(key);
            await mirror.append(key, entries);
          },
          listSubkeys: (key) => mirror.listSubkeys(key),
          load: (key) => mirror.load(key),
        },
        settingSources: ["project"],
        tools: [],
      },
      {
        onPermission: async () => ({
          behavior: "deny",
          message: "No tools expected",
        }),
      },
    );
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({ message: "mirror this turn", uuid: crypto.randomUUID() });
    run.finishInput();
    await withTimeout(consume, 20_000, "Mirrored adapter did not settle");

    expect(
      frames.some(
        (frame) =>
          frame.envelope.message.type === "system" &&
          frame.envelope.message.subtype === "mirror_error",
      ),
    ).toBe(false);
    const rootKey = mirrored.find((key) => key.subpath === undefined);
    if (rootKey === undefined) throw new Error("The SDK mirrored nothing");

    const local = await readTranscript(home, workspace, rootKey.sessionId);
    const stored = (await mirror.load(rootKey)) ?? [];
    expect(Object.keys(byUuid(local)).length).toBeGreaterThan(0);
    expect(byUuid(stored)).toEqual(byUuid(local));
    // A checkpoint is only meaningful because the pinned revision restores to
    // exactly those bytes, whatever the mirror does next.
    const revision = await mirror.captureRevision(rootKey);
    if (revision === null) throw new Error("expected a revision");
    expect(byUuid(await mirror.loadRevision(revision))).toEqual(byUuid(local));
    expect(await run.prepareCheckpoint()).toMatchObject({ status: "ready" });
  }, 40_000);

  test("resumes a new generation from the pinned checkpoint, never from an old worker's later writes", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-203-" });
    const { home, root, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      textReply(index === 0 ? "TURN_ONE_CONTEXT" : "TURN_TWO_RESUMED"),
    );
    const objects = createMemoryCheckpointObjectStore();
    const prefix = "sessions/resume/mirror";
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const baseConfig = {
      correlationId: "actual-generation-resume",
      cwd: workspace,
      maxTurns: 2,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic" as const,
        endpoint: server.url,
        auth: { kind: "api_key" as const, value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      settingSources: ["project"] as ["project"],
      tools: [],
    };
    const hooks = {
      onPermission: async () => ({
        behavior: "deny" as const,
        message: "No tools expected",
      }),
    };

    const first = new ClaudeSessionStore({ generation: 1, objects, prefix });
    const mirrored: TranscriptKey[] = [];
    const firstFrames = await drive(
      runtime.start(
        {
          ...baseConfig,
          claudeConfigDir: home,
          home,
          mode: "new",
          sessionStore: {
            append: async (key, entries) => {
              mirrored.push(key);
              await first.append(key, entries);
            },
            listSubkeys: (key) => first.listSubkeys(key),
            load: (key) => first.load(key),
          },
        },
        hooks,
      ),
      "remember the first turn",
    );
    const sessionId = sessionIdOf(firstFrames);
    const rootKey = mirrored.find(
      (key) => key.subpath === undefined && key.sessionId === sessionId,
    );
    if (rootKey === undefined) throw new Error("The SDK mirrored nothing");
    const transcripts = await first.captureTranscripts(sessionId);
    if (transcripts === null) throw new Error("expected transcripts");
    const pinned = transcripts.root;

    // The first worker lost its lease and keeps writing: a well-formed entry
    // that continues its own conversation, so only the generation boundary
    // stands between it and the resumed run.
    const stored = (await first.load(rootKey)) ?? [];
    const tail = [...stored]
      .reverse()
      .find((item) => typeof item.uuid === "string");
    if (tail === undefined) throw new Error("expected a stored entry");
    await first.append(rootKey, [
      {
        ...tail,
        message: { content: "ZOMBIE_SUFFIX", role: "user" },
        parentUuid: tail.uuid,
        type: "user",
        uuid: crypto.randomUUID(),
      },
    ]);

    const resumedHome = join(root, "home-resumed");
    await mkdir(resumedHome);
    const second = new ClaudeSessionStore({
      generation: 2,
      inherit: { sessionId, transcripts },
      objects,
      prefix,
    });
    const secondFrames = await drive(
      runtime.start(
        {
          ...baseConfig,
          claudeConfigDir: resumedHome,
          home: resumedHome,
          mode: "resume",
          resume: sessionId,
          sessionStore: second,
        },
        hooks,
      ),
      "what did I ask you to remember?",
    );

    expect(server.requests).toHaveLength(2);
    const resumedRequest = JSON.stringify(server.requests[1]?.body.messages);
    expect(resumedRequest).toContain("remember the first turn");
    expect(resumedRequest).toContain("TURN_ONE_CONTEXT");
    expect(resumedRequest).not.toContain("ZOMBIE_SUFFIX");
    expect(sessionIdOf(secondFrames)).toBe(sessionId);

    // The next checkpoint is the adopted parts followed by the second
    // generation's own, and restores to the conversation the engine had.
    const next = (await second.captureTranscripts(sessionId))?.root;
    if (next === undefined) throw new Error("expected a revision");
    expect(next.parts.slice(0, pinned.parts.length)).toEqual([...pinned.parts]);
    expect(
      next.parts
        .slice(pinned.parts.length)
        .every((part) => part.key.includes("/generation-0000000002/")),
    ).toBe(true);
    const restored = JSON.stringify(await second.loadRevision(next));
    expect(restored).toContain("remember the first turn");
    expect(restored).toContain("TURN_TWO_RESUMED");
    expect(restored).not.toContain("ZOMBIE_SUFFIX");
  }, 60_000);

  test("a mirror that keeps rejecting is reported before the turn's result, which still succeeds", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "mirror-reject-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer(() => textReply("MIRROR_FAILURE_RESULT"));
    const mirror = new ClaudeSessionStore({
      generation: 1,
      objects: createMemoryCheckpointObjectStore(),
      prefix: "sessions/mirror/reject",
    });
    let attempts = 0;
    const run = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    }).start(
      {
        ...mirrorProbeConfig(server.url, home, workspace),
        sessionStore: {
          append: async () => {
            attempts += 1;
            throw new Error("injected append failure");
          },
          listSubkeys: (key) => mirror.listSubkeys(key),
          load: (key) => mirror.load(key),
        },
      },
      denyEveryTool,
    );
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({
      message: "finish despite the mirror",
      uuid: crypto.randomUUID(),
    });
    run.finishInput();
    await withTimeout(consume, 30_000, "Rejecting mirror run did not settle");

    const sequence = frames.map(({ envelope: { message } }) =>
      message.type === "system" || message.type === "result"
        ? `${message.type}:${String(message.subtype)}`
        : message.type,
    );
    // The SDK flushes the pending batch before it hands over the result, so the
    // host learns of the loss in time to hold that turn's checkpoint back.
    const mirrorError = sequence.indexOf("system:mirror_error");
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(mirrorError).toBeGreaterThanOrEqual(0);
    expect(mirrorError).toBeLessThan(sequence.indexOf("result:success"));
    expect(await run.prepareCheckpoint()).toMatchObject({
      reason: "mirror_error",
      status: "rejected",
    });
  }, 40_000);

  test("restores once the entries of appends that timed out but still landed", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "mirror-timeout-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer(() => textReply("MIRROR_TIMEOUT_RESULT"));
    const mirror = new ClaudeSessionStore({
      generation: 1,
      objects: createMemoryCheckpointObjectStore(),
      prefix: "sessions/mirror/timeout",
    });
    const mirrored: TranscriptKey[] = [];
    const lateWrites: Promise<void>[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const run = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    }).start(
      {
        ...mirrorProbeConfig(server.url, home, workspace),
        sessionStore: {
          // The write reaches the store after the SDK has already given up on
          // it and retried, as an S3 PUT whose answer timed out would.
          append: async (key, entries) => {
            mirrored.push(key);
            if (key.subpath === undefined) {
              sent.push(
                ...(JSON.parse(JSON.stringify(entries)) as typeof sent),
              );
            }
            const late = Bun.sleep(150).then(() => mirror.append(key, entries));
            lateWrites.push(late);
            await Promise.race([
              late,
              Bun.sleep(25).then(() => {
                throw new Error("injected append timeout");
              }),
            ]);
          },
          listSubkeys: (key) => mirror.listSubkeys(key),
          load: (key) => mirror.load(key),
        },
      },
      denyEveryTool,
    );
    const frames: AgentFrame[] = [];
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    run.send({
      message: "finish after an ambiguous append timeout",
      uuid: crypto.randomUUID(),
    });
    run.finishInput();
    await withTimeout(consume, 30_000, "Timing-out mirror run did not settle");
    await withTimeout(
      Promise.all(lateWrites),
      15_000,
      "Late writes did not land",
    );

    expect(
      frames.some(
        ({ envelope: { message } }) =>
          message.type === "system" && message.subtype === "mirror_error",
      ),
    ).toBe(true);
    const rootKey = mirrored.find((key) => key.subpath === undefined);
    if (rootKey === undefined) throw new Error("The SDK mirrored nothing");
    const revision = await mirror.captureRevision(rootKey);
    if (revision === null) throw new Error("expected a revision");
    for (const entries of [
      (await mirror.load(rootKey)) ?? [],
      await mirror.loadRevision(revision),
    ]) {
      const uuids = entries.flatMap((entry) =>
        typeof entry.uuid === "string" ? [entry.uuid] : [],
      );
      expect(new Set(uuids).size).toBe(uuids.length);
      // Every entry the SDK sent, each once: a lost entry fails here too.
      expect(byUuid(entries)).toEqual(byUuid(sent));
      // Every retry landed, so the store holds each entry more than once.
      expect(
        sent.filter((entry) => typeof entry.uuid === "string").length,
      ).toBeGreaterThan(uuids.length);
      expect(JSON.stringify(entries)).toContain(
        "finish after an ambiguous append timeout",
      );
    }
  }, 60_000);

  test("holds the turn's result until a pending mirror append lands", async () => {
    const held = await startHeldMirrorRun("mirror-held-");
    try {
      await held.replied();
      expect(held.resultSeen()).toBe(false);
      held.release();
      await waitFor(held.resultSeen, 10_000);
      expect(await held.run.prepareCheckpoint()).toMatchObject({
        status: "ready",
      });
    } finally {
      await held.kill();
    }
  }, 60_000);

  test("a run killed while its mirror append hangs leaves no result to checkpoint", async () => {
    const held = await startHeldMirrorRun("mirror-hang-");
    try {
      await held.replied();
      expect(held.resultSeen()).toBe(false);
    } finally {
      await held.kill();
    }
    expect(held.resultSeen()).toBe(false);
    expect(await held.run.prepareCheckpoint()).toMatchObject({
      status: "rejected",
    });
  }, 60_000);

  test("a resume the store holds nothing for fails without reaching the model", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "mirror-missing-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer(() => textReply("MUST_NOT_RUN"));
    const missing = new ClaudeSessionStore({
      generation: 1,
      objects: createMemoryCheckpointObjectStore(),
      prefix: "sessions/mirror/missing",
    });
    const run = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    }).start(
      {
        ...mirrorProbeConfig(server.url, home, workspace),
        mode: "resume",
        resume: crypto.randomUUID(),
        // Answers `load` with null, as a store that materialized the resumed
        // transcript onto the engine's disk does, except nothing is on disk:
        // the engine falls back to a local transcript that does not exist.
        sessionStore: {
          append: (key, entries) => missing.append(key, entries),
          listSubkeys: (key) => missing.listSubkeys(key),
          load: (key) => missing.load(key),
          revisionScoped: true,
        },
      },
      denyEveryTool,
    );
    const frames: AgentFrame[] = [];
    const settled = (async () => {
      for await (const frame of run) frames.push(frame);
    })().then(
      () => undefined,
      (error: unknown) => error,
    );
    run.send({
      message: "resume a missing session",
      uuid: crypto.randomUUID(),
    });
    run.finishInput();
    const failure = await withTimeout(
      settled,
      30_000,
      "Missing resume did not settle",
    );

    // Not a quiet new session: the engine refuses, and no turn is billed.
    expect(String(failure)).toContain("No conversation found");
    expect(
      frames
        .filter(({ envelope: { message } }) => message.type === "result")
        .map(({ envelope: { message } }) => message),
    ).toEqual([
      expect.objectContaining({
        is_error: true,
        num_turns: 0,
        subtype: "error_during_execution",
      }),
    ]);
    expect(server.requests).toHaveLength(0);
  }, 40_000);
});

/** The smallest new-session config the transcript mirror probes above share. */
function mirrorProbeConfig(endpoint: string, home: string, workspace: string) {
  return {
    claudeConfigDir: home,
    correlationId: "actual-mirror-probe",
    cwd: workspace,
    home,
    maxTurns: 1,
    mode: "new" as const,
    model: "claude-sonnet-4-5",
    profile: {
      kind: "anthropic" as const,
      endpoint,
      auth: { kind: "api_key" as const, value: "placeholder-local" },
      principal: { ownerScope: "owner-a" },
    },
    settingSources: ["project"] as ["project"],
    tools: [],
  };
}

/**
 * A run whose every mirror append waits until `release()`, then lands in a
 * real store. `replied()` settles once the model's answer reached the engine,
 * the point past which only the pending flush stands between it and a result.
 */
const HELD_RESULT_WINDOW_MS = 2_000;

async function startHeldMirrorRun(prefix: string) {
  isolated = await createIsolatedWorkspace({ prefix });
  const { home, workspace } = isolated;
  const fake = startFakeAnthropicServer(() => textReply("HELD_APPEND_RESULT"));
  server = fake;
  const mirror = new ClaudeSessionStore({
    generation: 1,
    objects: createMemoryCheckpointObjectStore(),
    prefix: `sessions/mirror/${prefix}`,
  });
  const gate = Promise.withResolvers<void>();
  const appending = Promise.withResolvers<void>();
  const spawnedPids: number[] = [];
  const exitedPids: number[] = [];
  const run = new ClaudeSdkRuntime(
    { endpoints: [fake.url], models: ["claude-sonnet-4-5"] },
    {
      onSpawn: (pid) => spawnedPids.push(pid),
      onExit: (pid) => exitedPids.push(pid),
    },
  ).start(
    {
      ...mirrorProbeConfig(fake.url, home, workspace),
      sessionStore: {
        append: async (key, entries) => {
          appending.resolve();
          await gate.promise;
          await mirror.append(key, entries);
        },
        listSubkeys: (key) => mirror.listSubkeys(key),
        load: (key) => mirror.load(key),
      },
    },
    denyEveryTool,
  );
  const frames: AgentFrame[] = [];
  try {
    const consume = (async () => {
      for await (const frame of run) frames.push(frame);
    })();
    // Ended by the kill, never awaited: its rejection is expected.
    consume.catch(() => {});
    run.send({ message: "hold the mirror", uuid: crypto.randomUUID() });
  } catch (error) {
    // The caller's `finally` is not reached yet; stop the process here.
    run.abort();
    throw error;
  }
  const isResult = ({ envelope: { message } }: AgentFrame) =>
    message.type === "result";
  return {
    run,
    release: () => gate.resolve(),
    resultSeen: () => frames.some(isResult),
    replied: async () => {
      await withTimeout(appending.promise, 10_000, "The SDK never appended");
      await waitFor(
        () =>
          frames.some(
            ({ envelope: { message } }) =>
              message.type === "assistant" &&
              JSON.stringify(message).includes("HELD_APPEND_RESULT"),
          ),
        10_000,
      );
      // With nothing held, the result follows this reply within milliseconds;
      // a result still absent after this long is one the flush is holding.
      await Bun.sleep(HELD_RESULT_WINDOW_MS);
    },
    // The process is what a kill ends. When the append never lands, the
    // run's iterator stays pending behind it: the append runs in this process.
    kill: async () => {
      run.abort();
      await waitFor(() => exitedPids.length === spawnedPids.length, 5_000);
      expect(spawnedPids).toHaveLength(1);
    },
  };
}

const denyEveryTool = {
  onPermission: async () => ({
    behavior: "deny" as const,
    message: "No tools expected",
  }),
};

describe("resumed history against the actual SDK", () => {
  test("a checkpoint resume holds exactly the inputs the engine loaded", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-242-" });
    const { home, root, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      textReply(`resumed-turn-${index + 1}`),
    );
    const objects = createMemoryCheckpointObjectStore();
    const prefix = "sessions/resume/history";
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const base = {
      correlationId: "actual-resumed-history",
      cwd: workspace,
      maxTurns: 2,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic" as const,
        endpoint: server.url,
        auth: { kind: "api_key" as const, value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      settingSources: ["project"] as ["project"],
      tools: [],
    };
    const hooks = {
      onPermission: async () => ({
        behavior: "deny" as const,
        message: "No tools expected",
      }),
    };
    const consumed = crypto.randomUUID();
    const first = new ClaudeSessionStore({ generation: 1, objects, prefix });
    const mirrored: TranscriptKey[] = [];
    const firstRun = runtime.start(
      {
        ...base,
        claudeConfigDir: home,
        home,
        mode: "new",
        sessionStore: {
          append: async (key, entries) => {
            mirrored.push(key);
            await first.append(key, entries);
          },
          listSubkeys: (key) => first.listSubkeys(key),
          load: (key) => first.load(key),
        },
      },
      hooks,
    );
    const frames: AgentFrame[] = [];
    const firstDone = (async () => {
      for await (const frame of firstRun) frames.push(frame);
    })();
    firstRun.send({ message: "remember this", uuid: consumed });
    firstRun.finishInput();
    await withTimeout(firstDone, 20_000, "First run did not settle");
    const sessionId = sessionIdOf(frames);
    const transcripts = await first.captureTranscripts(sessionId);
    if (transcripts === null) throw new Error("expected transcripts");
    // Written past the checkpoint by a worker that lost its lease: the
    // resumed engine never loads it, so it is not held either.
    const rootKey = mirrored.find(
      (key) => key.subpath === undefined && key.sessionId === sessionId,
    );
    if (rootKey === undefined) throw new Error("The SDK mirrored nothing");
    const late = crypto.randomUUID();
    await first.append(rootKey, [
      { type: "user", uuid: late, message: { role: "user", content: "late" } },
    ]);

    const resumedHome = join(root, "home-resumed");
    await mkdir(resumedHome);
    const resumed = runtime.start(
      {
        ...base,
        claudeConfigDir: resumedHome,
        home: resumedHome,
        mode: "resume",
        resume: sessionId,
        sessionStore: new ClaudeSessionStore({
          generation: 2,
          inherit: { sessionId, transcripts },
          objects,
          prefix,
        }),
      },
      hooks,
    );
    const resumedDone = (async () => {
      for await (const _frame of resumed) void _frame;
    })();

    expect(
      await withTimeout(resumed.holdsInput(consumed), 10_000, "No history"),
    ).toBe(true);
    expect(await resumed.holdsInput(late)).toBe(false);
    expect(await resumed.holdsInput(crypto.randomUUID())).toBe(false);
    // Nothing was sent to find that out.
    expect(server.requests).toHaveLength(1);
    resumed.close();
    await withTimeout(
      resumedDone.catch(() => {}),
      10_000,
      "Did not close",
    );
  }, 60_000);

  test("resumes from the transcript the store wrote to a linked projects directory", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-667-" });
    const { home, root, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      textReply(index === 0 ? "TURN_ONE_CONTEXT" : "TURN_TWO_RESUMED"),
    );
    const objects = createMemoryCheckpointObjectStore();
    const prefix = "sessions/resume/disk";
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const base = {
      correlationId: "actual-disk-resume",
      cwd: workspace,
      maxTurns: 2,
      model: "claude-sonnet-4-5",
      profile: {
        kind: "anthropic" as const,
        endpoint: server.url,
        auth: { kind: "api_key" as const, value: "placeholder-local" },
        principal: { ownerScope: "owner-a" },
      },
      settingSources: ["project"] as ["project"],
      tools: [],
    };
    const hooks = {
      onPermission: async () => ({
        behavior: "deny" as const,
        message: "No tools expected",
      }),
    };
    const first = new ClaudeSessionStore({ generation: 1, objects, prefix });
    const consumed = crypto.randomUUID();
    const firstRun = runtime.start(
      {
        ...base,
        claudeConfigDir: home,
        home,
        mode: "new",
        sessionStore: first,
      },
      hooks,
    );
    const frames: AgentFrame[] = [];
    const firstDone = (async () => {
      for await (const frame of firstRun) frames.push(frame);
    })();
    firstRun.send({ message: "remember the first turn", uuid: consumed });
    firstRun.finishInput();
    await withTimeout(firstDone, 20_000, "First run did not settle");
    const sessionId = sessionIdOf(frames);
    const transcripts = await first.captureTranscripts(sessionId);
    if (transcripts === null) throw new Error("expected transcripts");

    // As the worker lays it out: the engine's projects directory is a link
    // onto another disk, and the store fills it before the engine starts.
    const resumedHome = join(root, "home-resumed");
    const disk = join(root, "volume-transcripts");
    await mkdir(resumedHome);
    await mkdir(disk);
    await symlink(disk, join(resumedHome, "projects"));
    const second = new ClaudeSessionStore({
      generation: 2,
      inherit: { sessionId, transcripts },
      objects,
      prefix,
    });
    await second.verifyInherited();
    await second.materialize(join(resumedHome, "projects"));
    const resumed = runtime.start(
      {
        ...base,
        claudeConfigDir: resumedHome,
        home: resumedHome,
        mode: "resume",
        resume: sessionId,
        sessionStore: second,
      },
      hooks,
    );
    const resumedFrames: AgentFrame[] = [];
    const resumedDone = (async () => {
      for await (const frame of resumed) resumedFrames.push(frame);
    })();
    expect(
      await withTimeout(resumed.holdsInput(consumed), 10_000, "No history"),
    ).toBe(true);
    resumed.send({ message: "what did I ask?", uuid: crypto.randomUUID() });
    resumed.finishInput();
    await withTimeout(resumedDone, 20_000, "Resumed run did not settle");

    expect(
      resumedFrames.some(
        (frame) =>
          frame.envelope.message.type === "system" &&
          frame.envelope.message.subtype === "mirror_error",
      ),
    ).toBe(false);
    const resumedRequest = JSON.stringify(server.requests[1]?.body.messages);
    expect(resumedRequest).toContain("remember the first turn");
    expect(resumedRequest).toContain("TURN_ONE_CONTEXT");
    // The engine kept writing to the file on the other disk, and the mirror
    // kept receiving what it wrote.
    const local = await readTranscript(resumedHome, workspace, sessionId);
    expect(await readdir(disk)).toHaveLength(1);
    expect(JSON.stringify(local)).toContain("TURN_TWO_RESUMED");
    const next = (await second.captureTranscripts(sessionId))?.root;
    if (next === undefined) throw new Error("expected a revision");
    expect(next.parts.length).toBeGreaterThan(transcripts.root.parts.length);
    expect(byUuid(await second.loadRevision(next))).toEqual(byUuid(local));
  }, 60_000);
});

/** Sends one prompt, closes input, and collects every frame the run emits. */
async function drive(
  run: AsyncIterable<AgentFrame> & {
    finishInput(): void;
    send(input: { message: string; uuid: string }): void;
  },
  message: string,
): Promise<AgentFrame[]> {
  const frames: AgentFrame[] = [];
  const consume = (async () => {
    for await (const frame of run) frames.push(frame);
  })();
  run.send({ message, uuid: crypto.randomUUID() });
  run.finishInput();
  await withTimeout(consume, 20_000, "SDK run did not settle");
  expect(
    frames.some(
      (frame) =>
        frame.envelope.message.type === "system" &&
        frame.envelope.message.subtype === "mirror_error",
    ),
  ).toBe(false);
  return frames;
}

function sessionIdOf(frames: readonly AgentFrame[]): string {
  const ids = new Set(
    frames
      .map((frame) => frame.envelope.message.session_id)
      .filter((value): value is string => typeof value === "string"),
  );
  const [only] = ids;
  if (ids.size !== 1 || only === undefined) {
    throw new Error(`expected one SDK session id, saw ${[...ids].join(", ")}`);
  }
  return only;
}

/**
 * Where the CLI writes a session's JSONL: `<config dir>/projects/<sanitized
 * cwd>/<session id>.jsonl`. Spelled out here rather than imported, because the
 * adapter package does not depend on the storage package.
 */
async function readTranscript(
  claudeHome: string,
  cwd: string,
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const path = join(
    claudeHome,
    "projects",
    cwd.replaceAll(/[^a-zA-Z0-9]/g, "-"),
    `${sessionId}.jsonl`,
  );
  return (await Bun.file(path).text())
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Entries keyed by uuid; entries without one are not mirror-deduplicated. */
function byUuid(
  entries: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    entries
      .filter((entry) => typeof entry.uuid === "string")
      .map((entry) => [entry.uuid as string, entry]),
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for process exit");
    }
    await Bun.sleep(10);
  }
}

async function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("checkpoint quiescence against the actual SDK", () => {
  const bashConfig = (
    workspace: string,
    home: string,
    url: string,
  ): ClaudeRuntimeConfig => ({
    claudeConfigDir: home,
    correlationId: "actual-quiescence",
    mode: "new",
    cwd: workspace,
    home,
    maxTurns: 3,
    model: "claude-sonnet-4-5",
    profile: {
      kind: "anthropic",
      endpoint: url,
      auth: { kind: "api_key", value: "placeholder-local" },
      principal: { ownerScope: "owner-a" },
    },
    settingSources: ["project"],
    tools: ["Bash"],
  });

  test("every tool the engine runs is settled by the time its turn ends", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-208-" });
    const { home, workspace } = isolated;
    const target = join(workspace, "written.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf ok > ${JSON.stringify(target)}` },
            "toolu_write",
          )
        : textReply("written"),
    );
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const run = runtime.start(bashConfig(workspace, home, server.url), {
      onPermission: async () => ({ behavior: "allow" }),
    });
    const consume = (async () => {
      for await (const frame of run) {
        if (frame.envelope.message.type === "result") run.finishInput();
      }
    })();
    run.send({ message: "write a file", uuid: crypto.randomUUID() });
    await withTimeout(consume, 20_000, "The tool turn did not settle");

    expect((await stat(target)).isFile()).toBe(true);
    expect((await run.prepareCheckpoint()).status).toBe("ready");
  }, 30_000);

  test("a backgrounded command holds checkpoints back after the turn's result", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-208-" });
    const { home, workspace } = isolated;
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: "sleep 8", run_in_background: true },
            "toolu_background",
          )
        : textReply("started in the background"),
    );
    const runtime = new ClaudeSdkRuntime({
      endpoints: [server.url],
      models: ["claude-sonnet-4-5"],
    });
    const run = runtime.start(bashConfig(workspace, home, server.url), {
      onPermission: async () => ({ behavior: "allow" }),
    });
    let resulted: (() => void) | undefined;
    const result = new Promise<void>((resolve) => {
      resulted = resolve;
    });
    const consume = (async () => {
      for await (const frame of run) {
        if (frame.envelope.message.type === "result") resulted?.();
      }
    })();
    run.send({ message: "start a server", uuid: crypto.randomUUID() });
    await withTimeout(result, 20_000, "The background turn did not settle");

    expect(await run.prepareCheckpoint()).toMatchObject({
      status: "rejected",
      reason: "background_writer",
    });
    expect((await run.leaseCheckpoint()).lease).toBeNull();
    run.close();
    await consume.catch(() => {});
  }, 30_000);

  test("a tool that asks to start under a checkpoint lease never runs", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-208-" });
    const { home, workspace } = isolated;
    const target = join(workspace, "under-lease.txt");
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply(
            "Bash",
            { command: `printf leaked > ${JSON.stringify(target)}` },
            "toolu_leased",
          )
        : textReply("refused"),
    );
    // The host never sends input under a lease (the ledger refuses it), so
    // this drives the engine directly to put a tool call in front of a held
    // lease and see what the pinned CLI does with the gate's refusal.
    const ledger = new TurnLedger("seeded");
    const grant = ledger.leaseCheckpoint();
    expect(grant.preparation.status).toBe("ready");
    const input = new InputStream();
    const abortController = new AbortController();
    let permissionAsked = false;
    const options: Options = buildSdkOptions(
      bashConfig(workspace, home, server.url),
      {
        onPermission: async () => {
          permissionAsked = true;
          return { behavior: "allow" };
        },
      },
      ledger,
      abortController,
    );
    const sdkQuery = query({ prompt: input, options });
    const results: unknown[] = [];
    const consume = (async () => {
      for await (const message of sdkQuery) {
        if (message.type === "user") {
          const content = (message.message as { content?: unknown }).content;
          if (Array.isArray(content)) results.push(...content);
        }
        if (message.type === "result") input.finish();
      }
    })();
    input.push({ message: "write under the lease", uuid: crypto.randomUUID() });
    await withTimeout(consume, 20_000, "The leased turn did not settle");
    grant.lease?.release();

    expect(await stat(target).catch(() => null)).toBeNull();
    expect(permissionAsked).toBe(false);
    expect(results).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        tool_use_id: "toolu_leased",
        is_error: true,
      }),
    );
    expect(JSON.stringify(results)).toContain("A checkpoint is being saved");
  }, 30_000);
});

describe("the engine's API key against its own tools", () => {
  test("a Bash tool finds the key in no environment and no descriptor", async () => {
    isolated = await createIsolatedWorkspace({ prefix: "94s-410-" });
    const { home, workspace } = isolated;
    const token = "wep_94s410-tool-must-not-see";
    // The bracket keeps the pattern from matching the probe's own argv.
    const mark = "tool-must-not-se[e]";
    const probe = [
      `mark='${mark}'`,
      `env_hits=$(env | grep -c -e "$mark" -e '^ANTHROPIC_API_KE[Y]=')`,
      "readable=0; hits=0; engine=0",
      "for f in /proc/[0-9]*/environ; do",
      '  e=$(tr "\\0" "\\n" < "$f" 2>/dev/null) || continue',
      '  [ -n "$e" ] || continue',
      "  readable=$((readable+1))",
      '  printf "%s\\n" "$e" | grep -q -e "$mark" && hits=$((hits+1))',
      `  printf "%s\\n" "$e" | grep -q '^CLAUDE_CODE_API_KEY_FILE_DESCRIPTO[R]=' && engine=$((engine+1))`,
      "done",
      'files=$(grep -rl -e "$mark" "$HOME" "$CLAUDE_CONFIG_DIR" 2>/dev/null | wc -l | tr -d " ")',
      "fd=closed; [ -e /dev/fd/3 ] && fd=open",
      'echo "probe env_hits=$env_hits readable=$readable hits=$hits engine=$engine files=$files fd=$fd"',
    ].join("\n");
    // Run by sh whatever the engine's shell is: zsh stops at the glob when
    // there is no /proc.
    await Bun.write(join(workspace, "probe.sh"), probe);
    await mkdir(join(workspace, ".claude"), { recursive: true });
    // Code the checkout runs through a SessionStart hook must not be handed
    // the descriptor.
    const hookReport = join(workspace, "hook-fd.txt");
    await Bun.write(
      join(workspace, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `if [ -e /dev/fd/3 ]; then echo open; else echo closed; fi > ${JSON.stringify(hookReport)}`,
                },
              ],
            },
          ],
        },
      }),
    );
    server = startFakeAnthropicServer((_request, index) =>
      index === 0
        ? toolReply("Bash", { command: "sh probe.sh" }, "toolu_probe")
        : textReply("probed"),
    );
    const run = new ClaudeSdkRuntime({
      endpoints: ["https://api.anthropic.com"],
      models: ["claude-sonnet-4-5"],
    }).start(
      {
        claudeConfigDir: home,
        correlationId: "94s-410",
        mode: "new",
        cwd: workspace,
        home,
        maxTurns: 2,
        model: "claude-sonnet-4-5",
        profile: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.com",
          auth: { kind: "egress_token", token, transport: server.url },
          principal: { ownerScope: "owner-a" },
        },
        settingSources: ["project"],
        tools: ["Bash"],
      },
      { onPermission: async () => ({ behavior: "allow" }) },
    );
    const consume = (async () => {
      for await (const frame of run) {
        if (frame.envelope.message.type === "result") run.finishInput();
      }
    })();
    run.send({ message: "probe", uuid: crypto.randomUUID() });
    await withTimeout(consume, 20_000, "The probe turn did not settle");

    expect(server.requests).toHaveLength(2);
    for (const request of server.requests) {
      expect(request.headers["x-api-key"]).toBe(token);
      expect(JSON.stringify(request.body)).not.toContain(token);
    }
    const output = JSON.stringify(server.requests[1]?.body.messages);
    const report =
      /probe env_hits=(\d+) readable=(\d+) hits=(\d+) engine=(\d+) files=(\d+) fd=(\w+)/.exec(
        output,
      );
    if (report === null) throw new Error(`no probe output in ${output}`);
    const [, envHits, readable, hits, engine, files, fd] = report;
    expect({ envHits, hits, files, fd }).toEqual({
      envHits: "0",
      hits: "0",
      files: "0",
      fd: "closed",
    });
    // Where there is a /proc (the worker, CI), the probe must have read the
    // engine's environ and more, or "no hits" proves nothing.
    if (process.platform === "linux") {
      expect(Number(engine)).toBeGreaterThanOrEqual(1);
      expect(Number(readable)).toBeGreaterThan(Number(engine));
    }
    expect((await Bun.file(hookReport).text()).trim()).toBe("closed");
  }, 30_000);
});

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return Promise.race([
    operation,
    Bun.sleep(timeoutMs).then(() => {
      throw new Error(message);
    }),
  ]);
}

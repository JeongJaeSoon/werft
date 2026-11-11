import { afterEach, describe, expect, test } from "bun:test";
import type {
  PlatformMcpServer,
  RuntimeEvent,
  RuntimeStart,
} from "@werft-ai/runtime-core";
import { type FakeMcp, startFakeMcp } from "@werft-ai/testkit/fake-mcp";

import {
  assertStartable,
  codexLaunch,
  codexProfileDigest,
  MCP_RELAY_SECRET_VARIABLE,
} from "./config.ts";
import { type McpRelay, type RelayPolicy, startMcpRelay } from "./mcp-relay.ts";
import { CodexRun, type CodexRunOptions } from "./run.ts";
import { FakeAppServer } from "./testing/fake-app-server.ts";

const UPSTREAM_BEARER = "upstream-bearer-1";
const PUSH = "mcp__github__request_push";

function serverOf(
  port: number,
  overrides: Partial<PlatformMcpServer> = {},
): PlatformMcpServer {
  return {
    name: "github",
    binding: "release-1",
    url: `http://127.0.0.1:${port}/mcp`,
    token: UPSTREAM_BEARER,
    tools: [PUSH],
    platform: true,
    trusted: [PUSH],
    ...overrides,
  };
}

function startOf(servers: readonly PlatformMcpServer[]): RuntimeStart {
  return {
    bindings: {
      provider: {
        kind: "openai_responses",
        endpoint: "https://api.openai.example/",
        auth: {
          kind: "egress_token",
          token: "engine-egress-1",
          transport: "http://egress.internal:8080/provider",
        },
      },
      principal: { ownerScope: "owner-1" },
    },
    bundle: { instructions: [], repoInstructions: null, mcpServers: servers },
    config: {
      mode: "new",
      correlationId: "c-1",
      cwd: "/work",
      home: "/home/agent",
      model: "gpt-test",
      permissionMode: "default",
      tools: ["exec_command", ...servers.flatMap((s) => s.tools)],
    },
  } as unknown as RuntimeStart;
}

describe("what a start with platform servers is allowed", () => {
  test("a platform server and its tools pass; another server or an unlisted tool does not", () => {
    const platform = serverOf(1);
    const start = startOf([platform]);
    expect(() => assertStartable(start.config, start.bundle)).not.toThrow();

    const remote = startOf([serverOf(1, { platform: false })]);
    expect(() => assertStartable(remote.config, remote.bundle)).toThrow(
      "MCP servers other than the platform's",
    );

    const stray = startOf([platform]);
    (stray.config as unknown as { tools: string[] }).tools.push(
      "mcp__other__tool",
    );
    expect(() => assertStartable(stray.config, stray.bundle)).toThrow(
      "the tools mcp__other__tool",
    );
  });
});

describe("codexLaunch with a relay", () => {
  const relay = {
    urls: new Map([["github", "http://127.0.0.1:9/mcp/github"]]),
    secret: "relay-secret-1",
  };

  test("the engine is given the relay's address and secret, never the server's", () => {
    const launch = codexLaunch(
      startOf([serverOf(1)]),
      { stateDir: "/state" },
      { PATH: "/usr/bin" },
      relay,
    );
    const entry = launch.args.find((a) => a.startsWith("mcp_servers.github="));
    expect(entry).toContain('"url" = "http://127.0.0.1:9/mcp/github"');
    expect(entry).toContain(
      `"bearer_token_env_var" = "${MCP_RELAY_SECRET_VARIABLE}"`,
    );
    expect(entry).toContain('"enabled_tools" = ["request_push"]');
    expect(launch.env[MCP_RELAY_SECRET_VARIABLE]).toBe("relay-secret-1");
    expect(JSON.stringify(launch)).not.toContain(UPSTREAM_BEARER);
    expect(launch.env.NO_PROXY).toContain("127.0.0.1");
  });

  test("a server the relay has no route for is a failed start", () => {
    expect(() =>
      codexLaunch(
        startOf([serverOf(1)]),
        { stateDir: "/state" },
        {},
        {
          urls: new Map(),
          secret: "x",
        },
      ),
    ).toThrow("no route for github");
  });
});

describe("the profile digest with servers", () => {
  test("moves with the server's release, its tools and its name, not its address or token", () => {
    const base = codexProfileDigest(startOf([serverOf(1)]));
    expect(
      codexProfileDigest(startOf([serverOf(2, { token: "rotated" })])),
    ).toBe(base);
    expect(
      codexProfileDigest(startOf([serverOf(1, { binding: "release-2" })])),
    ).not.toBe(base);
    expect(
      codexProfileDigest(
        startOf([
          serverOf(1, { name: "other", tools: ["mcp__other__request_push"] }),
        ]),
      ),
    ).not.toBe(base);
    expect(codexProfileDigest(startOf([]))).not.toBe(base);
  });
});

describe("the relay", () => {
  let upstream: FakeMcp | undefined;
  let relay: McpRelay | undefined;
  afterEach(async () => {
    relay?.close();
    await upstream?.stop();
    upstream = undefined;
    relay = undefined;
  });

  async function boot(policy: RelayPolicy, pinned = ["mcp__fake__whoami"]) {
    upstream = await startFakeMcp({ bearer: UPSTREAM_BEARER, marker: "m1" });
    const server = serverOf(upstream.port, {
      name: "fake",
      tools: pinned,
      trusted: pinned,
    });
    relay = startMcpRelay([server], policy);
    const url = relay.urls.get("fake") as string;
    const rpc = (method: string, params: unknown, secret = relay?.secret) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret === undefined
            ? {}
            : { authorization: `Bearer ${secret}` }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
    return { rpc, url };
  }

  const allow: RelayPolicy = async () => ({ allowed: true, done: () => {} });

  test("nothing opens without the relay's secret, and the server's bearer is not it", async () => {
    const { rpc } = await boot(allow);
    expect((await rpc("tools/list", {}, "")).status).toBe(401);
    expect((await rpc("tools/list", {}, UPSTREAM_BEARER)).status).toBe(401);
    expect(upstream?.calls().calls).toBe(0);
  });

  test("lists the pinned tools only and calls them with the server's bearer", async () => {
    const { rpc } = await boot(allow);
    const listed = (await (await rpc("tools/list", {})).json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listed.result.tools.map((t) => t.name)).toEqual(["whoami"]);
    const called = (await (
      await rpc("tools/call", { name: "whoami", arguments: {} })
    ).json()) as { result: { content: Array<{ text: string }> } };
    expect(called.result.content[0]?.text).toBe("ok:m1");
    expect(upstream?.calls().authorization_sha256).toHaveLength(1);
  });

  test("a refused call never reaches the server, and the model reads why", async () => {
    const seen: string[] = [];
    const { rpc } = await boot(async (call) => {
      seen.push(call.tool);
      return { allowed: false, text: "refused by the run" };
    });
    const answer = (await (
      await rpc("tools/call", { name: "whoami", arguments: {} })
    ).json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0]?.text).toBe("refused by the run");
    expect(seen).toEqual(["mcp__fake__whoami"]);
    expect(upstream?.calls().calls).toBe(0);
  });

  test("a tool the release does not pin is refused before the policy is asked", async () => {
    let asked = 0;
    const { rpc } = await boot(async () => {
      asked += 1;
      return { allowed: true, done: () => {} };
    });
    const answer = (await (
      await rpc("tools/call", { name: "other", arguments: {} })
    ).json()) as { result: { isError: boolean } };
    expect(answer.result.isError).toBe(true);
    expect(asked).toBe(0);
    expect(upstream?.calls().calls).toBe(0);
  });

  test("done runs once the call has ended, also when the server fails", async () => {
    let done = 0;
    const { rpc } = await boot(async () => ({
      allowed: true,
      done: () => {
        done += 1;
      },
    }));
    await rpc("tools/call", { name: "whoami", arguments: {} });
    expect(done).toBe(1);
  });
});

describe("the run judging a platform tool call", () => {
  function setup(
    options: {
      answers?: "ask" | "edits" | "none";
      approvalPolicy?: "untrusted" | "never";
      trusted?: string[];
      precheck?: CodexRunOptions["precheckTool"];
    } = {},
  ) {
    const server = new FakeAppServer("thread-1", { github: "ready" });
    let released = false;
    const run = new CodexRun({
      transport: server,
      launch: {
        answers: options.answers ?? "ask",
        approvalPolicy: options.approvalPolicy ?? "untrusted",
        developerInstructions: undefined,
        threadConfig: {},
      },
      cwd: "/work",
      model: "gpt-test",
      heldInputs: async () => new Set(),
      descendants: () => [],
      kill: () => {},
      startupProblem: () => undefined,
      precheckTool: options.precheck,
      mcp: {
        servers: new Set(["github"]),
        trusted: new Set(options.trusted ?? [PUSH]),
        release: () => {
          released = true;
        },
      },
    });
    const seen: RuntimeEvent[] = [];
    void (async () => {
      for await (const event of run.events()) seen.push(event);
    })();
    const call = (
      tool = PUSH,
      args: Record<string, unknown> = { source_ref: "main" },
    ) =>
      run.judgeMcpCall({
        tool,
        server: "github",
        arguments: args,
        signal: new AbortController().signal,
      });
    const announce = (id: string, tool = "request_push") =>
      server.emit("item/started", {
        threadId: "thread-1",
        item: {
          type: "mcpToolCall",
          id,
          server: "github",
          tool,
          arguments: {},
          status: "inProgress",
        },
      });
    const asked = async () => {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const hit = seen.find((e) => e.type === "approval.requested");
        if (hit?.type === "approval.requested") return hit.request;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("no approval was asked");
    };
    return {
      run,
      server,
      seen,
      call,
      announce,
      asked,
      released: () => released,
    };
  }

  test("a tool the server judges itself goes through unasked, and is announced under the platform's name", async () => {
    const t = setup();
    await t.run.ready();
    t.announce("item-1");
    const decision = await t.call();
    expect(decision.allowed).toBe(true);
    expect(t.seen.some((e) => e.type === "approval.requested")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const called = t.seen.find((e) => e.type === "tool.called");
    expect(called).toMatchObject({ tool: PUSH, toolCallId: "item-1" });
  });

  test("the pre-check's advice refuses the call before anything is asked", async () => {
    const t = setup({
      precheck: async (tool) => (tool === PUSH ? "unrelated_history" : null),
    });
    await t.run.ready();
    expect(await t.call()).toEqual({
      allowed: false,
      text: "unrelated_history",
    });
    expect(t.seen.some((e) => e.type === "approval.requested")).toBe(false);
  });

  test("a call in flight is a tool in flight for a checkpoint", async () => {
    const t = setup();
    await t.run.ready();
    const decision = await t.call();
    if (!decision.allowed) throw new Error("unreachable");
    const busy = await t.run.prepareCheckpoint("turn_end");
    expect(busy).toMatchObject({
      status: "rejected",
      reason: "tool_in_flight",
    });
    decision.done();
    expect((await t.run.prepareCheckpoint("turn_end")).status).toBe("ready");
  });

  test("a lease held for a checkpoint refuses the call", async () => {
    const t = setup();
    await t.run.ready();
    const grant = await t.run.leaseCheckpoint("turn_end");
    expect(grant.lease).not.toBeNull();
    const decision = await t.call();
    expect(decision.allowed).toBe(false);
    grant.lease?.release();
    expect((await t.call()).allowed).toBe(true);
  });

  test("a tool the server does not judge goes to the person, bound to the engine's item", async () => {
    const t = setup({ trusted: [] });
    await t.run.ready();
    t.announce("item-2");
    const decision = t.call();
    const request = await t.asked();
    expect(request.toolCallId).toBe("item-2");
    expect(request.tool.name).toBe(PUSH);
    await t.run.answer({
      localId: request.localId,
      inputHash: request.inputHash,
      kind: "selected",
      optionKind: "allow_once",
    });
    expect((await decision).allowed).toBe(true);
  });

  test("a denial, a dontAsk session and an interrupt each refuse an untrusted tool", async () => {
    const denied = setup({ trusted: [] });
    await denied.run.ready();
    const pending = denied.call();
    const request = await denied.asked();
    await denied.run.answer({
      localId: request.localId,
      inputHash: request.inputHash,
      kind: "selected",
      optionKind: "reject_once",
    });
    expect((await pending).allowed).toBe(false);

    const none = setup({ trusted: [], answers: "none" });
    await none.run.ready();
    expect((await none.call()).allowed).toBe(false);
    expect(none.seen.some((e) => e.type === "approval.requested")).toBe(false);

    const interrupted = setup({ trusted: [] });
    await interrupted.run.ready();
    const waiting = interrupted.call();
    await interrupted.asked();
    await interrupted.run.interrupt();
    expect((await waiting).allowed).toBe(false);
  });

  test("bypassPermissions runs an untrusted tool without asking", async () => {
    const t = setup({ trusted: [], answers: "none", approvalPolicy: "never" });
    await t.run.ready();
    expect((await t.call()).allowed).toBe(true);
    expect(t.seen.some((e) => e.type === "approval.requested")).toBe(false);
  });

  test("the engine's own ask before an MCP call is let through for a platform server and declined for any other", async () => {
    const t = setup();
    await t.run.ready();
    const ask = (serverName: string, threadId = "thread-1") =>
      t.server.ask("mcpServer/elicitation/request", {
        threadId,
        serverName,
        turnId: null,
        mode: "form",
        message: "Allow the tool?",
      });
    expect(await ask("github")).toEqual({ action: "accept", content: null });
    expect(await ask("somewhere")).toEqual({
      action: "decline",
      content: null,
    });
    // Another thread's ask is not answered at all.
    await expect(ask("github", "thread-2")).rejects.toThrow();
  });

  test("a call waiting on its pre-check is a tool in flight, and a lease taken meanwhile refuses it", async () => {
    let finish: (advice: string | null) => void = () => {};
    const t = setup({
      precheck: () =>
        new Promise<string | null>((resolve) => {
          finish = resolve;
        }),
    });
    await t.run.ready();
    const pending = t.call();
    expect(await t.run.prepareCheckpoint("turn_end")).toMatchObject({
      status: "rejected",
      reason: "tool_in_flight",
    });
    // A lease cannot be taken over an in-flight call, so the call is the one
    // that has to notice a checkpoint that started some other way.
    finish(null);
    expect((await pending).allowed).toBe(true);
  });

  test("a request the engine cancels while a person is asked leaves nothing open", async () => {
    const t = setup({ trusted: [] });
    await t.run.ready();
    const abort = new AbortController();
    const waiting = t.run.judgeMcpCall({
      tool: PUSH,
      server: "github",
      arguments: {},
      signal: abort.signal,
    });
    await t.asked();
    abort.abort();
    expect((await waiting).allowed).toBe(false);
    expect((await t.run.prepareCheckpoint("turn_end")).status).toBe("ready");
  });

  test("a pre-check that throws refuses the call and leaves no call in flight", async () => {
    const t = setup({
      precheck: () => {
        throw new Error("boom");
      },
    });
    await t.run.ready();
    expect((await t.call()).allowed).toBe(false);
    expect((await t.run.prepareCheckpoint("turn_end")).status).toBe("ready");
  });

  test("a run closed while a trusted call is judged does not let it through", async () => {
    const t = setup();
    await t.run.ready();
    const pending = t.call();
    t.run.abort();
    expect((await pending).allowed).toBe(false);
  });

  test("an engine that exits ends the relay and refuses later calls", async () => {
    const t = setup();
    await t.run.ready();
    t.server.exit({ code: 1, signal: null, stderr: "" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(t.released()).toBe(true);
    expect((await t.call()).allowed).toBe(false);
  });

  test("a closed run refuses, and ends the relay", async () => {
    const t = setup();
    await t.run.ready();
    t.run.abort();
    expect((await t.call()).allowed).toBe(false);
    expect(t.released()).toBe(true);
  });
});

describe("the run waiting for the relay servers", () => {
  const runOver = (server: FakeAppServer) =>
    new CodexRun({
      transport: server,
      launch: {
        answers: "ask",
        approvalPolicy: "untrusted",
        developerInstructions: undefined,
        threadConfig: {},
      },
      cwd: "/work",
      model: "gpt-test",
      heldInputs: async () => new Set(),
      descendants: () => [],
      kill: () => {},
      startupProblem: () => undefined,
      mcp: {
        servers: new Set(["github"]),
        trusted: new Set(),
        release: () => {},
      },
    });

  test("is not ready, and starts no turn, until the engine reports the server ready", async () => {
    const server = new FakeAppServer("thread-1", { github: "never" });
    const run = runOver(server);
    let ready = false;
    const readying = run.ready().then(() => {
      ready = true;
    });
    run.send({ uuid: "in-1", message: "hello" });
    await Bun.sleep(20);
    expect(ready).toBe(false);
    expect(server.started("turn/start")).toBeUndefined();
    server.emit("mcpServer/startupStatus/updated", {
      name: "github",
      status: "ready",
      threadId: null,
    });
    await readying;
    await Bun.sleep(0);
    expect(server.started("turn/start")).toBeDefined();
    run.abort();
  });

  test("refuses to start when the engine could not start the server", async () => {
    const run = runOver(new FakeAppServer("thread-1", { github: "failed" }));
    await expect(run.ready()).rejects.toThrow(
      "could not start the github MCP server (failed: connection refused)",
    );
    run.abort();
  });
});

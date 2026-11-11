import { describe, expect, test } from "bun:test";
import {
  type RuntimeConfig,
  type SessionEvent,
  sessionEventSchema,
} from "@werft-ai/contracts";
import {
  type AgentInput,
  approvalInputHash,
  type RuntimeEvent,
  type TurnEnded,
} from "@werft-ai/runtime-core";

import { unwiredCheckpoints } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { ScriptedRun } from "./testing/scripted-run.ts";
import { waitFor as until } from "./testing/wait-for.ts";
import { WorkerHost, type WorkerLogger } from "./worker-host.ts";
import { noWorkspace } from "./workspace.ts";

// The host driven by a run that implements the contract directly, with no
// Claude driver underneath, so nothing here leans on how the Claude adapter
// shapes a request.

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 50,
  heartbeatIntervalMs: 10_000,
  idleTimeoutMs: 60,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 2_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};

function publicEvent(
  id: string,
  event: string,
  data: unknown,
  inputs?: readonly string[],
): RuntimeEvent {
  return {
    type: "public",
    event: sessionEventSchema.parse({ id, event, data }) as SessionEvent,
    ...(inputs === undefined ? {} : { inputs }),
  };
}

function turnEnded(input: AgentInput, turn: Partial<TurnEnded> = {}) {
  return {
    type: "turn.ended",
    turn: {
      isError: false,
      abortedByStop: false,
      budgetExceeded: false,
      engineResult: { outcome: "done" },
      cost: { countRestarted: false, unknown: true },
      inputs: [input.uuid],
      ...turn,
    },
  } satisfies RuntimeEvent;
}

/** Ends the turn `input` started. */
function finish(
  run: ScriptedRun,
  input: AgentInput,
  turn: Partial<TurnEnded> = {},
): void {
  run.push(
    publicEvent("done", "system", { type: "system", subtype: "done" }, [
      input.uuid,
    ]),
    turnEnded(input, turn),
  );
}

function host(
  run: ScriptedRun,
  logger?: WorkerLogger,
  overrides: Partial<WorkerTimeouts> = {},
) {
  const gateway = new FakeWorkerGateway();
  const worker = new WorkerHost({
    checkpoints: unwiredCheckpoints,
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: logger ?? { info: () => {}, warn: () => {}, error: () => {} },
    runtimes: { launcherFor: () => ({ start: () => run }) },
    timeouts: { ...timeouts, ...overrides },
    workspace: noWorkspace,
  });
  return { gateway, worker };
}

/** A tool call in the run's own words: no Claude message shape anywhere. */
function call(run: ScriptedRun, sent: AgentInput, id: string): void {
  const input = { command: `run ${id}` };
  run.push(
    publicEvent(
      id,
      "system",
      { type: "system", subtype: "tool_call", call: id },
      [sent.uuid],
    ),
    { type: "tool.called", toolCallId: id, tool: "shell" },
    {
      type: "approval.requested",
      request: {
        localId: `local-${id}`,
        toolCallId: id,
        tool: { name: "shell", input },
        inputHash: approvalInputHash("shell", input),
        askedAt: performance.now(),
        kind: "permission",
        display: input,
      },
    },
  );
}

describe("WorkerHost over a run that implements the contract itself", () => {
  test("puts a request the run calls a question to the person as one, whatever its tool is named", async () => {
    const run = new ScriptedRun();
    // Nothing like AskUserQuestion: the questions and their ids are the run's.
    const input = { topic: "deploy target" };
    const questions = [
      {
        question_id: "target",
        prompt: "Which environment?",
        options: [
          { option_id: "target-staging", label: "staging" },
          { option_id: "target-production", label: "production" },
        ],
        multi_select: false,
        allow_free_text: false,
      },
    ];
    run.onSend = (sent) => {
      const block = { type: "tool_use", id: "call_1", name: "ask_human" };
      const message = { role: "assistant", content: [block] };
      run.push(
        publicEvent(
          "call_1",
          "tool_use",
          { type: "assistant", message, parent_tool_use_id: null },
          [sent.uuid],
        ),
        { type: "tool.called", toolCallId: "call_1", tool: "ask_human" },
        {
          type: "approval.requested",
          request: {
            localId: "local-1",
            toolCallId: "call_1",
            tool: { name: "ask_human", input },
            inputHash: approvalInputHash("ask_human", input),
            askedAt: performance.now(),
            kind: "question",
            questions,
          },
        },
      );
      run.onAnswer = () => finish(run, sent);
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("pick one");
    const loop = worker.runLoop();
    for (let waited = 0; gateway.registered().length === 0; waited += 5) {
      if (waited > 2_000) throw new Error("nothing was registered");
      await Bun.sleep(5);
    }
    const [registration] = gateway.registered();
    expect(registration?.request).toEqual({ kind: "question", questions });
    gateway.answer({
      request_id: registration?.request_id ?? "",
      kind: "question",
      answers: [
        { question_id: "target", selected_option_ids: ["target-production"] },
      ],
    });

    const summary = await loop;

    expect(run.answers).toEqual([
      {
        localId: "local-1",
        inputHash: approvalInputHash("ask_human", input),
        kind: "answered",
        answers: [
          { question_id: "target", selected_option_ids: ["target-production"] },
        ],
      },
    ]);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
  });

  test("hands the claim's git trailers on before the run starts; a failed write is only logged", async () => {
    const git = {
      co_author: {
        name: "octocat",
        email: "583231+octocat@users.noreply.github.com",
      },
      session_url: "https://console.example.com/sessions/s-1",
    };
    for (const fails of [false, true]) {
      const run = new ScriptedRun();
      run.onSend = (sent) => finish(run, sent);
      const gateway = new FakeWorkerGateway();
      const claim = gateway.bootstrapClaim.bind(gateway);
      gateway.bootstrapClaim = async (request) => ({
        ...(await claim(request)),
        git,
      });
      const handed: unknown[] = [];
      const warnings: string[] = [];
      const worker = new WorkerHost({
        checkpoints: unwiredCheckpoints,
        execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
        gateway,
        gitTrailers: async (given) => {
          handed.push(given.git);
          if (fails) throw new Error("read-only home");
        },
        logger: {
          info: () => {},
          warn: (event) => warnings.push(event),
          error: () => {},
        },
        runtimes: {
          launcherFor: () => ({
            start: () => {
              handed.push("started");
              return run;
            },
          }),
        },
        timeouts,
        workspace: noWorkspace,
      });
      gateway.enqueue("hello");
      const summary = await worker.runLoop();
      expect(handed).toEqual([git, "started"]);
      expect(summary.turns.map((turn) => turn.status)).toEqual(["completed"]);
      expect(warnings.includes("worker.git_trailers.not_written")).toBe(fails);
    }
  });

  describe("a turn's requester (94S-1304)", () => {
    const octocat = {
      name: "octocat",
      email: "583231+octocat@users.noreply.github.com",
    };
    const git = { co_author: null, session_url: "https://c/s/1" };

    async function runTurns(
      inputs: { coAuthor?: typeof octocat | null }[],
      writes: (given: unknown, calls: number) => Promise<void>,
    ) {
      const run = new ScriptedRun();
      run.onSend = (sent) => finish(run, sent);
      const gateway = new FakeWorkerGateway();
      const claim = gateway.bootstrapClaim.bind(gateway);
      gateway.bootstrapClaim = async (request) => ({
        ...(await claim(request)),
        git,
      });
      const handed: unknown[] = [];
      const warnings: string[] = [];
      const worker = new WorkerHost({
        checkpoints: unwiredCheckpoints,
        execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
        gateway,
        gitTrailers: async (given) => {
          handed.push(given.git?.co_author);
          await writes(given.git?.co_author, handed.length);
        },
        logger: {
          info: () => {},
          warn: (event) => warnings.push(event),
          error: () => {},
        },
        runtimes: { launcherFor: () => ({ start: () => run }) },
        timeouts,
        workspace: noWorkspace,
      });
      for (const input of inputs) gateway.enqueue("go", input);
      const summary = await worker.runLoop();
      return { handed, warnings, summary };
    }

    test("the files change at each turn's start, so one claim's turns name their own requesters", async () => {
      const { handed, summary } = await runTurns(
        [{ coAuthor: null }, { coAuthor: octocat }, { coAuthor: null }],
        async () => {},
      );
      expect(handed).toEqual([null, null, octocat, null]);
      expect(summary.turns.map((turn) => turn.status)).toEqual([
        "completed",
        "completed",
        "completed",
      ]);
    });

    test("an old control host sends no field: the claim's files stand", async () => {
      const { handed } = await runTurns([{}, {}], async () => {});
      expect(handed).toEqual([null]);
    });

    test("an input without the field after one that had it goes back to the claim's value", async () => {
      const { handed } = await runTurns(
        [{ coAuthor: octocat }, {}],
        async () => {},
      );
      expect(handed).toEqual([null, octocat, null]);
    });

    test("a turn whose files cannot be written is not started", async () => {
      const { handed, warnings, summary } = await runTurns(
        [{ coAuthor: octocat }],
        async (_given, calls) => {
          if (calls > 1) throw new Error("read-only home");
        },
      );
      expect(handed[1]).toEqual(octocat);
      expect(warnings).toContain("worker.git_trailers.turn_not_started");
      expect(summary.turns).toEqual([]);
      // The attempt stops instead of being handed the same input again.
      expect(summary.outcome).toBe("failed");
      expect(handed).toHaveLength(2);
    });
  });

  test("starts the engine with the git settings made from its claim", async () => {
    const git_author = {
      name: "werft-dev[bot]",
      email: "41898282+werft-dev[bot]@users.noreply.github.com",
    };
    const run = new ScriptedRun();
    run.onSend = (sent) => finish(run, sent);
    const gateway = new FakeWorkerGateway();
    const claim = gateway.bootstrapClaim.bind(gateway);
    gateway.bootstrapClaim = async (request) => ({
      ...(await claim(request)),
      git_author,
    });
    const launches: unknown[] = [];
    const worker = new WorkerHost({
      checkpoints: unwiredCheckpoints,
      execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
      gateway,
      gitEnvironment: (given) => ({
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: given.git_author?.name ?? "none",
      }),
      runtimes: {
        launcherFor: () => ({
          start: (launch) => {
            launches.push(launch.gitEnvironment);
            return run;
          },
        }),
      },
      timeouts,
      workspace: noWorkspace,
    });
    gateway.enqueue("hello");
    await worker.runLoop();
    expect(launches).toEqual([
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "werft-dev[bot]",
      },
    ]);
  });

  test("hands the engine routes to the claim's repositories and their Go modules before the run starts; a failed or empty route write is only logged and names no Go module", async () => {
    const access = { kind: "egress_token" as const, token: "wek_routes" };
    const workspace = {
      repository: {
        id: "app",
        url: "https://github.com/o/app.git",
        branch: "main",
        access,
      },
      additional_repositories: [
        {
          id: "docs",
          url: "https://github.com/o/docs",
          branch: "main",
          access,
        },
      ],
    };
    for (const outcome of ["written", "none", "fails"] as const) {
      const run = new ScriptedRun();
      run.onSend = (sent) => finish(run, sent);
      const gateway = new FakeWorkerGateway();
      const claim = gateway.bootstrapClaim.bind(gateway);
      gateway.bootstrapClaim = async (request) => ({
        ...(await claim(request)),
        workspace,
      });
      const handed: unknown[] = [];
      const warnings: string[] = [];
      const worker = new WorkerHost({
        checkpoints: unwiredCheckpoints,
        execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
        gateway,
        packageManagers: async (_token, _github, modules) => {
          handed.push(modules);
        },
        repositoryRoutes: async (given) => {
          handed.push(given);
          if (outcome === "fails") throw new Error("read-only home");
          return outcome === "written";
        },
        logger: {
          info: () => {},
          warn: (event) => warnings.push(event),
          error: () => {},
        },
        runtimes: {
          launcherFor: () => ({
            start: () => {
              handed.push("started");
              return run;
            },
          }),
        },
        timeouts,
        workspace: noWorkspace,
      });
      gateway.enqueue("hello");
      const summary = await worker.runLoop();
      // Without the routes, GOPRIVATE would send Go straight to github.com.
      expect(handed).toEqual([
        workspace,
        outcome === "written" ? ["github.com/o/app", "github.com/o/docs"] : [],
        "started",
      ]);
      expect(summary.turns.map((turn) => turn.status)).toEqual(["completed"]);
      expect(warnings.includes("worker.repository_routes.not_written")).toBe(
        outcome === "fails",
      );
    }
  });

  test("fetches a repository attached mid-turn with the claim's repository token, routes it for git and Go, and reports the commit", async () => {
    const access = { kind: "egress_token" as const, token: "repo-token" };
    const commit = "f".repeat(40);
    const gateway = new FakeWorkerGateway();
    const claim = gateway.bootstrapClaim.bind(gateway);
    gateway.bootstrapClaim = async (request) => ({
      ...(await claim(request)),
      workspace: { repository: null },
      repository_access: access,
    });
    const entry = {
      id: "docs",
      url: "https://github.com/acme/docs.git",
      branch: "main",
    };
    const order = { ...entry, receipt_id: "r-1" };
    const run = new ScriptedRun();
    run.onSend = (sent) => {
      // The agent's call lands mid-turn; the turn ends once it is reported.
      gateway.attachOrders = [order];
      void (async () => {
        while (gateway.attachReports.length === 0) await Bun.sleep(1);
        finish(run, sent);
      })();
    };
    const fetched: unknown[] = [];
    const routed: unknown[] = [];
    const modules: unknown[] = [];
    const worker = new WorkerHost({
      checkpoints: unwiredCheckpoints,
      execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
      gateway,
      packageManagers: async (_token, _github, given) => {
        modules.push(given);
      },
      repositoryRoutes: async (given) => {
        routed.push(structuredClone(given));
        return true;
      },
      runtimes: { launcherFor: () => ({ start: () => run }) },
      timeouts,
      workspace: {
        ...noWorkspace,
        attachRepository: async (repository) => {
          fetched.push(repository);
          return commit;
        },
      },
    });
    gateway.enqueue("hello");
    const summary = await worker.runLoop();

    expect(summary.turns.map((turn) => turn.status)).toEqual(["completed"]);
    expect(fetched).toEqual([{ ...entry, access }]);
    expect(gateway.attachReports).toEqual([
      { repository_id: "docs", receipt_id: "r-1", status: "attached", commit },
    ]);
    // Written again with the attached repository, once at the claim before.
    expect(routed).toEqual([
      { repository: null },
      { repository: null, additional_repositories: [{ ...entry, access }] },
    ]);
    expect(modules).toEqual([[], ["github.com/acme/docs"]]);
  });

  test("the next claim's attached repository is added again once the workspace is restored, before the engine starts", async () => {
    const access = { kind: "egress_token" as const, token: "[REDACTED]" };
    const docs = {
      id: "docs",
      url: "https://github.com/acme/docs.git",
      branch: "main",
      access,
    };
    const gateway = new FakeWorkerGateway();
    const claim = gateway.bootstrapClaim.bind(gateway);
    gateway.bootstrapClaim = async (request) => ({
      ...(await claim(request)),
      workspace: { repository: null, additional_repositories: [docs] },
      repository_access: access,
    });
    const steps: unknown[] = [];
    const run = new ScriptedRun();
    run.onSend = (sent) => finish(run, sent);
    const worker = new WorkerHost({
      checkpoints: {
        ...unwiredCheckpoints,
        // The checkout is rebuilt here, with origin alone.
        restorePlan: async () => {
          steps.push("restoring");
          await Bun.sleep(20);
          steps.push("restored");
          return { mode: "new" };
        },
      },
      execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
      gateway,
      runtimes: {
        launcherFor: () => ({
          start: () => {
            steps.push("started");
            return run;
          },
        }),
      },
      timeouts,
      workspace: {
        ...noWorkspace,
        prepare: async () => "restore",
        attachRepositories: async ({ descriptor }) => {
          steps.push(descriptor.additional_repositories);
          return { attached: ["docs"], failed: [] };
        },
      },
    });
    gateway.enqueue("hello");
    await worker.runLoop();

    expect(steps).toEqual(["restoring", "restored", [docs], "started"]);
  });

  test("an attachment handed out before the workspace is prepared waits for it", async () => {
    const gateway = new FakeWorkerGateway();
    gateway.attachOrders = [
      {
        id: "docs",
        url: "https://github.com/acme/docs.git",
        branch: "main",
        receipt_id: "r-1",
      },
    ];
    const steps: string[] = [];
    const run = new ScriptedRun();
    run.onSend = (sent) => {
      void (async () => {
        while (gateway.attachReports.length === 0) await Bun.sleep(1);
        finish(run, sent);
      })();
    };
    const worker = new WorkerHost({
      checkpoints: unwiredCheckpoints,
      execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
      gateway,
      runtimes: { launcherFor: () => ({ start: () => run }) },
      // Heartbeats while the workspace is prepared bring the order early.
      timeouts: { ...timeouts, heartbeatIntervalMs: 2 },
      workspace: {
        ...noWorkspace,
        prepare: async () => {
          steps.push("preparing");
          await Bun.sleep(40);
          steps.push("prepared");
          return "reuse";
        },
        attachRepository: async () => {
          steps.push("fetched");
          return "f".repeat(40);
        },
      },
    });
    gateway.enqueue("hello");
    const summary = await worker.runLoop();

    expect(summary.turns.map((turn) => turn.status)).toEqual(["completed"]);
    expect(steps).toEqual(["preparing", "prepared", "fetched"]);
  });

  test("finalizes without taking a checkpoint lease when the run takes no checkpoints", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => finish(run, sent);
    const warnings: string[] = [];
    const { gateway, worker } = host(run, {
      info: () => {},
      warn: (event) => warnings.push(event),
      error: () => {},
    });
    gateway.enqueue("hello");

    const summary = await worker.runLoop();

    expect(run.leases).toBe(0);
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    expect(gateway.finalized.map((request) => request.checkpoint)).toEqual([
      null,
    ]);
    // Not a checkpoint that failed: none was tried.
    expect(warnings).not.toContain("worker.checkpoint.rejected");
  });

  test("a drain does not park a run that takes no checkpoints, though the run says it could", async () => {
    const run = new ScriptedRun();
    run.parkable = () => ({ ok: true, resume: "scripted-session" });
    run.onSend = (sent) => call(run, sent, "c1");
    run.onAnswer = (answer) => {
      if (answer.kind === "cancelled") run.abort();
    };
    const warnings: string[] = [];
    const { gateway, worker } = host(run, {
      info: () => {},
      warn: (event) => warnings.push(event),
      error: () => {},
    });
    gateway.enqueue("hello");
    const loop = worker.runLoop();
    await until(() => gateway.registrations.length === 1, "the request");

    worker.drain("received SIGTERM");
    await loop;

    expect(warnings).toContain("worker.park.unavailable");
    expect(run.answers.map((answer) => answer.kind)).toEqual(["cancelled"]);
    expect(run.answers[0]).not.toMatchObject({ reason: "park" });
  });

  test("a grant whose allow came too late for its call is not spent, and is reported unused", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => {
      call(run, sent, "c1");
      // The engine aborts the call before the allow lands, then ends.
      setTimeout(() => finish(run, sent), 20);
    };
    run.answer = async (answer) => {
      run.answers.push(answer);
      return "stale";
    };
    const { gateway, worker } = host(run);
    gateway.grants = [
      {
        request_id: "req_parked_c1",
        turn_id: "1",
        tool: "shell",
        input_hash: approvalInputHash("shell", { command: "run c1" }),
      },
    ];
    gateway.enqueue("hello");

    await worker.runLoop();

    expect(run.answers.map((answer) => answer.kind)).toEqual(["selected"]);
    expect(gateway.registrations).toEqual([]);
    expect(gateway.delivered).toEqual([
      { request_id: "req_parked_c1", outcome: "grant_unused" },
    ]);
  });

  test("a grant the person also allowed for the session hands the run the rules to keep, and an older grant none", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => {
      call(run, sent, "c1");
      call(run, sent, "c2");
      setTimeout(() => finish(run, sent), 20);
    };
    const { gateway, worker } = host(run);
    gateway.grants = [
      {
        request_id: "req_parked_c1",
        turn_id: "1",
        tool: "shell",
        input_hash: approvalInputHash("shell", { command: "run c1" }),
        remember_offer: [{ tool_name: "shell", rule_content: "run:*" }],
      },
      {
        request_id: "req_parked_c2",
        turn_id: "1",
        tool: "shell",
        input_hash: approvalInputHash("shell", { command: "run c2" }),
      },
    ];
    gateway.enqueue("hello");

    await worker.runLoop();

    const [first, second] = run.answers;
    expect(first).toMatchObject({
      kind: "selected",
      optionKind: "allow_once",
      remember: {
        scope: "session",
        rules: [{ toolName: "shell", ruleContent: "run:*" }],
      },
    });
    expect(second).toMatchObject({ kind: "selected" });
    expect(second).not.toHaveProperty("remember");
  });

  test("still takes the lease when the run takes checkpoints", async () => {
    const run = new ScriptedRun();
    run.capabilities = {
      ...run.capabilities,
      effective: { ...run.capabilities.effective, checkpoint: true },
    };
    run.onSend = (sent) => finish(run, sent);
    const { gateway, worker } = host(run);
    gateway.enqueue("hello");

    await worker.runLoop();

    expect(run.leases).toBe(1);
  });

  describe("a claim that needs features", () => {
    const runtimeConfig: RuntimeConfig = {
      model: "fake-model",
      tools: [],
      permission_mode: "auto",
      provider: {
        kind: "anthropic",
        endpoint: "http://127.0.0.1:4000",
        auth: { kind: "egress_token", token: "t" },
      },
      mcp_servers: [
        {
          name: "docs",
          endpoint: "https://mcp.example.invalid/mcp",
          binding: `sha256:${"0".repeat(64)}`,
          access: { kind: "egress_token", token: "t" },
        },
      ],
    };

    function claimHost(run: ScriptedRun) {
      const gateway = new FakeWorkerGateway({
        runtimeConfig: structuredClone(runtimeConfig),
      });
      const worker = new WorkerHost({
        checkpoints: unwiredCheckpoints,
        execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
        gateway,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        runtimes: { launcherFor: () => ({ start: () => run }) },
        timeouts,
        workspace: noWorkspace,
      });
      return { gateway, worker };
    }

    test("is refused before any input when the run offers neither, naming both", async () => {
      const run = new ScriptedRun();
      run.onSend = (sent) => finish(run, sent);
      const { gateway, worker } = claimHost(run);
      gateway.enqueue("hello");

      const summary = await worker.runLoop();

      const reason =
        "Runtime claude_agent_sdk 0.3.319 cannot run this session's settings: it does not support mcp, classifier_review";
      expect(summary).toEqual({ outcome: "failed", reason, turns: [] });
      expect(run.inputs).toEqual([]);
      expect(gateway.releases.map((request) => request.reason)).toEqual([
        reason,
      ]);
    });

    test("runs as before when the run offers them, emulated mcp included", async () => {
      const run = new ScriptedRun();
      const { effective } = run.capabilities;
      run.capabilities = {
        ...run.capabilities,
        effective: {
          ...effective,
          mcp: "emulated",
          permissionModes: { ...effective.permissionModes, auto: "native" },
        },
      };
      run.onSend = (sent) => finish(run, sent);
      const { gateway, worker } = claimHost(run);
      gateway.enqueue("hello");

      const summary = await worker.runLoop();

      expect(summary.turns).toEqual([
        { turnId: "1", status: "completed", reason: null },
      ]);
      expect(run.inputs).toHaveLength(1);
    });
  });

  test("waits for a run that is still closing before it releases", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => finish(run, sent);
    let closed = false;
    run.closing = async () => {
      await Bun.sleep(100);
      closed = true;
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("hello");

    await worker.runLoop();

    expect(closed).toBe(true);
    expect(gateway.releases).toHaveLength(1);
  });

  test("reports a close that fails instead of leaving it unhandled", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => finish(run, sent);
    run.closing = () => Promise.reject(new Error("engine would not stop"));
    const warned: Array<{ event: string; fields: unknown }> = [];
    const { gateway, worker } = host(run, {
      info: () => {},
      warn: (event, fields) => warned.push({ event, fields }),
      error: () => {},
    });
    gateway.enqueue("hello");

    const summary = await worker.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
    ]);
    expect(warned).toContainEqual({
      event: "worker.close.failed",
      fields: { reason: "engine would not stop" },
    });
  });

  test("asks and settles an approval on each of two turns of a run that publishes no Claude tool_use", async () => {
    const run = new ScriptedRun();
    let turns = 0;
    run.onSend = (sent) => {
      turns += 1;
      const id = `call_${turns}`;
      call(run, sent, id);
      run.onAnswer = (answer) => {
        if (answer.localId === `local-${id}`) finish(run, sent);
      };
    };
    const { gateway, worker } = host(run);
    // The batch carrying the first call is held: nothing may be registered
    // for it until the gateway has stored it.
    let releaseCall: (() => void) | undefined;
    const callHeld = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    let callSent = false;
    const append = gateway.appendEvents.bind(gateway);
    gateway.appendEvents = async (request) => {
      const carries = request.events.some(
        (event) => event.event === "system" && event.data.call === "call_1",
      );
      if (carries) {
        callSent = true;
        await callHeld;
      }
      return append(request);
    };
    gateway.enqueue("first");
    gateway.enqueue("second");
    const loop = worker.runLoop();
    await until(() => callSent, "call_1 sent");
    await Bun.sleep(50);
    expect(gateway.registered()).toEqual([]);
    releaseCall?.();
    for (const id of ["call_1", "call_2"]) {
      await until(
        () =>
          gateway
            .registered()
            .some((entry) => entry.announce?.tool_use_id === id),
        `${id} registered`,
      );
      gateway.answer({
        request_id: gateway.requestIdFor(id),
        kind: "permission",
        decision: "allow",
      });
    }

    const summary = await loop;

    expect(run.answers.map(({ localId, kind }) => ({ localId, kind }))).toEqual(
      [
        { localId: "local-call_1", kind: "selected" },
        { localId: "local-call_2", kind: "selected" },
      ],
    );
    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
      { turnId: "2", status: "completed", reason: null },
    ]);
  });

  test("ends turns whose terminal reports no cost, with no cost recorded", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => finish(run, sent);
    const { gateway, worker } = host(run);
    gateway.enqueue("first");
    gateway.enqueue("second");

    const summary = await worker.runLoop();

    expect(summary.turns).toEqual([
      { turnId: "1", status: "completed", reason: null },
      { turnId: "2", status: "completed", reason: null },
    ]);
    expect(gateway.finalized.map((entry) => entry.terminal.cost_usd)).toEqual([
      null,
      null,
    ]);
  });

  test("charges a turn what the terminals it did not settle reported", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => {
      // A terminal for an input that is not this turn's settles nothing.
      run.push(
        turnEnded(
          { ...sent, uuid: "someone-else" },
          { cost: { deltaUsd: 0.25, countRestarted: false, unknown: false } },
        ),
      );
      finish(run, sent, {
        cost: { deltaUsd: 0.5, countRestarted: false, unknown: false },
      });
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("hello");

    await worker.runLoop();

    expect(gateway.finalized.map((entry) => entry.terminal.cost_usd)).toEqual([
      0.75,
    ]);
  });

  test("leaves what a turn of unknown cost carried for the next turn that reports", async () => {
    const run = new ScriptedRun();
    let turns = 0;
    run.onSend = (sent) => {
      turns += 1;
      if (turns === 1) {
        run.push(
          turnEnded(
            { ...sent, uuid: "someone-else" },
            { cost: { deltaUsd: 0.25, countRestarted: false, unknown: false } },
          ),
        );
        finish(run, sent);
        return;
      }
      finish(run, sent, {
        cost: { deltaUsd: 0.5, countRestarted: false, unknown: false },
      });
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("first");
    gateway.enqueue("second");

    await worker.runLoop();

    expect(gateway.finalized.map((entry) => entry.terminal.cost_usd)).toEqual([
      null,
      0.75,
    ]);
  });

  test("cancels an approval the turn waits on when it is interrupted, and records the interrupt rather than a deny", async () => {
    const run = new ScriptedRun();
    run.onSend = (sent) => {
      call(run, sent, "call_wait");
      run.interrupt = async () => {
        finish(run, sent, { abortedByStop: true });
        return { stillQueued: [] };
      };
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("deploy");
    const loop = worker.runLoop();
    await until(() => gateway.registered().length === 1, "the registration");
    gateway.interrupt("1");

    await loop;

    expect(run.answers).toEqual([
      expect.objectContaining({
        localId: "local-call_wait",
        kind: "cancelled",
        reason: "interrupt",
      }),
    ]);
    expect(gateway.settled).toEqual([
      {
        request_id: gateway.requestIdFor("call_wait"),
        outcome: "cancelled",
        reason: "interrupt",
      },
    ]);
  });

  test.each([
    ["applied", { outcome: "answered", answer_result: "applied" }],
    ["unknown", { outcome: "answered", answer_result: "unknown" }],
    ["stale", { outcome: "cancelled", answer_result: "stale" }],
  ] as const)(
    "reports what the run made of an answer it called %s",
    async (result, settled) => {
      const run = new ScriptedRun();
      run.answerResult = result;
      run.onSend = (sent) => {
        call(run, sent, "call_said");
        run.onAnswer = () => finish(run, sent);
      };
      const { gateway, worker } = host(run);
      gateway.enqueue("hello");
      const loop = worker.runLoop();
      await until(() => gateway.registered().length === 1, "the registration");
      gateway.answer({
        request_id: gateway.requestIdFor("call_said"),
        kind: "permission",
        decision: "allow",
      });

      await loop;

      expect(gateway.settled).toEqual([
        { request_id: gateway.requestIdFor("call_said"), ...settled },
      ]);
    },
  );

  test("counts the tool call wait from when the run asked, not from when the host heard", async () => {
    const run = new ScriptedRun();
    const waitMs = 400;
    let answeredAfter: number | undefined;
    run.onSend = (sent) => {
      const input = { command: "ls" };
      const pushedAt = performance.now();
      run.onAnswer = () => {
        answeredAfter = performance.now() - pushedAt;
        finish(run, sent);
      };
      // The run held this request most of the wait already; its call never
      // comes.
      run.push({
        type: "approval.requested",
        request: {
          localId: "local-late",
          toolCallId: "call_never",
          tool: { name: "shell", input },
          inputHash: approvalInputHash("shell", input),
          askedAt: pushedAt - (waitMs - 50),
          kind: "permission",
          display: input,
        },
      });
    };
    const { gateway, worker } = host(run, undefined, {
      toolUseFrameWaitMs: waitMs,
    });
    gateway.enqueue("hello");

    await worker.runLoop();

    expect(run.answers).toEqual([
      expect.objectContaining({
        localId: "local-late",
        kind: "cancelled",
        reason: "refused",
      }),
    ]);
    expect(answeredAfter).toBeLessThan(waitMs / 2);
  });

  test("keeps a late event for the previous input out of the turn that named its own", async () => {
    const run = new ScriptedRun();
    const sent: AgentInput[] = [];
    const lifecycle = (id: string, inputs: readonly string[]) =>
      publicEvent(id, "system", { type: "system", subtype: id }, inputs);
    run.onSend = (input) => {
      sent.push(input);
      const [first, second] = sent;
      if (second === undefined) {
        if (first !== undefined) finish(run, first);
        return;
      }
      run.push(
        lifecycle("second_queued", [second.uuid]),
        // The previous input's own word, after the next one was named.
        lifecycle("first_completed", [first?.uuid ?? ""]),
        lifecycle("unnamed", []),
      );
      finish(run, second);
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("first");
    gateway.enqueue("second");

    await worker.runLoop();

    const turnOf = new Map(
      gateway.batches.flatMap((batch) =>
        batch.events.flatMap((event) =>
          event.event === "system" ? [[event.data.subtype, batch.turn_id]] : [],
        ),
      ),
    );
    expect(Object.fromEntries(turnOf)).toMatchObject({
      second_queued: "2",
      first_completed: null,
      unnamed: "2",
    });
  });

  test("enters a turn on an input named by a message that published nothing", async () => {
    const run = new ScriptedRun();
    const sent: AgentInput[] = [];
    run.onSend = (input) => {
      sent.push(input);
      const [first, second] = sent;
      if (second === undefined) {
        if (first !== undefined) finish(run, first);
        return;
      }
      run.push(
        { type: "inputs.named", inputs: [second.uuid] },
        publicEvent("unnamed", "system", {
          type: "system",
          subtype: "unnamed",
        }),
      );
      finish(run, second);
    };
    const { gateway, worker } = host(run);
    gateway.enqueue("first");
    gateway.enqueue("second");

    await worker.runLoop();

    const unnamed = gateway.batches.find((batch) =>
      batch.events.some(
        (event) => event.event === "system" && event.data.subtype === "unnamed",
      ),
    );
    expect(unnamed?.turn_id).toBe("2");
  });
});

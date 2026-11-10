import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeConfig, WorkspaceRepository } from "@werft-ai/contracts";
import {
  type FakeAnthropicServer,
  startFakeAnthropicServer,
  textReply,
} from "@werft-ai/testkit/fake-anthropic";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspace,
} from "@werft-ai/testkit/workspace";

import type { RuntimeResumePlan, WorkerCheckpointPort } from "./checkpoint.ts";
import { workerRuntimeRegistry } from "./composition.ts";
import type { WorkerConfig, WorkerTimeouts } from "./config.ts";
import { EngineProcesses } from "./engine-processes.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { WorkerHost, type WorkerLogger } from "./worker-host.ts";
import { GitWorkspace } from "./workspace.ts";

const MODEL = "claude-sonnet-4-5";
const INSTRUCTIONS = "REPOSITORY_RULE_94S_258: run bun test before committing.";

const silent: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 50,
  claimTimeoutMs: 5_000,
  drainTimeoutMs: 5_000,
  heartbeatIntervalMs: 60_000,
  idleTimeoutMs: 300,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 100,
  questionTimeoutMs: 5_000,
  requestTimeoutMs: 5_000,
  startupTimeoutMs: 60_000,
};

/** Opens with `plan` and remembers the engine session a turn left behind. */
function checkpointsFrom(plan: RuntimeResumePlan): WorkerCheckpointPort & {
  resumeHandle?: string;
} {
  const port: WorkerCheckpointPort & { resumeHandle?: string } = {
    restorePlan: async () => plan,
    capture: async (preparation) => {
      if (preparation.status === "ready") {
        port.resumeHandle = preparation.checkpoint.resume;
      }
      return null;
    },
  };
  return port;
}

let isolated: IsolatedWorkspace | undefined;
let server: FakeAnthropicServer | undefined;

afterEach(async () => {
  server?.stop();
  await isolated?.dispose();
  isolated = undefined;
  server = undefined;
});

function git(args: string[], cwd: string): void {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@example.test", ...args],
    { cwd, stderr: "pipe", stdout: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
}

type Repository = {
  descriptor: { repository: WorkspaceRepository };
  home: string;
  markers: string[];
  publish(claudeMd: string): Promise<void>;
  workspace: string;
};

/**
 * A repository whose branch commits both halves of its Claude project
 * settings: a CLAUDE.md, and a settings.json whose hooks touch a marker
 * file outside the checkout the moment the engine would run them. The
 * worker's checkout of it starts empty, as a backend's mount does.
 */
async function repositoryWithProjectSettings(): Promise<Repository> {
  isolated = await createIsolatedWorkspace({ prefix: "94s-258-" });
  const { home, root, workspace } = isolated;
  await rm(workspace, { force: true, recursive: true });
  await mkdir(workspace);
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const markers = ["session-start", "prompt-submit"].map((name) =>
    join(root, `${name}.marker`),
  );
  const command = (marker: string) => ({
    hooks: [{ type: "command", command: `touch '${marker}'` }],
  });
  git(["init", "--quiet", "--bare", "--initial-branch=main", origin], root);
  git(["clone", "--quiet", origin, seed], root);
  await mkdir(join(seed, ".claude"));
  await writeFile(
    join(seed, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [command(markers[0] ?? "")],
        UserPromptSubmit: [command(markers[1] ?? "")],
      },
    }),
  );
  const publish = async (claudeMd: string) => {
    await writeFile(join(seed, "CLAUDE.md"), claudeMd);
    git(["add", "-A"], seed);
    git(["commit", "--quiet", "-m", "publish"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);
  };
  await publish(`${INSTRUCTIONS}\n`);
  return {
    descriptor: { repository: { id: "sample", url: origin, branch: "main" } },
    home,
    markers,
    publish,
    workspace,
  };
}

function claimedConfig(endpoint: string, claudeMd: boolean): RuntimeConfig {
  return {
    model: MODEL,
    tools: [],
    permission_mode: "default",
    provider: {
      kind: "anthropic",
      endpoint,
      auth: { kind: "egress_token", token: "placeholder-local" },
    },
    // Off is left out, as the gateway leaves it out.
    ...(claudeMd ? { project_settings: { claude_md: true } } : {}),
  };
}

/** One turn through the worker exactly as composition wires it. */
async function runOneTurn(
  repository: Repository,
  runtimeConfig: RuntimeConfig,
  checkpoints = checkpointsFrom({ mode: "new" }),
  turn = 1,
): Promise<void> {
  const gateway = new FakeWorkerGateway({
    runtimeConfig,
    sessionId: "33333333-3333-4333-8333-333333333333",
    firstTurn: turn,
    workspace: repository.descriptor,
  });
  gateway.enqueue(`message ${turn}`);
  const config = {
    egressCredentialUrl: runtimeConfig.provider.endpoint.replace(/\/$/, ""),
    runtime: {
      claudeConfigDir: repository.home,
      cwd: repository.workspace,
      home: repository.home,
    },
  } as WorkerConfig;
  const engines = new EngineProcesses();
  const host = new WorkerHost({
    checkpoints,
    engines,
    execution: { bootstrapNonce: "wln_local", generation: 1, id: "exec-1" },
    gateway,
    logger: silent,
    runtimes: workerRuntimeRegistry(config, engines),
    timeouts,
    workspace: new GitWorkspace(repository.workspace, [
      "AGENTS.md",
      "CLAUDE.md",
    ]),
  });
  const summary = await host.runLoop();
  expect(summary.turns).toEqual([
    { turnId: String(turn), status: "completed", reason: null },
  ]);
}

function firedMarkers(repository: Repository): string[] {
  return repository.markers.filter((marker) => existsSync(marker));
}

// The negative control, that these hooks do fire when the engine loads the
// project source itself, is the Claude adapter's project-settings test.
describe("the repository's own Claude project settings, under the claim's run config", () => {
  test("a run config that keeps CLAUDE.md out runs no repository hook and sends no repository text", async () => {
    const repository = await repositoryWithProjectSettings();
    server = startFakeAnthropicServer(() => textReply("ok"));

    await runOneTurn(repository, claimedConfig(server.url, false));

    expect(server.requests).toHaveLength(1);
    expect(firedMarkers(repository)).toEqual([]);
    expect(JSON.stringify(server.requests[0]?.body)).not.toContain(
      INSTRUCTIONS,
    );
  }, 60_000);

  test("a run config that lets CLAUDE.md in puts it in the system prompt and still runs no hook", async () => {
    const repository = await repositoryWithProjectSettings();
    server = startFakeAnthropicServer(() => textReply("ok"));

    await runOneTurn(repository, claimedConfig(server.url, true));

    expect(server.requests).toHaveLength(1);
    expect(firedMarkers(repository)).toEqual([]);
    const system = JSON.stringify(server.requests[0]?.body.system);
    expect(system).toContain(
      "Contents of the instruction file (AGENTS.md, else CLAUDE.md) at the root",
    );
    expect(system).toContain(INSTRUCTIONS);
    // Once, in the system prompt: nothing else loaded it alongside.
    expect(JSON.stringify(server.requests[0]?.body.messages)).not.toContain(
      INSTRUCTIONS,
    );
  }, 60_000);

  test("a fresh attempt after one that edited CLAUDE.md gets the branch's text, not the edit", async () => {
    const repository = await repositoryWithProjectSettings();
    server = startFakeAnthropicServer(() => textReply("ok"));
    await runOneTurn(repository, claimedConfig(server.url, true));
    // What the first attempt's engine could have left before dying, with no
    // checkpoint for the retry to restore.
    await writeFile(
      join(repository.workspace, "CLAUDE.md"),
      "PLANTED_RULE_94S_258\n",
    );

    await runOneTurn(repository, claimedConfig(server.url, true));

    expect(server.requests).toHaveLength(2);
    const system = JSON.stringify(server.requests[1]?.body.system);
    expect(system).toContain(INSTRUCTIONS);
    expect(system).not.toContain("PLANTED_RULE_94S_258");
  }, 90_000);

  test("a resumed session keeps the instructions it started with, whatever the branch says now", async () => {
    // The fingerprint deliberately ignores the text; this is why that is
    // safe: the engine replays the system prompt it recorded.
    const repository = await repositoryWithProjectSettings();
    server = startFakeAnthropicServer(() => textReply("ok"));
    const first = checkpointsFrom({ mode: "new" });
    await runOneTurn(repository, claimedConfig(server.url, true), first);
    const resume = first.resumeHandle;
    if (resume === undefined) throw new Error("No engine session was captured");
    await repository.publish("PUBLISHED_LATER_94S_258\n");

    await runOneTurn(
      repository,
      claimedConfig(server.url, true),
      checkpointsFrom({ mode: "resume", resume, localTranscriptResume: true }),
      2,
    );

    expect(server.requests).toHaveLength(2);
    // It is the same conversation, not a fresh one that happened to agree.
    expect(JSON.stringify(server.requests[1]?.body.messages)).toContain(
      "message 1",
    );
    const system = JSON.stringify(server.requests[1]?.body.system);
    expect(system).toContain(INSTRUCTIONS);
    expect(system).not.toContain("PUBLISHED_LATER_94S_258");
    expect(firedMarkers(repository)).toEqual([]);
  }, 90_000);
});

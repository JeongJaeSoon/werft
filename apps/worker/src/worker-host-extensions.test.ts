import { describe, expect, test } from "bun:test";
import type { RuntimeConfig } from "@werft-ai/contracts";
import { unwiredCheckpoints } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import { ExtensionBundleError } from "./extension-bundles.ts";
import { FakeWorkerGateway } from "./testing/fake-gateway.ts";
import { ScriptedRun } from "./testing/scripted-run.ts";
import { WorkerHost, type WorkerHostOptions } from "./worker-host.ts";
import { noWorkspace } from "./workspace.ts";

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 50,
  heartbeatIntervalMs: 5,
  idleTimeoutMs: 60,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 2_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};

const withBundle: RuntimeConfig = {
  model: "fake-model",
  tools: ["Read", "Skill"],
  permission_mode: "default",
  provider: {
    kind: "anthropic",
    endpoint: "http://127.0.0.1:4000",
    auth: { kind: "egress_token", token: "egress-token" },
  },
  extensions: [{ name: "lint", digest: "ab".repeat(32), scope: "agent" }],
};

function host(
  runtimeConfig: RuntimeConfig | undefined,
  extensionBundles?: WorkerHostOptions["extensionBundles"],
) {
  const gateway = new FakeWorkerGateway(
    runtimeConfig === undefined ? {} : { runtimeConfig },
  );
  const started = { engines: 0 };
  const run = new ScriptedRun();
  const worker = new WorkerHost({
    checkpoints: unwiredCheckpoints,
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    runtimes: {
      launcherFor: () => ({
        start: () => {
          started.engines += 1;
          return run;
        },
      }),
    },
    timeouts,
    workspace: noWorkspace,
    ...(extensionBundles === undefined ? {} : { extensionBundles }),
  });
  return { gateway, worker, started };
}

describe("a claim that carries extension bundles", () => {
  test("a bundle that cannot be published fails the start: no engine, and the reason is the release's", async () => {
    const { gateway, worker, started } = host(withBundle, async () => {
      throw new ExtensionBundleError("extension lint (abababababab): HTTP 404");
    });

    const summary = await worker.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(started.engines).toBe(0);
    expect(gateway.releases.map((release) => release.reason)).toEqual([
      expect.stringContaining("extension lint"),
    ]);
  });

  test("tools that do not list Skill fail the start before any download: no publisher call, no engine, and the reason says the fix", async () => {
    for (const tools of [[], ["Read"]]) {
      let downloads = 0;
      const { gateway, worker, started } = host(
        { ...withBundle, tools },
        async () => {
          downloads += 1;
        },
      );

      const summary = await worker.runLoop();

      expect(summary.outcome).toBe("failed");
      expect(downloads).toBe(0);
      expect(started.engines).toBe(0);
      const reason = gateway.releases[0]?.reason ?? "";
      expect(reason).toContain("lint");
      expect(reason).toContain('Add "Skill" to the runtime profile');
    }
  });

  test("with Skill among the tools the bundles are published and the engine starts", async () => {
    let downloads = 0;
    const { worker, started } = host(withBundle, async () => {
      downloads += 1;
    });

    await worker.runLoop();

    expect(downloads).toBe(1);
    expect(started.engines).toBe(1);
  });

  test("a worker with no way to publish them refuses to start rather than run without", async () => {
    const { gateway, worker, started } = host(withBundle);

    const summary = await worker.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(started.engines).toBe(0);
    expect(gateway.releases[0]?.reason).toContain("cannot publish");
  });

  test("the heartbeat keeps the lease while a slow download runs", async () => {
    let beatsDuring = 0;
    const { gateway, worker } = host(withBundle, async () => {
      const before = gateway.heartbeats.length;
      await Bun.sleep(120);
      beatsDuring = gateway.heartbeats.length - before;
      throw new ExtensionBundleError("stop after the slow fetch");
    });

    await worker.runLoop();

    // Every 5 ms for 120 ms is about two dozen; far more than "it ran once".
    expect(beatsDuring).toBeGreaterThanOrEqual(5);
  });

  test("a claim without bundles never calls the publisher", async () => {
    let called = 0;
    const { worker } = host(undefined, async () => {
      called += 1;
    });

    await worker.runLoop();

    expect(called).toBe(0);
  });
});

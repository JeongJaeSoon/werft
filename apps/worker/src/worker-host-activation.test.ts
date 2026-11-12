import { describe, expect, test } from "bun:test";
import { WorkerGatewayRequestError } from "@werft-ai/runtime-core";
import type { ScriptedStep } from "@werft-ai/runtime-core/testing";
import { unwiredCheckpoints } from "./checkpoint.ts";
import type { WorkerTimeouts } from "./config.ts";
import {
  FakeWorkerGateway,
  type FakeWorkerGatewayOptions,
} from "./testing/fake-gateway.ts";
import { scriptedRuntime, startScripted } from "./testing/scripted-engine.ts";
import { waitFor as pollFor } from "./testing/wait-for.ts";
import {
  type RuntimeRegistry,
  WorkerHost,
  type WorkerLogger,
} from "./worker-host.ts";

// The launch nonce stays readable in the container's environ by whatever the
// engine runs. It stops opening anything once the gateway has accepted one
// fenced call from the worker, so the worker makes that call and waits for
// its answer before it writes a file or starts a process.

const silent: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const timeouts: WorkerTimeouts = {
  answerPollIntervalMs: 2,
  claimTimeoutMs: 200,
  drainTimeoutMs: 50,
  heartbeatIntervalMs: 10_000,
  idleTimeoutMs: 60,
  maxTurnMs: 60_000,
  nextInputRetryTimeoutMs: 60_000,
  nextInputWaitMs: 15,
  questionTimeoutMs: 1_000,
  requestTimeoutMs: 1_000,
  startupTimeoutMs: 60_000,
};

const IDLE: ScriptedStep[] = [{ type: "await-input" }];

function refusal(
  status: number,
  code: ConstructorParameters<typeof WorkerGatewayRequestError>[1],
  retryable = false,
) {
  return new WorkerGatewayRequestError(
    status,
    code,
    `activation answered ${code}`,
    retryable,
  );
}

/**
 * A host whose every step after the claim is recorded in `trail`, with
 * whether the activation had been answered when the step ran.
 */
function harness(
  overrides: {
    gateway?: FakeWorkerGatewayOptions | FakeWorkerGateway;
    /** Runs inside the first step after the activation, after it is recorded. */
    duringGitTrailers?: () => Promise<void>;
    /** Runs inside the route step, after it is recorded. */
    duringRepositoryRoutes?: () => Promise<void>;
    timeouts?: Partial<WorkerTimeouts>;
  } = {},
) {
  const gateway =
    overrides.gateway instanceof FakeWorkerGateway
      ? overrides.gateway
      : new FakeWorkerGateway(overrides.gateway);
  const trail: string[] = [];
  const step = (name: string) => {
    trail.push(`${name} after ${gateway.calls.at(-1)}`);
  };
  const runtime = scriptedRuntime(IDLE);
  const runtimes: RuntimeRegistry = {
    launcherFor: () => ({
      start: (launch) => {
        step("engine");
        return startScripted(runtime, launch);
      },
    }),
  };
  const host = new WorkerHost({
    checkpoints: unwiredCheckpoints,
    execution: { bootstrapNonce: "wln_test", generation: 1, id: "exec-1" },
    gateway,
    gitTrailers: async () => {
      step("gitTrailers");
      await overrides.duringGitTrailers?.();
    },
    logger: silent,
    packageManagers: async () => step("packageManagers"),
    repositoryRoutes: async () => {
      step("repositoryRoutes");
      await overrides.duringRepositoryRoutes?.();
      return false;
    },
    runtimes,
    sleep: async () => {
      await Bun.sleep(1);
    },
    timeouts: { ...timeouts, ...overrides.timeouts },
    workspace: {
      async prepare() {
        step("workspace");
        return "reuse";
      },
      committedInstructions: () => null,
      instructionsCommit: () => null,
    },
  });
  return { gateway, host, trail };
}

const waitFor = (condition: () => boolean, label: string): Promise<void> =>
  pollFor(condition, label, { timeoutMs: 5_000, stepMs: 2 });

describe("WorkerHost activation", () => {
  test("writes nothing and starts nothing until the gateway has accepted its first call", async () => {
    const { gateway, host, trail } = harness();
    let release = () => {};
    gateway.activationHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = host.runLoop();
    await waitFor(() => gateway.calls.includes("heartbeat"), "the activation");
    // Longer than any step below would take to follow the claim.
    await Bun.sleep(50);

    expect(gateway.calls).toEqual([
      "bootstrapClaim",
      "useCredential",
      "heartbeat",
    ]);
    expect(gateway.heartbeats).toEqual([
      expect.objectContaining({
        attempt_state: "starting",
        turn_id: null,
      }),
    ]);
    expect(trail).toEqual([]);

    release();
    const summary = await running;

    expect(summary.outcome).toBe("idle");
    // Every step ran, and each of them after the one heartbeat was answered.
    expect(trail.map((entry) => entry.split(" ")[0])).toEqual([
      "gitTrailers",
      "repositoryRoutes",
      "packageManagers",
      "workspace",
      "engine",
    ]);
    expect(trail[0]).toBe("gitTrailers after heartbeat");
    expect(gateway.calls.indexOf("heartbeat")).toBe(2);
  });

  for (const [status, code] of [
    [401, "UNAUTHORIZED"],
    [409, "STALE_EPOCH"],
  ] as const) {
    test(`an activation answered ${code} claims once more and starts under the credential that works`, async () => {
      const { gateway, host, trail } = harness();
      gateway.activationFailures.push(refusal(status, code));

      const summary = await host.runLoop();

      expect(summary.outcome).toBe("idle");
      expect(gateway.calls.slice(0, 6)).toEqual([
        "bootstrapClaim",
        "useCredential",
        "heartbeat",
        "bootstrapClaim",
        "useCredential",
        "heartbeat",
      ]);
      expect(
        gateway.calls.filter((call) => call === "bootstrapClaim"),
      ).toHaveLength(2);
      // Nothing ran between the refused activation and the accepted one.
      expect(trail[0]).toBe("gitTrailers after heartbeat");
      expect(trail.map((entry) => entry.split(" ")[0])).toContain("engine");
    });
  }

  test("a second refusal ends the worker with nothing written and nothing started", async () => {
    const { gateway, host, trail } = harness();
    gateway.activationFailures.push(
      refusal(401, "UNAUTHORIZED"),
      refusal(401, "UNAUTHORIZED"),
    );

    const summary = await host.runLoop();

    expect(summary).toEqual({
      outcome: "lease_lost",
      reason: expect.stringContaining("UNAUTHORIZED"),
      turns: [],
    });
    expect(gateway.calls).toEqual([
      "bootstrapClaim",
      "useCredential",
      "heartbeat",
      "bootstrapClaim",
      "useCredential",
      "heartbeat",
    ]);
    expect(trail).toEqual([]);
    expect(gateway.releases).toEqual([]);
  });

  test("an activation that went unanswered is sent again under the same credential, without claiming again", async () => {
    const { gateway, host, trail } = harness();
    gateway.activationFailures.push(
      refusal(503, "INTERNAL_ERROR", true),
      refusal(503, "INTERNAL_ERROR", true),
    );

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(gateway.calls.slice(0, 5)).toEqual([
      "bootstrapClaim",
      "useCredential",
      "heartbeat",
      "heartbeat",
      "heartbeat",
    ]);
    expect(
      gateway.calls.filter((call) => call === "bootstrapClaim"),
    ).toHaveLength(1);
    const [first, second, third] = gateway.heartbeats;
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(trail[0]).toBe("gitTrailers after heartbeat");
  });

  test("an expired lease at activation ends the worker without claiming again", async () => {
    const { gateway, host, trail } = harness();
    gateway.activationFailures.push(refusal(409, "LEASE_EXPIRED"));

    const summary = await host.runLoop();

    expect(summary).toEqual({
      outcome: "lease_lost",
      reason: expect.stringContaining("LEASE_EXPIRED"),
      turns: [],
    });
    expect(gateway.calls).toEqual([
      "bootstrapClaim",
      "useCredential",
      "heartbeat",
    ]);
    expect(trail).toEqual([]);
  });

  test("a lease that runs out while the activation goes unanswered ends the worker", async () => {
    const { gateway, host, trail } = harness({ gateway: { leaseTtlMs: 40 } });
    for (let i = 0; i < 1_000; i++) {
      gateway.activationFailures.push(refusal(503, "INTERNAL_ERROR", true));
    }

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("lease_lost");
    expect(summary.reason).toContain("lease ran out");
    expect(
      gateway.calls.filter((call) => call === "bootstrapClaim"),
    ).toHaveLength(1);
    expect(trail).toEqual([]);
    // It stopped asking: most of the refusals were never drawn.
    expect(gateway.activationFailures.length).toBeGreaterThan(0);
  });

  test("a refusal that is neither a lost fence nor retryable fails the worker with nothing started", async () => {
    const { gateway, host, trail } = harness();
    gateway.activationFailures.push(refusal(400, "BAD_REQUEST"));

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("failed");
    expect(
      gateway.calls.filter((call) => call === "bootstrapClaim"),
    ).toHaveLength(1);
    expect(trail).toEqual([]);
  });

  test("an activation answered after the claim's lease ran out starts nothing", async () => {
    const { gateway, host, trail } = harness({ gateway: { leaseTtlMs: 40 } });
    let release = () => {};
    gateway.activationHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = host.runLoop();
    await waitFor(() => gateway.calls.includes("heartbeat"), "the activation");
    await Bun.sleep(120);
    release();
    const summary = await running;
    // Long enough for a startup revived by the late answer to show.
    await Bun.sleep(50);

    expect(summary.outcome).toBe("lease_lost");
    expect(summary.reason).toContain("lease ran out");
    expect(trail).toEqual([]);
    expect(gateway.calls).toEqual([
      "bootstrapClaim",
      "useCredential",
      "heartbeat",
    ]);
  });

  test("an answer that grants a lease already over starts nothing", async () => {
    class ShortGrant extends FakeWorkerGateway {
      override async heartbeat(
        request: Parameters<FakeWorkerGateway["heartbeat"]>[0],
      ) {
        const answer = await super.heartbeat(request);
        await Bun.sleep(30);
        return { ...answer, lease_remaining_ms: 5 };
      }
    }
    const { host, trail } = harness({ gateway: new ShortGrant() });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("lease_lost");
    expect(summary.reason).toContain("after the lease it granted");
    expect(trail).toEqual([]);
  });

  test("an answer handled after the claim's lease, on a stalled event loop, starts nothing even though it grants a fresh lease", async () => {
    class Stalled extends FakeWorkerGateway {
      override async heartbeat(
        request: Parameters<FakeWorkerGateway["heartbeat"]>[0],
      ) {
        const answer = await super.heartbeat(request);
        // Blocks the loop past the claim's lease: the timer that was due is
        // still queued when this answer is handled.
        const until = performance.now() + 80;
        while (performance.now() < until);
        return { ...answer, lease_remaining_ms: 1_000 };
      }
    }
    const { host, trail } = harness({
      gateway: new Stalled({ leaseTtlMs: 40 }),
    });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("lease_lost");
    expect(summary.reason).toContain("lease ran out");
    expect(trail).toEqual([]);
  });

  test("a step that outlasts the activation's lease is the last one: no further configuration, workspace or engine", async () => {
    class BriefGrant extends FakeWorkerGateway {
      override async heartbeat(
        request: Parameters<FakeWorkerGateway["heartbeat"]>[0],
      ) {
        return { ...(await super.heartbeat(request)), lease_remaining_ms: 40 };
      }
    }
    const { gateway, host, trail } = harness({
      gateway: new BriefGrant(),
      duringGitTrailers: () => Bun.sleep(80),
    });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("lease_lost");
    expect(trail).toEqual(["gitTrailers after heartbeat"]);
    expect(gateway.releases).toEqual([]);
    expect(gateway.calls).not.toContain("nextInput");
  });

  test("a stop during a step is seen before the next one: no further configuration, workspace or engine, and the session is given back", async () => {
    const stopping: { drain?: () => void } = {};
    const { gateway, host, trail } = harness({
      duringGitTrailers: async () => {
        stopping.drain?.();
        await Bun.sleep(5);
      },
    });
    stopping.drain = () => host.drain("received SIGTERM");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("drained");
    expect(trail).toEqual(["gitTrailers after heartbeat"]);
    expect(gateway.releases).toHaveLength(1);
    expect(gateway.calls).not.toContain("nextInput");
  });

  test("a stop while the routes are written is seen before the package configuration", async () => {
    const stopping: { drain?: () => void } = {};
    const { gateway, host, trail } = harness({
      duringRepositoryRoutes: async () => {
        stopping.drain?.();
        await Bun.sleep(5);
      },
    });
    stopping.drain = () => host.drain("received SIGTERM");

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("drained");
    expect(trail.map((entry) => entry.split(" ")[0])).toEqual([
      "gitTrailers",
      "repositoryRoutes",
    ]);
    expect(gateway.releases).toHaveLength(1);
  });

  test("claiming again replaces what the first claim installed: the accepted activation carries the second claim's fence and credential", async () => {
    const credentials: string[] = [];
    class Rotating extends FakeWorkerGateway {
      private claims = 0;
      override async bootstrapClaim(
        request: Parameters<FakeWorkerGateway["bootstrapClaim"]>[0],
      ) {
        const claim = await super.bootstrapClaim(request);
        this.claims += 1;
        return {
          ...claim,
          auth_revision: claim.auth_revision + this.claims,
          session_credential: `${claim.session_credential}-${this.claims}`,
        };
      }
      override useCredential(credential: string): void {
        credentials.push(credential);
        super.useCredential(credential);
      }
    }
    const gateway = new Rotating();
    gateway.activationFailures.push(refusal(409, "STALE_EPOCH"));
    const { host } = harness({ gateway });

    const summary = await host.runLoop();

    expect(summary.outcome).toBe("idle");
    expect(credentials).toHaveLength(2);
    expect(credentials[1]).toBe(`${credentials[0]?.slice(0, -2)}-2`);
    const [refused, ...later] = gateway.heartbeats;
    // The refused beat went out under the first claim's fence; every beat
    // after it, the accepted activation included, under the second's.
    expect(later.length).toBeGreaterThan(0);
    expect(new Set(later.map((beat) => beat.auth_revision))).toEqual(
      new Set([(refused?.auth_revision ?? 0) + 1]),
    );
  });

  test("a stop with the activation still unanswered when the stop grace is spent ends the worker, and the late answer starts nothing", async () => {
    const { gateway, host, trail } = harness({
      timeouts: { requestTimeoutMs: 40 },
    });
    let release = () => {};
    gateway.activationHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = host.runLoop();
    await waitFor(() => gateway.calls.includes("heartbeat"), "the activation");
    host.drain("received SIGTERM");
    const summary = await running;

    expect(summary).toEqual({
      outcome: "drained",
      reason: "received SIGTERM",
      turns: [],
    });
    release();
    await Bun.sleep(30);
    expect(trail).toEqual([]);
    expect(gateway.calls).toEqual([
      "bootstrapClaim",
      "useCredential",
      "heartbeat",
    ]);
  });

  test("a stop whose activation is answered within the grace gives the session back with nothing written and nothing started", async () => {
    const { gateway, host, trail } = harness();
    let release = () => {};
    gateway.activationHold = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = host.runLoop();
    await waitFor(() => gateway.calls.includes("heartbeat"), "the activation");
    host.drain("received SIGTERM");
    release();
    const summary = await running;

    expect(summary.outcome).toBe("drained");
    expect(trail).toEqual([]);
    // The session was activated, so it is released rather than left to its
    // lease.
    expect(gateway.releases).toHaveLength(1);
    expect(gateway.calls).not.toContain("nextInput");
  });
});

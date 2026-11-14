import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each case spawns a bun process per role; a loaded runner needs more than
// the default 5s for several of them.
const TIMEOUT_MS = 30_000;

async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(
    [process.execPath, "run", `${import.meta.dir}/main.ts`, ...args],
    // An otherwise empty environment: a role that got as far as reading its
    // settings would fail on them, not on the role.
    {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

// A loop never ends by itself: read its output until the line shows, then stop it.
async function runUntil(
  args: string[],
  env: Record<string, string>,
  needle: string,
  waitMs = 20_000,
) {
  const child = Bun.spawn(
    [process.execPath, "run", `${import.meta.dir}/main.ts`, ...args],
    {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let seen = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) seen += decoder.decode(chunk);
  };
  const readers = [drain(child.stdout), drain(child.stderr)];
  const deadline = Date.now() + waitMs;
  while (
    !seen.includes(needle) &&
    child.exitCode === null &&
    Date.now() < deadline
  ) {
    await Bun.sleep(100);
  }
  child.kill();
  await Promise.all([child.exited, ...readers]);
  return seen;
}

describe("control host executable", () => {
  test(
    "refuses to guess a role or a mode",
    async () => {
      for (const args of [
        [],
        ["worker"],
        ["API"],
        ["api", "--once"],
        ["metrics", "--health"],
        ["scheduler", "--loop"],
        ["reconciler", "--once", "--health"],
      ]) {
        const { exitCode, stderr } = await run(args);
        expect(exitCode, args.join(" ")).toBe(2);
        expect(stderr).toContain(
          "usage: bun run src/main.ts <api|metrics> | <scheduler|reconciler|slack> [--once|--health|--serve]",
        );
      }
    },
    TIMEOUT_MS,
  );

  test(
    "metrics reads its own settings and stops on a missing database",
    async () => {
      const { exitCode, stderr } = await run(["metrics"]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("DATABASE_URL is required");
    },
    TIMEOUT_MS,
  );

  test(
    "--serve refuses to run outside the pass loop",
    async () => {
      for (const role of ["scheduler", "reconciler", "slack"]) {
        const { exitCode, stderr } = await run([role, "--serve"]);
        expect(exitCode, role).not.toBe(0);
        expect(stderr, role).toContain("no IPC channel");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "each role validates its own settings and nothing else",
    async () => {
      // Without DATABASE_URL every role refuses, each in its own words: the
      // API before any listener, the loops before any pass, a pass before
      // it touches anything.
      const api = await run(["api"]);
      expect(api.exitCode).not.toBe(0);
      expect(api.stderr).toContain("DATABASE_URL is required");
      for (const args of [
        ["reconciler"],
        ["reconciler", "--once"],
        ["scheduler"],
        ["scheduler", "--once"],
        ["slack"],
        ["slack", "--once"],
      ]) {
        const { exitCode, stderr } = await run(args);
        expect(exitCode, args.join(" ")).not.toBe(0);
        expect(stderr, args.join(" ")).toContain(
          "DATABASE_URL or QUEUE_DATABASE_URL is required",
        );
      }
      // The loop refuses a bad pass setting once at startup rather than
      // failing every pass until the restart policy gives up. The unused
      // address shows no connection is needed to find it.
      const loop = await run(["reconciler"], {
        DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
        RECONCILER_BATCH_SIZE: "0",
      });
      expect(loop.exitCode).not.toBe(0);
      expect(loop.stderr).toContain("RECONCILER_BATCH_SIZE");
      expect(loop.stdout).not.toContain("Reconciler loop started");
    },
    TIMEOUT_MS,
  );

  test(
    "slack --once passes the startup gate the loop does",
    async () => {
      const once = await run(["slack", "--once"], {
        DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
        PLATFORM_SECRET_KEY: "ab".repeat(32),
        PLATFORM_CONFIG_DIR: "/config",
      });
      expect(once.exitCode).not.toBe(0);
      expect(once.stderr).toContain("PLATFORM_CONFIG_DIR no longer read");
    },
    TIMEOUT_MS,
  );

  test(
    "the slack loop warns once at start when MOCK_SLACK_API_URL is set, without the value",
    async () => {
      const seen = await runUntil(
        ["slack"],
        {
          DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
          PLATFORM_SECRET_KEY: "ab".repeat(32),
          MOCK_SLACK_API_URL: "https://slack-proxy.example/api",
        },
        "Mock Slack override in use: MOCK_SLACK_API_URL",
      );
      expect(seen).toContain("Mock Slack override in use: MOCK_SLACK_API_URL");
      expect(seen).not.toContain("slack-proxy.example");
    },
    TIMEOUT_MS,
  );

  test(
    "--health judges the role's own status file",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "control-host-health-"));
      try {
        const statusFile = join(dir, "status.json");
        const missing = await run(["scheduler", "--health"], {
          SCHEDULER_STATUS_FILE: statusFile,
        });
        expect(missing.exitCode).toBe(1);
        expect(missing.stderr).toContain("no status file");

        const now = new Date().toISOString();
        const status = {
          loopStartedAt: now,
          passes: 1,
          lastSuccessAt: now,
          lastFailureAt: null,
          lastFailureReason: null,
          lastSkippedAt: null,
          lastDegradedAt: null,
          lastPassDurationMs: 10,
          consecutiveFailures: 0,
          passDeadlineAt: null,
        };
        const health = async (written: Record<string, unknown>) => {
          await writeFile(
            statusFile,
            JSON.stringify({ ...status, ...written }),
          );
          return run(["scheduler", "--health"], {
            SCHEDULER_STATUS_FILE: statusFile,
          });
        };
        const healthy = await health({});
        expect(healthy.exitCode).toBe(0);
        expect(healthy.stdout).toContain("last successful pass");

        // A recent degraded pass is healthy and says it was degraded
        // an old one, a failure after it, or a pass past its
        // deadline is not.
        const old = new Date(Date.now() - 600_000).toISOString();
        const degraded = await health({
          lastSuccessAt: old,
          lastDegradedAt: now,
        });
        expect(degraded.exitCode).toBe(0);
        expect(degraded.stdout).toContain("completed degraded");
        const stale = await health({
          lastSuccessAt: null,
          lastDegradedAt: old,
        });
        expect(stale.exitCode).toBe(1);
        expect(stale.stderr).toContain("completed degraded");
        const failed = await health({
          lastDegradedAt: now,
          consecutiveFailures: 1,
          lastFailureAt: now,
          lastFailureReason: "pass exited with code 1",
        });
        expect(failed.exitCode).toBe(1);
        expect(failed.stderr).toContain("pass exited with code 1");
        const overdue = await health({
          lastDegradedAt: now,
          passDeadlineAt: old,
        });
        expect(overdue.exitCode).toBe(1);
        expect(overdue.stderr).toContain("past its deadline");

        // The reconciler reads its own file, not the scheduler's.
        const other = await run(["reconciler", "--health"], {
          RECONCILER_STATUS_FILE: join(dir, "reconciler.json"),
          SCHEDULER_STATUS_FILE: statusFile,
        });
        expect(other.exitCode).toBe(1);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
    TIMEOUT_MS,
  );

  test(
    "a scheduler loop forgets the quota preflight an earlier loop noted",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "control-host-quota-"));
      try {
        const statusFile = join(dir, "status.json");
        const marker = `${statusFile}.quota-verified`;
        await writeFile(marker, "noted by an earlier loop");
        // Nothing answers on either address, so the one pass fails before
        // its own preflight and the loop gives up after it.
        const loop = await run(["scheduler"], {
          AWS_REGION: "ap-northeast-1",
          DATABASE_URL: "postgres://nobody@127.0.0.1:1/none",
          DOCKER_HOST: `unix://${join(dir, "no-daemon.sock")}`,
          EXECUTION_EGRESS_PROXY_URL: "http://egress-proxy:3128",
          EXECUTION_INSTALLATION_ID: "quota-marker",
          EXECUTION_SLOT_LIMIT: "1",
          MAX_TURN_SECONDS: "3600",
          PROVIDER_MAX_RETRIES: "2",
          QUEUED_INPUT_LIMIT_PER_SESSION: "20",
          S3_BUCKET: "claude-sessions",
          SCHEDULER_MAX_CONSECUTIVE_FAILURES: "1",
          SCHEDULER_STATUS_FILE: statusFile,
          SESSION_COST_LIMIT_USD: "25",
          STORAGE_LIMIT_BYTES: "1073741824",
          WORKER_GATEWAY_URL: "http://api:3000",
          WORKER_IMAGE: "werft-worker:dev",
        });
        expect(loop.stderr + loop.stdout).toContain("Scheduler loop started");
        expect(loop.exitCode).toBe(1);
        expect(await Bun.file(marker).exists()).toBe(false);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
    TIMEOUT_MS,
  );
});

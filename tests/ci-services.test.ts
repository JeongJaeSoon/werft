import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Integration jobs start PostgreSQL and LocalStack from a step, not from
// `services:`. The script is checked against a fake docker; the
// workflow for where its steps sit.

const root = join(import.meta.dir, "..");
const script = join(root, ".github/scripts/ci-services.sh");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ci-services-"));
  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG"
case "$1" in
run) echo "run output of $4"; exit "\${FAKE_RUN_RC:-0}" ;;
inspect) echo "\${FAKE_STATE:-running}" ;;
exec) [ "\${FAKE_PROBE:-ok}" = hang ] && exec sleep 30; [ "\${FAKE_PROBE:-ok}" = ok ] ;;
logs) echo "container log of $4" ;;
esac
`,
    { mode: 0o755 },
  );
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

const services = (
  command: string,
  env: Record<string, string> = {},
): { code: number; out: string } => {
  const result = Bun.spawnSync(["bash", script, command], {
    env: {
      ...process.env,
      DOCKER_CLI: join(dir, "docker"),
      FAKE_LOG: join(dir, "calls"),
      LOCALSTACK: "true",
      LOCALSTACK_SERVICE_IMAGE: "mirror/localstack@sha256:1",
      POSTGRES: "true",
      POSTGRES_SERVICE_IMAGE: "mirror/postgres@sha256:2",
      SERVICES_DIR: join(dir, "records"),
      SERVICES_WAIT_SECONDS: "2",
      ...env,
    },
  });
  return { code: result.exitCode, out: result.stdout.toString() };
};
const calls = () => readFileSync(join(dir, "calls"), "utf8");

describe("ci-services.sh", () => {
  test("starts each enabled service on its old port and waits for both", () => {
    expect(services("start").code).toBe(0);
    const { code, out } = services("wait");
    expect(code).toBe(0);
    expect(out).toContain("postgres ready");
    expect(out).toContain("localstack ready");
    expect(calls()).toContain(
      "run --detach --name ci-postgres --publish 5432:5432 --env POSTGRES_DB=sessions",
    );
    expect(calls()).toContain("mirror/postgres@sha256:2");
    expect(calls()).toContain(
      "run --detach --name ci-localstack --publish 4566:4566 --env SERVICES=s3,secretsmanager",
    );
    expect(calls()).toContain("mirror/localstack@sha256:1");
  });

  test("starts nothing a job does not use", () => {
    services("start", { LOCALSTACK: "false" });
    expect(services("wait", { LOCALSTACK: "false" }).code).toBe(0);
    expect(calls()).not.toContain("ci-localstack");
  });

  test("fails with docker's output when a container cannot be started", () => {
    const env = { FAKE_RUN_RC: "125", LOCALSTACK: "false" };
    services("start", env);
    const { code, out } = services("wait", env);
    expect(code).toBe(1);
    expect(out).toContain(
      "::error::postgres service could not be started (docker run exited 125)",
    );
    expect(out).toContain("run output of ci-postgres");
  });

  test("fails with the container's log once it has exited", () => {
    const env = { FAKE_STATE: "exited", LOCALSTACK: "false" };
    services("start", env);
    const { code, out } = services("wait", env);
    expect(code).toBe(1);
    expect(out).toContain("::error::postgres service container is exited");
    expect(out).toContain("container log of ci-postgres");
  });

  test("fails with every log when a service never gets ready", () => {
    services("start");
    const { code, out } = services("wait", { FAKE_PROBE: "down" });
    expect(code).toBe(1);
    expect(out).toContain("::error::postgres service not ready after 2s");
    expect(out).toContain("::error::localstack service not ready after 2s");
    expect(out).toContain("container log of ci-localstack");
  });

  test("keeps its deadline when the daemon stops answering", () => {
    const env = { LOCALSTACK: "false", SERVICES_CALL_TIMEOUT: "1" };
    services("start", env);
    const started = Date.now();
    const { code, out } = services("wait", { ...env, FAKE_PROBE: "hang" });
    expect(code).toBe(1);
    expect(out).toContain("::error::postgres service not ready after 2s");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("ci.yml integration jobs", () => {
  type Step = { name?: string; uses?: string; if?: string; run?: string };
  const job = (
    Bun.YAML.parse(
      readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"),
    ) as {
      jobs: Record<string, { services?: unknown; steps: Step[] }>;
    }
  ).jobs["integration-domain"];
  const steps = job?.steps ?? [];
  const at = (match: (step: Step) => boolean) => steps.findIndex(match);
  const script = (command: string) => (step: Step) =>
    step.run?.trim() === `.github/scripts/ci-services.sh ${command}`;

  test("start services after checkout, before the install, and wait before the tests", () => {
    expect(job?.services).toBeUndefined();
    const checkout = at(
      (step) => step.uses?.startsWith("actions/checkout@") ?? false,
    );
    const start = at(script("start"));
    const install = at((step) => step.uses === "./.github/actions/bun-setup");
    const wait = at(script("wait"));
    const tests = at((step) => step.name === "Tests of this domain");
    // The gate step comes first and every later step waits on it.
    expect(steps[0]?.id).toBe("gate");
    expect(checkout).toBe(1);
    expect(start).toBe(2);
    expect(install).toBeGreaterThan(start);
    expect(wait).toBeGreaterThan(install);
    expect(tests).toBeGreaterThan(wait);
  });

  test("remove the containers whatever happened", () => {
    const stop = steps[at(script("stop"))];
    expect(stop?.if).toBe("always() && steps.gate.outputs.run == 'true'");
  });
});

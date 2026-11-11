import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { run } from "../../tests/d2-gate/harness.ts";

/**
 * What the soak runner and the campaigns share: the stack they are
 * pointed at (scripts/soak/stack.sh writes it), raw JSONL output, the
 * statistics the criteria are judged with, clock alignment, and the
 * reproducibility record every result carries.
 */

// ---------------------------------------------------------------- stack

export type SoakEnv = {
  apiImage: string;
  apiKey: string;
  /** The owner's second key, which answers requests (`self_approval`). */
  approveKey: string;
  apiUrl: string;
  chaosUrl: string;
  composeFiles: string[];
  databaseUrl: string;
  installation: string;
  messagesUrl: string;
  network: string;
  project: string;
  s3Url: string;
  /** The VM stall probe; only the soak runner needs it. */
  vmLagUrl: string | null;
  /** The host probe's second target; only the soak runner needs it. */
  hostEchoUrl: string | null;
  workerImage: string;
};

export function soakEnv(vars = process.env): SoakEnv {
  const need = (name: string): string => {
    const value = vars[name];
    if (!value) {
      throw new Error(
        `${name} is not set: run scripts/soak/stack.sh up and source its vars.sh`,
      );
    }
    return value;
  };
  return {
    apiImage: need("API_IMAGE"),
    apiKey: need("SOAK_API_KEY"),
    approveKey: need("SOAK_APPROVE_KEY"),
    apiUrl: need("SOAK_API_URL"),
    chaosUrl: need("SOAK_CHAOS_URL"),
    composeFiles: need("SOAK_COMPOSE_FILES").split(" ").filter(Boolean),
    databaseUrl: need("SOAK_DATABASE_URL"),
    installation: need("SOAK_INSTALLATION"),
    messagesUrl: need("SOAK_MESSAGES_URL"),
    network: need("SOAK_NETWORK"),
    project: need("SOAK_PROJECT"),
    s3Url: need("SOAK_S3_URL"),
    vmLagUrl: vars.SOAK_VM_LAG_URL || null,
    hostEchoUrl: vars.SOAK_HOST_ECHO_URL || null,
    workerImage: need("WORKER_IMAGE"),
  };
}

export function container(env: SoakEnv, service: string): string {
  return `${env.project}-${service}-1`;
}

/** `docker compose` on the soak project, the way stack.sh runs it. */
function composeArgv(env: SoakEnv, args: string[]): string[] {
  return [
    "docker",
    "compose",
    "-p",
    env.project,
    ...env.composeFiles,
    "--profile",
    "apps",
    "--profile",
    "worker",
    ...args,
  ];
}

export function compose(env: SoakEnv, args: string[]) {
  return run(composeArgv(env, args), { allowFail: true });
}

/**
 * Runs a compose command straight into a file. A day of stack logs is
 * gigabytes, which `compose()` would buffer in memory whole.
 */
export async function composeToFile(
  env: SoakEnv,
  args: string[],
  path: string,
): Promise<number> {
  const child = Bun.spawn(composeArgv(env, args), {
    stderr: "inherit",
    stdout: Bun.file(path),
  });
  return child.exited;
}

// ---------------------------------------------------------------- raw output

/** Appends one JSON object per line; every raw result goes through one. */
export class Jsonl {
  constructor(readonly path: string) {}

  write(record: Record<string, unknown>): void {
    appendFileSync(
      this.path,
      `${JSON.stringify({ t: new Date().toISOString(), ...record })}\n`,
    );
  }
}

export class Output {
  private readonly files = new Map<string, Jsonl>();

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  jsonl(name: string): Jsonl {
    let file = this.files.get(name);
    if (!file) {
      file = new Jsonl(join(this.dir, `${name}.jsonl`));
      this.files.set(name, file);
    }
    return file;
  }

  json(name: string, value: unknown): void {
    writeFileSync(
      join(this.dir, `${name}.json`),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  }

  text(name: string, value: string): void {
    writeFileSync(join(this.dir, name), value);
  }
}

// ---------------------------------------------------------------- statistics

export type Distribution = {
  n: number;
  min: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
};

/** Nearest-rank percentile: the smallest sample at or above p of them. */
export function percentile(
  sorted: readonly number[],
  p: number,
): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

export function distribution(samples: readonly number[]): Distribution {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? null,
  };
}

// ---------------------------------------------------------------- clocks

/**
 * Host clock minus the container clock, from one round trip to the soak
 * Messages API (the database and the fault injector share that clock:
 * containers run on one kernel). Host timestamps minus this are container
 * timestamps.
 */
export async function clockOffset(
  messagesUrl: string,
): Promise<{ offsetMs: number; rttMs: number }> {
  const sent = Date.now();
  const response = await fetch(`${messagesUrl}/clock`, {
    signal: AbortSignal.timeout(5000),
  });
  const { now } = (await response.json()) as { now: number };
  const received = Date.now();
  return {
    offsetMs: Math.round((sent + received) / 2 - now),
    rttMs: received - sent,
  };
}

// ---------------------------------------------------------------- reproducibility

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The record every result carries (재현성): commit, config, the SDK
 * and Claude Code versions inside the worker image, Bun on both sides, the
 * image identifiers, the bun.lock hash, and the exact command.
 */
export async function reproMeta(
  env: SoakEnv,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const text = async (command: string[]) =>
    (await run(command, { allowFail: true })).stdout.trim();
  const imageId = (image: string) =>
    text(["docker", "image", "inspect", "--format", "{{.Id}}", image]);
  const inWorker = (script: string) =>
    text([
      "docker",
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      env.workerImage,
      "-c",
      script,
    ]);
  const serviceImage = (service: string) =>
    text([
      "docker",
      "inspect",
      "--format",
      "{{.Config.Image}} {{.Image}}",
      container(env, service),
    ]);
  const head = await text(["git", "rev-parse", "HEAD"]);
  return {
    command: process.argv.join(" "),
    // rc.sh may build the images from the RC and run a later tools commit.
    tested_sha: process.env.SOAK_PRODUCT_SHA ?? head,
    tools_sha: head,
    worktree_dirty: (await text(["git", "status", "--porcelain"])) !== "",
    bun_lock_sha256:
      process.env.SOAK_PRODUCT_BUN_LOCK ?? sha256File("bun.lock"),
    compose_project: env.project,
    installation: env.installation,
    compose_files: env.composeFiles.filter((file) => file !== "-f"),
    control_host_image: `${env.apiImage} ${await imageId(env.apiImage)}`,
    worker_image: `${env.workerImage} ${await imageId(env.workerImage)}`,
    egress_proxy_image: await serviceImage("egress-proxy"),
    postgres_image: await serviceImage("postgres"),
    localstack_image: await serviceImage("localstack"),
    git_host_image: await serviceImage("fake-git"),
    messages_image: await serviceImage("gate-messages"),
    claude_agent_sdk: await inWorker(
      'sed -n \'s/^  "version": "\\(.*\\)",$/\\1/p\' /app/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
    ),
    claude_code: await inWorker(
      "$(find /app/node_modules/@anthropic-ai -path '*claude-agent-sdk-linux-*/claude' -type f | head -n 1) --version",
    ),
    worker_bun: await inWorker("bun --version"),
    host_bun: Bun.version,
    host: `${process.platform} ${process.arch}`,
    docker: await text([
      "docker",
      "version",
      "--format",
      "{{.Server.Version}} (API {{.Server.APIVersion}}) {{.Server.Os}}/{{.Server.Arch}}",
    ]),
    docker_resources: await text([
      "docker",
      "info",
      "--format",
      "{{.NCPU}} CPUs, {{.MemTotal}} bytes",
    ]),
    object_store:
      "SeaweedFS S3 on a named volume, versioned bucket with Object Lock (CHECKPOINT_OBJECT_PROTECTION=locked)",
    model_api:
      "scripts/soak/messages.ts (scripted Messages API with latency/error injection)",
    ...extra,
  };
}

// ---------------------------------------------------------------- report

type Verdict = "pass" | "fail" | "skip";

/** One row of the criteria table: 입력·기대·실제·결과. */
export type Criterion = {
  actual: string;
  area: string;
  expected: string;
  id: string;
  input: string;
  status: Verdict;
};

export function criterion(
  row: Omit<Criterion, "actual" | "status"> & {
    actual: unknown;
    pass: boolean | null;
  },
): Criterion {
  const { actual, pass, ...rest } = row;
  return {
    ...rest,
    actual: typeof actual === "string" ? actual : JSON.stringify(actual),
    status: pass === null ? "skip" : pass ? "pass" : "fail",
  };
}

export function markdownReport(
  title: string,
  meta: Record<string, unknown>,
  rows: Criterion[],
): string {
  const cell = (value: unknown) =>
    (typeof value === "string" ? value : JSON.stringify(value))
      .replaceAll("|", "\\|")
      .replaceAll("\n", " ")
      .slice(0, 600);
  const count = (status: Verdict) =>
    rows.filter((row) => row.status === status).length;
  return [
    `# ${title}`,
    "",
    "| key | value |",
    "|---|---|",
    ...Object.entries(meta).map(
      ([key, value]) => `| ${key} | ${cell(value)} |`,
    ),
    "",
    `pass ${count("pass")} · fail ${count("fail")} · skip ${count("skip")}`,
    "",
    "| id | 영역 | 입력 | 기대 | 실제 | 결과 |",
    "|---|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.id} | ${cell(row.area)} | ${cell(row.input)} | ${cell(row.expected)} | ${cell(row.actual)} | ${row.status.toUpperCase()} |`,
    ),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- misc

export function between(
  [min, max]: readonly [number, number],
  random = Math.random,
): number {
  return Math.round(min + (max - min) * random());
}

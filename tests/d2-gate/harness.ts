import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  CreateSessionResponse,
  GetSessionResponse,
  GetTurnResponse,
  PendingRequest,
  PostSessionMessageResponse,
} from "@werft-ai/contracts";
import { digestParts } from "@werft-ai/runtime-codec-kit";
import {
  checkpointBundleRefs,
  PEELED_REF_FORMAT,
  peeledCommits,
} from "@werft-ai/runtime-core";
import { Pool } from "pg";

/**
 * What tests/d2-gate/gate.e2e.test.ts drives the stack with. Everything here
 * talks to the running product from outside — public HTTP, the database,
 * the bucket, the Docker CLI and the gate's own fault injector — so what
 * the gate observes is what an operator could.
 */

export const BUCKET = "claude-sessions";

export type GateEnv = {
  apiImage: string;
  apiKey: string;
  apiUrl: string;
  chaosUrl: string;
  command: string;
  databaseUrl: string;
  installation: string;
  messagesUrl: string;
  network: string;
  out: string;
  project: string;
  s3Url: string;
  workerImage: string;
};

/**
 * The reasons `main.ts <role> --health` gives for an unhealthy loop
 * (apps/control-host/src/pass-loop/health.ts; health.test.ts keeps them in step).
 */
export const UNHEALTHY =
  /no pass has completed since|failed pass\(es\) since the last completed one|running past its deadline|no status file/;

/** Null unless run.sh started the stack; the gate never starts one itself. */
export function gateEnv(): GateEnv | null {
  const vars = process.env;
  if (vars.D2_GATE !== "1") return null;
  const need = (name: string): string => {
    const value = vars[name];
    if (!value)
      throw new Error(`${name} is not set; run scripts/d2-gate/run.sh`);
    return value;
  };
  return {
    apiImage: need("API_IMAGE"),
    apiKey: need("D2_GATE_API_KEY"),
    apiUrl: need("D2_GATE_API_URL"),
    chaosUrl: need("D2_GATE_CHAOS_URL"),
    command: need("D2_GATE_COMMAND"),
    databaseUrl: need("D2_GATE_DATABASE_URL"),
    installation: need("EXECUTION_INSTALLATION_ID"),
    messagesUrl: need("D2_GATE_MESSAGES_URL"),
    network: need("D2_GATE_NETWORK"),
    out: need("D2_GATE_OUT"),
    project: need("D2_GATE_PROJECT"),
    s3Url: need("D2_GATE_S3_URL"),
    workerImage: need("WORKER_IMAGE"),
  };
}

// ---------------------------------------------------------------- report

export type CheckStatus = "pass" | "fail" | "skip";

export type Check = {
  actual: string;
  /** Which acceptance criterion of this is evidence for. */
  criterion: string;
  expected: string;
  id: string;
  input: string;
  status: CheckStatus;
  title: string;
};

export class GateReport {
  readonly checks: Check[] = [];
  readonly meta: Record<string, unknown> = {};

  /** Records the outcome and returns whether it passed. */
  check(
    entry: Omit<Check, "actual" | "status"> & {
      actual: unknown;
      pass: boolean;
    },
  ): boolean {
    const { pass, actual, ...rest } = entry;
    this.checks.push({
      ...rest,
      actual: typeof actual === "string" ? actual : JSON.stringify(actual),
      status: pass ? "pass" : "fail",
    });
    return pass;
  }

  skip(entry: Omit<Check, "status" | "actual"> & { reason: string }): void {
    const { reason, ...rest } = entry;
    this.checks.push({ ...rest, actual: reason, status: "skip" });
  }

  failed(): Check[] {
    return this.checks.filter((check) => check.status === "fail");
  }

  async write(directory: string): Promise<void> {
    await writeFile(
      join(directory, "report.json"),
      `${JSON.stringify({ meta: this.meta, checks: this.checks }, null, 2)}\n`,
    );
    const cell = (text: string) =>
      text.replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 400);
    const lines = [
      "# D2 gate report (94S-247)",
      "",
      "| key | value |",
      "|---|---|",
      ...Object.entries(this.meta).map(
        ([key, value]) =>
          `| ${key} | ${cell(typeof value === "string" ? value : JSON.stringify(value))} |`,
      ),
      "",
      `pass ${this.count("pass")} · fail ${this.count("fail")} · skip ${this.count("skip")}`,
      "",
      "| id | AC | check | input | expected | actual | result |",
      "|---|---|---|---|---|---|---|",
      ...this.checks.map(
        (check) =>
          `| ${check.id} | ${check.criterion} | ${cell(check.title)} | ${cell(check.input)} | ${cell(check.expected)} | ${cell(check.actual)} | ${check.status.toUpperCase()} |`,
      ),
      "",
    ];
    await writeFile(join(directory, "report.md"), lines.join("\n"));
  }

  private count(status: CheckStatus): number {
    return this.checks.filter((check) => check.status === status).length;
  }
}

// ---------------------------------------------------------------- waiting

export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) {
        return value;
      }
    } catch (error) {
      last = error;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${label}${last ? `: ${String(last)}` : ""}`,
  );
}

// ---------------------------------------------------------------- public API

export type ApiResult = { body: unknown; status: number };

const OPEN_TURN = new Set(["queued", "running", "needs_input"]);

export class PublicApi {
  constructor(
    private readonly base: string,
    private readonly key: string,
  ) {}

  async call(method: string, path: string, body?: unknown): Promise<ApiResult> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { "idempotency-key": crypto.randomUUID() }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { body: parsed, status: response.status };
  }

  async createSession(message: string): Promise<CreateSessionResponse> {
    const created = await this.call("POST", "/v1/sessions", {
      profile_id: "d2-gate",
      repository_id: "gate-app",
      message,
    });
    if (created.status !== 201 && created.status !== 202) {
      throw new Error(
        `create ${created.status} ${JSON.stringify(created.body)}`,
      );
    }
    return created.body as CreateSessionResponse;
  }

  postMessage(sessionId: string, message: string): Promise<ApiResult> {
    return this.call("POST", `/v1/sessions/${sessionId}/messages`, { message });
  }

  /** A message the scenario needs accepted; anything else ends it here. */
  async message(sessionId: string, message: string): Promise<string> {
    const posted = await this.postMessage(sessionId, message);
    if (posted.status !== 202) {
      throw new Error(
        `message ${posted.status} ${JSON.stringify(posted.body)}`,
      );
    }
    return (posted.body as PostSessionMessageResponse).turn_id;
  }

  async session(sessionId: string): Promise<GetSessionResponse> {
    return (await this.call("GET", `/v1/sessions/${sessionId}`))
      .body as GetSessionResponse;
  }

  async turn(sessionId: string, turnId: string): Promise<GetTurnResponse> {
    return (await this.call("GET", `/v1/sessions/${sessionId}/turns/${turnId}`))
      .body as GetTurnResponse;
  }

  /**
   * Waits the turn out, allowing every permission it asks for the way a
   * user would: the gate's profile runs Write without asking, but whatever
   * does ask must not be what decides the outcome.
   */
  async settle(
    sessionId: string,
    turnId: string,
    timeoutMs: number,
  ): Promise<GetTurnResponse> {
    return waitFor(
      `turn ${turnId} of ${sessionId} to end`,
      async () => {
        const pending = await this.call(
          "GET",
          `/v1/sessions/${sessionId}/pending-requests`,
        );
        const { items } = pending.body as { items?: PendingRequest[] };
        for (const request of items ?? []) {
          if (request.kind !== "permission") continue;
          await this.call("POST", `/v1/sessions/${sessionId}/answers`, {
            request_id: request.request_id,
            kind: "permission",
            action: "allow",
          });
        }
        const turn = await this.turn(sessionId, turnId);
        return turn?.status && !OPEN_TURN.has(turn.status) ? turn : null;
      },
      timeoutMs,
    );
  }
}

// ---------------------------------------------------------------- database

export function database(url: string): Pool {
  return new Pool({ connectionString: url, max: 4 });
}

// ---------------------------------------------------------------- objects

export class Bucket {
  private readonly client: S3Client;

  constructor(endpoint: string) {
    this.client = new S3Client({
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      endpoint,
      forcePathStyle: true,
      region: "ap-northeast-1",
    });
  }

  async get(key: string, version?: string | null): Promise<Uint8Array> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ...(version ? { VersionId: version } : {}),
      }),
    );
    return await (
      response.Body as { transformToByteArray(): Promise<Uint8Array> }
    ).transformToByteArray();
  }

  /** Every version of every key under the prefix, oldest first per key. */
  async versions(
    prefix: string,
  ): Promise<Array<{ key: string; version: string }>> {
    const found: Array<{ key: string; version: string }> = [];
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      const page = await this.client.send(
        new ListObjectVersionsCommand({
          Bucket: BUCKET,
          KeyMarker: keyMarker,
          Prefix: prefix,
          VersionIdMarker: versionMarker,
        }),
      );
      for (const entry of page.Versions ?? []) {
        found.push({ key: entry.Key ?? "", version: entry.VersionId ?? "" });
      }
      if (!page.IsTruncated) return found;
      keyMarker = page.NextKeyMarker;
      versionMarker = page.NextVersionIdMarker;
    }
  }
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Ref = { bytes: number; key: string; sha256: string; version?: string };

type Manifest = {
  revision: number;
  sessionId: string;
  transcripts: {
    root: { entryCount: number; parts: Ref[]; sha256: string };
    subagents: Record<
      string,
      { entryCount: number; parts: Ref[]; sha256: string }
    >;
  };
  workspace: {
    bundle: Ref;
    baseBundles?: Ref[];
    gitCommit: string;
    untracked: Array<Ref & { executable?: true; path: string }>;
  };
};

export type CheckpointRow = {
  manifest_ref: string;
  manifest_sha256: string;
  manifest_version: string | null;
  revision: number;
  turn_id: string;
};

export type VerifiedCheckpoint = {
  bundleHeads: string;
  manifest: Manifest;
  problems: string[];
  rootEntries: Array<Record<string, unknown>>;
  subagentEntries: Record<string, Array<Record<string, unknown>>>;
  tree: Record<string, string>;
};

/**
 * Reads a committed checkpoint back the way a restore would — by the
 * versions it pins — and lists every digest that does not match. Also
 * unpacks the workspace bundle to name the commit and files it carries.
 */
export async function verifyCheckpoint(
  bucket: Bucket,
  row: CheckpointRow,
): Promise<VerifiedCheckpoint> {
  const problems: string[] = [];
  const manifestBytes = await bucket.get(
    row.manifest_ref,
    row.manifest_version,
  );
  if (sha256(manifestBytes) !== row.manifest_sha256) {
    problems.push(
      `manifest sha256 ${sha256(manifestBytes)} != pointer ${row.manifest_sha256}`,
    );
  }
  const manifest = JSON.parse(
    new TextDecoder().decode(manifestBytes),
  ) as Manifest;
  if (manifest.revision !== row.revision) {
    problems.push(
      `manifest revision ${manifest.revision} != pointer ${row.revision}`,
    );
  }
  const fetchRef = async (label: string, ref: Ref): Promise<Uint8Array> => {
    const bytes = await bucket.get(ref.key, ref.version);
    if (sha256(bytes) !== ref.sha256)
      problems.push(`${label} ${ref.key} sha256 mismatch`);
    if (bytes.byteLength !== ref.bytes)
      problems.push(`${label} ${ref.key} size mismatch`);
    if (!ref.version) problems.push(`${label} ${ref.key} carries no version`);
    return bytes;
  };
  const jsonl = (chunks: Uint8Array[]) =>
    chunks
      .map((chunk) => new TextDecoder().decode(chunk))
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const readTranscript = async (
    label: string,
    transcript: { entryCount: number; parts: Ref[]; sha256: string },
  ) => {
    if (digestParts(transcript.parts) !== transcript.sha256) {
      problems.push(`${label} part-list digest mismatch`);
    }
    const chunks: Uint8Array[] = [];
    for (const part of transcript.parts)
      chunks.push(await fetchRef(label, part));
    return jsonl(chunks);
  };
  const rootEntries = await readTranscript(
    "root transcript",
    manifest.transcripts.root,
  );
  const subagentEntries: Record<string, Array<Record<string, unknown>>> = {};
  for (const [subpath, transcript] of Object.entries(
    manifest.transcripts.subagents,
  )) {
    subagentEntries[subpath] = await readTranscript(
      `subagent ${subpath}`,
      transcript,
    );
  }
  for (const file of manifest.workspace.untracked) {
    await fetchRef(`untracked ${file.path}`, file);
  }
  const bundles: Uint8Array[] = [];
  for (const base of manifest.workspace.baseBundles ?? []) {
    bundles.push(await fetchRef("base bundle", base));
  }
  bundles.push(await fetchRef("bundle", manifest.workspace.bundle));
  const { heads, tree } = await unbundle(
    bundles,
    manifest.workspace.gitCommit,
    problems,
  );
  return {
    bundleHeads: heads,
    manifest,
    problems,
    rootEntries,
    subagentEntries,
    tree,
  };
}

/**
 * What the bundle names and carries: its heads as `git bundle list-heads`
 * prints them, and every file of the manifest's commit. `bundles` is the
 * manifest's chain, base bundles oldest first and its own bundle last: an
 * incremental bundle needs commits only an earlier one carries, so
 * they are fetched in that order into one repository, the way a restore
 * stacks them (scripts/lib/backup-lib.sh `unbundle_chain`).
 */
async function unbundle(
  bundles: Uint8Array[],
  commit: string,
  problems: string[],
): Promise<{ heads: string; tree: Record<string, string> }> {
  const directory = await mkdtemp(join(tmpdir(), "d2-gate-bundle-"));
  try {
    const repo = join(directory, "repo.git");
    await run(["git", "init", "--quiet", "--bare", repo]);
    const git = (args: string[], allowFail = false) =>
      run(["git", "-C", repo, ...args], { allowFail });
    let heads = "";
    for (const [index, bundle] of bundles.entries()) {
      const file = join(directory, `workspace-${index}.bundle`);
      await writeFile(file, bundle);
      const verified = await git(["bundle", "verify", file], true);
      if (verified.code !== 0)
        problems.push(
          `git bundle verify of bundle ${index + 1}/${bundles.length}: ${verified.stderr.trim()}`,
        );
      heads = (await git(["bundle", "list-heads", file])).stdout.trim();
      // fsckObjects as unbundle_chain and the worker restore fetch: a
      // malformed object they refuse must fail the gate too.
      await git([
        "-c",
        "fetch.fsckObjects=true",
        "fetch",
        "--quiet",
        "--no-write-fetch-head",
        file,
        `refs/*:refs/chain/${index}/*`,
      ]);
    }
    // The rule finalize and a restore apply to the last bundle's refs
    // peeled: a capture that changed nothing tags a commit an
    // earlier bundle carries.
    const last = `refs/chain/${bundles.length - 1}/`;
    const peeled = peeledCommits(
      (await git(["for-each-ref", `--format=${PEELED_REF_FORMAT}`, last]))
        .stdout,
    );
    const checked = checkpointBundleRefs(
      heads
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ")[1] ?? "")
        .map((name): [string, string | null] => [
          name,
          name.startsWith("refs/")
            ? (peeled.get(`${last}${name.slice("refs/".length)}`) ?? null)
            : null,
        ]),
      commit,
    );
    if (checked.status === "invalid") problems.push(checked.reason);
    const tree: Record<string, string> = {};
    const listing = (await git(["ls-tree", "-r", "--name-only", commit], true))
      .stdout;
    for (const name of listing.split("\n").filter(Boolean)) {
      tree[name] = (await git(["show", `${commit}:${name}`])).stdout;
    }
    return { heads, tree };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
// ---------------------------------------------------------------- processes

export async function run(
  command: string[],
  options: { allowFail?: boolean } = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
  const child = Bun.spawn(command, { stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 && !options.allowFail) {
    throw new Error(`${command.join(" ")} exited ${code}: ${stderr.trim()}`);
  }
  return { code, stderr, stdout };
}

// ---------------------------------------------------------------- docker

export type WorkerContainer = {
  executionId: string;
  generation: number;
  id: string;
  image: string;
  name: string;
  state: string;
};

export type WorkerEvent = { [field: string]: unknown; event: string };

export class Workers {
  private readonly following = new Map<
    string,
    { file: string; process: { kill(): void } }
  >();
  private watching: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly installation: string,
    private readonly out: string,
  ) {}

  /** The session's worker containers, newest generation first. */
  async of(sessionId: string): Promise<WorkerContainer[]> {
    const { stdout } = await run([
      "docker",
      "ps",
      "-a",
      "--filter",
      `label=werft.installation=${this.installation}`,
      "--filter",
      `label=werft.session-id=${sessionId}`,
      "--filter",
      "name=ap-worker-",
      "--format",
      '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "werft.generation"}}\t{{.Label "werft.session-execution-id"}}\t{{.Image}}',
    ]);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [
          id = "",
          name = "",
          state = "",
          generation = "0",
          executionId = "",
          image = "",
        ] = line.split("\t");
        return {
          executionId,
          generation: Number(generation),
          id,
          image,
          name,
          state,
        };
      })
      .sort((a, b) => b.generation - a.generation);
  }

  async running(
    sessionId: string,
    timeoutMs = 180_000,
  ): Promise<WorkerContainer> {
    return waitFor(
      `a running worker for ${sessionId}`,
      async () => {
        const found = (await this.of(sessionId)).find(
          (c) => c.state === "running",
        );
        if (found) this.follow(found.name);
        return found;
      },
      timeoutMs,
      500,
    );
  }

  /**
   * Streams the container's log to a file for as long as it exists: the
   * scheduler removes a container once it has seen it exit, and the log
   * goes with it.
   */
  follow(name: string): string {
    const existing = this.following.get(name);
    if (existing) return existing.file;
    const file = join(this.out, `${name}.log`);
    const process = Bun.spawn(["docker", "logs", "-f", name], {
      stderr: Bun.file(`${file}.stderr`),
      stdout: Bun.file(file),
    });
    this.following.set(name, { file, process });
    return file;
  }

  /**
   * Follows every worker of the installation from the moment it shows up,
   * so a worker that dies before a test looks for it still leaves its log.
   */
  watch(): void {
    if (this.watching) return;
    this.watching = setInterval(async () => {
      const { stdout } = await run(
        [
          "docker",
          "ps",
          "-a",
          "--filter",
          `label=werft.installation=${this.installation}`,
          "--filter",
          "name=ap-worker-",
          "--format",
          "{{.Names}}",
        ],
        { allowFail: true },
      );
      for (const name of stdout.split("\n").filter(Boolean)) this.follow(name);
    }, 500);
  }

  stop(): void {
    if (this.watching) clearInterval(this.watching);
    for (const { process } of this.following.values()) process.kill();
  }

  /**
   * The worker's structured log: one `{timestamp, level, event, ...fields}`
   * object per line (apps/worker/src/console-logger.ts `createConsoleLogger`).
   */
  async events(name: string): Promise<WorkerEvent[]> {
    const file = this.follow(name);
    const text = (await Bun.file(file).exists())
      ? await Bun.file(file).text()
      : "";
    const lines: WorkerEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (typeof record.event === "string") lines.push(record as WorkerEvent);
      } catch {}
    }
    return lines;
  }

  async inspect(
    name: string,
  ): Promise<{ HostConfig?: { Tmpfs?: Record<string, string> } }> {
    const { stdout } = await run(["docker", "inspect", name]);
    const [found] = JSON.parse(stdout) as Array<{
      HostConfig?: { Tmpfs?: Record<string, string> };
    }>;
    if (!found) throw new Error(`docker inspect ${name} returned nothing`);
    return found;
  }

  /**
   * The Claude Code engine process inside the container: its pid and its
   * start time in clock ticks since boot, which together name one process
   * even across pid reuse.
   */
  async engine(
    name: string,
  ): Promise<{ command: string; pid: number; startTicks: string } | null> {
    const script =
      'p=claude-agent-sdk; for d in /proc/[0-9]*; do c=$(tr "\\0" " " < "$d/cmdline" 2>/dev/null); case "$c" in *"$p"-linux*/claude*) echo "$(basename "$d") $(cut -d" " -f22 "$d/stat") $c";; esac; done';
    const { stdout } = await run(["docker", "exec", name, "sh", "-c", script], {
      allowFail: true,
    });
    const line = stdout.split("\n").find(Boolean);
    if (!line) return null;
    const [pid = "0", startTicks = "", ...command] = line.split(" ");
    return { command: command.join(" ").trim(), pid: Number(pid), startTicks };
  }

  /**
   * HEAD, branch, status, file digests and executable bits of the mounted
   * workspace. Only the executable bit: that is the one mode bit a checkpoint
   * carries, and restore writes the rest owner-only (runtime-core
   * workspace-restore.ts, ).
   */
  async workspace(name: string, files: string[]): Promise<string> {
    const script = [
      "cd /workspace",
      "git rev-parse HEAD",
      "git symbolic-ref HEAD",
      "git status --porcelain=v1 -uall",
      `sha256sum ${files.join(" ")}`,
      `for f in ${files.join(" ")}; do if [ -x "$f" ]; then echo "x $f"; else echo "- $f"; fi; done`,
    ].join(" && ");
    return (await run(["docker", "exec", name, "sh", "-c", script])).stdout;
  }
}

// ---------------------------------------------------------------- gate services

export type ChaosRule = {
  action: "corrupt" | "delay" | "fail" | "hold" | "lose_response";
  bodyContains?: string;
  delayMs?: number;
  method?: string;
  path: string;
  times: number;
  upstream: "gateway" | "s3";
};

export type ChaosEntry = {
  at: string;
  /** append-events only: the batch key and each event's sha256 by source_sequence. */
  batch: { events: Record<string, string>; key: string } | null;
  /** A `corrupt` rule changed a byte of this answer. */
  corrupted?: boolean;
  /** The start of a gateway's 4xx/5xx answer. */
  errorBody?: string;
  /** When the injector sent it on upstream; null while held or never. */
  forwardedAt?: string | null;
  /** Arrival order at the fault injector. */
  index: number;
  method: string;
  path: string;
  rule: string | null;
  sessionId: string | null;
  status: number;
  upstream: "gateway" | "s3";
  upstreamStatus: number | null;
};

export class Chaos {
  constructor(private readonly base: string) {}

  async arm(rule: ChaosRule): Promise<string> {
    const response = await fetch(`${this.base}/rules`, {
      body: JSON.stringify(rule),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    return ((await response.json()) as { id: string }).id;
  }

  /** Lets the requests a `hold` rule is holding go on upstream. */
  async release(id: string): Promise<void> {
    await fetch(`${this.base}/rules/${id}/release`, { method: "POST" });
  }

  async disarm(id: string): Promise<void> {
    await fetch(`${this.base}/rules/${id}`, { method: "DELETE" });
  }

  async log(sessionId?: string): Promise<ChaosEntry[]> {
    const query = sessionId ? `?session=${sessionId}` : "";
    return (await (
      await fetch(`${this.base}/log${query}`)
    ).json()) as ChaosEntry[];
  }
}

export type ModelRequest = {
  at: string;
  hasTools: boolean;
  index: number;
  messages: unknown[];
  specId: string | null;
  step: number | null;
};

export class Messages {
  constructor(private readonly base: string) {}

  async requests(specId?: string): Promise<ModelRequest[]> {
    const query = specId ? `?spec=${encodeURIComponent(specId)}` : "";
    return (await (
      await fetch(`${this.base}/requests${query}`)
    ).json()) as ModelRequest[];
  }
}

// ---------------------------------------------------------------- scripted turns

export type Step = {
  delayMs?: number;
  input: Record<string, unknown>;
  tool: string;
};

/** A prompt the gate's Messages API plays back (scripts/d2-gate/fake-messages.ts). */
export function prompt(
  text: string,
  spec: { final: string; finalDelayMs?: number; id: string; steps: Step[] },
): string {
  return `${text}\nGATE-SPEC ${JSON.stringify(spec)}`;
}

export const write = (path: string, content: string): Step => ({
  input: { content, file_path: path },
  tool: "Write",
});

export const read = (path: string): Step => ({
  input: { file_path: path },
  tool: "Read",
});
